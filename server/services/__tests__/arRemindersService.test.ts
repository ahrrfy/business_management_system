/**
 * اختبارات arRemindersService — تذكيرات الذمم الآجلة (سجلّ مراجعة → واتساب).
 *
 * تركّز على: منطق التصفية (٧ أيام + منع تكرار)، IDOR (فرع)، صحّة snapshots، وترتيب الأقدم أولاً.
 * لا نختبر getARAging الأساسي (له اختباراته الخاصّة) — نستدعيه كما هو.
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
  /** الرصيد الجاري إن اختلف عن total — لمحاكاة سند قبض مستقلّ (يخفّض الرصيد لا paidAmount)
   *  أو رصيد افتتاحي دائن. الافتراضي = total (لا دفعات على الحساب). */
  currentBalance?: string;
}): Promise<void> {
  const d = db();
  const branchId = opts.branchId ?? 1;
  await d.insert(s.customers).values({
    id: opts.customerId,
    name: opts.customerName,
    phone: opts.phone ?? "07901234567",
    customerType: "فرد",
    currentBalance: opts.currentBalance ?? opts.total,
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

  it("انقضاء التبريد: عميل ذُكِّر قبل ٨ أيام يعود للقائمة (الجانب الموجب — فجوة مراجعة ٥/٧)", async () => {
    await makeCustomerWithOverdueInvoice({
      customerId: 125,
      customerName: "ذُكِّر قبل ٨ أيام",
      invoiceId: 1025,
      invoiceNumber: "INV-1025",
      dueDate: daysAgo(30),
      total: "200000",
    });
    await logReminderSent(
      {
        customerId: 125,
        totalUnpaidSnapshot: "200000",
        oldestInvoiceDate: daysAgo(30),
        daysOverdue: 30,
        messageBody: "تذكير قديم",
      },
      { userId: 1, branchId: 1 },
    );
    // داخل نافذة التبريد ⇒ مستبعَد.
    expect(await getReminderQueue({ branchId: 1 })).toEqual([]);
    // ادفع التذكير إلى الوراء ٨ أيام (تجاوز REMINDER_COOLDOWN_DAYS=7) ⇒ يجب أن يعود.
    // انقلاب إشارة/وحدة زمنية في شرط `nowMs - last.at < cooldownMs` كان سيمرّ صامتاً بلا هذا الاختبار.
    await db().execute(sql`UPDATE arReminders SET createdAt = DATE_SUB(NOW(), INTERVAL 8 DAY)`);
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue.map((r) => r.customerId)).toEqual([125]);
    expect(queue[0].lastReminderStatus).toBe("SENT");
    expect(queue[0].isPromiseDue).toBe(false);
  });

  it("branchId=null ⇒ تجميع كل الفروع (قراءة الأدمن/برنامج اليوم)", async () => {
    await makeCustomerWithOverdueInvoice({
      customerId: 126,
      customerName: "عميل فرع ١ للتجميع",
      branchId: 1,
      invoiceId: 1026,
      invoiceNumber: "INV-1026",
      dueDate: daysAgo(20),
      total: "100000",
    });
    await makeCustomerWithOverdueInvoice({
      customerId: 127,
      customerName: "عميل فرع ٢ للتجميع",
      branchId: 2,
      invoiceId: 1027,
      invoiceNumber: "INV-1027",
      dueDate: daysAgo(40),
      total: "80000",
    });
    const all = await getReminderQueue({ branchId: null });
    expect(all.map((r) => r.customerId).sort()).toEqual([126, 127]);
    // التبريد الموحَّد عبر الفروع: تذكير لعميل ١٢٧ من فرعه يخفيه من القراءة المجمَّعة أيضاً.
    await logReminderSent(
      {
        customerId: 127,
        totalUnpaidSnapshot: "80000",
        oldestInvoiceDate: daysAgo(40),
        daysOverdue: 40,
        messageBody: "تذكير",
      },
      { userId: 2, branchId: 2 },
    );
    const after = await getReminderQueue({ branchId: null });
    expect(after.map((r) => r.customerId)).toEqual([126]);
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

describe("arRemindersService - دلالة الرصيد الجاري (مراجعة ٥/٧: الذمم الحاكمة = currentBalance)", () => {
  it("عميل سدّد كامل دينه «على الحساب» (سند مستقلّ ⇒ currentBalance=0 وفواتيره PENDING) لا يُطالَب", async () => {
    // سند القبض المستقلّ يخفّض customers.currentBalance عبر adjustCustomerBalance دون أن يمسّ
    // invoices.paidAmount ⇒ unpaidTotal يبقى موجباً رغم أن الذمّة صفر. نحاكي أثره النهائي مباشرة.
    await makeCustomerWithOverdueInvoice({
      customerId: 400,
      customerName: "سدّد على الحساب",
      invoiceId: 4000,
      invoiceNumber: "INV-4000",
      dueDate: daysAgo(30),
      total: "250000",
      currentBalance: "0",
    });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toEqual([]);
  });

  it("عميل دائن برصيد افتتاحي (currentBalance سالب) لا يُطالَب", async () => {
    await makeCustomerWithOverdueInvoice({
      customerId: 401,
      customerName: "دائن افتتاحياً",
      invoiceId: 4001,
      invoiceNumber: "INV-4001",
      dueDate: daysAgo(30),
      total: "100000",
      currentBalance: "-50000",
    });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toEqual([]);
  });

  it("دفعة جزئية على الحساب ⇒ المبلغ المُطالَب به = min(متبقّي الفواتير، الرصيد الجاري)", async () => {
    // فواتير متأخّرة بمتبقٍّ 100000 لكن العميل دفع 60000 على الحساب ⇒ ذمّته الجارية 40000.
    // الرسالة يجب أن تطالب بـ40000 لا 100000 (مطالبة بمبلغ مسدَّد = خطأ تجاه عميل حقيقي).
    await makeCustomerWithOverdueInvoice({
      customerId: 402,
      customerName: "دفع جزئياً على الحساب",
      invoiceId: 4002,
      invoiceNumber: "INV-4002",
      dueDate: daysAgo(30),
      total: "100000",
      currentBalance: "40000",
    });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toHaveLength(1);
    expect(queue[0].totalUnpaid).toBe("40000.00");
  });

  it("رصيد جارٍ أكبر من متبقّي الفواتير (افتتاحي مدين إضافي) ⇒ المطالبة بمتبقّي الفواتير فقط", async () => {
    // التذكير مبنيّ على فواتير متأخّرة محدَّدة — الجزء الافتتاحي/غير المُبوَّب لا يُضخّم الرسالة.
    await makeCustomerWithOverdueInvoice({
      customerId: 403,
      customerName: "افتتاحي مدين فوق الفواتير",
      invoiceId: 4003,
      invoiceNumber: "INV-4003",
      dueDate: daysAgo(30),
      total: "100000",
      currentBalance: "175000",
    });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toHaveLength(1);
    expect(queue[0].totalUnpaid).toBe("100000.00");
  });
});

describe("arRemindersService - وعد الدفع (promise tracking)", () => {
  beforeEach(async () => {
    await makeCustomerWithOverdueInvoice({
      customerId: 300,
      customerName: "عميل وَعَد",
      invoiceId: 3000,
      invoiceNumber: "INV-3000",
      dueDate: daysAgo(20),
      total: "500000",
    });
  });

  it("تخطٍّ بوعد مستقبلي ⇒ العميل يختفي من القائمة حتى يوم الوعد (يتخطّى العرض العاديّ)", async () => {
    // قبل التخطّي، العميل ظاهر
    let queue = await getReminderQueue({ branchId: 1 });
    expect(queue.map((r) => r.customerId)).toEqual([300]);

    // خطَّ بوعد بعد ٣ أيام (مستقبل)
    await logReminderSkipped(
      {
        customerId: 300,
        totalUnpaidSnapshot: "500000",
        oldestInvoiceDate: daysAgo(20),
        daysOverdue: 20,
        skipReason: "العميل وعد بالدفع",
        promisedDate: daysAhead(3),
      },
      { userId: 1, branchId: 1 },
    );

    // القائمة الآن فارغة (وعد مستقبلي = متابعة مؤجَّلة)
    queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toEqual([]);
  });

  it("تخطٍّ بوعد اليوم ⇒ العميل يعود فوراً بشارة isPromiseDue (يتخطّى التبريد)", async () => {
    // خطَّ بوعد اليوم نفسه (استحقاق فوري)
    await logReminderSkipped(
      {
        customerId: 300,
        totalUnpaidSnapshot: "500000",
        oldestInvoiceDate: daysAgo(20),
        daysOverdue: 20,
        skipReason: "وعد يدفع اليوم بعد الظهر",
        promisedDate: today(),
      },
      { userId: 1, branchId: 1 },
    );

    // العميل يعود للقائمة رغم أن تبريد ٧ أيام لم ينتهِ (استحقاق وعد أقوى من التبريد)
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toHaveLength(1);
    expect(queue[0].isPromiseDue).toBe(true);
    expect(queue[0].promisedDate).toBe(today());
    expect(queue[0].lastReminderStatus).toBe("SKIPPED");
  });

  it("الوعود المستحقّة تُرتَّب أعلى القائمة (أولوية على تأخّر الفواتير)", async () => {
    // عميل ثانٍ متأخّر ٩٠ يوماً بلا وعد (كان سيتصدّر بالترتيب العاديّ)
    await makeCustomerWithOverdueInvoice({
      customerId: 301,
      customerName: "متأخّر ٩٠ بلا وعد",
      invoiceId: 3001,
      invoiceNumber: "INV-3001",
      dueDate: daysAgo(90),
      total: "100000",
    });
    // خطَّ العميل الأوّل (٢٠ يوماً) بوعد اليوم — يجب أن يتصدّر رغم أن الثاني أكثر تأخّراً
    await logReminderSkipped(
      {
        customerId: 300,
        totalUnpaidSnapshot: "500000",
        oldestInvoiceDate: daysAgo(20),
        daysOverdue: 20,
        skipReason: "وعد اليوم",
        promisedDate: today(),
      },
      { userId: 1, branchId: 1 },
    );
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue.map((r) => r.customerId)).toEqual([300, 301]);
    expect(queue[0].isPromiseDue).toBe(true);
    expect(queue[1].isPromiseDue).toBe(false);
  });

  it("وعد فات يومه (أمس) ⇒ يبقى ظاهراً بـisPromiseDue متجاوزاً التبريد (فجوة مراجعة ٥/٧)", async () => {
    // logReminderSkipped يرفض وعداً ماضياً عند الإنشاء ⇒ نحاكي وعداً سُجِّل قبل أيام وفات يومه أمس
    // بإدراج الصفّ مباشرة (createdAt=الآن ⇒ داخل نافذة التبريد — يثبت أن الوعد الفائت يتجاوزها).
    // انحدارٌ يحوّل `promisedDate <= today` إلى `===` كان سيُضيع كل وعد فائت بصمت بلا هذا الاختبار.
    await db()
      .insert(s.arReminders)
      .values({
        customerId: 300,
        branchId: 1,
        totalUnpaidSnapshot: "500000.00",
        oldestInvoiceDate: daysAgo(20),
        daysOverdue: 20,
        messageBody: "",
        status: "SKIPPED",
        skipReason: "وعد قديم فات يومه",
        promisedDate: daysAgo(1),
        createdBy: 1,
      });
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toHaveLength(1);
    expect(queue[0].customerId).toBe(300);
    expect(queue[0].isPromiseDue).toBe(true);
    expect(queue[0].promisedDate).toBe(daysAgo(1));
  });

  it("رفض وعد في الماضي (المتابعة يجب أن تكون مستقبلاً)", async () => {
    await expect(
      logReminderSkipped(
        {
          customerId: 300,
          totalUnpaidSnapshot: "500000",
          oldestInvoiceDate: daysAgo(20),
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
        customerId: 300,
        totalUnpaidSnapshot: "500000",
        oldestInvoiceDate: daysAgo(20),
        daysOverdue: 20,
        skipReason: "قرار مؤقّت",
        // بلا promisedDate
      },
      { userId: 1, branchId: 1 },
    );
    const queue = await getReminderQueue({ branchId: 1 });
    expect(queue).toEqual([]); // مستبعَد بتبريد ٧ أيام
  });

  it("promisedDate يظهر في السجلّ التاريخي للسياق", async () => {
    await logReminderSkipped(
      {
        customerId: 300,
        totalUnpaidSnapshot: "500000",
        oldestInvoiceDate: daysAgo(20),
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

/** عميل بذمّة من قيد OPENING فقط (بلا أي فاتورة نظام) — يحاكي أحد الـ٣٢٥ عميلاً المستوردين. */
async function makeOpeningBalanceOnlyCustomer(opts: {
  customerId: number;
  customerName: string;
  phone?: string;
  currentBalance: string;
  openedOn: string; // YYYY-MM-DD
}): Promise<void> {
  const d = db();
  await d.insert(s.customers).values({
    id: opts.customerId,
    name: opts.customerName,
    phone: opts.phone ?? "07901234567",
    customerType: "فرد",
    currentBalance: opts.currentBalance,
    isActive: true,
  });
  await d.insert(s.accountingEntries).values({
    entryType: "OPENING",
    customerId: opts.customerId,
    amount: opts.currentBalance,
    entryDate: opts.openedOn,
    dedupeKey: `OPENING:CUSTOMER:${opts.customerId}`,
  });
}

describe("arRemindersService - مدينو الرصيد الافتتاحي فقط (قرار مالك ٥/٧)", () => {
  it("يُدرَج في النطاق المجمَّع (openingOnly) مؤرَّخاً من قيد OPENING، بشارة isOpeningBalance ومبلغ = الرصيد كاملاً", async () => {
    await makeOpeningBalanceOnlyCustomer({
      customerId: 500,
      customerName: "مستورد بلا فواتير",
      currentBalance: "750000",
      openedOn: daysAgo(30),
    });
    const queue = await getReminderQueue({ branchId: null, openingOnly: true });
    expect(queue).toHaveLength(1);
    expect(queue[0].customerId).toBe(500);
    expect(queue[0].isOpeningBalance).toBe(true);
    expect(queue[0].totalUnpaid).toBe("750000.00");
    expect(queue[0].oldestInvoiceDate).toBe(daysAgo(30));
    expect(queue[0].daysOverdue).toBe(30);
  });

  it("لا يظهر في طابور فرع محدَّد (بلا انتماء فرعيّ) — عزل الفرع يبقى سليماً", async () => {
    await makeOpeningBalanceOnlyCustomer({
      customerId: 501,
      customerName: "مستورد فرع محدَّد",
      currentBalance: "300000",
      openedOn: daysAgo(30),
    });
    expect(await getReminderQueue({ branchId: 1 })).toEqual([]);
    expect(await getReminderQueue({ branchId: 2 })).toEqual([]);
  });

  it("لا يظهر في التجميع العادي (branchId=null بلا openingOnly صريح) — يمنع تسرّبه لـdashboard.ts", async () => {
    await makeOpeningBalanceOnlyCustomer({
      customerId: 502,
      customerName: "مستورد نطاق عادي",
      currentBalance: "300000",
      openedOn: daysAgo(30),
    });
    // مرآة استدعاء dashboard.ts (getReminderQueue({branchId}) بلا openingOnly، وbranchId=null
    // لأي مدير مرتفع لا الأدمن حصراً — راجع reportsRouter.ts). تحقّق عدائي (٥/٧) كشف أن هذا كان
    // يُسرِّب مدينِي الافتتاحي إلى «برنامج اليوم» لكل مدير رغم أن الراوتر يمنعه صراحةً من رؤيتهم
    // عبر queue({openingScope:true}) (أدمن حصراً). الآن: نطاق مستقلّ لا يتفعّل إلا بـopeningOnly صريح.
    const queueAll = await getReminderQueue({ branchId: null });
    expect(queueAll.find((r) => r.customerId === 502)).toBeUndefined();
    // لكنه يظهر صحيحاً عبر النطاق الصريح.
    const openingOnly = await getReminderQueue({ branchId: null, openingOnly: true });
    expect(openingOnly.map((r) => r.customerId)).toContain(502);
  });

  it("متأخّر أقلّ من ٧ أيام من تاريخ الافتتاح ⇒ لا يظهر بعد", async () => {
    await makeOpeningBalanceOnlyCustomer({
      customerId: 503,
      customerName: "مستورد حديث",
      currentBalance: "100000",
      openedOn: daysAgo(3),
    });
    expect(await getReminderQueue({ branchId: null, openingOnly: true })).toEqual([]);
  });

  it("رصيد صفري (سُدِّد بالكامل) ⇒ لا يظهر رغم وجود قيد OPENING", async () => {
    await makeOpeningBalanceOnlyCustomer({
      customerId: 504,
      customerName: "مستورد سدَّد بالكامل",
      currentBalance: "0",
      openedOn: daysAgo(30),
    });
    expect(await getReminderQueue({ branchId: null, openingOnly: true })).toEqual([]);
  });

  it("رصيد دائن (سالب) بلا فواتير ⇒ لا يظهر", async () => {
    await makeOpeningBalanceOnlyCustomer({
      customerId: 505,
      customerName: "مستورد دائن",
      currentBalance: "-50000",
      openedOn: daysAgo(30),
    });
    expect(await getReminderQueue({ branchId: null, openingOnly: true })).toEqual([]);
  });

  it("عميل له قيد OPENING **و** فاتورة نظام معاً ⇒ يُعامَل كعميل فواتير (isOpeningBalance=false)، لا مسار الافتتاحي", async () => {
    const d = db();
    // عميل واحد بقيد OPENING (تاريخ قديم) **و** فاتورة نظام متأخّرة لاحقاً — oldestInvoiceDate
    // من الفاتورة (لا null) ⇒ يُصنَّف عبر مسار الفواتير لا مسار «الافتتاحي البحت».
    await d.insert(s.customers).values({
      id: 506,
      name: "مستورد له فاتورة لاحقاً",
      phone: "07901234567",
      customerType: "فرد",
      currentBalance: "900000",
      isActive: true,
    });
    await d.insert(s.accountingEntries).values({
      entryType: "OPENING",
      customerId: 506,
      amount: "700000",
      entryDate: daysAgo(60),
      dedupeKey: "OPENING:CUSTOMER:506",
    });
    await d.insert(s.invoices).values({
      id: 5060,
      invoiceNumber: "INV-5060",
      sourceType: "POS",
      sourceId: "test-5060",
      branchId: 1,
      customerId: 506,
      priceTier: "RETAIL",
      dueDate: daysAgo(20),
      subtotal: "200000",
      total: "200000",
      paidAmount: "0",
      status: "PENDING",
    });
    const queue = await getReminderQueue({ branchId: null, openingOnly: true });
    // لا يظهر في نطاق «الافتتاحي فقط» (له فاتورة ⇒ ليس بحتاً افتتاحياً).
    expect(queue.find((r) => r.customerId === 506)).toBeUndefined();
    const invoiceQueue = await getReminderQueue({ branchId: 1 });
    const row = invoiceQueue.find((r) => r.customerId === 506);
    expect(row?.isOpeningBalance).toBe(false);
  });

  it("logReminderSent لمدين افتتاحي بحت ينجح عبر assertOpeningBalanceDebtor (لا فاتورة فرعيّة مطلوبة)", async () => {
    await makeOpeningBalanceOnlyCustomer({
      customerId: 507,
      customerName: "مستورد للإرسال",
      currentBalance: "400000",
      openedOn: daysAgo(30),
    });
    const r = await logReminderSent(
      {
        customerId: 507,
        totalUnpaidSnapshot: "400000",
        oldestInvoiceDate: daysAgo(30),
        daysOverdue: 30,
        messageBody: "تذكير برصيد سابق",
        isOpeningBalance: true,
      },
      { userId: 1, branchId: 1 },
    );
    expect(r.id).toBeGreaterThan(0);
    const rows = await db().select().from(s.arReminders);
    expect(rows[0].status).toBe("SENT");
  });

  it("logReminderSent لعميل بلا رصيد افتتاحي موجب (وبلا فاتورة) ⇒ NOT_FOUND", async () => {
    await makePlainCustomer(508, "عميل بلا ذمّة");
    await expect(
      logReminderSent(
        {
          customerId: 508,
          totalUnpaidSnapshot: "100000",
          oldestInvoiceDate: daysAgo(30),
          daysOverdue: 30,
          messageBody: "محاولة خاطئة",
          isOpeningBalance: true,
        },
        { userId: 1, branchId: 1 },
      ),
    ).rejects.toThrow(/لا رصيد افتتاحيّ/);
  });
});

/** عميل عاديّ بلا أي ذمّة (لا فاتورة، لا قيد OPENING) — لاختبار رفض تذكير الافتتاحي عليه. */
async function makePlainCustomer(id: number, name: string): Promise<void> {
  await db().insert(s.customers).values({
    id,
    name,
    phone: "07900000000",
    customerType: "فرد",
    currentBalance: "0",
    isActive: true,
  });
}
