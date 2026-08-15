// دورة حياة مسيّر الرواتب بعد المسودة: الاعتماد (draft→approved)، الدفع (approved→paid عبر قيود
// PAYMENT_OUT وإيصالات خزينة فعلية)، والإلغاء/العكس (حسب الحالة — حذف/تراجع/عكس محاسبي بقيود معاكسة).
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { accountingEntries, commissionRuns, employees, payrollItems, payrollRuns, receipts } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { restoreAdvanceSettlementsTx, settleAdvancesOnPayTx } from "../advancesService";
import { assertCashOutAvailable } from "../cash/cashAvailability";
import { postEntry } from "../ledgerService";
import { money, round2, toDateStr, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { periodEntryDate } from "./helpers";
import { getRun } from "./queries";

export async function approveRun(id: number, actor: Actor) {
  return withTx(async (tx) => {
    const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).for("update").limit(1);
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "المسيّر غير موجود" });
    if (run.status !== "draft") throw new TRPCError({ code: "BAD_REQUEST", message: "يُعتمد المسيّر من حالة المسودة فقط" });
    if (Number(run.employeeCount) === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن اعتماد مسيّر فارغ" });
    // حارس المسيّر «الشبح»: صافٍ كلّي صفر/سالب لا يُعتمد (لا شيء يُدفع) ⇒ يُمنع اعتماد/دفع بلا قيد.
    if (money(run.totalNet).lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن اعتماد مسيّر صافيه صفر" });
    const items = await tx.select({ net: payrollItems.net }).from(payrollItems).where(eq(payrollItems.runId, id));
    if (items.some((item) => money(item.net).isNegative())) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن اعتماد مسيّر يحتوي على صافي راتب سالب" });
    }
    const payableTotal = items.reduce((sum, item) => sum.plus(money(item.net)), new Decimal(0));
    if (!round2(payableTotal).eq(round2(money(run.totalNet)))) {
      throw new TRPCError({ code: "CONFLICT", message: "إجمالي المسيّر لا يطابق مجموع مبالغ الدفع — أعد توليد المسيّر" });
    }
    // #12 (تدقيق التثبيت): حارس التقاط العمولة — تشغيلة عمولات معتمدة لنفس الشهر بلا payrollRunId
    // يعني عمولة معتمدة ستضيع (تُدفع في مسيّر لاحق أو لا تُدفع). التوليد كان يلتقط عند الإنشاء فقط،
    // فتشغيلة اعتُمدت بعد التوليد لا تُلتقَط. الاعتماد يحرس: يُرفض حتى يُعاد توليد المسيّر أو يُلغى
    // اعتماد التشغيلة. لا صرف صامت بلا اعتراف.
    const [uncaptured] = await tx
      .select({ id: commissionRuns.id, period: commissionRuns.period })
      .from(commissionRuns)
      .where(
        and(
          eq(commissionRuns.period, run.period),
          eq(commissionRuns.status, "approved"),
          isNull(commissionRuns.payrollRunId),
        ),
      )
      .limit(1);
    if (uncaptured) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `تشغيلة عمولات معتمدة (#${uncaptured.id}) لشهر ${uncaptured.period} غير مُلتقَطة في هذا المسيّر — أعد توليد المسيّر لالتقاطها، أو ألغِ اعتماد التشغيلة قبل اعتماد المسيّر.`,
      });
    }
    // SOD-01/02 (فصل المهام): المُعتمِد يجب أن يختلف عن مُولِّد المسيّر — يَكسر دورة إنشاء→اعتماد→دفع
    // المنفردة (المسار الحرج لاحتيال الرواتب). نُسجّل approvedBy في السجلّ الثابت لإثبات المُعتمِد المستقلّ.
    if (run.createdBy != null && Number(run.createdBy) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز اعتماد مسيّر أنشأته بنفسك — يلزم مُعتمِد آخر (فصل المهام)." });
    }
    await tx.update(payrollRuns).set({ status: "approved", approvedAt: new Date(), approvedBy: actor.userId }).where(eq(payrollRuns.id, id));
  }).then(() => getRun(id));
}

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
    if (items.some((item) => money(item.net).isNegative())) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الدفع مرفوض: يوجد بند راتب بصافٍ سالب" });
    }
    const payoutTotal = items.reduce((sum, item) => sum.plus(money(item.net)), new Decimal(0));
    if (!round2(payoutTotal).eq(round2(money(run.totalNet)))) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "الدفع مرفوض: مجموع مبالغ الموظفين لا يساوي إجمالي صافي المسيّر",
      });
    }

    // نقفل خزائن الفروع بترتيب ثابت ونفحص **إجمالي** صافي كل فرع قبل أي إيصال.
    // فحص كل موظف منفرداً لا يكفي إذا كان كل راتب دون الرصيد ومجموعها يتجاوزه.
    const treasuryByBranch = new Map<number, Decimal>();
    for (const item of items) {
      const net = money(item.net);
      if (net.lte(0)) continue;
      const branchId = item.empBranchId ?? run.branchId ?? null;
      if (branchId == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "صرف الرواتب نقداً يتطلب فرعاً محدداً لكل موظف أو للمسيّر",
        });
      }
      const id = Number(branchId);
      treasuryByBranch.set(id, (treasuryByBranch.get(id) ?? money(0)).plus(net));
    }
    for (const [branchId, amount] of Array.from(treasuryByBranch.entries()).sort(
      ([left], [right]) => left - right,
    )) {
      await assertCashOutAvailable(tx, {
        branchId,
        cashBucket: "TREASURY",
        amount,
        operation: "صرف مسيّر الرواتب",
      });
    }

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

      /*
       * استقطاع السلفة: أجرٌ **مكتسَبٌ فعلاً** لم يخرج نقداً الآن لأن نقده خرج سلفاً.
       * بلا هذا القيد يُعترَف مصروفُ الرواتب بالصافي وحده، بينما سندُ السلفة الأصلي
       * (PAYMENT_OUT بمفتاح غير PAYROLL) لا يدخل قائمة الدخل أبداً ⇒ يختفي المبلغ من
       * المصروف نهائياً والربحُ مضخَّمٌ به دائماً (موظفٌ بأجر ١م وسلفة ٣٠٠ألف كان يُسجَّل
       * مصروفُه ٧٠٠ألف فقط). قيدٌ **بلا إيصال** ⇒ يرفع المصروف ولا يمسّ الخزينة
       * (النقد خرج وقت المنح فعلاً). المفتاح ضمن نطاق PAYROLL% فيدخل قائمة الدخل،
       * ويُعكَس مع بقية قيود المسيّر عند إلغاء الدفع (PAYROLL-REV).
       */
      const advanceRecovered = money(it.advanceDeduction ?? 0);
      if (advanceRecovered.gt(0)) {
        await postEntry(tx, {
          entryType: "PAYMENT_OUT",
          branchId: empBranchId,
          receiptId: null,
          amount: advanceRecovered,
          revenue: new Decimal(0),
          entryDate,
          dedupeKey: await nextDedupeKey(tx, `PAYROLL:${id}:${Number(it.employeeId)}:ADV`),
          notes: `استرداد سلفة من الراتب — مسيّر ${run.period} (أجرٌ مكتسَب، نقدُه خرج عند المنح)`,
        });
      }
    }

    // advances (بند 12ج): إنقاص أرصدة السلف بمقدار advanceDeduction المصروف فعلاً —
    // بالأقدم أولاً، وSETTLED عند بلوغ الصفر. ذرّي مع الدفع (أي فشل يُدحرج كل شيء).
    if (isFirstPay) {
      await settleAdvancesOnPayTx(
        tx,
        items.map((it) => {
          // سقف دفاعيّ (دفاع في العمق): لا تُسوَّ سلفةٌ بأكثر من الأجر الإجماليّ المكتسَب في البند
          // (gross + overtime + commission). توليدُ المسيّر يقصّ advanceDeduction عند هذا الأصل بالفعل،
          // فهذا السطر لا يغيّر شيئاً للبيانات السليمة — لكنه يحمي أيّ مسودة وُلّدت **قبل** إصلاح القصّ
          // من شطب سلفةٍ بلا استردادٍ نقديّ مقابل. لا يمسّ استقطاعات الغياب/الجزاء اليدوية (خارج هذا الأصل).
          const earned = Decimal.max(0, money(it.gross).plus(money(it.overtime)).plus(money(it.commission)));
          const settleAmount = Decimal.min(money(it.advanceDeduction), earned);
          return { employeeId: Number(it.employeeId), amount: settleAmount };
        }),
        id,
      );
    }

    await tx.update(payrollRuns).set({ status: "paid", paidAt: new Date(), paidBy: actor.userId }).where(eq(payrollRuns.id, id));
  }).then(() => getRun(id));
}

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
export async function cancelRun(id: number, actor: Actor & { enforceCashReturnEvidence?: boolean }) {
  return withTx(async (tx) => {
    const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).for("update").limit(1);
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "المسيّر غير موجود" });
    if (run.status === "paid" && actor.enforceCashReturnEvidence) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لا يمكن عكس راتب مدفوع من شاشة الرواتب لأن ذلك لا يثبت رجوع النقد. سجّل تحصيل النقد فعلياً من مسار الخزينة ثم نفّذ تسوية محاسبية موثقة.",
      });
    }

    if (run.status === "draft") {
      // استعادة تسويات السلف (تدقيق ١٧/٧): إن كان المسيّر قد دُفع سابقاً ثم عُكس فأُعيد لمسودة، فحذفه
      // يُلغي أثره نهائياً ⇒ نُعيد remaining للسلف قبل الحذف، وإلا خصمها توليدُ مسيّرٍ جديد مرّةً ثانية.
      // (المسيّر الذي لم يُدفع قطّ لا يحمل سجلّات تسوية ⇒ لا أثر.)
      await restoreAdvanceSettlementsTx(tx, id);
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

      // مرآةُ قيد استرداد السلفة (بلا إيصال — لم يخرج نقدٌ عنده فلا يعود عنده). بدونها
      // يبقى مصروفُ السلفة في قائمة الدخل بعد عكس المسيّر ⇒ مصروفٌ بلا مسيّر.
      const advanceRecovered = money(it.advanceDeduction ?? 0);
      if (advanceRecovered.gt(0)) {
        await postEntry(tx, {
          entryType: "PAYMENT_OUT",
          branchId: empBranchId,
          receiptId: null,
          amount: advanceRecovered.neg(),
          revenue: new Decimal(0),
          entryDate,
          dedupeKey: await nextDedupeKey(tx, `PAYROLL-REV:${id}:${Number(it.employeeId)}:ADV`),
          notes: `عكس استرداد سلفة — مسيّر ${run.period}`,
        });
      }
    }
    // عكس مسيّر مدفوع لا يستعيد أرصدة السلف (remaining) — قرار موثَّق: التسوية وقعت على راتبٍ صُرف،
    // وإعادة الدفع اللاحقة لا تخصمها ثانيةً (isFirstPay). الاستعادة تحدث عند **حذف** المسيّر فقط
    // (draft ⇒ restoreAdvanceSettlementsTx، تدقيق ١٧/٧) عبر سجلّات advanceSettlements المربوطة بالمسيّر
    // ⇒ حذف+إعادة توليد لم يعُد يخصم السلفة مضاعفاً.
    await tx.update(payrollRuns).set({ status: "approved", paidAt: null }).where(eq(payrollRuns.id, id));
    return { id, deleted: false, status: "approved" as const };
  });
}
