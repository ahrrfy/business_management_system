import { getDb } from "../db";
import { customers } from "../../drizzle/schema";
import { eq, like, desc } from "drizzle-orm";

/**
 * ====================================
 * خدمة العملاء
 * ====================================
 */

export interface CreateCustomerInput {
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  country?: string;
  taxId?: string;
  creditLimit?: number;
  customerType?: "INDIVIDUAL" | "BUSINESS";
}

export interface UpdateCustomerInput {
  id: number;
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  country?: string;
  taxId?: string;
  creditLimit?: number;
  customerType?: "INDIVIDUAL" | "BUSINESS";
  isActive?: boolean;
}

export class CustomerService {
  /**
   * إنشاء عميل جديد
   */
  async createCustomer(input: CreateCustomerInput) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const result = await db.insert(customers).values({
        name: input.name,
        email: input.email || null,
        phone: input.phone || null,
        address: input.address || null,
        city: input.city || null,
        country: input.country || null,
        taxId: input.taxId || null,
        creditLimit: input.creditLimit ? input.creditLimit.toString() : "0",
        customerType: input.customerType || "INDIVIDUAL",
      });

      return {
        id: Number(result[0].insertId),
        ...input,
      };
    } catch (error) {
      console.error("[CustomerService] Error creating customer:", error);
      throw error;
    }
  }

  /**
   * تحديث عميل
   */
  async updateCustomer(input: UpdateCustomerInput) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const updateData: Record<string, any> = {};

      if (input.name) updateData.name = input.name;
      if (input.email) updateData.email = input.email;
      if (input.phone) updateData.phone = input.phone;
      if (input.address) updateData.address = input.address;
      if (input.city) updateData.city = input.city;
      if (input.country) updateData.country = input.country;
      if (input.taxId) updateData.taxId = input.taxId;
      if (input.creditLimit !== undefined)
        updateData.creditLimit = input.creditLimit.toString();
      if (input.customerType) updateData.customerType = input.customerType;
      if (input.isActive !== undefined) updateData.isActive = input.isActive;

      await db
        .update(customers)
        .set(updateData)
        .where(eq(customers.id, input.id));

      return { success: true };
    } catch (error) {
      console.error("[CustomerService] Error updating customer:", error);
      throw error;
    }
  }

  /**
   * الحصول على تفاصيل العميل
   */
  async getCustomer(id: number) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const result = await db
        .select()
        .from(customers)
        .where(eq(customers.id, id))
        .limit(1);

      if (!result.length) {
        throw new Error("العميل غير موجود");
      }

      return result[0];
    } catch (error) {
      console.error("[CustomerService] Error getting customer:", error);
      throw error;
    }
  }

  /**
   * البحث عن العملاء
   */
  async searchCustomers(query: string, limit: number = 50) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const results = await db
        .select()
        .from(customers)
        .where(like(customers.name, `%${query}%`))
        .limit(limit);

      return results;
    } catch (error) {
      console.error("[CustomerService] Error searching customers:", error);
      throw error;
    }
  }

  /**
   * قائمة العملاء
   */
  async listCustomers(limit: number = 50, offset: number = 0) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const results = await db
        .select()
        .from(customers)
        .orderBy(desc(customers.createdAt))
        .limit(limit)
        .offset(offset);

      return results;
    } catch (error) {
      console.error("[CustomerService] Error listing customers:", error);
      throw error;
    }
  }

  /**
   * حذف عميل
   */
  async deleteCustomer(id: number) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      await db.delete(customers).where(eq(customers.id, id));

      return { success: true };
    } catch (error) {
      console.error("[CustomerService] Error deleting customer:", error);
      throw error;
    }
  }

  /**
   * تحديث الرصيد الحالي للعميل
   */
  async updateCustomerBalance(customerId: number, amount: number) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const customer = await this.getCustomer(customerId);
      const currentBalance = customer.currentBalance ? parseFloat(customer.currentBalance) : 0;
      const newBalance = currentBalance + amount;

      await db
        .update(customers)
        .set({ currentBalance: newBalance.toString() })
        .where(eq(customers.id, customerId));

      return { success: true, newBalance };
    } catch (error) {
      console.error("[CustomerService] Error updating customer balance:", error);
      throw error;
    }
  }
}

export const customerService = new CustomerService();
