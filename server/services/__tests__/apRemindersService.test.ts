/**
 * اختبارات apRemindersService — تذكيرات الذمم الدائنة (سجلّ مراجعة → واتساب). مرآة arRemindersService.test.
 *
 * تركّز على: منطق التصفية (٧ أيام + منع تكرار)، IDOR (فرع)، صحّة snapshots، وترتيب الأقدم أولاً،
 * ودلالة الرصيد الجاري (الذمم الحاكمة = suppliers.currentBalance). لا نختبر getAPAging (له اختباراته).
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  getReminderHistory,
  getReminderQueue,
  logReminderSent,
  logReminderSkipped,
} from "../apRemindersService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

/** أنشئ مورداً + أمر شراء ملتزَم (CONFIRMED) بتاريخ طلب محدَّد (AP aging يعمّر على orderDate). */
async function makeSupplierWithOverduePO(opts: {
  supplierId: number;
  supplierName: string;
  phone?: string;
  branchId?: number;
  poId: number;
  poNumber: string;
  orderDate: string; // YYYY-MM-DD
  total: string;
  paid?: string;
  /** الرصيد الجاري إن اختلف عن total — لمحاكاة تسديد مستقلّ (يخفّض الرصيد لا paidAmount)
   *  أو رصيد افتتاحي مدين (المورد يدين لنا). الافتراضي = total. */
  currentBalance?: string;
}): Promise<void> {
  const d = db();
  const branchId = opts.branchId ?? 1;
  await d.insert(s.suppliers).values({
    id: opts.supplierId,
    name: opts.supplierName,
    phone: opts.phone ?? "07901234567",
    currentBalance: opts.currentBalance ?? opts.total,
    isActive: true,
  });
  await d.insert(s.purchaseOrders).values({
    id: opts.poId,
    poNumber: opts.poNumber,
    supplierId: opts.supplierId,
    branchId,
    // ظهر UTC (لا منتصف الليل) لتفادي انزياح حدّ اليوم في DATE(orderDate)/DATEDIFF.
    orderDate: new Date(`${opts.orderDate}T12:00:00.000Z`),
    subtotal: opts.total,
    total: opts.total,
    paidAmount: opts.paid ?? "0",
    status: "CONFIRMED",
  });
}

/** تاريخ منذ N يوماً (YYYY-MM-DD)، UTC. */
function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** تاريخ بعد N يوماً من اليوم (YYYY-MM-DD)، UTC. للتحقّق من وعود المستقبل. */
function daysAhead(n: number): string {
  const d = new Date(Date.now() + n * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** «اليوم» بصيغة YYYY-MM-DD UTC — يطابق منطق الخدمة (`todayUTC`). */
function today(): string {
  const d = new Date();
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

describe("apRemindersService - getReminderQueue", () => {
  it("قائمة فارغة حين لا أوامر شراء متأخّرة", async () => {
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toEqual([]);
  });

  it("يستبعد أوامر شراء متأخّرة أقلّ من ٧ أيام (أوّل تذكير بعد يوم ٧)", async () => {
    await makeSupplierWithOverduePO({
      supplierId: 100,
      supplierName: "مورد تأخّر ٥ أيام",
      poId: 1000,
      poNumber: "PO-1000",
      orderDate: daysAgo(5),
      total: "500000",
    });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toEqual([]);
  });

  it("يُدرج مورداً بأمر شراء متأخّر ٧ أيام بالضبط (حدّ التبريد)", async () => {
    await makeSupplierWithOverduePO({
      supplierId: 101,
      supplierName: "مورد يوم ٧",
      poId: 1001,
      poNumber: "PO-1001",
      orderDate: daysAgo(7),
      total: "300000",
    });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toHaveLength(1);
    expect(queue[0].supplierId).toBe(101);
    expect(queue[0].daysOverdue).toBe(7);
    expect(Number(queue[0].totalUnpaid)).toBe(300000);
  });

  it("يُرتّب الأكثر تأخّراً أولاً (أهمّ للمراجعة اليدوية)", async () => {
    await makeSupplierWithOverduePO({
      supplierId: 110,
      supplierName: "متأخّر ١٠ أيام",
      poId: 1010,
      poNumber: "PO-1010",
      orderDate: daysAgo(10),
      total: "100000",
    });
    await makeSupplierWithOverduePO({
      supplierId: 111,
      supplierName: "متأخّر ٩٠ يوماً",
      poId: 1011,
      poNumber: "PO-1011",
      orderDate: daysAgo(90),
      total: "50000",
    });
    await makeSupplierWithOverduePO({
      supplierId: 112,
      supplierName: "متأخّر ٤٥ يوماً",
      poId: 1012,
      poNumber: "PO-1012",
      orderDate: daysAgo(45),
      total: "200000",
    });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue.map((r) => r.supplierId)).toEqual([111, 112, 110]); // الأقدم أولاً
  });

  it("عزل الفرع: موردو الفرع ٢ لا يظهرون في قائمة الفرع ١", async () => {
    await makeSupplierWithOverduePO({
      supplierId: 120,
      supplierName: "مورد فرع ١",
      branchId: 1,
      poId: 1020,
      poNumber: "PO-1020",
      orderDate: daysAgo(30),
      total: "100000",
    });
    await makeSupplierWithOverduePO({
      supplierId: 121,
      supplierName: "مورد فرع ٢",
      branchId: 2,
      poId: 1021,
      poNumber: "PO-1021",
      orderDate: daysAgo(30),
      total: "100000",
    });
    const queue1 = await getReminderQueue({ branchId: 1 });
    const queue2 = await getReminderQueue({ branchId: 2 });
    expect(queue1.map((r) => r.supplierId)).toEqual([120]);
    expect(queue2.map((r) => r.supplierId)).toEqual([121]);
  });

  it("انقضاء التبريد: مورد ذُكِّر قبل ٨ أيام يعود للقائمة", async () => {
    await makeSupplierWithOverduePO({
      supplierId: 125,
      supplierName: "ذُكِّر قبل ٨ أيام",
      poId: 1025,
      poNumber: "PO-1025",
      orderDate: daysAgo(30),
      total: "200000",
    });
    await logReminderSent(
      {
        supplierId: 125,
        totalUnpaidSnapshot: "200000",
        oldestPoDate: daysAgo(30),
        daysOverdue: 30,
        messageBody: "تذكير قديم",
      },
      { userId: 1, branchId: 1 },
    );
    // داخل نافذة التبريد ⇒ مستبعَد.
    expect(await getReminderQueue({ branchId: 1 })).toEqual([]);
    // ادفع التذكير إلى الوراء ٨ أيام (تجاوز REMINDER_COOLDOWN_DAYS=7) ⇒ يجب أن يعود.
    await db().execute(sql`UPDATE apReminders SET createdAt = DATE_SUB(NOW(), INTERVAL 8 DAY)`);
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue.map((r) => r.supplierId)).toEqual([125]);
    expect(queue[0].lastReminderStatus).toBe("SENT");
    expect(queue[0].isPromiseDue).toBe(false);
  });

  it("branchId=null ⇒ تجميع كل الفروع (قراءة الأدمن المجمَّعة)", async () => {
    await makeSupplierWithOverduePO({
      supplierId: 126,
      supplierName: "مورد فرع ١ للتجميع",
      branchId: 1,
      poId: 1026,
      poNumber: "PO-1026",
      orderDate: daysAgo(20),
      total: "100000",
    });
    await makeSupplierWithOverduePO({
      supplierId: 127,
      supplierName: "مورد فرع ٢ للتجميع",
      branchId: 2,
      poId: 1027,
      poNumber: "PO-1027",
      orderDate: daysAgo(40),
      total: "80000",
    });
    const all = await getReminderQueue({ branchId: null });
    expect(all.map((r) => r.supplierId).sort()).toEqual([126, 127]);
    // التبريد الموحَّد عبر الفروع: تذكير للمورد ١٢٧ من فرعه يخفيه من القراءة المجمَّعة أيضاً.
    await logReminderSent(
      {
        supplierId: 127,
        totalUnpaidSnapshot: "80000",
        oldestPoDate: daysAgo(40),
        daysOverdue: 40,
        messageBody: "تذكير",
      },
      { userId: 2, branchId: 2 },
    );
    const after = await getReminderQueue({ branchId: null });
    expect(after.map((r) => r.supplierId)).toEqual([126]);
  });

  it("منع التكرار: مورد ذُكِّر خلال ٧ أيام لا يظهر مجدداً", async () => {
    await makeSupplierWithOverduePO({
      supplierId: 130,
      supplierName: "ذُكِّر أمس",
      poId: 1030,
      poNumber: "PO-1030",
      orderDate: daysAgo(20),
      total: "150000",
    });
    let queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toHaveLength(1);

    await logReminderSent(
      {
        supplierId: 130,
        totalUnpaidSnapshot: "150000",
        oldestPoDate: daysAgo(20),
        daysOverdue: 20,
        messageBody: "تنسيق سداد...",
      },
      { userId: 1, branchId: 1 },
    );

    queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toEqual([]);
  });
});

describe("apRemindersService - دلالة الرصيد الجاري (الذمم الحاكمة = currentBalance)", () => {
  it("مورد سُدِّد كامل ذمّته (currentBalance=0 وأوامره غير مسدَّدة) لا يُطالَب", async () => {
    await makeSupplierWithOverduePO({
      supplierId: 400,
      supplierName: "سُدِّد",
      poId: 4000,
      poNumber: "PO-4000",
      orderDate: daysAgo(30),
      total: "250000",
      currentBalance: "0",
    });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toEqual([]);
  });

  it("مورد مدين لنا (currentBalance سالب) لا يُطالَب", async () => {
    await makeSupplierWithOverduePO({
      supplierId: 401,
      supplierName: "مدين لنا",
      poId: 4001,
      poNumber: "PO-4001",
      orderDate: daysAgo(30),
      total: "100000",
      currentBalance: "-50000",
    });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toEqual([]);
  });

  it("تسديد جزئي ⇒ المبلغ = min(متبقّي أوامر الشراء، الرصيد الجاري)", async () => {
    await makeSupplierWithOverduePO({
      supplierId: 402,
      supplierName: "سُدِّد جزئياً",
      poId: 4002,
      poNumber: "PO-4002",
      orderDate: daysAgo(30),
      total: "100000",
      currentBalance: "40000",
    });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toHaveLength(1);
    expect(queue[0].totalUnpaid).toBe("40000.00");
  });

  it("رصيد جارٍ أكبر من متبقّي أوامر الشراء (افتتاحي إضافي) ⇒ المطالبة بمتبقّي الأوامر فقط", async () => {
    await makeSupplierWithOverduePO({
      supplierId: 403,
      supplierName: "افتتاحي فوق الأوامر",
      poId: 4003,
      poNumber: "PO-4003",
      orderDate: daysAgo(30),
      total: "100000",
      currentBalance: "175000",
    });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toHaveLength(1);
    expect(queue[0].totalUnpaid).toBe("100000.00");
  });
});

describe("apRemindersService - وعد السداد (promise tracking)", () => {
  beforeEach(async () => {
    await makeSupplierWithOverduePO({
      supplierId: 300,
      supplierName: "مورد وُعِد بسداده",
      poId: 3000,
      poNumber: "PO-3000",
      orderDate: daysAgo(20),
      total: "500000",
    });
  });

  it("تخطٍّ بوعد مستقبلي ⇒ المورد يختفي حتى يوم الوعد", async () => {
    let queue = await getReminderQueue({ branchId: 1 });
    expect(queue.map((r) => r.supplierId)).toEqual([300]);

    await logReminderSkipped(
      {
        supplierId: 300,
        totalUnpaidSnapshot: "500000",
        oldestPoDate: daysAgo(20),
        daysOverdue: 20,
        skipReason: "سنسدّد لاحقاً",
        promisedDate: daysAhead(3),
      },
      { userId: 1, branchId: 1 },
    );

    queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toEqual([]);
  });

  it("تخطٍّ بوعد اليوم ⇒ المورد يعود فوراً بشارة isPromiseDue (يتخطّى التبريد)", async () => {
    await logReminderSkipped(
      {
        supplierId: 300,
        totalUnpaidSnapshot: "500000",
        oldestPoDate: daysAgo(20),
        daysOverdue: 20,
        skipReason: "سنسدّد اليوم بعد الظهر",
        promisedDate: today(),
      },
      { userId: 1, branchId: 1 },
    );

    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toHaveLength(1);
    expect(queue[0].isPromiseDue).toBe(true);
    expect(queue[0].promisedDate).toBe(today());
    expect(queue[0].lastReminderStatus).toBe("SKIPPED");
  });

  it("الوعود المستحقّة تُرتَّب أعلى القائمة (أولوية على تأخّر الأوامر)", async () => {
    await makeSupplierWithOverduePO({
      supplierId: 301,
      supplierName: "متأخّر ٩٠ بلا وعد",
      poId: 3001,
      poNumber: "PO-3001",
      orderDate: daysAgo(90),
      total: "100000",
    });
    await logReminderSkipped(
      {
        supplierId: 300,
        totalUnpaidSnapshot: "500000",
        oldestPoDate: daysAgo(20),
        daysOverdue: 20,
        skipReason: "وعد اليوم",
        promisedDate: today(),
      },
      { userId: 1, branchId: 1 },
    );
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue.map((r) => r.supplierId)).toEqual([300, 301]);
    expect(queue[0].isPromiseDue).toBe(true);
    expect(queue[1].isPromiseDue).toBe(false);
  });

  it("وعد فات يومه (أمس) ⇒ يبقى ظاهراً بـisPromiseDue متجاوزاً التبريد", async () => {
    await db()
      .insert(s.apReminders)
      .values({
        supplierId: 300,
        branchId: 1,
        totalUnpaidSnapshot: "500000.00",
        oldestPoDate: daysAgo(20),
        daysOverdue: 20,
        messageBody: "",
        status: "SKIPPED",
        skipReason: "وعد قديم فات يومه",
        promisedDate: daysAgo(1),
        createdBy: 1,
      });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toHaveLength(1);
    expect(queue[0].supplierId).toBe(300);
    expect(queue[0].isPromiseDue).toBe(true);
    expect(queue[0].promisedDate).toBe(daysAgo(1));
  });

  it("رفض وعد في الماضي (المتابعة يجب أن تكون مستقبلاً)", async () => {
    await expect(
      logReminderSkipped(
        {
          supplierId: 300,
          totalUnpaidSnapshot: "500000",
          oldestPoDate: daysAgo(20),
          daysOverdue: 20,
          skipReason: "وعد ماضٍ خاطئ",
          promisedDate: daysAgo(1),
        },
        { userId: 1, branchId: 1 },
      ),
    ).rejects.toThrow(/الماضي/);
  });

  it("تخطٍّ بلا وعد ⇒ يتصرّف كتخطٍّ عاديّ (يخضع للتبريد)", async () => {
    await logReminderSkipped(
      {
        supplierId: 300,
        totalUnpaidSnapshot: "500000",
        oldestPoDate: daysAgo(20),
        daysOverdue: 20,
        skipReason: "قرار مؤقّت",
      },
      { userId: 1, branchId: 1 },
    );
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toEqual([]);
  });

  it("promisedDate يظهر في السجلّ التاريخي للسياق", async () => {
    await logReminderSkipped(
      {
        supplierId: 300,
        totalUnpaidSnapshot: "500000",
        oldestPoDate: daysAgo(20),
        daysOverdue: 20,
        skipReason: "وعد بعد أسبوع",
        promisedDate: daysAhead(7),
      },
      { userId: 1, branchId: 1 },
    );
    const history = await getReminderHistory({ branchId: 1 });
    expect(history).toHaveLength(1);
    expect(history[0].promisedDate).toBe(daysAhead(7));
    expect(history[0].skipReason).toBe("وعد بعد أسبوع");
  });
});

describe("apRemindersService - logReminderSent / logReminderSkipped", () => {
  beforeEach(async () => {
    await makeSupplierWithOverduePO({
      supplierId: 200,
      supplierName: "مورد اختبار",
      poId: 2000,
      poNumber: "PO-2000",
      orderDate: daysAgo(15),
      total: "100000",
    });
  });

  it("يسجّل تذكيراً مُرسَلاً بكل snapshots", async () => {
    const r = await logReminderSent(
      {
        supplierId: 200,
        totalUnpaidSnapshot: "100000",
        oldestPoDate: daysAgo(15),
        daysOverdue: 15,
        messageBody: "السلام عليكم، بخصوص حسابنا معكم.",
      },
      { userId: 1, branchId: 1 },
    );
    expect(r.id).toBeGreaterThan(0);

    const rows = await db().select().from(s.apReminders);
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
        supplierId: 200,
        totalUnpaidSnapshot: "100000",
        oldestPoDate: daysAgo(15),
        daysOverdue: 15,
        skipReason: "السداد مجدوَل نهاية الشهر",
      },
      { userId: 1, branchId: 1 },
    );
    expect(r.id).toBeGreaterThan(0);
    const rows = await db().select().from(s.apReminders);
    expect(rows[0].status).toBe("SKIPPED");
    expect(rows[0].skipReason).toBe("السداد مجدوَل نهاية الشهر");
    expect(rows[0].messageBody).toBe("");
  });

  it("يرفض تسجيل تذكير على مورد بلا أمر شراء في الفرع (IDOR)", async () => {
    await expect(
      logReminderSent(
        {
          supplierId: 200,
          totalUnpaidSnapshot: "100000",
          oldestPoDate: daysAgo(15),
          daysOverdue: 15,
          messageBody: "محاولة IDOR",
        },
        { userId: 2, branchId: 2 },
      ),
    ).rejects.toThrow(/لا أوامر شراء لهذا المورد/);
  });

  it("يرفض رصيداً غير موجب", async () => {
    await expect(
      logReminderSent(
        {
          supplierId: 200,
          totalUnpaidSnapshot: "0",
          oldestPoDate: daysAgo(15),
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
          supplierId: 200,
          totalUnpaidSnapshot: "100000",
          oldestPoDate: daysAgo(15),
          daysOverdue: 15,
          skipReason: "   ",
        },
        { userId: 1, branchId: 1 },
      ),
    ).rejects.toThrow(/سبب/);
  });

  it("سجلّ التاريخ يُعيد التذكيرات مع اسم المورد بترتيب الأحدث أولاً", async () => {
    await logReminderSent(
      { supplierId: 200, totalUnpaidSnapshot: "100000", oldestPoDate: daysAgo(15), daysOverdue: 15, messageBody: "أوّل" },
      { userId: 1, branchId: 1 },
    );
    await logReminderSkipped(
      { supplierId: 200, totalUnpaidSnapshot: "100000", oldestPoDate: daysAgo(15), daysOverdue: 15, skipReason: "لاحقاً" },
      { userId: 1, branchId: 1 },
    );
    const history = await getReminderHistory({ branchId: 1 });
    expect(history).toHaveLength(2);
    expect(history[0].status).toBe("SKIPPED"); // الأحدث أولاً
    expect(history[1].status).toBe("SENT");
    expect(history[0].supplierName).toBe("مورد اختبار");
  });
});
