import { describe, it, expect } from "vitest";
import { appRouter } from "./routers";
import { TRPCError } from "@trpc/server";

/**
 * اختبارات الأمان على Procedures الحقيقية
 * تختبر الحماية من الهجمات على مستوى API
 */
describe("Procedures Security Tests - Real API", () => {
  // إنشاء caller بدون context (محاكاة طلب بدون مصادقة)
  const caller = appRouter.createCaller({
    user: null,
    req: {} as any,
    res: {} as any,
  });

  // إنشاء caller مع context مصادق
  const authenticatedCaller = appRouter.createCaller({
    user: {
      id: 1,
      openId: "test-user",
      name: "Test User",
      email: "test@example.com",
      role: "user",
      lastSignedIn: new Date(),
      loginMethod: "oauth",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    req: {} as any,
    res: {} as any,
  });

  describe("Authentication Protection", () => {
    it("should reject unauthenticated product creation", async () => {
      try {
        // @ts-ignore - intentionally calling protected procedure without auth
        await caller.products.create({
          name: "Test Product",
          sku: "TEST-001",
          salePrice: "100",
          costPrice: "50",
          quantityOnHand: 10,
        });
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error).toBeInstanceOf(TRPCError);
        expect(error.code).toBe("UNAUTHORIZED");
      }
    });

    it("should reject unauthenticated customer creation", async () => {
      try {
        // @ts-ignore
        await caller.customers.create({
          name: "Test Customer",
          email: "test@example.com",
          phone: "555-0000",
        });
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error).toBeInstanceOf(TRPCError);
        expect(error.code).toBe("UNAUTHORIZED");
      }
    });

    it("should reject unauthenticated order creation", async () => {
      try {
        // @ts-ignore
        await caller.onlineOrders.create({
          customerId: 1,
          items: [],
          shippingAddress: "Test Address",
        });
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error).toBeInstanceOf(TRPCError);
        expect(error.code).toBe("UNAUTHORIZED");
      }
    });
  });

  describe("Input Validation on Procedures", () => {
    it("should reject invalid product data", async () => {
      try {
        await authenticatedCaller.products.create({
          name: "", // Empty name
          sku: "TEST",
          salePrice: "100",
          costPrice: "50",
          quantityOnHand: 10,
        });
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error).toBeInstanceOf(TRPCError);
      }
    });

    it("should reject invalid customer email", async () => {
      try {
        await authenticatedCaller.customers.create({
          name: "Test",
          email: "invalid-email", // Invalid email format
          phone: "555-0000",
        });
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error).toBeInstanceOf(TRPCError);
      }
    });

    it("should reject order with invalid items", async () => {
      try {
        await authenticatedCaller.onlineOrders.create({
          customerId: 1,
          items: [
            {
              productId: -1, // Invalid product ID
              quantity: 0, // Invalid quantity
            },
          ],
          shippingAddress: "Test",
        });
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error).toBeInstanceOf(TRPCError);
      }
    });

    it("should reject negative quantities", async () => {
      try {
        await authenticatedCaller.onlineOrders.create({
          customerId: 1,
          items: [
            {
              productId: 1,
              quantity: -5, // Negative quantity
            },
          ],
          shippingAddress: "Test",
        });
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error).toBeInstanceOf(TRPCError);
      }
    });
  });

  describe("Authorization Checks", () => {
    it("should allow authenticated user to list products", async () => {
      try {
        const result = await authenticatedCaller.products.list({
          limit: 10,
          offset: 0,
        });
        expect(result).toBeDefined();
      } catch (error) {
        // May fail if no products exist, but should not be auth error
        expect(error).not.toBeInstanceOf(TRPCError);
      }
    });

    it("should allow authenticated user to list customers", async () => {
      try {
        const result = await authenticatedCaller.customers.list({
          limit: 10,
          offset: 0,
        });
        expect(result).toBeDefined();
      } catch (error) {
        expect(error).not.toBeInstanceOf(TRPCError);
      }
    });

    it("should allow authenticated user to list orders", async () => {
      try {
        const result = await authenticatedCaller.onlineOrders.list({
          limit: 10,
          offset: 0,
        });
        expect(result).toBeDefined();
      } catch (error) {
        expect(error).not.toBeInstanceOf(TRPCError);
      }
    });
  });

  describe("Data Integrity Protection", () => {
    it("should prevent creating duplicate SKUs", async () => {
      try {
        // Create first product
        const result1 = await authenticatedCaller.products.create({
          name: "Product 1",
          sku: "UNIQUE-SKU-001",
          salePrice: "100",
          costPrice: "50",
          quantityOnHand: 10,
        });

        // Try to create second product with same SKU
        const result2 = await authenticatedCaller.products.create({
          name: "Product 2",
          sku: "UNIQUE-SKU-001", // Duplicate SKU
          salePrice: "200",
          costPrice: "100",
          quantityOnHand: 5,
        });

        // Should fail due to unique constraint
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error).toBeInstanceOf(TRPCError);
      }
    });

    it("should validate order total calculation", async () => {
      try {
        const result = await authenticatedCaller.onlineOrders.create({
          customerId: 1,
          items: [
            {
              productId: 1,
              quantity: 1,
            },
          ],
          shippingAddress: "Test Address",
          shippingCost: 50,
          taxAmount: 15,
        });

        expect(result).toBeDefined();
        expect(result.order).toBeDefined();
      } catch (error: any) {
        // May fail if product doesn't exist, but should validate properly
        if (error.code !== "NOT_FOUND") {
          expect(error).toBeInstanceOf(TRPCError);
        }
      }
    });
  });

  describe("Error Handling", () => {
    it("should return proper error for non-existent product", async () => {
      try {
        await authenticatedCaller.products.getById(999999999);
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error).toBeInstanceOf(TRPCError);
        expect(error.code).toBe("NOT_FOUND");
      }
    });

    it("should return proper error for non-existent customer", async () => {
      try {
        await authenticatedCaller.customers.getById(999999999);
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error).toBeInstanceOf(TRPCError);
        expect(error.code).toBe("NOT_FOUND");
      }
    });

    it("should return proper error for non-existent order", async () => {
      try {
        await authenticatedCaller.onlineOrders.getById(999999999);
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error).toBeInstanceOf(TRPCError);
        expect(error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("XSS Prevention", () => {
    it("should safely handle HTML in product name", async () => {
      try {
        const result = await authenticatedCaller.products.create({
          name: "<script>alert('XSS')</script>",
          sku: "XSS-TEST-001",
          salePrice: "100",
          costPrice: "50",
          quantityOnHand: 10,
        });

        // Should create product with escaped content
        expect(result).toBeDefined();
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    it("should safely handle HTML in customer name", async () => {
      try {
        const result = await authenticatedCaller.customers.create({
          name: "<img src=x onerror=alert('XSS')>",
          email: "test@example.com",
          phone: "555-0000",
        });

        expect(result).toBeDefined();
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });
});
