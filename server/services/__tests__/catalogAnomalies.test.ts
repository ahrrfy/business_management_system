/**
 * catalogAnomalies.test.ts — اختبارات تكامل لطبقات priceSanity الثلاث:
 *  - L1 (input-time zod): يرفض حفظ متغيّرٍ بتكلفة ≥ ٥× السعر بلا سبب.
 *  - L2 (detection): detectAll يمسك حادثة SINARLINE على قاعدة معدَّة.
 *  - L3 (audit trail): Trigger يكتب سجلاً بتصنيف حدّة صحيح عند تغيير التكلفة.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { detectAll, detectL1, detectL4, detectL6 } from "../catalogAnomalies/detectors";

const TABLES = ["priceAnomalyLog", "catalogAnomalyOverrides", "branchStock", "productPrices", "productUnits", "productImages", "productVariants", "products", "branches", "users"];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) {
    try {
      await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
    } catch {
      // بعض الجداول قد لا توجد في بعض الوقت — تُنشئها هجراتنا لاحقاً بأمان.
    }
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", branchType: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_admin", name: "المدير", role: "admin", loginMethod: "local" });
}

async function seedSinarline() {
  const d = db();
  // SINARLINE-class: cost 16162 vs retail 2000 → ratio 8.08 → L1 blocker
  await d.insert(s.products).values({ id: 100, name: "SINARLINE test", productType: "ورق لاصق" });
  await d.insert(s.productVariants).values({ id: 100, productId: 100, sku: "PR-SINR-TEST", costPrice: "16162" });
  await d.insert(s.productUnits).values({ id: 100, variantId: 100, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 100, priceTier: "RETAIL", price: "2000" });
}

describe("catalogAnomalies detectors — كشف رجعيّ", () => {
  beforeEach(async () => {
    await reset();
    await seedBase();
  });

  it("L1: يمسك حالة SINARLINE (cost >= 5× base retail) كـblocker", async () => {
    await seedSinarline();
    const findings = await detectL1(db());
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const sinarline = findings.find((f) => f.variantId === 100);
    expect(sinarline).toBeDefined();
    expect(sinarline?.severity).toBe("blocker");
    expect(sinarline?.metrics.ratio as number).toBeGreaterThanOrEqual(5);
  });

  it("L4: يمسك تكلفة صفر مع مبيعات مسجّلة", async () => {
    const d = db();
    // منتج بتكلفة صفر + مخزون فعلي
    await d.insert(s.products).values({ id: 200, name: "ZeroCost test" });
    await d.insert(s.productVariants).values({ id: 200, productId: 200, sku: "PR-ZERO-TEST", costPrice: "0" });
    await d.insert(s.productUnits).values({ id: 200, variantId: 200, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
    await d.insert(s.productPrices).values({ productUnitId: 200, priceTier: "RETAIL", price: "500" });
    await d.insert(s.branchStock).values({ variantId: 200, branchId: 1, quantity: 50 });
    const findings = await detectL4(d);
    const zeroFinding = findings.find((f) => f.variantId === 200);
    expect(zeroFinding).toBeDefined();
    expect(zeroFinding?.severity).toBe("warning");
    expect(Number(zeroFinding?.metrics.totalStock)).toBe(50);
  });

  it("L6: يمسك تكلفة كارتون تفوق سعر بيعه (SINARLINE 60-class)", async () => {
    const d = db();
    // baseCost 347 × factor 12 (كرتون) = 4164 > سعر كرتون 700 → ratio 5.95
    await d.insert(s.products).values({ id: 300, name: "SINARLINE60 test" });
    await d.insert(s.productVariants).values({ id: 300, productId: 300, sku: "PR-SINR60-TEST", costPrice: "347" });
    await d.insert(s.productUnits).values([
      { id: 300, variantId: 300, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
      { id: 301, variantId: 300, unitName: "كرتون", conversionFactor: "12", isBaseUnit: false },
    ]);
    await d.insert(s.productPrices).values([
      { productUnitId: 300, priceTier: "RETAIL", price: "500" },
      { productUnitId: 301, priceTier: "RETAIL", price: "700" },
    ]);
    const findings = await detectL6(d);
    const cartonFinding = findings.find((f) => f.variantId === 300);
    expect(cartonFinding).toBeDefined();
    expect(cartonFinding?.severity).toBe("blocker"); // ratio 5.95× ≥ 2
    expect(Number(cartonFinding?.metrics.ratio)).toBeGreaterThan(5);
  });

  it("detectAll يجمع نتائج العدسات الست", async () => {
    await seedSinarline();
    const all = await detectAll(db());
    expect(all.length).toBeGreaterThan(0);
    const codes = new Set(all.map((f) => f.code));
    expect(codes.has("L1")).toBe(true);
  });
});

describe("priceAnomalyLog — Trigger BEFORE UPDATE", () => {
  beforeEach(async () => {
    await reset();
    await seedBase();
  });

  it("يلتقط تغيير التكلفة ٥→٤٠ كـblocker (نسبة ٨×)", async () => {
    const d = db();
    await d.insert(s.products).values({ id: 400, name: "trigger test" });
    await d.insert(s.productVariants).values({ id: 400, productId: 400, sku: "PR-TRG-TEST", costPrice: "5" });
    // نغيّر التكلفة إلى 40 (8×)
    await d.execute(sql`UPDATE productVariants SET costPrice = 40 WHERE id = 400`);
    const rows = await d.execute(sql`SELECT changeKind, oldValue, newValue, severity FROM priceAnomalyLog WHERE variantId = 400`);
    const logs = (rows as unknown as [Array<{ changeKind: string; oldValue: string; newValue: string; severity: string }>, unknown])[0];
    expect(logs.length).toBe(1);
    expect(logs[0].severity).toBe("blocker");
    expect(Number(logs[0].oldValue)).toBe(5);
    expect(Number(logs[0].newValue)).toBe(40);
  });

  it("يلتقط تغيير التكلفة كارثياً (١٥×) كـcatastrophic", async () => {
    const d = db();
    await d.insert(s.products).values({ id: 401, name: "trigger cat" });
    await d.insert(s.productVariants).values({ id: 401, productId: 401, sku: "PR-CAT-TEST", costPrice: "100" });
    await d.execute(sql`UPDATE productVariants SET costPrice = 1500 WHERE id = 401`);
    const rows = await d.execute(sql`SELECT severity FROM priceAnomalyLog WHERE variantId = 401`);
    const logs = (rows as unknown as [Array<{ severity: string }>, unknown])[0];
    expect(logs[0].severity).toBe("catastrophic");
  });

  it("لا يلتقط تغييراً طفيفاً (١.٥×) بل يصنّفه info", async () => {
    const d = db();
    await d.insert(s.products).values({ id: 402, name: "trigger minor" });
    await d.insert(s.productVariants).values({ id: 402, productId: 402, sku: "PR-MIN-TEST", costPrice: "100" });
    await d.execute(sql`UPDATE productVariants SET costPrice = 150 WHERE id = 402`);
    const rows = await d.execute(sql`SELECT severity FROM priceAnomalyLog WHERE variantId = 402`);
    const logs = (rows as unknown as [Array<{ severity: string }>, unknown])[0];
    expect(logs[0].severity).toBe("info");
  });
});

describe("CHECK constraint — chk_variant_cost_range", () => {
  beforeEach(async () => {
    await reset();
    await seedBase();
  });

  it("يرفض تكلفة > 100M د.ع", async () => {
    const d = db();
    await d.insert(s.products).values({ id: 500, name: "chk test" });
    await expect(async () => {
      await d.insert(s.productVariants).values({ id: 500, productId: 500, sku: "PR-CHK-TEST", costPrice: "1000000000" }); // ١ مليار
    }).rejects.toThrow();
  });

  it("يقبل تكلفة معقولة (10M)", async () => {
    const d = db();
    await d.insert(s.products).values({ id: 501, name: "chk ok" });
    await d.insert(s.productVariants).values({ id: 501, productId: 501, sku: "PR-CHK-OK", costPrice: "10000000" });
    const [row] = await d.select().from(s.productVariants).where(eq(s.productVariants.id, 501));
    expect(row.costPrice).toBe("10000000.00");
  });
});
