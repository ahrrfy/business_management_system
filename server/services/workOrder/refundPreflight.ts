/**
 * **تمهيدُ الاسترداد** — يُجيب الشاشةَ بما سيفعله الخادمُ فعلاً، لا بما تظنّه.
 *
 * العقدُ ودواعيه في [`shared/refundPreflight.ts`](../../../shared/refundPreflight.ts).
 *
 * ⚠️ **قاعدةُ هذا الملفّ:** كلُّ مبلغٍ هنا يُحسَب **بنفس المُرشِّح الذي ستستعمله العملية**،
 * ومن نفس المساعدين ([`appliedCollectionsForWorkOrder`](../reception/deposits.ts)،
 * [`workOrderFeeHeldNet`](./deliveryFeeRefund.ts)) — فأيُّ تغييرٍ في قواعد الردّ ينعكس هنا
 * تلقائياً. تكرارُ المنطق نسخاً كان سيُنتج تمهيداً يشيخ بصمتٍ ويكذب على الشاشة.
 */
import { and, eq, inArray, isNull, notLike, or, sql } from "drizzle-orm";
import { deliveryConsignments, invoices, receipts, shifts, users, workOrders } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2, toDbMoney } from "../money";
import { MATERIALIZED_RECEIPT_STATUSES, computeDrawerCashBalance, computeTreasuryCashBalance } from "../cash/cashAvailability";
import { appliedCollectionsForWorkOrder } from "../reception/deposits";
import { workOrderFeeHeldNet } from "./deliveryFeeRefund";
import type { RefundDrawerCandidate, RefundPreflight, WorkOrderRefundOperation } from "@shared/refundPreflight";

/** طرقُ القبض التي يخرج ردُّها نقداً — TELECOM بلا سكّة ردّ فيُردّ نقداً (نفسُ قاعدة الخدمات). */
function exitsCashDrawer(method: string | null | undefined): boolean {
  return method === "CASH" || method === "TELECOM";
}

/**
 * الأدراجُ المفتوحة المؤهَّلة — **مُصفّاةٌ بالفرع والنوع هنا** لا في الشاشة.
 *
 * `shiftType = null` ⇒ أيّ درجٍ مفتوح (مسارُ التوصيل، `resolveBranchCashShiftTx`).
 * وقيمةٌ نصّية ⇒ يُقصَر عليها (مسارُ أمر الشغل، `resolveLockedReceptionCashShift`).
 */
async function eligibleDrawers(
  tx: Tx,
  branchId: number,
  shiftType: string | null,
  opts: { needed: ReturnType<typeof money>; exposeCash: boolean },
): Promise<RefundDrawerCandidate[]> {
  const conds = [eq(shifts.branchId, branchId), eq(shifts.status, "OPEN")];
  if (shiftType != null) conds.push(eq(shifts.shiftType, shiftType as "RECEPTION"));
  const rows = await tx
    .select({
      shiftId: shifts.id,
      userId: shifts.userId,
      userName: users.name,
      shiftType: shifts.shiftType,
      openingBalance: shifts.openingBalance,
    })
    .from(shifts)
    .leftJoin(users, eq(users.id, shifts.userId))
    .where(and(...conds));

  const out: RefundDrawerCandidate[] = [];
  for (const r of rows) {
    // نفسُ صيغة `assertCashOutAvailable` ⇒ ما تعرضه الشاشة هو ما يقيس به الحارس.
    const available = await computeDrawerCashBalance(tx, Number(r.shiftId), r.openingBalance ?? "0");
    out.push({
      shiftId: Number(r.shiftId),
      userId: Number(r.userId),
      userName: String(r.userName ?? ""),
      shiftType: String(r.shiftType ?? ""),
      // الرقمُ الحسّاس لمن يملك الخزينة؛ وللبقية علَمُ الكفاية وحده.
      ...(opts.exposeCash ? { expectedCash: toDbMoney(round2(available)) } : {}),
      sufficient: available.gte(opts.needed),
    });
  }
  return out;
}

/**
 * النقدُ الخارج عند **إلغاء** أمر الشغل — **مطابقٌ لبنية `cancelWorkOrder` بنداً بند.**
 *
 * ثلاثةُ روافدَ تُخرج نقداً، بنفس شروطها في [`cancel.ts`](./cancel.ts):
 *  ① **العربونُ المباشر** — محكومٌ بـ`deposit > 0` (إيصالُه يحمل قيمةَ العمود).
 *  ② **حصصُ العربون المطبَّقة** (`orderPayments`) — **بلا حارسِ العربون** بعد سدّ الفجوة (١/٩):
 *     كانت الحلقةُ في `cancel.ts` داخل `if (refundD.gt(0))` فتُتخطّى حين `deposit = 0`، تاركةً
 *     مالَ العميل في الدرج بلا مسار خروجٍ (خرقُ §٥). أُخرِجت من الحارس هناك، فيجب أن تُحسَب
 *     هنا كذلك بلا حارس — وإلّا قال التمهيدُ «لا نقد» بينما الخدمةُ تصرفها وتطلب درجاً.
 *  ③ **أمانةُ أجرة التوصيل** — نقداً دائماً.
 *
 * القاعدةُ الحاكمة: **يُحسَب بنفس شرط التنفيذ حرفاً بحرف** — أيّ انحرافٍ يُنتج حائطاً أو تقديراً
 * كاذباً. أُثبت هذا التلازمُ باختبار تكاملٍ ([`refundPreflightAppliedGap.test.ts`](../__tests__/refundPreflightAppliedGap.test.ts)).
 */
async function cancelCashOut(tx: Tx, workOrderId: number, deposit: string | null): Promise<{ total: ReturnType<typeof money>; hasCashOnlyPortion: boolean }> {
  let total = money(0);
  // **الجزءُ النقديُّ الذي لا يقبل البطاقة** — حصصٌ مطبَّقة أو أمانةُ أجرة: كلاهما يُردّ نقداً
  // حتماً (مراجعة Codex P2). وجودُه يمنع رافدَ CARD كي لا يُنشأ طلبُ تحكّمٍ يستحيل اعتمادُه.
  let hasCashOnlyPortion = false;
  const refundD = round2(money(deposit ?? "0"));

  // ① العربونُ المباشر — محكومٌ بـ`deposit > 0` كما في `cancel.ts` (إيصالُه يحمل قيمةَ العمود).
  if (refundD.gt(0)) {
    const dep = (
      await tx
        .select({ amount: receipts.amount, paymentMethod: receipts.paymentMethod })
        .from(receipts)
        .where(and(
          eq(receipts.workOrderId, workOrderId),
          eq(receipts.direction, "IN"),
          eq(receipts.status, "COMPLETED"),
          eq(receipts.approvalStatus, "APPROVED"),
          isNull(receipts.invoiceId),
          or(isNull(receipts.referenceNumber), notLike(receipts.referenceNumber, "DLV-FEE-%")),
        ))
        .limit(1)
    )[0];
    if (dep && exitsCashDrawer(dep.paymentMethod)) total = total.plus(money(dep.amount));
  }

  // ② حصصُ العربون المطبَّقة — **بلا حارسِ العربون** (مطابقةً لـ`cancel.ts` بعد سدّ الفجوة ١/٩):
  // تُصرَف حين توجد حصصٌ فعلاً ولو كان `deposit = 0`. لو بقيت داخل الحارس هنا لَقال التمهيدُ
  // «لا نقد» بينما الخدمةُ تصرفها وتطلب درجاً ⇒ الحائطُ الذي حذّر منه الفحص.
  for (const part of await appliedCollectionsForWorkOrder(tx, workOrderId)) {
    const amt = round2(money(part.amount));
    if (amt.lte(0)) continue;
    if (exitsCashDrawer(part.method)) {
      total = total.plus(amt);
      hasCashOnlyPortion = true;
    }
  }

  // ③ أمانةُ أجرة التوصيل — نقداً دائماً، خارج الحارس كذلك.
  const feeHeld = await workOrderFeeHeldNet(tx, workOrderId);
  total = total.plus(feeHeld);
  if (feeHeld.gt(0)) hasCashOnlyPortion = true;

  return { total: round2(total), hasCashOnlyPortion };
}

/**
 * النقدُ الخارج عند **استرجاع تسليم** أمر الشغل.
 *
 * ⚠️ **درسٌ بالثمن (مراجعة Codex على #928):** أدخلتُ هنا استثناءً «الفاتورةُ ذاتُ البنود
 * تُفوَّض إلى `returnSaleInTx` بلا درج ⇒ صفر» — بناءً على قراءةٍ لِـ`reverseDelivery.ts`
 * **لم تعد قائمة**: الملفُّ أُعيدت كتابته، ولا أثرَ فيه لـ`returnSaleInTx`؛ التنفيذُ يمرّ على
 * مصادر الردّ ويطلب درجَ استقبالٍ مقفلاً لكلّ مصدرٍ نقديّ. فكان استثنائي يُبلّغ «لا درج» بينما
 * التنفيذُ يطلبه ⇒ حمولةٌ بلا `refundShiftId` ⇒ فشلُ اشتقاق الوردية عند تعدّد الأدراج.
 * ⇒ أُزيل الاستثناء. **والقاعدة: تحقّق من الشيفرة الحاليّة لا من ذاكرةِ قراءةٍ سابقة.**
 *
 * والحسبة: مجموعُ إيصالات IN المكتملة **النقديّة وحدها** — لا `paidAmount` الإجماليّ.
 */
async function reverseCashOut(
  tx: Tx,
  workOrderId: number,
  invoiceId: number | null,
): Promise<ReturnType<typeof money>> {
  const rows = await tx
    .select({ amount: receipts.amount, paymentMethod: receipts.paymentMethod })
    .from(receipts)
    .where(and(
      invoiceId != null
        ? or(eq(receipts.invoiceId, invoiceId), eq(receipts.workOrderId, workOrderId))!
        : eq(receipts.workOrderId, workOrderId),
      eq(receipts.direction, "IN"),
      eq(receipts.status, "COMPLETED"),
      eq(receipts.approvalStatus, "APPROVED"),
      or(isNull(receipts.referenceNumber), notLike(receipts.referenceNumber, "DLV-FEE-%")),
    ));
  return round2(rows.reduce(
    (sum, r) => (exitsCashDrawer(r.paymentMethod) ? sum.plus(money(r.amount)) : sum),
    money(0),
  ));
}


/**
 * نقدُ **الخزينة الإدارية** المتاح — بنفس صيغة `assertCashOutAvailable` لدلو `TREASURY`،
 * فما تعرضه الشاشة هو ما يقيس به الحارسُ عند التنفيذ. ويُحجَب رقمُه كالأدراج عمّن لا يملك
 * `treasury:READ`؛ ويبقى `treasurySufficient` كافياً للقرار بلا كشفِ رصيد.
 */
async function treasurySnapshot(
  tx: Tx,
  branchId: number,
  needed: ReturnType<typeof money>,
  exposeCash: boolean,
): Promise<{ treasuryCash: string | null; treasurySufficient: boolean }> {
  const available = await computeTreasuryCashBalance(tx, branchId);
  return {
    treasuryCash: exposeCash ? toDbMoney(round2(available)) : null,
    treasurySufficient: available.gte(needed),
  };
}

/** تمهيدُ إلغاء/استرجاع أمر شغل. */
export async function workOrderRefundPreflight(
  tx: Tx,
  workOrderId: number,
  operation: WorkOrderRefundOperation,
  opts: { exposeCash: boolean },
): Promise<RefundPreflight | null> {
  const wo = (
    await tx
      .select({ id: workOrders.id, branchId: workOrders.branchId, invoiceId: workOrders.invoiceId, deposit: workOrders.deposit })
      .from(workOrders)
      .where(eq(workOrders.id, workOrderId))
      .limit(1)
  )[0];
  if (!wo) return null;

  const branchId = Number(wo.branchId);
  const cancel = operation === "CANCEL"
    ? await cancelCashOut(tx, workOrderId, wo.deposit ?? null)
    : null;
  const cashOut = cancel != null
    ? cancel.total
    : await reverseCashOut(tx, workOrderId, wo.invoiceId == null ? null : Number(wo.invoiceId));
  const needsCashDrawer = cashOut.gt(0);
  return {
    needsCashDrawer,
    estimatedCashOut: toDbMoney(cashOut),
    branchId,
    /**
     * **البطاقةُ ممنوعةٌ حين يوجد جزءٌ نقديٌّ لا يقبلها** (مراجعة Codex P2 على #930): حصصٌ
     * مطبَّقة أو أمانةُ أجرة تُردّ نقداً حتماً، فاختيارُ CARD يُنشئ طلبَ تحكّمٍ يستحيل اعتمادُه
     * (الخدمةُ ترفضه عند التنفيذ فيبقى معلّقاً للأبد). ⇒ تُخفيه الشاشةُ ويرفضه الطلبُ عند
     * الإنشاء. للاسترجاع لا نُبيح البطاقةَ أصلاً (تفويضٌ لا ردٌّ مباشر) ⇒ `false`.
     */
    cardRefundAllowed: cancel != null ? !cancel.hasCashOnlyPortion : false,
    // لا نُحمّل الأدراج حين لا نقدَ يخرج — استعلامٌ بلا مستهلك.
    drawers: needsCashDrawer ? await eligibleDrawers(tx, branchId, "RECEPTION", { needed: cashOut, exposeCash: opts.exposeCash }) : [],
    ...(needsCashDrawer
      ? await treasurySnapshot(tx, branchId, cashOut, opts.exposeCash)
      : { treasuryCash: null, treasurySufficient: false }),
  };
}

/**
 * تمهيدُ **إرجاع إرسالية** — نفسُ شرط `previewNeedsCash` في
 * [`delivery/returns.ts`](../delivery/returns.ts): المقبوضُ على الفاتورة أو صافي أمانة الأجرة.
 * وهو الذي يجعل إرجاعَ طردٍ **بلا نقدٍ إطلاقاً** ممكناً خارج الوردية بدل تعطيله.
 */
export async function consignmentReturnPreflight(
  tx: Tx,
  consignmentId: number,
  opts: { exposeCash: boolean },
): Promise<RefundPreflight | null> {
  const cn = (
    await tx
      .select({
        branchId: deliveryConsignments.branchId,
        invoiceId: deliveryConsignments.invoiceId,
        consignmentNumber: deliveryConsignments.consignmentNumber,
        feeSettledAt: deliveryConsignments.feeSettledAt,
      })
      .from(deliveryConsignments)
      .where(eq(deliveryConsignments.id, consignmentId))
      .limit(1)
  )[0];
  if (!cn) return null;

  const branchId = Number(cn.branchId);
  let paid = money(0);
  if (cn.invoiceId != null) {
    const inv = (
      await tx.select({ paidAmount: invoices.paidAmount }).from(invoices)
        .where(eq(invoices.id, Number(cn.invoiceId))).limit(1)
    )[0];
    paid = money(inv?.paidAmount ?? "0");
  }
  /**
   * ⚠️ **مراجعُ الأجرة ليست `DLV-FEE-CN-…`** (مراجعة Codex P1، الجولة الثانية): ذلك نمطٌ
   * اخترعتُه قياساً على `DLV-FEE-WO-` ولا وجودَ له في المستودع. الاستقبالُ يكتب
   * `DLV-FEE-INV-{invoiceId}` وصفوفُ صرف المندوب تحمل **اسم الإرسالية** — وهما ما يفحصه
   * [`returns.ts`](../delivery/returns.ts)، مع شرطٍ ثالث: `feeSettledAt == null` (المُسوّاة
   * لا تُردّ). فبمرجعٍ لا يطابق شيئاً كان الصافي صفراً دائماً ⇒ طردٌ بأجرةٍ محتجزةٍ وحدها
   * يُبلَّغ «لا نقد» ⇒ لا منتقيَ ⇒ الخادمُ يرفض بلا مخرج: **الحائطُ الأصليّ يعود**.
   */
  let feeNet = money(0);
  if (cn.feeSettledAt == null) {
    const feeRefs = [`DLV-FEE-INV-${Number(cn.invoiceId)}`, String(cn.consignmentNumber ?? "")]
      .filter((r) => r && !r.endsWith("null"));
    if (feeRefs.length) {
      const feeRow = (
        await tx
          .select({ v: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE -${receipts.amount} END), 0)` })
          .from(receipts)
          .where(and(
            inArray(receipts.referenceNumber, feeRefs),
            // نفسُ مجموعة الحالات التي يستعملها التنفيذ (`returns.ts`): REVERSED حدثٌ نقديّ
            // تاريخيّ يرافقه تعويضيٌّ معاكس، فإسقاطُه يترك OUT بلا IN ⇒ صافٍ سالبٌ يُخفي المنتقي.
            inArray(receipts.status, [...MATERIALIZED_RECEIPT_STATUSES]),
            eq(receipts.approvalStatus, "APPROVED"),
          ))
      )[0];
      feeNet = money(feeRow?.v ?? "0");
    }
  }
  const cashOut = round2(paid.plus(feeNet));
  const needsCashDrawer = cashOut.gt(0);
  return {
    needsCashDrawer,
    estimatedCashOut: toDbMoney(cashOut),
    branchId,
    // الاسترجاعُ تفويضٌ لا ردٌّ مباشر على البطاقة ⇒ لا نُبيحها أصلاً.
    cardRefundAllowed: false,
    // مسارُ التوصيل يقبل أيّ درجٍ مفتوح بالفرع (`resolveBranchCashShiftTx`) — لا RECEPTION وحدها.
    drawers: needsCashDrawer ? await eligibleDrawers(tx, branchId, null, { needed: cashOut, exposeCash: opts.exposeCash }) : [],
    ...(needsCashDrawer
      ? await treasurySnapshot(tx, branchId, cashOut, opts.exposeCash)
      : { treasuryCash: null, treasurySufficient: false }),
  };
}
