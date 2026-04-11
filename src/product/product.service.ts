import { InferAttributes, Op, WhereOptions } from 'sequelize';
import z from 'zod';

import { emitter } from '@/lib/events/emitter';
import {
	InternalServerError,
	NotFound,
	UnprocessableEntity,
} from '@/lib/exceptions';
import { validateWithZodSchema } from '@/lib/utils';
import { SellerEvent } from '@/seller/seller.event';
import { Seller } from '@/seller/seller.model';
import { Tag } from '@/tag/tag.model';
import { UserPreference } from '@/user/user-preference.model';

import {
	CreateProductDto,
	SearchProductsBySellerDto,
	SearchProductsDto,
	UpdateProductDto,
} from './dto';
import { Product } from './product.model';

export const productService: ProductService = {
	getProductById: async (rawProductId) => {
		const productId = await validateWithZodSchema(
			z.uuid(),
			rawProductId,
			'Invalid product ID',
		);
		const product = await Product.findByPk(productId);
		if (!product) throw new NotFound('Product not found');
		return product;
	},

	searchProducts: async (rawQueryParams) => {
		const data = await validateWithZodSchema(
			SearchProductsDto,
			rawQueryParams,
			'Invalid query parameter(s)',
		);

		let whereClause: WhereOptions<Product> = {
			quantity: { [Op.gte]: 1 },
			isPublished: true,
		};

		if (data.minPrice !== undefined || data.maxPrice !== undefined) {
			whereClause.price = {};
			if (data.minPrice !== undefined) {
				whereClause.price = { ...whereClause.price, [Op.gte]: data.minPrice };
			}
			if (data.maxPrice !== undefined) {
				whereClause.price = { ...whereClause.price, [Op.lte]: data.maxPrice };
			}
		}

		if (data.query) {
			whereClause = {
				...whereClause,
				[Op.or]: [
					{
						name: { [Op.iLike]: `%${data.query}%` },
					},
					{
						description: { [Op.iLike]: `%${data.query}%` },
					},
				],
			};
		}

		const { rows: products, count } = await Product.findAndCountAll({
			limit: data.limit,
			offset: (data.page - 1) * data.limit,
			where: whereClause,
			order: [[data.sortBy, data.sortOrder.toUpperCase()]],
		});

		return {
			total: count,
			page: data.page,
			limit: data.limit,
			products,
		};
	},

	getProductWithDetails: async (productId) => {
		const product = await Product.findByPk(productId, {
			include: [
				{ model: Seller, attributes: ['id', 'storeName'] },
				{ model: Tag, as: 'tags', through: { attributes: [] } },
			],
		});

		if (!product) throw new NotFound('Product not found');
		return product;
	},

	getProductWithTags: async (productId) => {
		const product = await Product.findByPk(productId, {
			include: [{ model: Tag, as: 'tags', through: { attributes: [] } }],
		});
		if (!product) throw new NotFound('Product not found');
		return product;
	},

	updateProductInventory: async (productId, quantityChange) => {
		const product = await Product.findByPk(productId);
		if (!product) throw new NotFound('Product not found');

		const newQuantity = product.quantity + quantityChange;
		if (newQuantity < 0) {
			throw new UnprocessableEntity('Insufficient inventory.');
		}

		await product.update({ quantity: newQuantity });
		return product;
	},

	createProductForSeller: async (userId, rawProductData) => {
		const data = await validateWithZodSchema(
			CreateProductDto,
			rawProductData,
			'Invalid product data',
		);

		const seller = await Seller.findOne({
			where: { userId },
			attributes: ['id'],
		});
		if (!seller) throw new NotFound('Seller profile not found.');

		const product = await Product.create({ ...data, sellerId: seller.id });
		emitter.emit(SellerEvent.PRODUCT_CREATED, seller.id, product);
		return product;
	},

	getAllProductsBySeller: async (userId) => {
		const seller = await Seller.findOne({ where: { userId } });
		if (!seller) throw new NotFound('Seller profile not found.');
		return Product.findAll({
			where: { sellerId: seller.id },
			order: [['created_at', 'DESC']],
		});
	},

	getProductBySeller: async (userId, productId) => {
		const seller = await Seller.findOne({ where: { userId } });
		if (!seller) throw new NotFound('Seller profile not found.');

		const product = await Product.findOne({
			where: { id: productId, sellerId: seller.id },
		});
		if (!product) throw new NotFound('Product not found');
		return product;
	},

	updateProductBySeller: async (userId, productId, rawUpdateData) => {
		const data = await validateWithZodSchema(
			UpdateProductDto,
			rawUpdateData,
			'Invalid product data',
		);

		const seller = await Seller.findOne({
			where: { userId },
			attributes: ['id'],
		});
		if (!seller) throw new NotFound('Seller profile not found.');

		const [affectedRows, updatedProducts] = await Product.update(data, {
			where: { id: productId, sellerId: seller.id },
			returning: true,
		});

		emitter.emit(
			SellerEvent.PRODUCT_UPDATED,
			seller.id,
			updatedProducts[0],
			data,
		);

		if (affectedRows === 0)
			throw new InternalServerError('Could not update product');
		return updatedProducts[0];
	},

	deleteAllProductsBySeller: async (userId) => {
		const seller = await Seller.findOne({ where: { userId } });
		if (!seller) throw new NotFound('Seller profile not found.');
		await Product.destroy({ where: { sellerId: seller.id } });
	},

	deleteProductBySeller: async (userId, productId) => {
		const seller = await Seller.findOne({ where: { userId } });
		if (!seller) throw new NotFound('Seller profile not found.');
		await Product.destroy({ where: { id: productId, sellerId: seller.id } });
	},

	searchProductsBySeller: async (userId, rawQueryParams) => {
		const data = await validateWithZodSchema(
			SearchProductsBySellerDto,
			rawQueryParams,
			'Invalid query parameter(s)',
		);

		const seller = await Seller.findOne({
			where: { userId },
			attributes: ['id'],
		});
		if (!seller) throw new NotFound('Seller profile not found.');

		let whereClause: WhereOptions<Product> = {
			sellerId: seller.id,
		};

		if (data.isPublished !== undefined) {
			whereClause.isPublished = data.isPublished;
		}

		if (data.minPrice !== undefined || data.maxPrice !== undefined) {
			whereClause.price = {};
			if (data.minPrice !== undefined) {
				whereClause.price = { ...whereClause.price, [Op.gte]: data.minPrice };
			}
			if (data.maxPrice !== undefined) {
				whereClause.price = { ...whereClause.price, [Op.lte]: data.maxPrice };
			}
		}

		if (data.minQuantity !== undefined || data.maxQuantity !== undefined) {
			whereClause.quantity = {};
			if (data.minQuantity !== undefined) {
				whereClause.quantity = {
					...whereClause.quantity,
					[Op.gte]: data.minQuantity,
				};
			}
			if (data.maxQuantity !== undefined) {
				whereClause.quantity = {
					...whereClause.quantity,
					[Op.lte]: data.maxQuantity,
				};
			}
		}

		if (data.query) {
			whereClause = {
				...whereClause,
				[Op.or]: [
					{
						name: { [Op.iLike]: `%${data.query}%` },
					},
					{
						description: { [Op.iLike]: `%${data.query}%` },
					},
				],
			};
		}

		const { rows: products, count } = await Product.findAndCountAll({
			limit: data.limit,
			offset: (data.page - 1) * data.limit,
			where: whereClause,
			order: [[data.sortBy, data.sortOrder.toUpperCase()]],
			attributes: { exclude: ['sellerId'] },
		});

		return {
			total: count,
			page: data.page,
			limit: data.limit,
			sort: { by: data.sortBy, order: data.sortOrder },
			products,
		};
	},

	updatePublishedStatusBySeller: async (userId, rawStatusData) => {
		const { isPublished } = await validateWithZodSchema(
			z.object({ isPublished: z.boolean() }),
			rawStatusData,
			'Invalid status data',
		);
		const seller = await Seller.findOne({
			where: { userId },
			attributes: ['id'],
		});
		if (!seller) throw new NotFound('Seller profile not found.');

		const [affectedRows] = await Product.update(
			{ isPublished },
			{ where: { sellerId: seller.id } },
		);
		return { updatedCount: affectedRows, isPublished };
	},

	getRecommendedProducts: async (userId, options) => {
		const { limit = 20, page = 1 } = options;
		const offset = (page - 1) * limit;

		const userPreferences = await UserPreference.findAll({
			where: { userId },
			include: [
				{
					model: Tag,
					attributes: ['id', 'name'],
					required: true,
				},
			],
			order: [['weight', 'DESC']],
			limit: 50,
		});

		if (userPreferences.length === 0) {
			const result = await Product.findAndCountAll({
				where: { isPublished: true },
				limit,
				offset,
				order: [['createdAt', 'DESC']],
			});

			return {
				total: result.count,
				page,
				limit,
				hasMore: result.count > page * limit,
				products: result.rows.map((product) => ({
					...product.toJSON(),
					relevanceScore: 0,
				})),
			};
		}

		const tagWeights = userPreferences.reduce(
			(acc, pref) => {
				acc[pref.tagId] = pref.weight;
				return acc;
			},
			{} as Record<string, number>,
		);

		const preferredTagIds = Object.keys(tagWeights);

		const { rows: products } = await Product.findAndCountAll({
			where: { isPublished: true },
			limit,
			offset,
			include: [
				{
					model: Tag,
					where: { id: preferredTagIds },
					attributes: ['id', 'name'],
					through: { attributes: [] },
					required: true,
				},
			],
		});

		const productsWithScore = products.map((product) => {
			const matchingTags = product.tags || [];
			const relevanceScore = matchingTags.reduce((score, tag) => {
				return score + (tagWeights[tag.id] || 0);
			}, 0);

			return {
				...product.toJSON(),
				relevanceScore,
			};
		});

		productsWithScore.sort((a, b) => b.relevanceScore - a.relevanceScore);

		return {
			products: productsWithScore.map(({ tags, ...product }) => product),
			total: productsWithScore.length,
			page,
			limit,
			hasMore: productsWithScore.length > page * limit,
		};
	},
};

interface ProductService {
	getProductById: (productId: string) => Promise<Product>;
	searchProducts: (rawQueryParams: any) => Promise<{
		total: number;
		page: number;
		limit: number;
		products: Product[];
	}>;
	getProductWithDetails: (productId: string) => Promise<Product>;
	getProductWithTags: (productId: string) => Promise<Product>;
	updateProductInventory: (
		productId: string,
		quantityChange: number,
	) => Promise<Product>;
	createProductForSeller: (
		userId: string,
		rawProductData: any,
	) => Promise<Product>;
	getAllProductsBySeller: (userId: string) => Promise<Product[]>;
	getProductBySeller: (userId: string, productId: string) => Promise<Product>;
	updateProductBySeller: (
		userId: string,
		productId: string,
		rawUpdateData: any,
	) => Promise<Product>;
	deleteAllProductsBySeller: (userId: string) => Promise<void>;
	deleteProductBySeller: (userId: string, productId: string) => Promise<void>;
	searchProductsBySeller: (
		userId: string,
		rawQueryParams: any,
	) => Promise<{
		total: number;
		page: number;
		limit: number;
		sort: { by: string; order: string };
		products: Product[];
	}>;
	updatePublishedStatusBySeller: (
		userId: string,
		rawStatusData: any,
	) => Promise<{
		updatedCount: number;
		isPublished: boolean;
	}>;
	getRecommendedProducts: (
		userId: string,
		options: { limit?: number; page?: number },
	) => Promise<{
		products: RecommendedProduct[];
		total: number;
		page: number;
		limit: number;
		hasMore: boolean;
	}>;
}

interface RecommendedProduct extends InferAttributes<Product> {
	relevanceScore: number;
}
