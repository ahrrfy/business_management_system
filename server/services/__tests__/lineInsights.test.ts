/**
 * رؤى أسعار سطور البيع (`getSaleLineInsights`) على قاعدة حقيقيّة.
 * يحرس الحقائق التي تُبنى عليها التنبيهات: استبعاد الملغاة/المستبدَلة/الهدايا/الأصفار، عزل العملاء،
 * سقف المراجع لكل وحدة، فصل الوحدات، وإبقاء المُرتجَع مرجعاً صالحاً (سعرٌ دفعه العميل فعلاً).
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { MAX_SALE_REFS_PER_LINE, getSaleLineInsights } from "../pricing/lineInsights";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = [
  "invoiceItems", "invoices", "productUnits", "productVariants", "products", "customers", "users", "branches",
];

let invSeq = 0;
async function addSale(opts: {
  customerId: number | null;
  unitId: number;
  price: string;
  at: string;
  status?: (typeof s.invoices.$inferInsert)["status"];
  isGift?: boolean;
  discountPercent?: string;
  discountAmount?: string;
  variantId?: number;
  branchId?: number;
  createdBy?: number;
}): Promise<number> {
  invSeq += 1;
  const id = invSeq;
  await db().insert(s.invoices).values({
    id, invoiceNumber: `INV-T-${id}`, sourceType: "POS", branchId: opts.branchId ?? 1, createdBy: opts.createdBy ?? null, customerId: opts.customerId,
    invoiceDate: new Date(opts.at), subtotal: opts.price, total: opts.price, costTotal: "0.00",
    status: opts.status ?? "PAID",
  });
  await db().insert(s.invoiceItems).values({
    invoiceId: id, variantId: opts.variantId ?? 1, productUnitId: opts.unitId, quantity: "1", baseQuantity: 1,
    unitPrice: opts.price, unitCost: "50.00", total: opts.price, isGift: opts.isGift ?? false,
    discountPercent: opts.discountPercent ?? "0", discountAmount: opts.discountAmount ?? "0",
  });
  return id;
}

beforeEach(async () => {
  invSeq = 0;
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await db().insert(s.branches).values([
    { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
    { id: 2, name: "SECOND", code: "SECOND", type: "MAIN" },
  ]);
  await db().insert(s.users).values([
    { id: 1, openId: "line-insights", name: "مدير", role: "manager", loginMethod: "local" },
    { id: 2, openId: "line-insights-2", name: "كاشير", role: "cashier", loginMethod: "local" },
  ]);
  await db().insert(s.customers).values([
    { id: 1, name: "عميل أ" },
    { id: 2, name: "عميل ب" },
  ]);
  await db().insert(s.products).values({ id: 1, name: "قلم" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN", costPrice: "50.00" });
  await db().insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12" },
  ]);
});

describe.sequential("getSaleLineInsights", () => {
  it("يعيد آخر المبيعات الفعليّة للعميل الأحدث أولاً بأسعارها وأرقام فواتيرها وخصمها", async () => {
    await addSale({ customerId: 1, unitId: 1, price: "100.00", at: "2026-08-01T10:00:00Z" });
    await addSale({ customerId: 1, unitId: 1, price: "120.00", at: "2026-09-01T10:00:00Z", discountPercent: "5" });
    const out = await getSaleLineInsights(db(), { customerId: 1, items: [{ variantId: 1, productUnitId: 1 }] });
    const refs = out["1:1"]!.lastSales;
    expect(refs.map((r) => r.price)).toEqual(["120.00", "100.00"]);
    expect(refs[0]).toMatchObject({ invoiceNumber: "INV-T-2", discountPercent: "5.00" });
    expect(new Date(refs[0]!.at).toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });

  it("عزل العملاء: لا يُرى سعر عميلٍ آخر ولا فواتير بلا عميل", async () => {
    await addSale({ customerId: 2, unitId: 1, price: "999.00", at: "2026-09-01T10:00:00Z" });
    await addSale({ customerId: null, unitId: 1, price: "888.00", at: "2026-09-02T10:00:00Z" });
    const out = await getSaleLineInsights(db(), { customerId: 1, items: [{ variantId: 1, productUnitId: 1 }] });
    expect(out).toEqual({});
  });

  it("يستبعد الملغاة والمستبدَلة والهدايا وأسعار الصفر، ويُبقي المُرتجَع", async () => {
    await addSale({ customerId: 1, unitId: 1, price: "10.00", at: "2026-09-01T10:00:00Z", status: "CANCELLED" });
    await addSale({ customerId: 1, unitId: 1, price: "20.00", at: "2026-09-02T10:00:00Z", status: "SUPERSEDED" });
    await addSale({ customerId: 1, unitId: 1, price: "30.00", at: "2026-09-03T10:00:00Z", isGift: true });
    await addSale({ customerId: 1, unitId: 1, price: "0.00", at: "2026-09-04T10:00:00Z" });
    await addSale({ customerId: 1, unitId: 1, price: "77.00", at: "2026-08-01T10:00:00Z", status: "RETURNED" });
    const out = await getSaleLineInsights(db(), { customerId: 1, items: [{ variantId: 1, productUnitId: 1 }] });
    expect(out["1:1"]!.lastSales.map((r) => r.price)).toEqual(["77.00"]);
  });

  it("excludeInvoiceId: الفاتورة قيد التصحيح لا تُعدّ «آخر بيع» لنفسها، وغيرها يبقى", async () => {
    const older = await addSale({ customerId: 1, unitId: 1, price: "100.00", at: "2026-08-01T10:00:00Z" });
    const editing = await addSale({ customerId: 1, unitId: 1, price: "150.00", at: "2026-09-01T10:00:00Z" });
    const base = { customerId: 1, items: [{ variantId: 1, productUnitId: 1 }] };
    expect((await getSaleLineInsights(db(), base))["1:1"]!.lastSales[0]!.price).toBe("150.00");
    const out = await getSaleLineInsights(db(), { ...base, excludeInvoiceId: editing });
    expect(out["1:1"]!.lastSales.map((r) => r.invoiceId)).toEqual([older]);
    expect(await getSaleLineInsights(db(), { ...base, excludeInvoiceId: older }).then((o) => o["1:1"]!.lastSales.length)).toBe(1);
  });

  it("خصم بمبلغٍ (discountPercent=0) يُشتقّ نسبةً فعليّة من إجمالي السطر ولا يظهر «بلا خصم»", async () => {
    await addSale({ customerId: 1, unitId: 1, price: "100.00", at: "2026-09-01T10:00:00Z", discountAmount: "20.00" });
    const out = await getSaleLineInsights(db(), { customerId: 1, items: [{ variantId: 1, productUnitId: 1 }] });
    expect(out["1:1"]!.lastSales[0]!.discountPercent).toBe("20");
  });

  it("scope: المحصور بفرعٍ/بموظّفٍ لا يرى سعر فرعٍ/موظّفٍ آخر، وغير المحصور يرى الكل", async () => {
    await addSale({ customerId: 1, unitId: 1, price: "100.00", at: "2026-08-01T10:00:00Z", branchId: 1, createdBy: 1 });
    await addSale({ customerId: 1, unitId: 1, price: "130.00", at: "2026-09-01T10:00:00Z", branchId: 2, createdBy: 2 });
    const base = { customerId: 1, items: [{ variantId: 1, productUnitId: 1 }] };
    const prices = async (scope?: { branchId?: number | null; ownerId?: number | null }) =>
      (await getSaleLineInsights(db(), { ...base, scope }))["1:1"]?.lastSales.map((r) => r.price);
    expect(await prices()).toEqual(["130.00", "100.00"]);
    expect(await prices({ branchId: null, ownerId: null })).toEqual(["130.00", "100.00"]);
    expect(await prices({ branchId: 1 })).toEqual(["100.00"]);
    expect(await prices({ branchId: 2 })).toEqual(["130.00"]);
    expect(await prices({ ownerId: 2 })).toEqual(["130.00"]);
    expect(await prices({ branchId: 1, ownerId: 2 })).toBeUndefined();
  });

  it("سقف المراجع لكل وحدة، والوحدات لا تُجوِّع بعضها ولا تختلط", async () => {
    for (let i = 1; i <= 6; i++) {
      await addSale({ customerId: 1, unitId: 1, price: `${100 + i}.00`, at: `2026-09-0${i}T10:00:00Z` });
    }
    await addSale({ customerId: 1, unitId: 2, price: "1200.00", at: "2026-01-01T10:00:00Z" });
    const out = await getSaleLineInsights(db(), {
      customerId: 1,
      items: [{ variantId: 1, productUnitId: 1 }, { variantId: 1, productUnitId: 2 }],
    });
    expect(out["1:1"]!.lastSales).toHaveLength(MAX_SALE_REFS_PER_LINE);
    expect(out["1:1"]!.lastSales.map((r) => r.price)).toEqual(["106.00", "105.00", "104.00"]);
    // الوحدة الأقدم/الأقلّ تكراراً ما زالت حاضرة (لا تجويع بـ LIMIT واحد).
    expect(out["1:2"]!.lastSales.map((r) => r.price)).toEqual(["1200.00"]);
  });

  it("الصنف الذي لم يُباع للعميل غائبٌ من النتيجة، والمدخل المكرَّر لا يكرّر المراجع", async () => {
    await addSale({ customerId: 1, unitId: 1, price: "100.00", at: "2026-09-01T10:00:00Z" });
    const out = await getSaleLineInsights(db(), {
      customerId: 1,
      items: [{ variantId: 1, productUnitId: 1 }, { variantId: 1, productUnitId: 1 }, { variantId: 1, productUnitId: 2 }],
    });
    expect(Object.keys(out)).toEqual(["1:1"]);
    expect(out["1:1"]!.lastSales).toHaveLength(1);
  });

  it("قائمة أصنافٍ فارغة ⇒ {} بلا استعلام", async () => {
    expect(await getSaleLineInsights(db(), { customerId: 1, items: [] })).toEqual({});
  });
});
