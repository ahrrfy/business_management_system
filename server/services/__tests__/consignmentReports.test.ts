import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createProduct } from "../catalogService";
import { createSupplier } from "../supplierService";
import { createConsignmentNote, consignmentBalancesReport } from "../consignment/noteService";
import { getInventoryValuation } from "../reportsInventoryService";

/** بضاعة الأمانة — ش٤: الأمانة خارج تقييم أصول المكتبة (تُعرَض سطراً منفصلاً) + تقرير الأرصدة. §١١. */
const actor = { userId: 1, branchId: 1 };
const TABLES = [
  "inventoryMovements", "consignmentNoteLines", "consignmentNotes",
  "branchStock", "productPrices", "productUnits", "productVariants", "productImages", "products",
  "suppliers", "categories", "users", "branches",
];
function db() { const d = getDb(); if (!d) throw new Error("no DB"); return d; }
async function seedBase() {
  await db().insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }, { id: 2, name: "SALES", code: "SALES", type: "SALES" }]);
  await db().insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
}
beforeEach(async () => { await truncateTables(TABLES); await seedBase(); });

describe("بضاعة الأمانة ش٤ — استثناء التقييم", () => {
  it("صنف أمانة مودَع لا يدخل مجموع تقييم الأصول، ويظهر في السطر المنفصل + تقرير الأرصدة", async () => {
    // منتج مملوك برصيد افتتاحي (أصل مكتبة).
    await createProduct({ name: "قلم", variants: [{ sku: "OWN-1", costPrice: "100", openingStock: 10,
      units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL" as const, price: "200" }] }] }] }, actor);
    // مودِع + صنف أمانة + إيداع 20 (حصة 4000).
    const cid = (await createSupplier({ name: "أ. حيدر", supplierKind: "CONSIGNOR" }, actor)).supplierId;
    await createProduct({ name: "ملزمة", isConsignment: true, consignorId: cid,
      variants: [{ sku: "MLZ-1", costPrice: "4000", units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL" as const, price: "5000" }] }] }] }, actor);
    const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, "MLZ-1")))[0];
    const u = (await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(v.id))))[0];
    await createConsignmentNote({ noteType: "DEPOSIT", consignorId: cid, branchId: 1,
      lines: [{ lineDirection: "IN", variantId: Number(v.id), productUnitId: Number(u.id), quantity: "20" }] }, actor);

    const val = await getInventoryValuation({});
    // مجموع الأصول = المملوك فقط (10 × 100 = 1000) — لا يتضمّن الأمانة (20 × 4000 = 80000).
    expect(val.totals.totalValue).toBe("1000.00");
    // الأمانة سطر منفصل.
    expect(val.consignment.totalValue).toBe("80000.00");
    expect(val.consignment.totalQty).toBe(20);

    // تقرير الأرصدة: المودِع له 20 قطعة بقيمة 80000 بالحصة.
    const bal = await consignmentBalancesReport();
    const row = bal.find((r) => r.consignorId === cid)!;
    expect(row.remainingQty).toBe(20);
    expect(row.remainingValueByShare).toBe("80000.00");
  });
});
