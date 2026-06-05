import { describe, it, expect } from "vitest";
import { getDb } from "./db";
import { products, customers, onlineOrders } from "../drizzle/schema";
import { eq } from "drizzle-orm";

/**
 * اختبارات الضغط (Load Tests)
 * تقيس أداء النظام تحت حمل عالي
 */
describe("Load Tests - API Performance", () => {
  it("should handle 100 concurrent product queries", async () => {
    const db = await getDb();
    if (!db) {
      console.warn("Database not available");
      return;
    }

    const startTime = performance.now();
    const promises = Array(100)
      .fill(null)
      .map(() => db.select().from(products).limit(10));

    const results = await Promise.all(promises);
    const endTime = performance.now();

    expect(results).toHaveLength(100);
    expect(endTime - startTime).toBeLessThan(5000); // Should complete in less than 5 seconds
  });

  it("should handle 50 concurrent customer queries", async () => {
    const db = await getDb();
    if (!db) {
      console.warn("Database not available");
      return;
    }

    const startTime = performance.now();
    const promises = Array(50)
      .fill(null)
      .map(() => db.select().from(customers).limit(20));

    const results = await Promise.all(promises);
    const endTime = performance.now();

    expect(results).toHaveLength(50);
    expect(endTime - startTime).toBeLessThan(3000); // Should complete in less than 3 seconds
  });

  it("should handle 30 concurrent order queries", async () => {
    const db = await getDb();
    if (!db) {
      console.warn("Database not available");
      return;
    }

    const startTime = performance.now();
    const promises = Array(30)
      .fill(null)
      .map(() => db.select().from(onlineOrders).limit(50));

    const results = await Promise.all(promises);
    const endTime = performance.now();

    expect(results).toHaveLength(30);
    expect(endTime - startTime).toBeLessThan(2000); // Should complete in less than 2 seconds
  });

  it("should handle rapid sequential inserts", async () => {
    const db = await getDb();
    if (!db) {
      console.warn("Database not available");
      return;
    }

    const startTime = performance.now();
    let successCount = 0;

    for (let i = 0; i < 20; i++) {
      try {
        await db.insert(customers).values({
          name: `Test Customer ${Date.now()}-${i}`,
          email: `test-${Date.now()}-${i}@example.com`,
          phone: `555-000${i}`,
        });
        successCount++;
      } catch (error) {
        console.error("Insert failed:", error);
      }
    }

    const endTime = performance.now();

    expect(successCount).toBeGreaterThan(0);
    expect(endTime - startTime).toBeLessThan(5000);
  });

  it("should handle complex queries with joins", async () => {
    const db = await getDb();
    if (!db) {
      console.warn("Database not available");
      return;
    }

    const startTime = performance.now();
    const promises = Array(20)
      .fill(null)
      .map(() =>
        db
          .select()
          .from(onlineOrders)
          .limit(100)
      );

    const results = await Promise.all(promises);
    const endTime = performance.now();

    expect(results).toHaveLength(20);
    expect(endTime - startTime).toBeLessThan(3000);
  });

  it("should maintain response time under heavy load", async () => {
    const db = await getDb();
    if (!db) {
      console.warn("Database not available");
      return;
    }

    const queryTimes: number[] = [];

    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      await db.select().from(products).limit(5);
      const end = performance.now();
      queryTimes.push(end - start);
    }

    const avgTime = queryTimes.reduce((a, b) => a + b, 0) / queryTimes.length;
    const maxTime = Math.max(...queryTimes);

    expect(avgTime).toBeLessThan(100); // Average response time should be less than 100ms
    expect(maxTime).toBeLessThan(500); // Max response time should be less than 500ms
  });
});
