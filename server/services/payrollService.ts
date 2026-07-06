/* ============================================================================
 * خدمة الرواتب — وحدة الموارد البشرية (server/services/payrollService.ts)
 * مسيّر شهري بثلاث حالات (مسودة → معتمد → مدفوع) — وحدة مالية حسّاسة.
 *
 * السياسة المالية المعتمدة:
 *  - generatePayroll(period): داخل withTx؛ يرفض إن وُجد مسيّر لنفس الشهر مسبقاً.
 *    لكل موظف غير منتهي الخدمة:
 *      gross    = شهري ? salary + allowances : مجموع amount حضور ذلك الشهر
 *      overtime = 0 (افتراضي، يُحرَّر عبر updateItem)
 *      deductions = 0 (افتراضي، يُحرَّر عبر updateItem)
 *      net      = gross + overtime − deductions
 *      hours    = شهري ? null : مجموع ساعات الحضور
 *    يُدرَج المسيّر (draft) + بنوده، وتُحسَب مجاميعه وتُخزَّن. كل المبالغ عبر money.ts.
 *  - updateItem: يعيد حساب صافي البند + مجاميع المسيّر — فقط أثناء الحالة draft.
 *  - approveRun: draft → approved (+approvedAt).
 *  - payRun: approved → paid (+paidAt) داخل withTx، ويقيّد لكل بند قيد PAYMENT_OUT واحداً
 *    (راتب من الخزينة، بلا shiftId) بمفتاح dedupe فريد PAYROLL:<runId>:<employeeId>.
 *  - cancelRun: draft ⇒ حذف البنود + المسيّر. paid ⇒ عكس القيود (قيود معاكسة سالبة بمفتاح
 *    dedupe جديد PAYROLL-REV:<runId>:<employeeId>) ثم إعادة الحالة إلى approved. approved ⇒
 *    إعادة الحالة إلى draft (بلا قيود). انظر cancelRun للتوثيق الكامل.
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { desc, eq, getTableColumns, sql } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import { accountingEntries, attendance, commissionRunLines, commissionRuns, employees, payrollItems, payrollRuns, receipts } from "../../drizzle/schema";
import { and, inArray } from "drizzle-orm";
import type { Tx } from "../db";
import { postEntry } from "./ledgerService";
import { money, round2, toDateStr, toDbMoney } from "./money";
import { requireDb, withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { settleAdvancesOnPayTx, suggestDeductionsTx } from "./advancesService";

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertPeriod(period: string): string {
  const p = period?.trim();
  if (!p || !PERIOD_RE.test(p)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الشهر يجب أن يكون بصيغة YYYY-MM" });
  }
  return p;
}

/** أول يوم من الشهر (YYYY-MM-01) — يُستعمل entryDate للقيود ولا تأثير له على dedupe. */
function periodEntryDate(period: string): string {
  return `${period}-01`;
}

/** صافي البند = الإجمالي + الإضافي + العمولة − الاستقطاع (لا يقلّ عن الصفر منطقياً، لكن لا نقصّ —
 *  قد يكون الاستقطاع أكبر فعلاً (سلفة)؛ نتركه كما هو ليعكس الواقع، والواجهة تعرضه بدقّة).
 *  commissions (٦/٧/٢٦): العمولة تُلتقط من تشغيلة العمولات المعتمدة لنفس الشهر عند التوليد —
 *  موجبة دائماً (السالب لا يخصم من الراتب؛ يبقى مرحَّلاً في سلسلة التشغيلات). */
function computeNet(gross: Decimal, overtime: Decimal, commission: Decimal, deductions: Decimal): Decimal {
  return round2(gross.plus(overtime).plus(commission).minus(deductions));
}

/* ─────────────────────────── قراءة ─────────────────────────── */

export async function listRuns() {
  const db = requireDb();
  const rows = await db.select().from(payrollRuns).orderBy(desc(payrollRuns.period), desc(payrollRuns.id));
  return rows;
}

export async function getRun(id: number) {
  const db = requireDb();
  const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, id)).limit(1);
  if (!run) return null;
  const items = await db
    .select({
      ...getTableColumns(payrollItems),
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      position: employees.position,
      department: employees.department,
      colorTag: employees.colorTag,
      photoUrl: employees.photoUrl,
      employmentStatus: employees.employmentStatus,
      baseSalary: employees.salary,
    })
    .from(payrollItems)
    .leftJoin(employees, eq(payrollItems.employeeId, employees.id))
    .where(eq(payrollItems.runId, id))
    .orderBy(payrollItems.id);
  return {
    ...run,
    items: items.map((it) => ({ ...it, employeeName: fullEmployeeName(it) })),
  };
}

/* ─────────────────────────── حساب المجاميع ─────────────────────────── */

/** يجمع بنود المسيّر (داخل tx) ويحدّث رأس المسيّر بالمجاميع وعدد الموظفين. */
async function recomputeRunTotals(tx: Tx, runId: number): Promise<void> {
  const items = await tx
    .select({ gross: payrollItems.gross, overtime: payrollItems.overtime, commission: payrollItems.commission, deductions: payrollItems.deductions, net: payrollItems.net })
    .from(payrollItems)
    .where(eq(payrollItems.runId, runId));
  let g = new Decimal(0);
  let ot = new Decimal(0);
  let com = new Decimal(0);
  let ded = new Decimal(0);
  let net = new Decimal(0);
  for (const it of items) {
    g = g.plus(money(it.gross));
    ot = ot.plus(money(it.overtime));
    com = com.plus(money(it.commission));
    ded = ded.plus(money(it.deductions));
    net = net.plus(money(it.net));
  }
  await tx
    .update(payrollRuns)
    .set({
      employeeCount: items.length,
      totalGross: toDbMoney(g),
      totalOvertime: toDbMoney(ot),
      totalCommission: toDbMoney(com),
      totalDeductions: toDbMoney(ded),
      totalNet: toDbMoney(net),
    })
    .where(eq(payrollRuns.id, runId));
}

/* ─────────────────────────── توليد المسيّر ─────────────────────────── */

export async function generatePayroll(period: string, actor: Actor) {
  const p = assertPeriod(period);
  return withTx(async (tx) => {
    // رفض التكرار: مسيّر واحد لكل شهر (القاعدة تفرض UNIQUE أيضاً، نتحقّق مبكراً برسالة عربية).
    const [exists] = await tx.select({ id: payrollRuns.id }).from(payrollRuns).where(eq(payrollRuns.period, p)).limit(1);
    if (exists) throw new TRPCError({ code: "CONFLICT", message: `يوجد مسيّر رواتب لشهر ${p} بالفعل` });

    // كل الموظفين غير منتهي الخدمة (نشطون + في إجازة).
    const emps = await tx
      .select({
        id: employees.id,
        payType: employees.payType,
        salary: employees.salary,
        allowances: employees.allowances,
      })
      .from(employees)
      .where(sql`${employees.employmentStatus} <> 'terminated'`)
      .orderBy(employees.id);

    // commissions (٦/٧/٢٦): التقاط تشغيلة العمولات **المعتمدة** لنفس الشهر — بند «عمولة» لكل
    // موظف داخل نفس المعاملة (قفل رأس التشغيلة يمنع سباق إلغاء الاعتماد أثناء التوليد).
    // uq_payroll_period + ON DELETE SET NULL على payrollRunId يضمنان الالتقاط مرّة واحدة بالضبط:
    // حذف مسودة المسيّر يفكّ الربط تلقائياً فيلتقطها التوليد التالي بلا ازدواج.
    const [commissionRun] = await tx
      .select()
      .from(commissionRuns)
      .where(and(eq(commissionRuns.period, p), eq(commissionRuns.status, "approved")))
      .for("update");
    const commissionByEmp = new Map<number, Decimal>();
    if (commissionRun) {
      if (commissionRun.payrollRunId != null) {
        // دفاعي — لا يبلغه مسار سليم (مسيّر الشهر فريد والفكّ تلقائي مع حذف مسودته).
        throw new TRPCError({ code: "CONFLICT", message: "تشغيلة العمولات مرتبطة بمسيّر آخر — فكّ الربط أولاً." });
      }
      const cLines = await tx
        .select({ employeeId: commissionRunLines.employeeId, commissionAmount: commissionRunLines.commissionAmount })
        .from(commissionRunLines)
        .where(eq(commissionRunLines.runId, Number(commissionRun.id)));
      for (const l of cLines) commissionByEmp.set(Number(l.employeeId), money(l.commissionAmount));
    }

    // اكتمال التسوية: موظف له سطر عمولة لكنه خارج قائمة التوليد (فُصل بعد أن باع) يُلحق
    // ببند أجرٍ صفري كي تُصرف عمولته المستحقة مرّة واحدة ولا تضيع.
    const listedIds = new Set(emps.map((e) => Number(e.id)));
    const zeroGrossIds = new Set<number>();
    const missingIds = Array.from(commissionByEmp.keys()).filter((id) => money(commissionByEmp.get(id) ?? 0).gt(0) && !listedIds.has(id));
    if (missingIds.length > 0) {
      const extra = await tx
        .select({ id: employees.id, payType: employees.payType, salary: employees.salary, allowances: employees.allowances })
        .from(employees)
        .where(inArray(employees.id, missingIds));
      for (const e of extra) {
        zeroGrossIds.add(Number(e.id));
        emps.push(e);
      }
    }

    // الحارس بعد الاكتمال عمداً: منشأة كلُّ من تبقّى فيها مفصولون ذوو عمولات معتمدة
    // يجب أن تستطيع توليد مسيّر تسويتهم (بنود أجرٍ صفري بعمولة) — كان الحارس المبكر يمنعها.
    if (emps.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يوجد موظفون لتوليد مسيّر لهم" });
    }

    // مجاميع حضور الشهر لموظفي الساعة (amount + hours) — مطابقة بادئة YYYY-MM على عمود التاريخ.
    // تصفية على status IN ('PRESENT','LATE') كحارس عميق: حتى لو دخل أمر مالي صفّ ABSENT/LEAVE
    // بمبلغ موجب (سهو/استيراد بصمة/تعديل يدوي قديم) لا يدخل في gross — الأجر لا يدفع عن غياب.
    const attRows = await tx
      .select({
        employeeId: attendance.employeeId,
        sumAmount: sql<string>`COALESCE(SUM(${attendance.amount}), 0)`,
        sumHours: sql<string>`COALESCE(SUM(${attendance.hours}), 0)`,
      })
      .from(attendance)
      .where(sql`DATE_FORMAT(${attendance.attendanceDate}, '%Y-%m') = ${p} AND ${attendance.status} IN ('PRESENT', 'LATE')`)
      .groupBy(attendance.employeeId);
    const attMap = new Map<number, { amount: string; hours: string }>(
      attRows.map((r) => [Number(r.employeeId), { amount: String(r.sumAmount), hours: String(r.sumHours) }]),
    );

    // advances (بند 12ج، ٧/٧): اقتراح استقطاع السلف من أقدم سلفة نشطة لكل موظف —
    // يُملأ advanceDeduction ويدخل **ضمن** deductions (لا فوقها) فيَنقص net تلقائياً.
    const advanceByEmp = await suggestDeductionsTx(tx, emps.map((e) => Number(e.id)));

    // رأس المسيّر (مسودة) — المجاميع تُحدَّث بعد إدراج البنود.
    const runRes = await tx.insert(payrollRuns).values({
      period: p,
      branchId: actor.branchId ?? null,
      status: "draft",
      employeeCount: 0,
      totalGross: "0",
      totalOvertime: "0",
      totalDeductions: "0",
      totalNet: "0",
      createdBy: actor.userId,
    });
    const runId = extractInsertId(runRes);

    for (const e of emps) {
      const monthly = e.payType === "monthly";
      const zeroGross = zeroGrossIds.has(Number(e.id));
      const allowances = zeroGross ? new Decimal(0) : money(e.allowances ?? 0);
      let gross: Decimal;
      let hours: string | null;
      if (zeroGross) {
        // تسوية نهائية لمفصولٍ ذي عمولة مستحقة — لا راتب، عمولة فقط.
        gross = new Decimal(0);
        hours = null;
      } else if (monthly) {
        gross = round2(money(e.salary ?? 0).plus(allowances));
        hours = null;
      } else {
        const att = attMap.get(Number(e.id));
        gross = round2(money(att?.amount ?? 0));
        hours = new Decimal(att?.hours ?? 0).toFixed(2);
      }
      const overtime = new Decimal(0);
      const commission = commissionByEmp.get(Number(e.id)) ?? new Decimal(0);
      // استقطاع السلفة المقترح جزء من deductions ابتداءً (يُحرَّر لاحقاً عبر updateItem لكن لا
      // يهبط الاستقطاع الكلي دون جزء السلفة — انظر الحارس هناك).
      const advanceDeduction = advanceByEmp.get(Number(e.id))?.suggested ?? new Decimal(0);
      const deductions = advanceDeduction;
      const net = computeNet(gross, overtime, commission, deductions);
      await tx.insert(payrollItems).values({
        runId,
        employeeId: Number(e.id),
        payType: monthly ? "monthly" : "hourly",
        hours,
        gross: toDbMoney(gross),
        // مخصّصات لقطة العرض في القسيمة؛ مضمَّنة أصلاً في gross للشهري (gross = أساسي + مخصّصات).
        allowances: toDbMoney(monthly && !zeroGross ? allowances : 0),
        overtime: toDbMoney(overtime),
        commission: toDbMoney(commission),
        deductions: toDbMoney(deductions),
        advanceDeduction: toDbMoney(advanceDeduction),
        net: toDbMoney(net),
      });
    }

    await recomputeRunTotals(tx, runId);

    // ربط الالتقاط داخل نفس المعاملة — أثر تدقيقي ثنائي الاتجاه (التشغيلة تعرف مسيّرها).
    if (commissionRun) {
      await tx.update(commissionRuns).set({ payrollRunId: runId }).where(eq(commissionRuns.id, Number(commissionRun.id)));
    }
    return runId;
  }).then((runId) => getRun(runId));
}

/* ─────────────────────────── تحرير بند ─────────────────────────── */

export interface UpdateItemInput {
  overtime?: string | null;
  deductions?: string | null;
  note?: string | null;
}

export async function updateItem(itemId: number, input: UpdateItemInput) {
  return withTx(async (tx) => {
    const [item] = await tx.select().from(payrollItems).where(eq(payrollItems.id, itemId)).for("update").limit(1);
    if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "بند المسيّر غير موجود" });
    const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, Number(item.runId))).limit(1);
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "المسيّر غير موجود" });
    if (run.status !== "draft") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تعديل البنود إلا والمسيّر مسودة" });
    }

    const overtime = input.overtime != null ? money(input.overtime) : money(item.overtime);
    const deductions = input.deductions != null ? money(input.deductions) : money(item.deductions);
    if (overtime.isNegative()) throw new TRPCError({ code: "BAD_REQUEST", message: "العمل الإضافي لا يكون سالباً" });
    if (deductions.isNegative()) throw new TRPCError({ code: "BAD_REQUEST", message: "الاستقطاع لا يكون سالباً" });
    // advances (بند 12ج): استقطاع السلفة المولَّد ثابت في البند — التعديل اليدوي يطال بقية
    // الاستقطاعات (غياب/جزاء) فوقه فقط. السماح بالهبوط دونه يفكّ الاتساق مع تسوية السلف عند
    // الدفع (settleAdvancesOnPayTx تُنقص remaining بمقدار advanceDeduction كما وُلّد).
    const advancePart = money(item.advanceDeduction);
    if (deductions.lt(advancePart)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الاستقطاع لا يقلّ عن استقطاع السلفة المولَّد (${toDbMoney(advancePart)}) — لتغييره ألغِ المسودة وعدِّل السلفة ثم أعد التوليد`,
      });
    }
    // العمولة قراءة فقط هنا — تعديلها = إعادة احتساب تشغيلة العمولات قبل توليد المسيّر.
    const net = computeNet(money(item.gross), overtime, money(item.commission), deductions);

    await tx
      .update(payrollItems)
      .set({
        overtime: toDbMoney(overtime),
        deductions: toDbMoney(deductions),
        net: toDbMoney(net),
        note: input.note !== undefined ? (input.note?.trim() || null) : item.note,
      })
      .where(eq(payrollItems.id, itemId));

    await recomputeRunTotals(tx, Number(item.runId));
    return Number(item.runId);
  }).then((runId) => getRun(runId));
}

/* ─────────────────────────── اعتماد ─────────────────────────── */

export async function approveRun(id: number, actor: Actor) {
  return withTx(async (tx) => {
    const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).for("update").limit(1);
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "المسيّر غير موجود" });
    if (run.status !== "draft") throw new TRPCError({ code: "BAD_REQUEST", message: "يُعتمد المسيّر من حالة المسودة فقط" });
    if (Number(run.employeeCount) === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن اعتماد مسيّر فارغ" });
    // حارس المسيّر «الشبح»: صافٍ كلّي صفر/سالب لا يُعتمد (لا شيء يُدفع) ⇒ يُمنع اعتماد/دفع بلا قيد.
    if (money(run.totalNet).lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن اعتماد مسيّر صافيه صفر" });
    // SOD-01/02 (فصل المهام): المُعتمِد يجب أن يختلف عن مُولِّد المسيّر — يَكسر دورة إنشاء→اعتماد→دفع
    // المنفردة (المسار الحرج لاحتيال الرواتب). نُسجّل approvedBy في السجلّ الثابت لإثبات المُعتمِد المستقلّ.
    if (run.createdBy != null && Number(run.createdBy) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز اعتماد مسيّر أنشأته بنفسك — يلزم مُعتمِد آخر (فصل المهام)." });
    }
    await tx.update(payrollRuns).set({ status: "approved", approvedAt: new Date(), approvedBy: actor.userId }).where(eq(payrollRuns.id, id));
  }).then(() => getRun(id));
}

/* ─────────────────────────── دفع ─────────────────────────── */

/**
 * مفتاح dedupe التالي لأساسٍ معيّن (PAYROLL:<runId>:<empId> أو PAYROLL-REV:<runId>:<empId>).
 * عمود dedupeKey فريد (uq_entry_dedupe) ⇒ لو أعيد دفع مسيّر سبق عكسه، فإعادة استعمال
 * المفتاح الأساسي تصطدم بالقيد الفريد. لذا: المحاولة الأولى تأخذ المفتاح الأساسي (متوافق مع
 * التقارير والاختبارات)، والمحاولات التالية تأخذ لاحقة :r1، :r2 … ⇒ عكس ثمّ إعادة دفع يعملان
 * بلا اصطدام مع بقاء كل القيود (أصلية/عكسية/إعادة) في الدفتر للأثر التدقيقي.
 * يُستدعى داخل tx تقفل صفّ المسيّر (.for("update")) ⇒ لا سباق على العدّ.
 */
async function nextDedupeKey(tx: Tx, base: string): Promise<string> {
  const [row] = await tx
    .select({ c: sql<number>`COUNT(*)` })
    .from(accountingEntries)
    .where(sql`${accountingEntries.dedupeKey} = ${base} OR ${accountingEntries.dedupeKey} LIKE ${`${base}:r%`}`);
  const n = Number(row?.c ?? 0);
  return n === 0 ? base : `${base}:r${n}`;
}

/**
 * دفع المسيّر: approved → paid. لكل بند يُقيَّد قيد PAYMENT_OUT واحد بمبلغ صافي البند:
 *  - revenue = 0، amount = net، branchId = فرع الموظف نفسه (يسقط لفرع المسيّر إن غاب)
 *  - dedupeKey = PAYROLL:<runId>:<employeeId> (أو :r<n> عند إعادة الدفع بعد عكس) ⇒ يمنع الدفع
 *    المزدوج لنفس الموظف في نفس المحاولة، ويسمح بإعادة الدفع بعد عكس دون اصطدام بالقيد الفريد.
 *  - بلا shiftId (الرواتب تُصرف من الخزينة لا من صندوق الكاشير).
 * كل ذلك داخل tx واحدة ⇒ أي فشل يُرجِع الحالة وكل القيود.
 */
export async function payRun(id: number, actor: Actor) {
  return withTx(async (tx) => {
    const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).for("update").limit(1);
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "المسيّر غير موجود" });
    if (run.status !== "approved") throw new TRPCError({ code: "BAD_REQUEST", message: "يُدفع المسيّر بعد اعتماده فقط" });
    // SOD-01 (فصل المهام): الدافع يجب أن يختلف عن مُولِّد المسيّر — يَمنع دورة إنشاء→دفع منفردة
    // (المُعتمِد المستقلّ مفروض أصلاً في approveRun؛ هذا حارس إضافي على الصرف النقدي).
    if (run.createdBy != null && Number(run.createdBy) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز صرف مسيّر أنشأته بنفسك — يلزم دافع آخر (فصل المهام)." });
    }

    // نجلب فرع كل موظف (employees.branchId) مع البند ⇒ يُرحَّل مصروف راتبه بفرعه هو.
    const items = await tx
      .select({ ...getTableColumns(payrollItems), empBranchId: employees.branchId })
      .from(payrollItems)
      .leftJoin(employees, eq(payrollItems.employeeId, employees.id))
      .where(eq(payrollItems.runId, id))
      .orderBy(payrollItems.employeeId);
    if (items.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "لا بنود لدفعها" });

    // advances (بند 12ج): هل هذا **أول** دفع لهذا المسيّر أم إعادة دفع بعد عكس؟ تسوية السلف
    // (إنقاص remaining) تُطبَّق مرّة واحدة عند أول دفع فقط — عكس الدفع لا يُعيد أرصدة السلف
    // (متّسق مع دلالة cancelRun: القيود الأصلية تبقى والسلفة خُصمت فعلاً من راتبٍ صُرف)، وإعادة
    // الدفع بعد العكس لا تخصمها مرّة ثانية. الفحص قبل قيد أي مدفوعات هذه الجولة.
    const [prevPay] = await tx
      .select({ c: sql<number>`COUNT(*)` })
      .from(accountingEntries)
      .where(sql`${accountingEntries.dedupeKey} LIKE ${`PAYROLL:${id}:%`}`);
    const isFirstPay = Number(prevPay?.c ?? 0) === 0;

    const entryDate = new Date(periodEntryDate(run.period));
    for (const it of items) {
      const net = money(it.net);
      // قيد بصافر/سالب لا يُجمّل الدفتر — نتخطّاه (لا قيد نقدي بقيمة غير موجبة).
      if (net.lte(0)) continue;
      const empBranchId = it.empBranchId ?? run.branchId ?? null;
      // TREASURY-OUT (تدقيق ٢/٧): كان الدفع يكتب قيد PAYMENT_OUT بلا أي receipt ⇒ رصيد الخزينة
      // (مجموع receipts بـcashBucket='TREASURY') لا ينقص عند صرف الرواتب فينحرف تراكمياً بحجم
      // إجمالي الرواتب. الآن نُخرج نقداً فعلياً من الخزينة بإيصال OUT/TREASURY مربوط بالقيد.
      const rRes = await tx.insert(receipts).values({
        invoiceId: null,
        branchId: empBranchId,
        shiftId: null,
        cashBucket: "TREASURY",
        direction: "OUT",
        amount: toDbMoney(net),
        paymentMethod: "CASH",
        status: "COMPLETED",
        partyType: "OTHER",
        description: `راتب — مسيّر ${run.period}`,
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        // إسناد فرعي بفرع الموظف نفسه (لا فرع المُولِّد) ⇒ ربحية كل فرع دقيقة؛ يسقط لفرع المسيّر
        // إن لم يكن للموظف فرع. المسيّر مركزي على مستوى الشركة لكن القيد يُنسَب لفرع كل موظف.
        branchId: empBranchId,
        receiptId,
        amount: net,
        revenue: new Decimal(0),
        entryDate,
        dedupeKey: await nextDedupeKey(tx, `PAYROLL:${id}:${Number(it.employeeId)}`),
        notes: `راتب — مسيّر ${run.period}`,
      });
    }

    // advances (بند 12ج): إنقاص أرصدة السلف بمقدار advanceDeduction المصروف فعلاً —
    // بالأقدم أولاً، وSETTLED عند بلوغ الصفر. ذرّي مع الدفع (أي فشل يُدحرج كل شيء).
    if (isFirstPay) {
      await settleAdvancesOnPayTx(
        tx,
        items.map((it) => ({ employeeId: Number(it.employeeId), amount: money(it.advanceDeduction) })),
      );
    }

    await tx.update(payrollRuns).set({ status: "paid", paidAt: new Date(), paidBy: actor.userId }).where(eq(payrollRuns.id, id));
  }).then(() => getRun(id));
}

/* ─────────────────────────── إلغاء/عكس ─────────────────────────── */

/**
 * إلغاء المسيّر — السلوك حسب الحالة:
 *  - draft     ⇒ حذف البنود ثم رأس المسيّر (لا أثر محاسبي إطلاقاً).
 *  - approved  ⇒ إعادة الحالة إلى draft (لم تُقيَّد أي قيود بعد، فلا عكس).
 *  - paid      ⇒ عكس الدفع: لكل بند موجب يُقيَّد قيد PAYMENT_OUT معاكس بمبلغ سالب
 *               (dedupeKey مستقل PAYROLL-REV:<runId>:<employeeId> حتى لا يصطدم بقيد الدفع الأصلي)،
 *               ثم تُعاد الحالة إلى approved. القيود الأصلية تبقى للأثر التدقيقي، والمحصّلة الصافية
 *               في الدفتر = صفر بعد القيود المعاكسة. إعادة الدفع لاحقاً مدعومة: nextDedupeKey يمنح
 *               قيد الدفع الجديد لاحقة :r<n> فلا يصطدم بالمفتاح الأصلي (انظر payRun).
 *
 * ملاحظة تصميم: لا نحذف صفوف accountingEntries الأصلية (سجلّ مالي ثابت). العكس يكون بقيود
 * معاكسة — متّسقاً مع نمط cancelExpense (قيد ADJUST/عكس بدل الحذف).
 *
 * advances (بند 12ج): عكس مسيّر **مدفوع** لا يُعيد أرصدة السلف (remaining) المُنقَصة عند
 * الدفع الأول — قرار موثَّق: التسوية وقعت على راتبٍ صُرف فعلاً، والعكس المحاسبي لا يلغي
 * واقعة الخصم؛ وإعادة الدفع اللاحقة لا تخصم السلف مرّة ثانية (payRun يتسوّى مرة واحدة فقط
 * عبر فحص isFirstPay). تصحيح السلف بعد عكس نهائي = شأن يدوي بقرار مدير.
 */
export async function cancelRun(id: number, actor: Actor) {
  return withTx(async (tx) => {
    const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).for("update").limit(1);
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "المسيّر غير موجود" });

    if (run.status === "draft") {
      await tx.delete(payrollItems).where(eq(payrollItems.runId, id));
      await tx.delete(payrollRuns).where(eq(payrollRuns.id, id));
      return { id, deleted: true, status: "deleted" as const };
    }

    if (run.status === "approved") {
      await tx.update(payrollRuns).set({ status: "draft", approvedAt: null }).where(eq(payrollRuns.id, id));
      return { id, deleted: false, status: "draft" as const };
    }

    // paid ⇒ عكس قيود الدفع بقيود معاكسة سالبة، ثم العودة إلى approved.
    // العكس يطابق إسناد الدفع: بفرع الموظف نفسه ⇒ تتصافر محصّلة كل فرع بدقّة بعد العكس.
    const items = await tx
      .select({ ...getTableColumns(payrollItems), empBranchId: employees.branchId })
      .from(payrollItems)
      .leftJoin(employees, eq(payrollItems.employeeId, employees.id))
      .where(eq(payrollItems.runId, id))
      .orderBy(payrollItems.employeeId);
    const entryDate = new Date(toDateStr());
    for (const it of items) {
      const net = money(it.net);
      if (net.lte(0)) continue;
      const empBranchId = it.empBranchId ?? run.branchId ?? null;
      // TREASURY-OUT (تدقيق ٢/٧): عكس الدفع يُعيد النقد للخزينة بإيصال IN/TREASURY (المبلغ موجب،
      // الاتجاه IN — قيد CHECK يمنع مبلغاً سالباً) ⇒ يتصافر رصيد الخزينة تماماً بعد العكس.
      const rRes = await tx.insert(receipts).values({
        invoiceId: null,
        branchId: empBranchId,
        shiftId: null,
        cashBucket: "TREASURY",
        direction: "IN",
        amount: toDbMoney(net),
        paymentMethod: "CASH",
        status: "COMPLETED",
        partyType: "OTHER",
        description: `عكس راتب — مسيّر ${run.period}`,
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId: empBranchId,
        receiptId,
        amount: net.neg(),
        revenue: new Decimal(0),
        entryDate,
        dedupeKey: await nextDedupeKey(tx, `PAYROLL-REV:${id}:${Number(it.employeeId)}`),
        notes: `عكس راتب — مسيّر ${run.period}`,
      });
    }
    await tx.update(payrollRuns).set({ status: "approved", paidAt: null }).where(eq(payrollRuns.id, id));
    return { id, deleted: false, status: "approved" as const };
  });
}
