/**
 * اختبارات arRemindersService — تذكيرات الذمم الآجلة (سجلّ مراجعة → واتساب).
 *
 * تركّز على: منطق التصفية (٧ أيام + منع تكرار)، IDOR (فرع)، صحّة snapshots، وترتيب الأقدم أولاً.
 * لا نختبر getARAging الأساسي (له اختباراته الخاصّة) — نستدعيه كما هو.
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  getReminderHistory,
  getReminderQueue,
  logReminderSent,
  logReminderSkipped,
} from "../arRemindersService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

/** أنشئ فاتورة PENDING آجلة بتاريخ استحقاق محدَّد + عميل + فرع افتراضي. */
async function makeCustomerWithOverdueInvoice(opts: {
  customerId: number;
  customerName: string;
  phone?: string;
  branchId?: number;
  invoiceId: number;
  invoiceNumber: string;
  dueDate: string; // YYYY-MM-DD
  total: string;
  paid?: string;
}): Promise<void> {
  const d = db();
  const branchId = opts.branchId ?? 1;
  await d.insert(s.customers).values({
    id: opts.customerId,
    name: opts.customerName,
    phone: opts.phone ?? "07901234567",
    customerType: "فرد",
    currentBalance: opts.total,
    isActive: true,
  });
  await d.insert(s.invoices).values({
    id: opts.invoiceId,
    invoiceNumber: opts.invoiceNumber,
    sourceType: "POS",
    sourceId: `test-${opts.invoiceId}`,
    branchId,
    customerId: opts.customerId,
    priceTier: "RETAIL",
    dueDate: opts.dueDate,
    subtotal: opts.total,
    total: opts.total,
    paidAmount: opts.paid ?? "0",
    status: (opts.paid && Number(opts.paid) > 0) ? "PARTIALLY_PAID" : "PENDING",
  });
}

/** تاريخ منذ N يوماً (YYYY-MM-DD)، UTC. */
function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

beforeEach(async () => {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع مبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "u1", name: "المدير", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "u2", name: "مدير-٢", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
});

describe("arRemindersService - getReminderQueue", () => {
  it("قائمة فارغة حين لا فواتير متأخّرة", async () => {
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toEqual([]);
  });

  it("يستبعد فواتير متأخّرة أقلّ من ٧ أيام (سياسة المالك: أوّل تذكير بعد يوم ٧)", async () => {
    await makeCustomerWithOverdueInvoice({
      customerId: 100,
      customerName: "عميل تأخّر ٥ أيام",
      invoiceId: 1000,
      invoiceNumber: "INV-1000",
      dueDate: daysAgo(5),
      total: "500000",
    });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toEqual([]);
  });

  it("يُدرج عميلاً بفاتورة متأخّرة ٧ أيام بالضبط (حدّ التبريد)", async () => {
    await makeCustomerWithOverdueInvoice({
      customerId: 101,
      customerName: "عميل يوم ٧",
      invoiceId: 1001,
      invoiceNumber: "INV-1001",
      dueDate: daysAgo(7),
      total: "300000",
    });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toHaveLength(1);
    expect(queue[0].customerId).toBe(101);
    expect(queue[0].daysOverdue).toBe(7);
    expect(Number(queue[0].totalUnpaid)).toBe(300000);
  });

  it("يُرتّب الأكثر تأخّراً أولاً (أهمّ للمراجعة اليدوية)", async () => {
    await makeCustomerWithOverdueInvoice({
      customerId: 110,
      customerName: "متأخّر ١٠ أيام",
      invoiceId: 1010,
      invoiceNumber: "INV-1010",
      dueDate: daysAgo(10),
      total: "100000",
    });
    await makeCustomerWithOverdueInvoice({
      customerId: 111,
      customerName: "متأخّر ٩٠ يوماً",
      invoiceId: 1011,
      invoiceNumber: "INV-1011",
      dueDate: daysAgo(90),
      total: "50000",
    });
    await makeCustomerWithOverdueInvoice({
      customerId: 112,
      customerName: "متأخّر ٤٥ يوماً",
      invoiceId: 1012,
      invoiceNumber: "INV-1012",
      dueDate: daysAgo(45),
      total: "200000",
    });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue.map((r) => r.customerId)).toEqual([111, 112, 110]); // الأقدم أولاً
  });

  it("عزل الفرع: عملاء الفرع ٢ لا يظهرون في قائمة الفرع ١", async () => {
    await makeCustomerWithOverdueInvoice({
      customerId: 120,
      customerName: "عميل فرع ١",
      branchId: 1,
      invoiceId: 1020,
      invoiceNumber: "INV-1020",
      dueDate: daysAgo(30),
      total: "100000",
    });
    await makeCustomerWithOverdueInvoice({
      customerId: 121,
      customerName: "عميل فرع ٢",
      branchId: 2,
      invoiceId: 1021,
      invoiceNumber: "INV-1021",
      dueDate: daysAgo(30),
      total: "100000",
    });
    const queue1 = await getReminderQueue({ branchId: 1 });
    const queue2 = await getReminderQueue({ branchId: 2 });
    expect(queue1.map((r) => r.customerId)).toEqual([120]);
    expect(queue2.map((r) => r.customerId)).toEqual([121]);
  });

  it("منع التكرار: عميل ذُكِّر خلال ٧ أيام لا يظهر مجدداً", async () => {
    await makeCustomerWithOverdueInvoice({
      customerId: 130,
      customerName: "ذُكِّر أمس",
      invoiceId: 1030,
      invoiceNumber: "INV-1030",
      dueDate: daysAgo(20),
      total: "150000",
    });
    // القائمة قبل الإرسال — عميل واحد
    let queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toHaveLength(1);

    // سجّل تذكيراً مُرسَلاً
    await logReminderSent(
      {
        customerId: 130,
        totalUnpaidSnapshot: "150000",
        oldestInvoiceDate: daysAgo(20),
        daysOverdue: 20,
        messageBody: "تذكير ودّي...",
      },
      { userId: 1, branchId: 1 },
    );

    // القائمة بعد الإرسال — العميل مستبعَد (تبريد ٧ أيام).
    queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toEqual([]);
  });
});

describe("arRemindersService - logReminderSent / logReminderSkipped", () => {
  beforeEach(async () => {
    await makeCustomerWithOverdueInvoice({
      customerId: 200,
      customerName: "عميل اختبار",
      invoiceId: 2000,
      invoiceNumber: "INV-2000",
      dueDate: daysAgo(15),
      total: "100000",
    });
  });

  it("يسجّل تذكيراً مُرسَلاً بكل snapshots", async () => {
    const r = await logReminderSent(
      {
        customerId: 200,
        totalUnpaidSnapshot: "100000",
        oldestInvoiceDate: daysAgo(15),
        daysOverdue: 15,
        messageBody: "السلام عليكم، تذكير بالرصيد.",
      },
      { userId: 1, branchId: 1 },
    );
    expect(r.id).toBeGreaterThan(0);

    const rows = await db().select().from(s.arReminders);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("SENT");
    expect(rows[0].totalUnpaidSnapshot).toBe("100000.00");
    expect(rows[0].daysOverdue).toBe(15);
    expect(rows[0].skipReason).toBeNull();
    expect(rows[0].createdBy).toBe(1);
    expect(rows[0].branchId).toBe(1);
  });

  it("يسجّل تخطٍّ بسبب واضح", async () => {
    const r = await logReminderSkipped(
      {
        customerId: 200,
        totalUnpaidSnapshot: "100000",
        oldestInvoiceDate: daysAgo(15),
        daysOverdue: 15,
        skipReason: "العميل وعد بالدفع يوم الأحد",
      },
      { userId: 1, branchId: 1 },
    );
    expect(r.id).toBeGreaterThan(0);
    const rows = await db().select().from(s.arReminders);
    expect(rows[0].status).toBe("SKIPPED");
    expect(rows[0].skipReason).toBe("العميل وعد بالدفع يوم الأحد");
    expect(rows[0].messageBody).toBe("");
  });

  it("يرفض تسجيل تذكير على عميل بلا فاتورة في الفرع (IDOR)", async () => {
    // عميل ٢٠٠ فواتيره في الفرع ١؛ محاولة تسجيل تذكير عليه من فرع ٢ ⇒ يجب أن تُرفض.
    await expect(
      logReminderSent(
        {
          customerId: 200,
          totalUnpaidSnapshot: "100000",
          oldestInvoiceDate: daysAgo(15),
          daysOverdue: 15,
          messageBody: "محاولة IDOR",
        },
        { userId: 2, branchId: 2 },
      ),
    ).rejects.toThrow(/لا فواتير لهذا العميل/);
  });

  it("يرفض رصيداً غير موجب", async () => {
    await expect(
      logReminderSent(
        {
          customerId: 200,
          totalUnpaidSnapshot: "0",
          oldestInvoiceDate: daysAgo(15),
          daysOverdue: 15,
          messageBody: "رصيد صفر",
        },
        { userId: 1, branchId: 1 },
      ),
    ).rejects.toThrow(/موجب/);
  });

  it("يرفض تخطٍّ بلا سبب", async () => {
    await expect(
      logReminderSkipped(
        {
          customerId: 200,
          totalUnpaidSnapshot: "100000",
          oldestInvoiceDate: daysAgo(15),
          daysOverdue: 15,
          skipReason: "   ",
        },
        { userId: 1, branchId: 1 },
      ),
    ).rejects.toThrow(/سبب/);
  });

  it("سجلّ التاريخ يُعيد التذكيرات مع اسم العميل بترتيب الأحدث أولاً", async () => {
    await logReminderSent(
      { customerId: 200, totalUnpaidSnapshot: "100000", oldestInvoiceDate: daysAgo(15), daysOverdue: 15, messageBody: "أوّل" },
      { userId: 1, branchId: 1 },
    );
    await logReminderSkipped(
      { customerId: 200, totalUnpaidSnapshot: "100000", oldestInvoiceDate: daysAgo(15), daysOverdue: 15, skipReason: "لاحقاً" },
      { userId: 1, branchId: 1 },
    );
    const history = await getReminderHistory({ branchId: 1 });
    expect(history).toHaveLength(2);
    expect(history[0].status).toBe("SKIPPED"); // الأحدث أولاً
    expect(history[1].status).toBe("SENT");
    expect(history[0].customerName).toBe("عميل اختبار");
  });
});
