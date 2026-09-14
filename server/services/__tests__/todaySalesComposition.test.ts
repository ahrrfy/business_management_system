// تركيب مبيعات اليوم — جسر «لماذا لا تساوي المبيعاتُ النقدَ في الدرج».
// نُثبّت: الإجماليّ == getTodayNetSales، والتفكيك نقد/غير نقد/آجل يجمع إلى الإجماليّ بالبناء،
// صافي المرتجع/الردّ، عزل الفرع، واستبعاد الملغى.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getTodaySalesComposition, getTodayNetSales } from "../reports/todaySales";

// يومٌ ثابت (ظهر UTC = يوم بغداد نفسه) — يمنع تذبذب حدّ يوم بغداد قرب منتصف الليل.
const NOW = new Date(Date.UTC(2026, 8, 10, 12, 0, 0));

const TABLES = ["orderPayments", "receipts", "invoiceItems", "invoices", "workOrders", "branches", "users"];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "مدير", role: "admin", loginMethod: "local", branchId: 1 });
}

let seqInvoice = 0;
async function invoice(o: {
  id: number;
  branchId?: number;
  total: string;
  returnedTotal?: string;
  status?: "PAID" | "PENDING" | "CANCELLED";
  paidAmount?: string;
}) {
  seqInvoice += 1;
  await db().insert(s.invoices).values({
    id: o.id,
    invoiceNumber: `INV-${o.id}`,
    sourceType: "ORDER",
    sourceId: `t-${o.id}-${seqInvoice}`,
    branchId: o.branchId ?? 1,
    priceTier: "RETAIL",
    subtotal: o.total,
    total: o.total,
    returnedTotal: o.returnedTotal ?? "0.00",
    paidAmount: o.paidAmount ?? "0.00",
    status: o.status ?? "PAID",
    invoiceDate: NOW,
  });
}

async function receipt(o: {
  invoiceId?: number | null;
  branchId?: number;
  direction: "IN" | "OUT";
  amount: string;
  method: "CASH" | "CARD" | "TRANSFER" | "WALLET";
  bucket?: "DRAWER" | "TREASURY" | null; // افتراض CASH=DRAWER؛ صريحٌ للخزينة أو NULL
  status?: "COMPLETED" | "PENDING" | "REVERSED";
  approval?: "APPROVED" | "PENDING_APPROVAL";
  id?: number;
}) {
  await db().insert(s.receipts).values({
    id: o.id,
    branchId: o.branchId ?? 1,
    invoiceId: o.invoiceId ?? null,
    shiftId: null,
    cashBucket: o.bucket !== undefined ? o.bucket : o.method === "CASH" ? "DRAWER" : null,
    direction: o.direction,
    amount: o.amount,
    paymentMethod: o.method,
    status: o.status ?? "COMPLETED",
    approvalStatus: o.approval ?? "APPROVED",
    createdBy: 1,
    createdAt: NOW,
  });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("تركيب مبيعات اليوم — نقد/غير نقد/آجل", () => {
  it("يفكّك الإجماليّ إلى نقد + غير نقديّ + آجل، ويساوي getTodayNetSales", async () => {
    await invoice({ id: 1, total: "100000" });
    await receipt({ invoiceId: 1, direction: "IN", amount: "100000", method: "CASH" });
    await invoice({ id: 2, total: "200000" });
    await receipt({ invoiceId: 2, direction: "IN", amount: "200000", method: "CARD" });
    await invoice({ id: 3, total: "150000", status: "PENDING" }); // آجل بلا قبض
    await invoice({ id: 4, total: "90000" }); // مختلط: نقد + تحويل
    await receipt({ invoiceId: 4, direction: "IN", amount: "50000", method: "CASH" });
    await receipt({ invoiceId: 4, direction: "IN", amount: "40000", method: "TRANSFER" });
    // ملغاة تُستبعَد + فرع آخر يُستبعَد لفرع ١
    await invoice({ id: 5, total: "999000", status: "CANCELLED" });
    await invoice({ id: 6, total: "500000", branchId: 2 });
    await receipt({ invoiceId: 6, branchId: 2, direction: "IN", amount: "500000", method: "CASH" });

    const c = await getTodaySalesComposition(1, NOW);
    const net = await getTodayNetSales(1, NOW);

    expect(c.total).toBe("540000.00"); // 100+200+150+90 ألف
    expect(c.total).toBe(net.total); // رأس الجسر == بطاقة اللوحة
    expect(c.invoiceCount).toBe(4);
    expect(c.cash).toBe("150000.00"); // 100k + 50k المختلط
    expect(c.card).toBe("200000.00");
    expect(c.transfer).toBe("40000.00");
    expect(c.nonCash).toBe("240000.00"); // 200k بطاقة + 40k تحويل
    expect(c.credit).toBe("150000.00"); // الفاتورة الآجلة

    // الثابت: نقد + غير نقديّ + آجل = الإجماليّ
    const sum = Number(c.cash) + Number(c.nonCash) + Number(c.credit);
    expect(sum.toFixed(2)).toBe("540000.00");
  });

  it("يصافي المرتجع من الإجماليّ والردّ من النقد (صافٍ لا إجماليّ)", async () => {
    await invoice({ id: 1, total: "100000", returnedTotal: "40000" }); // صافي بيع 60k
    await receipt({ invoiceId: 1, direction: "IN", amount: "100000", method: "CASH" });
    await receipt({ invoiceId: 1, direction: "OUT", amount: "40000", method: "CASH" }); // ردّ نقديّ

    const c = await getTodaySalesComposition(1, NOW);
    expect(c.total).toBe("60000.00"); // 100k − 40k مرتجع
    expect(c.cash).toBe("60000.00"); // 100k قبض − 40k ردّ
    expect(c.nonCash).toBe("0.00");
    expect(c.credit).toBe("0.00");
  });

  it("عزل الفرع: لا تدخل مبيعات فرعٍ آخر", async () => {
    await invoice({ id: 1, total: "100000", branchId: 1 });
    await receipt({ invoiceId: 1, direction: "IN", amount: "100000", method: "CASH" });
    await invoice({ id: 2, total: "700000", branchId: 2 });
    await receipt({ invoiceId: 2, branchId: 2, direction: "IN", amount: "700000", method: "CARD" });

    const c1 = await getTodaySalesComposition(1, NOW);
    expect(c1.total).toBe("100000.00");
    expect(c1.cash).toBe("100000.00");
    expect(c1.nonCash).toBe("0.00");
  });

  it("قاعدة بلا مبيعات ⇒ أصفار بلا انهيار", async () => {
    const c = await getTodaySalesComposition(1, NOW);
    expect(c.total).toBe("0.00");
    expect(c.cash).toBe("0.00");
    expect(c.nonCash).toBe("0.00");
    expect(c.credit).toBe("0.00");
    expect(c.treasuryCash).toBe("0.00");
    expect(c.pendingRefund).toBe("0.00");
    expect(c.invoiceCount).toBe(0);
  });

  it("ردٌّ نقديٌّ من الخزينة لا يُخصَم من نقد الدرج المعروض (#485)", async () => {
    await invoice({ id: 1, total: "100000", returnedTotal: "30000" }); // صافي 70k
    await receipt({ invoiceId: 1, direction: "IN", amount: "100000", method: "CASH" }); // درج
    await receipt({ invoiceId: 1, direction: "OUT", amount: "30000", method: "CASH", bucket: "TREASURY" }); // ردٌّ من الخزينة

    const c = await getTodaySalesComposition(1, NOW);
    expect(c.total).toBe("70000.00");
    expect(c.cash).toBe("100000.00"); // الدرج كاملٌ — لم يُخصَم منه ردّ الخزينة
    expect(c.treasuryCash).toBe("-30000.00"); // صافي خروجٍ من الخزينة الإدارية، مفصولاً
    expect(c.credit).toBe("0.00");
    expect(c.pendingRefund).toBe("0.00");
    // الثابت: total = cash + treasuryCash + nonCash + credit − pendingRefund
    const identity =
      Number(c.cash) + Number(c.treasuryCash) + Number(c.nonCash) + Number(c.credit) - Number(c.pendingRefund);
    expect(identity.toFixed(2)).toBe("70000.00");
  });

  it("ردٌّ معلّق (غير مكتمل) يُفصَل عن الائتمان — لا يُعرَض «آجل» سالباً (#487)", async () => {
    await invoice({ id: 1, total: "100000", returnedTotal: "100000" }); // صافي 0
    await receipt({ invoiceId: 1, direction: "IN", amount: "100000", method: "CASH" }); // قبضٌ معتمد
    // ردّ OUT لم يُعتمد بعد ⇒ مُستبعَد من التحصيل (receiptApprovalStatus <> APPROVED)
    await receipt({ invoiceId: 1, direction: "OUT", amount: "100000", method: "CASH", status: "PENDING", approval: "PENDING_APPROVAL" });

    const c = await getTodaySalesComposition(1, NOW);
    expect(c.total).toBe("0.00");
    expect(c.cash).toBe("100000.00"); // القبض المعتمد وحده
    expect(c.credit).toBe("0.00"); // ليس آجلاً
    expect(c.pendingRefund).toBe("100000.00"); // مالٌ يُردّ للعميل، مفصولاً بوضوح
  });

  it("عربونٌ واحدٌ مُقسَّط على أمرَي شغل يُحتسب لكلتا فاتورتيهما بلا ازدواج (#478)", async () => {
    await invoice({ id: 1, total: "30000", paidAmount: "30000" });
    await invoice({ id: 2, total: "20000", paidAmount: "20000" });
    const d = db();
    // نتجاوز سلسلة FK الثقيلة (receptionDrafts/customers) — نبذر ما تلمسه استعلامات الجسر فقط.
    await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    await d.insert(s.workOrders).values([
      { id: 10, orderNumber: "WO-10", branchId: 1, title: "درع", invoiceId: 1 },
      { id: 20, orderNumber: "WO-20", branchId: 1, title: "لوحة", invoiceId: 2 },
    ]);
    // لأن القبض شُطّر على هدفين يبقى invoiceId للإيصال NULL — حقيقة كل حصة في APPLICATION.
    await receipt({ id: 200, invoiceId: null, direction: "IN", amount: "50000", method: "CASH" });
    await d.insert(s.orderPayments).values([
      { id: 1, draftId: 999, branchId: 1, kind: "COLLECTION", method: "CASH", amount: "50000", receiptId: 200, status: "APPLIED", createdBy: 1 },
      { id: 2, draftId: 999, branchId: 1, kind: "APPLICATION", amount: "30000", parentPaymentId: 1, appliedKind: "WORKORDER", appliedId: 10, createdBy: 1 },
      { id: 3, draftId: 999, branchId: 1, kind: "APPLICATION", amount: "20000", parentPaymentId: 1, appliedKind: "WORKORDER", appliedId: 20, createdBy: 1 },
    ]);
    await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

    const c = await getTodaySalesComposition(1, NOW);
    expect(c.total).toBe("50000.00");
    expect(c.cash).toBe("50000.00");
    expect(c.credit).toBe("0.00");
  });

  it("التطبيقات المُقسَّطة تحفظ دلو إيصال القبض وتشمل هدف الفاتورة المباشر", async () => {
    await invoice({ id: 1, total: "10000", paidAmount: "10000" });
    await invoice({ id: 2, total: "20000", paidAmount: "20000" });
    const d = db();
    await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    await d.insert(s.workOrders).values({ id: 20, orderNumber: "WO-20", branchId: 1, title: "لوحة", invoiceId: 2 });
    await receipt({ id: 201, invoiceId: null, direction: "IN", amount: "30000", method: "CASH", bucket: "TREASURY" });
    await d.insert(s.orderPayments).values([
      { id: 10, draftId: 1000, branchId: 1, kind: "COLLECTION", method: "CASH", amount: "30000", receiptId: 201, status: "APPLIED", createdBy: 1 },
      { id: 11, draftId: 1000, branchId: 1, kind: "APPLICATION", amount: "10000", parentPaymentId: 10, appliedKind: "INVOICE", appliedId: 1, createdBy: 1 },
      { id: 12, draftId: 1000, branchId: 1, kind: "APPLICATION", amount: "20000", parentPaymentId: 10, appliedKind: "WORKORDER", appliedId: 20, createdBy: 1 },
    ]);
    await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

    const c = await getTodaySalesComposition(1, NOW);
    expect(c.total).toBe("30000.00");
    expect(c.cash).toBe("0.00");
    expect(c.treasuryCash).toBe("30000.00");
    expect(c.credit).toBe("0.00");
  });

  it("دفعةٌ واحدة موزَّعة بين فاتورةٍ مباشرة وأمر شغل تُضمّ بكامل تطبيقاتها بلا ازدواج (#478)", async () => {
    await invoice({ id: 1, total: "20000", paidAmount: "20000" });
    await invoice({ id: 2, total: "30000", paidAmount: "30000" });
    const d = db();
    await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    await d.insert(s.workOrders).values({ id: 10, orderNumber: "WO-10", branchId: 1, title: "درع", invoiceId: 2 });
    // الإيصال موزَّع على هدفين، لذلك يبقى invoiceId=NULL وتبقى الحقيقة في APPLICATION كلّها.
    await receipt({ id: 200, invoiceId: null, direction: "IN", amount: "50000", method: "CASH" });
    await d.insert(s.orderPayments).values([
      { id: 1, draftId: 999, branchId: 1, kind: "COLLECTION", method: "CASH", amount: "50000", receiptId: 200, status: "APPLIED", createdBy: 1 },
      { id: 2, draftId: 999, branchId: 1, kind: "APPLICATION", amount: "20000", parentPaymentId: 1, appliedKind: "INVOICE", appliedId: 1, createdBy: 1 },
      { id: 3, draftId: 999, branchId: 1, kind: "APPLICATION", amount: "30000", parentPaymentId: 1, appliedKind: "WORKORDER", appliedId: 10, createdBy: 1 },
    ]);
    await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

    const c = await getTodaySalesComposition(1, NOW);
    expect(c.total).toBe("50000.00");
    expect(c.cash).toBe("50000.00");
    expect(c.credit).toBe("0.00");
    expect(c.pendingRefund).toBe("0.00");
  });
});
