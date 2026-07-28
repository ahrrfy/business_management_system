// وحدة الهدايا — G-م١ الوارد: بضاعة مجّانية من مورّد ترفع المخزون بصفر تكلفة (تخفيف WAVG)،
// بلا قيد PURCHASE ولا دين للمورّد. الثوابت الحرجة: تخفيف المتوسّط + صفر أثر ماليّ + تحويل الوحدة + الحرّاس.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { receiveInboundGift } from "../gifts/inbound";
import { getGiftVoucher, listGifts } from "../gifts/list";
import { approveGift, createOutboundGift } from "../gifts/outbound";
import { giftsReport } from "../gifts/reports";
import { recordPurchaseBonusGift } from "../gifts/purchaseBonus";
import { closeGiftCampaign, createGiftCampaign, listGiftCampaigns } from "../gifts/campaigns";

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
    "giftVoucherLines", "giftVouchers", "giftCampaigns", "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements", "purchaseOrders",
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
  await d.insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0", phone: "+9647701112233" });
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

  it("idempotency: نفس clientRequestId ⇒ سند وارد واحد (لا رفع مخزون مزدوج)", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 10 });
    const rid = "req-inb-dup";
    const a = await receiveInboundGift({ branchId: 1, clientRequestId: rid, lines: [{ variantId: 1, productUnitId: 1, quantity: 5 }] }, actor);
    const b = await receiveInboundGift({ branchId: 1, clientRequestId: rid, lines: [{ variantId: 1, productUnitId: 1, quantity: 5 }] }, actor);
    expect(b.giftVoucherId).toBe(a.giftVoucherId); // replay — نفس السند
    expect(await stockOf(1)).toBe(15); // رُفع مرّة واحدة (10+5) لا 20
    expect(await countRows(s.giftVouchers)).toBe(1);
  });

  it("getGiftVoucher: تفاصيل الطباعة (رأس + طرف + أسطر بأسماء المنتجات، بلا تكلفة) + عزل الفرع", async () => {
    const res = await receiveInboundGift({ branchId: 1, supplierId: 1, giftType: "عيّنة", lines: [{ variantId: 1, productUnitId: 1, quantity: 3 }] }, actor);
    const gv = await getGiftVoucher({ scopedBranchId: 1 }, res.giftVoucherId);
    expect(gv).toBeTruthy();
    expect(gv!.giftNumber).toBe(res.giftNumber);
    expect(gv!.direction).toBe("IN");
    expect(gv!.partyName).toBe("مورد"); // اسم المورّد للوارد
    expect(gv!.partyPhone).toBe("+9647701112233"); // هاتف المورّد (لإشعار واتساب)
    expect(gv!.lines.length).toBe(1);
    expect(gv!.lines[0].productName).toBe("ورق");
    expect(gv!.lines[0].unitName).toBe("قطعة");
    expect(Number(gv!.lines[0].baseQuantity)).toBe(3);
    expect("totalCost" in (gv as Record<string, unknown>)).toBe(false); // لا تكلفة في حمولة الطباعة
    // عزل الفرع: فرعٌ آخر لا يرى السند.
    expect(await getGiftVoucher({ scopedBranchId: 2 }, res.giftVoucherId)).toBeNull();
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

  it("idempotency: نفس clientRequestId ⇒ سند صادر واحد (لا خصم/قيد مزدوج)", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
    const rid = "req-out-dup";
    const a = await createOutboundGift({ branchId: 1, customerId: 1, clientRequestId: rid, lines: [{ variantId: 1, productUnitId: 1, quantity: 10 }] }, actor);
    const b = await createOutboundGift({ branchId: 1, customerId: 1, clientRequestId: rid, lines: [{ variantId: 1, productUnitId: 1, quantity: 10 }] }, actor);
    expect(b.giftVoucherId).toBe(a.giftVoucherId);
    expect(await stockOf(1)).toBe(90); // خُصم مرّة واحدة (100-10)
    expect((await ledger()).length).toBe(1); // قيد GIFT_OUT واحد لا اثنان
    expect(await countRows(s.giftVouchers)).toBe(1);
  });

  it("حجب التكلفة (redactCost) ⇒ totalCost = null في القائمة", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
    await createOutboundGift({ branchId: 1, customerId: 1, lines: [{ variantId: 1, productUnitId: 1, quantity: 10 }] }, actor); // admin ⇒ totalCost=1000
    const visible = await listGifts({ scopedBranchId: 1 }, {});
    expect(visible[0].totalCost).toBe("1000.00");
    const redacted = await listGifts({ scopedBranchId: 1 }, { redactCost: true });
    expect(redacted[0].totalCost).toBeNull();
  });
});

describe("G-م٤ تقارير الهدايا", () => {
  it("giftsReport يجمّع الملخّص + تركّز المُنشئ/العميل (كشف إساءة) + حسب النوع", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
    // صادرتان لنفس العميل من نفس المُنشئ (admin auto-post، 10×100=1000 لكلٍّ) ⇒ تركّز.
    await createOutboundGift({ branchId: 1, customerId: 1, giftType: "مجاملة", lines: [{ variantId: 1, productUnitId: 1, quantity: 10 }] }, actor);
    await createOutboundGift({ branchId: 1, customerId: 1, giftType: "مجاملة", lines: [{ variantId: 1, productUnitId: 1, quantity: 10 }] }, actor);
    // وارد (صفر تكلفة، لا يدخل تكلفة الصادر).
    await receiveInboundGift({ branchId: 1, supplierId: 1, lines: [{ variantId: 1, productUnitId: 1, quantity: 5 }] }, actor);

    const today = new Date().toISOString().slice(0, 10);
    const rep = await giftsReport({ from: `${today.slice(0, 8)}01`, to: today, branchId: 1 });

    const out = rep.summary.find((x) => x.direction === "OUT");
    const inn = rep.summary.find((x) => x.direction === "IN");
    expect(Number(out?.count)).toBe(2);
    expect(Number(out?.totalCost)).toBe(2000);
    expect(Number(inn?.count)).toBe(1);
    expect(Number(inn?.totalCost)).toBe(0);
    // كشف الإساءة: أعلى مُنشئ = admin (userId 1) بعددٍ 2، وأعلى عميل = العميل 1 بعددٍ 2.
    expect(Number(rep.byCreator[0].count)).toBe(2);
    expect(Number(rep.byCreator[0].createdBy)).toBe(1);
    expect(Number(rep.byCustomer[0].count)).toBe(2);
    expect(Number(rep.byCustomer[0].customerId)).toBe(1);
    // حسب النوع: «مجاملة» بعددٍ 2.
    expect(Number(rep.byType.find((x) => x.giftType === "مجاملة")?.count)).toBe(2);
  });
});

describe("G-م٦ بونص أمر الشراء (اشترِ واحصل)", () => {
  const seedPO = () =>
    db().insert(s.purchaseOrders).values({ id: 1, poNumber: "PO-1", supplierId: 1, branchId: 1, subtotal: "500", total: "500", status: "CONFIRMED" });

  it("recordPurchaseBonusGift يسجّل الكمية المجّانية سند هدية وارد للمورّد نفسه (صفر تكلفة)", async () => {
    await seedPO();
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
    const res = await recordPurchaseBonusGift({ purchaseOrderId: 1, bonusLines: [{ variantId: 1, freeBaseQuantity: 12 }] }, actor);
    expect(res?.giftNumber).toMatch(/^GFT-1-/);
    expect(await stockOf(1)).toBe(112); // 100 + 12 مجاناً
    expect(await countRows(s.accountingEntries)).toBe(0); // صفر قيد (وارد مجّانيّ)
    const gv = (await db().select().from(s.giftVouchers))[0];
    expect(gv.direction).toBe("IN");
    expect(Number(gv.supplierId)).toBe(1); // المورّد من أمر الشراء نفسه
    expect(gv.giftType).toBe("بونص شراء");
  });

  it("بلا كمية مجّانية موجبة ⇒ null (لا سند)", async () => {
    await seedPO();
    const res = await recordPurchaseBonusGift({ purchaseOrderId: 1, bonusLines: [{ variantId: 1, freeBaseQuantity: 0 }] }, actor);
    expect(res).toBeNull();
    expect(await countRows(s.giftVouchers)).toBe(0);
  });
});

describe("G-م٧ حملات الهدايا (ربط + فرض ميزانيّة بقفل تسلسليّ)", () => {
  const mgrA = { userId: 2, branchId: 1, role: "manager" };
  const mgrB = { userId: 3, branchId: 1, role: "manager" };

  it("createGiftCampaign ينشئ حملة برصيد إنفاق صفر، ويرفض اسماً مكرَّراً", async () => {
    const res = await createGiftCampaign({ name: "حملة العودة للمدارس", budgetCost: "10000" }, actor);
    expect(res.campaignId).toBeGreaterThan(0);
    const list = await listGiftCampaigns();
    expect(list.length).toBe(1);
    expect(list[0].status).toBe("ACTIVE");
    expect(Number(list[0].spent)).toBe(0);
    expect(String(list[0].budgetCost)).toBe("10000.00");
    await expect(createGiftCampaign({ name: "حملة العودة للمدارس" }, actor)).rejects.toThrow();
  });

  it("هدية تحت ميزانيّة الحملة ⇒ مُنجَزة فوراً (مدير)، والمُنفَق يتراكم", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
    const camp = await createGiftCampaign({ name: "حملة أ", budgetCost: "5000" }, actor);
    const res = await createOutboundGift(
      { branchId: 1, customerId: 1, campaignId: camp.campaignId, lines: [{ variantId: 1, productUnitId: 1, quantity: 10 }] }, // 10×100=1000
      mgrA,
    );
    expect(res.status).toBe("DELIVERED");
    const list = await listGiftCampaigns();
    expect(Number(list[0].spent)).toBe(1000);
  });

  it("تجاوز ميزانيّة الحملة ⇒ PENDING_APPROVAL حتى للمدير (لا تُنجَز رغم كونها تحت العتبة العامة)", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
    const camp = await createGiftCampaign({ name: "حملة ب", budgetCost: "500" }, actor); // سقف 500
    // 10×100=1000 > 500 (سقف الحملة) لكن < 50000 (العتبة العامة) ⇒ لولا فحص الحملة لكانت مُنجَزة.
    const res = await createOutboundGift(
      { branchId: 1, customerId: 1, campaignId: camp.campaignId, lines: [{ variantId: 1, productUnitId: 1, quantity: 10 }] },
      mgrA,
    );
    expect(res.status).toBe("PENDING_APPROVAL");
    expect(await stockOf(1)).toBe(1000); // صفر أثر حتى الاعتماد
  });

  it("admin يتجاوز فرض ميزانيّة الحملة (نمط تجاوز العتبة العامة)", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
    const camp = await createGiftCampaign({ name: "حملة ج", budgetCost: "500" }, actor);
    const res = await createOutboundGift(
      { branchId: 1, customerId: 1, campaignId: camp.campaignId, lines: [{ variantId: 1, productUnitId: 1, quantity: 10 }] },
      actor, // admin
    );
    expect(res.status).toBe("DELIVERED");
  });

  it("يُرفض ربط هدية بحملة مغلقة", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
    const camp = await createGiftCampaign({ name: "حملة د" }, actor);
    await closeGiftCampaign(camp.campaignId);
    await expect(
      createOutboundGift({ branchId: 1, customerId: 1, campaignId: camp.campaignId, lines: [{ variantId: 1, productUnitId: 1, quantity: 1 }] }, mgrA),
    ).rejects.toThrow(/مغلقة/);
  });

  it("يُرفض ربط هدية بحملة غير موجودة", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
    await expect(
      createOutboundGift({ branchId: 1, customerId: 1, campaignId: 999999, lines: [{ variantId: 1, productUnitId: 1, quantity: 1 }] }, mgrA),
    ).rejects.toThrow();
  });

  it("اعتماد هدية بحملة أُغلقت لاحقاً: يُرفض لغير الأدمن، ويُقبَل للأدمن", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
    const camp = await createGiftCampaign({ name: "حملة هـ", budgetCost: "100" }, actor); // سقف صغير ⇒ معلَّقة دائماً
    const res = await createOutboundGift(
      { branchId: 1, customerId: 1, campaignId: camp.campaignId, lines: [{ variantId: 1, productUnitId: 1, quantity: 10 }] },
      mgrA,
    );
    expect(res.pending).toBe(true);
    await closeGiftCampaign(camp.campaignId);
    await expect(approveGift(res.giftVoucherId, mgrB)).rejects.toThrow(/أُغلقت/);
    const ap = await approveGift(res.giftVoucherId, actor); // admin يتجاوز
    expect(ap.status).toBe("DELIVERED");
  });

  it("closeGiftCampaign يرفض حملة غير موجودة أو مغلقة مسبقاً", async () => {
    await expect(closeGiftCampaign(999999)).rejects.toThrow();
    const camp = await createGiftCampaign({ name: "حملة و" }, actor);
    await closeGiftCampaign(camp.campaignId);
    await expect(closeGiftCampaign(camp.campaignId)).rejects.toThrow(/مسبقاً/);
  });

  it("listGiftCampaigns.spent يجمع المُنجَز فقط (لا يحتسب المعلَّق)", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
    const camp = await createGiftCampaign({ name: "حملة ز", budgetCost: "100000" }, actor);
    await createOutboundGift({ branchId: 1, customerId: 1, campaignId: camp.campaignId, lines: [{ variantId: 1, productUnitId: 1, quantity: 5 }] }, mgrA); // مُنجَز 500
    await createOutboundGift({ branchId: 1, customerId: 1, campaignId: camp.campaignId, lines: [{ variantId: 1, productUnitId: 1, quantity: 3 }] }, { userId: 4, branchId: 1, role: "accountant" }); // محاسب ⇒ معلَّق 300
    const list = await listGiftCampaigns({ status: "ACTIVE" });
    expect(Number(list[0].spent)).toBe(500); // 300 المعلَّق لا يُحتسَب
  });
});
