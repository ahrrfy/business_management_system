// وحدة الهدايا — G-م١ الوارد: بضاعة مجّانية من مورّد ترفع المخزون بصفر تكلفة (تخفيف WAVG)،
// بلا قيد PURCHASE ولا دين للمورّد. الثوابت الحرجة: تخفيف المتوسّط + صفر أثر ماليّ + تحويل الوحدة + الحرّاس.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { receiveInboundGift } from "../gifts/inbound";
import { listGifts } from "../gifts/list";
import { approveGift, createOutboundGift } from "../gifts/outbound";

const actor = { userId: 1, branchId: 1, role: "admin" };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "giftVoucherLines", "giftVouchers", "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
    "branchStock", "productPrices", "productUnits", "productVariants", "products", "suppliers", "customers", "branches", "users",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "t1", name: "admin", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "t2", name: "mgrA", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "t3", name: "mgrB", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "t4", name: "acc", role: "accountant", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
  await d.insert(s.customers).values({ id: 1, name: "عميل تجريبي", currentBalance: "0" });
  // منتج عاديّ (id 1، تكلفة قائمة 100) + بكج (id 2) + خدميّ (id 3).
  await d.insert(s.products).values([
    { id: 1, name: "ورق" },
    { id: 2, name: "بكج مدرسيّ", isBundle: true },
    { id: 3, name: "خدمة تصميم", isService: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "P-1", costPrice: "100.00" },
    { id: 2, productId: 2, sku: "B-1", costPrice: "0.00" },
    { id: 3, productId: 3, sku: "S-1", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", isBaseUnit: false },
    { id: 3, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 4, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

const countRows = async (table: any): Promise<number> => {
  const r = await db().select({ n: sql<number>`COUNT(*)` }).from(table);
  return Number(r[0]?.n ?? 0);
};
const stockOf = async (variantId: number, branchId = 1): Promise<number> => {
  const r = await db().select({ q: s.branchStock.quantity }).from(s.branchStock)
    .where(sql`${s.branchStock.variantId} = ${variantId} AND ${s.branchStock.branchId} = ${branchId}`);
  return Number(r[0]?.q ?? 0);
};
const costOf = async (variantId: number): Promise<string> => {
  const r = await db().select({ c: s.productVariants.costPrice }).from(s.productVariants).where(eq(s.productVariants.id, variantId));
  return String(r[0]?.c ?? "");
};

describe("G-م١ الهدايا الواردة", () => {
  it("ترفع المخزون وتخفّف WAVG بصفر تكلفة، بلا قيد دفتر ولا دين مورّد", async () => {
    // مخزون قائم 10 @ تكلفة 100.
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 10 });

    const res = await receiveInboundGift(
      { branchId: 1, supplierId: 1, giftType: "اشترِ واحصل", lines: [{ variantId: 1, productUnitId: 1, quantity: 2 }] },
      actor,
    );
    expect(res.giftNumber).toMatch(/^GFT-1-\d{8}-00001$/);

    // المخزون 10 → 12، والمتوسّط 100 → 10×100/12 = 83.33 (تخفيف).
    expect(await stockOf(1)).toBe(12);
    expect(await costOf(1)).toBe("83.33");

    // صفر أثر ماليّ: لا قيد دفتر، ولا دين على المورّد.
    expect(await countRows(s.accountingEntries)).toBe(0);
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(String(sup.currentBalance)).toBe("0.00");

    // حركة IN واحدة بمرجع GIFT_IN.
    const mv = await db().select().from(s.inventoryMovements);
    expect(mv.length).toBe(1);
    expect(mv[0].movementType).toBe("IN");
    expect(mv[0].referenceType).toBe("GIFT_IN");

    // رأس السند: وارد، مُنجَز، صفر تكلفة.
    const gv = (await db().select().from(s.giftVouchers).where(eq(s.giftVouchers.id, res.giftVoucherId)))[0];
    expect(gv.direction).toBe("IN");
    expect(gv.status).toBe("DELIVERED");
    expect(String(gv.totalCost)).toBe("0.00");
    expect(Number(gv.supplierId)).toBe(1);
    // سطر واحد بكمية أساس 2 ولقطة تكلفة صفر.
    const lines = await db().select().from(s.giftVoucherLines).where(eq(s.giftVoucherLines.giftVoucherId, res.giftVoucherId));
    expect(lines.length).toBe(1);
    expect(Number(lines[0].baseQuantity)).toBe(2);
    expect(String(lines[0].unitCostSnapshot)).toBe("0.00");
  });

  it("بلا مخزون قائم ⇒ يصير المتوسّط صفراً (كل المخزون مجّانيّ)", async () => {
    // لا branchStock للصنف — التكلفة القائمة 100.
    const res = await receiveInboundGift({ branchId: 1, lines: [{ variantId: 1, productUnitId: 1, quantity: 5 }] }, actor);
    expect(res.giftNumber).toMatch(/^GFT-1-/);
    expect(await stockOf(1)).toBe(5);
    expect(await costOf(1)).toBe("0.00");
  });

  it("غير قابل للبيع (استخدام داخليّ/عيّنة) ⇒ يُوثَّق بلا رفع مخزون ولا مسّ WAVG", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 10 });
    const res = await receiveInboundGift(
      { branchId: 1, sellable: false, giftType: "حامل عرض", lines: [{ variantId: 1, productUnitId: 1, quantity: 4 }] },
      actor,
    );
    // لا رفع مخزون البيع ولا تخفيف WAVG (يبقيان كما هما).
    expect(await stockOf(1)).toBe(10);
    expect(await costOf(1)).toBe("100.00");
    expect(await countRows(s.inventoryMovements)).toBe(0);
    // لكنّ السند موثَّق (sellable=false) بأسطره للتتبّع.
    const gv = (await db().select().from(s.giftVouchers).where(eq(s.giftVouchers.id, res.giftVoucherId)))[0];
    expect(gv.direction).toBe("IN");
    expect(Boolean(gv.sellable)).toBe(false);
    const lines = await db().select().from(s.giftVoucherLines).where(eq(s.giftVoucherLines.giftVoucherId, res.giftVoucherId));
    expect(lines.length).toBe(1);
    expect(Number(lines[0].baseQuantity)).toBe(4);
  });

  it("تحويل الوحدة (درزن) ⇒ كمية الأساس صحيحة", async () => {
    await receiveInboundGift({ branchId: 1, lines: [{ variantId: 1, productUnitId: 2, quantity: 1 }] }, actor); // 1 درزن = 12
    expect(await stockOf(1)).toBe(12);
    const line = (await db().select().from(s.giftVoucherLines))[0];
    expect(Number(line.baseQuantity)).toBe(12);
  });

  it("يُرفض حجز/استلام منتج بكج (مركّب)", async () => {
    await expect(
      receiveInboundGift({ branchId: 1, lines: [{ variantId: 2, productUnitId: 3, quantity: 1 }] }, actor),
    ).rejects.toThrow(/بكج/);
    // لا سند أُنشئ (ذرّية).
    expect(await countRows(s.giftVouchers)).toBe(0);
  });

  it("يُرفض منتج خدميّ (بلا مخزون)", async () => {
    await expect(
      receiveInboundGift({ branchId: 1, lines: [{ variantId: 3, productUnitId: 4, quantity: 1 }] }, actor),
    ).rejects.toThrow(/خدميّ/);
  });

  it("listGifts يعيد السند بعزل الفرع مع اسم المورّد", async () => {
    await receiveInboundGift({ branchId: 1, supplierId: 1, lines: [{ variantId: 1, productUnitId: 1, quantity: 3 }] }, actor);
    const rows = await listGifts({ scopedBranchId: 1 });
    expect(rows.length).toBe(1);
    expect(rows[0].direction).toBe("IN");
    expect(rows[0].supplierName).toBe("مورد");
    // عزل: فرع آخر لا يرى السند.
    const other = await listGifts({ scopedBranchId: 2 });
    expect(other.length).toBe(0);
  });
});

describe("G-م٢ الهدايا الصادرة", () => {
  const mgrA = { userId: 2, branchId: 1, role: "manager" };
  const mgrB = { userId: 3, branchId: 1, role: "manager" };
  const acc = { userId: 4, branchId: 1, role: "accountant" };
  const ledger = async () => db().select().from(s.accountingEntries);

  it("مدير تحت العتبة ⇒ مُنجَز فوراً: خصم مخزون + قيد GIFT_OUT (revenue=0, profit=-cost, بلا invoiceId)", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
    const res = await createOutboundGift({ branchId: 1, customerId: 1, giftType: "مجاملة", lines: [{ variantId: 1, productUnitId: 1, quantity: 10 }] }, mgrA);
    expect(res.status).toBe("DELIVERED");
    expect(res.pending).toBe(false);
    expect(res.totalCost).toBe("1000.00"); // 100 × 10
    expect(await stockOf(1)).toBe(990);
    const le = await ledger();
    expect(le.length).toBe(1);
    expect(le[0].entryType).toBe("GIFT_OUT");
    expect(String(le[0].revenue)).toBe("0.00");
    expect(String(le[0].cost)).toBe("1000.00");
    expect(String(le[0].profit)).toBe("-1000.00");
    expect(le[0].invoiceId).toBeNull(); // خارج وعاء العمولة (INNER JOIN الفواتير يستبعده)
    expect(le[0].dedupeKey).toBe(`GIFT:${res.giftVoucherId}`);
  });

  it("فوق العتبة ⇒ PENDING_APPROVAL بصفر أثر (لا خصم مخزون ولا قيد)", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
    const res = await createOutboundGift({ branchId: 1, customerId: 1, lines: [{ variantId: 1, productUnitId: 1, quantity: 600 }] }, mgrA); // 60000 > 50000
    expect(res.status).toBe("PENDING_APPROVAL");
    expect(res.pending).toBe(true);
    expect(await stockOf(1)).toBe(1000);
    expect((await ledger()).length).toBe(0);
  });

  it("محاسب (غير مدير) ⇒ PENDING حتى تحت العتبة", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
    const res = await createOutboundGift({ branchId: 1, customerId: 1, lines: [{ variantId: 1, productUnitId: 1, quantity: 5 }] }, acc);
    expect(res.status).toBe("PENDING_APPROVAL");
    expect(await stockOf(1)).toBe(1000);
  });

  it("اعتماد مدير آخر ⇒ يطبّق الأثر (خصم + قيد GIFT_OUT)", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
    const res = await createOutboundGift({ branchId: 1, customerId: 1, lines: [{ variantId: 1, productUnitId: 1, quantity: 600 }] }, mgrA);
    expect(res.pending).toBe(true);
    const ap = await approveGift(res.giftVoucherId, mgrB);
    expect(ap.status).toBe("DELIVERED");
    expect(ap.totalCost).toBe("60000.00");
    expect(await stockOf(1)).toBe(400);
    const le = await ledger();
    expect(le.length).toBe(1);
    expect(le[0].entryType).toBe("GIFT_OUT");
    expect(String(le[0].profit)).toBe("-60000.00");
  });

  it("SOD-04: المُنشئ لا يعتمد هديته بنفسه", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
    const res = await createOutboundGift({ branchId: 1, customerId: 1, lines: [{ variantId: 1, productUnitId: 1, quantity: 600 }] }, mgrA);
    await expect(approveGift(res.giftVoucherId, mgrA)).rejects.toThrow(/فصل المهام|بنفسك/);
    expect(await stockOf(1)).toBe(1000); // ما زالت معلّقة بلا أثر
  });

  it("يُرفض منح هدية فوق المخزون المتاح", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 5 });
    await expect(
      createOutboundGift({ branchId: 1, customerId: 1, lines: [{ variantId: 1, productUnitId: 1, quantity: 10 }] }, mgrA),
    ).rejects.toThrow(/غير كاف/);
  });

  it("admin يُنجز فوراً حتى فوق العتبة", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
    const res = await createOutboundGift({ branchId: 1, customerId: 1, lines: [{ variantId: 1, productUnitId: 1, quantity: 600 }] }, actor);
    expect(res.status).toBe("DELIVERED");
    expect(await stockOf(1)).toBe(400);
  });
});
