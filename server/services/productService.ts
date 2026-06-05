import { getDb } from "../db";
import { products, categories } from "../../drizzle/schema";
import { eq, like, desc, lte } from "drizzle-orm";

/**
 * ====================================
 * خدمة المنتجات
 * ====================================
 */

export interface CreateProductInput {
  name: string;
  sku: string;
  description?: string;
  categoryId?: number;
  costPrice: number;
  salePrice: number;
  wholesalePrice?: number;
  quantityOnHand: number;
  minStock: number;
  maxStock: number;
  reorderPoint: number;
}

export interface UpdateProductInput {
  id: number;
  name?: string;
  description?: string;
  salePrice?: number;
  costPrice?: number;
  wholesalePrice?: number;
  minStock?: number;
  maxStock?: number;
  reorderPoint?: number;
}

export class ProductService {
  /**
   * إنشاء منتج جديد
   */
  async createProduct(input: CreateProductInput) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      // التحقق من عدم تكرار SKU
      const existing = await db
        .select()
        .from(products)
        .where(eq(products.sku, input.sku))
        .limit(1);

      if (existing.length) {
        throw new Error(`المنتج برقم ${input.sku} موجود بالفعل`);
      }

      const result = await db.insert(products).values({
        name: input.name,
        sku: input.sku,
        description: input.description || null,
        categoryId: input.categoryId || null,
        costPrice: input.costPrice.toString(),
        salePrice: input.salePrice.toString(),
        wholesalePrice: input.wholesalePrice
          ? input.wholesalePrice.toString()
          : null,
        quantityOnHand: input.quantityOnHand,
        minStock: input.minStock,
        maxStock: input.maxStock,
        reorderPoint: input.reorderPoint,
      });

      return {
        id: Number(result[0].insertId),
        ...input,
      };
    } catch (error) {
      console.error("[ProductService] Error creating product:", error);
      throw error;
    }
  }

  /**
   * تحديث منتج
   */
  async updateProduct(input: UpdateProductInput) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const updateData: Record<string, any> = {};

      if (input.name) updateData.name = input.name;
      if (input.description) updateData.description = input.description;
      if (input.salePrice !== undefined)
        updateData.salePrice = input.salePrice.toString();
      if (input.costPrice !== undefined)
        updateData.costPrice = input.costPrice.toString();
      if (input.wholesalePrice !== undefined)
        updateData.wholesalePrice = input.wholesalePrice.toString();
      if (input.minStock !== undefined) updateData.minStock = input.minStock;
      if (input.maxStock !== undefined) updateData.maxStock = input.maxStock;
      if (input.reorderPoint !== undefined)
        updateData.reorderPoint = input.reorderPoint;

      await db
        .update(products)
        .set(updateData)
        .where(eq(products.id, input.id));

      return { success: true };
    } catch (error) {
      console.error("[ProductService] Error updating product:", error);
      throw error;
    }
  }

  /**
   * الحصول على تفاصيل المنتج
   */
  async getProduct(id: number) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const result = await db
        .select()
        .from(products)
        .where(eq(products.id, id))
        .limit(1);

      if (!result.length) {
        throw new Error("المنتج غير موجود");
      }

      return result[0];
    } catch (error) {
      console.error("[ProductService] Error getting product:", error);
      throw error;
    }
  }

  /**
   * البحث عن المنتجات
   */
  async searchProducts(query: string, limit: number = 50) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const results = await db
        .select()
        .from(products)
        .where(like(products.name, `%${query}%`))
        .limit(limit);

      return results;
    } catch (error) {
      console.error("[ProductService] Error searching products:", error);
      throw error;
    }
  }

  /**
   * قائمة المنتجات
   */
  async listProducts(limit: number = 50, offset: number = 0) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const results = await db
        .select()
        .from(products)
        .orderBy(desc(products.createdAt))
        .limit(limit)
        .offset(offset);

      return results;
    } catch (error) {
      console.error("[ProductService] Error listing products:", error);
      throw error;
    }
  }

  /**
   * المنتجات المنخفضة المخزون
   */
  async getLowStockProducts() {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const results = await db
        .select()
        .from(products)
        .where(lte(products.quantityOnHand, products.reorderPoint));

      return results;
    } catch (error) {
      console.error("[ProductService] Error getting low stock products:", error);
      throw error;
    }
  }

  /**
   * حساب قيمة المخزون
   */
  async getInventoryValue() {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const allProducts = await db.select().from(products);

      const totalValue = allProducts.reduce((sum, product) => {
        const costPrice = parseFloat(product.costPrice);
        return sum + costPrice * product.quantityOnHand;
      }, 0);

      return {
        totalValue,
        totalProducts: allProducts.length,
        totalQuantity: allProducts.reduce(
          (sum, p) => sum + p.quantityOnHand,
          0
        ),
      };
    } catch (error) {
      console.error("[ProductService] Error calculating inventory value:", error);
      throw error;
    }
  }

  /**
   * حذف منتج
   */
  async deleteProduct(id: number) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      await db.delete(products).where(eq(products.id, id));

      return { success: true };
    } catch (error) {
      console.error("[ProductService] Error deleting product:", error);
      throw error;
    }
  }

  /**
   * الحصول على المنتجات حسب الفئة
   */
  async getProductsByCategory(categoryId: number) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const results = await db
        .select()
        .from(products)
        .where(eq(products.categoryId, categoryId));

      return results;
    } catch (error) {
      console.error("[ProductService] Error getting products by category:", error);
      throw error;
    }
  }
}

export const productService = new ProductService();
