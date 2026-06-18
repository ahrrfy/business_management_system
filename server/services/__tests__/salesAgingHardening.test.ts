/**
 * تكملة شريحة dueDate + تحصين موافقة المدير:
 *  (أ) getARAging يُعمِّر الذمم من تاريخ الاستحقاق (dueDate) لا تاريخ الفاتورة.
 *  (ب) verifyManagerApproval يطبّق حدّ معدّل ضدّ تخمين كلمة مرور المدير.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { getARAging } from "../reportsService";
import { verifyManagerApproval } from "../../routers/saleRouter";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1, role: "admin" };

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
  "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await truncateTables(TABLES);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "0.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
  await d.insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("getARAging — تُعمَّر الذمم من تاريخ الاستحقاق لا الفاتورة", () => {
  it("بيع آجل بتاريخ استحقاق ماضٍ (>٩٠ يوم) ⇒ يقع في دلو ٩٠+ لا ٠-٣٠", async () => {
    // بيع آجل (بلا دفع) ⇒ ذمة كاملة، الفاتورة تاريخها اليوم لكن الاستحقاق في الماضي البعيد.
    await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        dueDate: "2026-01-01",
      },
      actor,
    );
    const aging = await getARAging({ branchId: 1 });
    const row = aging.find((r) => Number(r.customerId) === 1);
    expect(row).toBeTruthy();
    expect(Number(row!.unpaidTotal)).toBe(10);
    // العبرة: التعمير بالاستحقاق (ماضٍ) يضعه في 90+، ولو عُمِّر بتاريخ الفاتورة (اليوم) لوقع في 0-30.
    expect(Number(row!.d91p)).toBe(10);
    expect(Number(row!.d0_30)).toBe(0);
  });

  it("بيع آجل بلا تاريخ استحقاق ⇒ يُعمَّر من تاريخ الفاتورة (اليوم) في دلو ٠-٣٠ (متوافق)", async () => {
    await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }] },
      actor,
    );
    const aging = await getARAging({ branchId: 1 });
    const row = aging.find((r) => Number(r.customerId) === 1);
    expect(row).toBeTruthy();
    expect(Number(row!.d0_30)).toBe(10);
    expect(Number(row!.d91p)).toBe(0);
  });
});

describe("verifyManagerApproval — حدّ معدّل ضدّ تخمين كلمة المرور", () => {
  it("بعد ٥ محاولات فاشلة خلال النافذة ⇒ السادسة تُرفَض بـTOO_MANY_REQUESTS", async () => {
    const ctx = { user: { id: 1, branchId: 1 } };
    const email = "ghost-ratelimit@x.local"; // غير موجود ⇒ يُرفَض FORBIDDEN لكن يُحتسب ضمن النافذة
    for (let i = 0; i < 5; i++) {
      await expect(
        verifyManagerApproval({ email, password: "wrong" }, ctx),
      ).rejects.toThrow();
    }
    let err: any;
    try {
      await verifyManagerApproval({ email, password: "wrong" }, ctx);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("TOO_MANY_REQUESTS");
  }, 15000);
});
