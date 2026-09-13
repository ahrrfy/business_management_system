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

const TABLES = ["receipts", "invoiceItems", "invoices", "branches", "users"];

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
  invoiceId: number;
  branchId?: number;
  direction: "IN" | "OUT";
  amount: string;
  method: "CASH" | "CARD" | "TRANSFER" | "WALLET";
}) {
  await db().insert(s.receipts).values({
    branchId: o.branchId ?? 1,
    invoiceId: o.invoiceId,
    shiftId: null,
    cashBucket: o.method === "CASH" ? "DRAWER" : null,
    direction: o.direction,
    amount: o.amount,
    paymentMethod: o.method,
    status: "COMPLETED",
    approvalStatus: "APPROVED",
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
    expect(c.invoiceCount).toBe(0);
  });
});
