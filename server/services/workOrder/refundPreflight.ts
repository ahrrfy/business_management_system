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
import { deliveryConsignments, invoiceItems, invoices, receipts, shifts, users, workOrders } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2, toDbMoney } from "../money";
import { computeDrawerCashBalance } from "../cash/cashAvailability";
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
 * النقدُ الخارج عند **إلغاء** أمر الشغل — **مطابقٌ لبنية `cancelWorkOrder` لا لِما ينبغي أن تكون.**
 *
 * ⚠️ **قيدٌ حاسم (مراجعة Codex، الجولة الثانية):** كتلةَ الردّ كلَّها في
 * [`cancel.ts`](./cancel.ts) محكومةٌ بـ`if (refundD.gt(0))` حيث `refundD = wo.deposit` —
 * فحصصُ العربون المطبَّقة (`orderPayments`) **لا تُصرَف إطلاقاً** حين يكون العمود صفراً، ولو
 * كان النقدُ محتجزاً فعلاً. فلو ادّعى التمهيدُ خروجَ نقدٍ عندئذٍ لَحجب الإلغاءَ بلا وردية
 * مفتوحة على أمرٍ **كانت الخدمةُ ستُلغيه بلا درجٍ أصلاً** — أي حائطٌ جديد.
 *
 * ⇒ التمهيدُ يعكس السلوكَ القائم حرفياً: بلا عربونٍ موجب لا نُطالب بدرج.
 *
 * 🔻 **وهذا يكشف فجوةً ماليّةً أعمق لا يجوز لي سدُّها منفرداً:** حصصُ عربونٍ نقديّةٍ محتجزة
 * على أمرٍ عموده صفر تبقى بلا مسار خروجٍ عند الإلغاء (§٥ — «لكلّ مالٍ محتجَز مسارُ خروجٍ
 * ممكنٌ دائماً»). تغييرُ ذلك سلوكٌ ماليّ يقرّره المالك، ومرفوعٌ إليه.
 */
async function cancelCashOut(tx: Tx, workOrderId: number, deposit: string | null): Promise<ReturnType<typeof money>> {
  let total = money(0);
  const refundD = round2(money(deposit ?? "0"));

  // نفسُ حارس `cancel.ts`: بلا عربونٍ موجب لا يُفتح مسارُ الردّ ولا يُطلَب درج.
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

    for (const part of await appliedCollectionsForWorkOrder(tx, workOrderId)) {
      const amt = round2(money(part.amount));
      if (amt.lte(0)) continue;
      if (exitsCashDrawer(part.method)) total = total.plus(amt);
    }
  }

  // أمانةُ أجرة التوصيل خارج الحارس أعلاه في `cancel.ts` كذلك — تُردّ نقداً ولو كان العربون صفراً.
  total = total.plus(await workOrderFeeHeldNet(tx, workOrderId));
  return round2(total);
}

/**
 * النقدُ الخارج عند **استرجاع تسليم** أمر الشغل.
 *
 * ⚠️ **الفاتورةُ ذاتُ البنود لا تمرّ بهذا المسار إطلاقاً** (مراجعة Codex، الجولة الثانية):
 * [`reverseDelivery.ts`](./reverseDelivery.ts) يُفوّضها كاملةً إلى `returnSaleInTx` **بلا
 * `refund` ولا `refundShiftId`** ويعود مبكّراً — فلا يُفتح درجٌ قطّ. وحسبُ الإيصالات هنا كان
 * يُطالب بدرجٍ فيُعطَّل استرجاعٌ **كانت الخدمةُ ستُتمّه بلا وردية** — حائطٌ جديد.
 * ⇒ صفرٌ للفاتورة ذات البنود، وحسبةُ الإيصالات للخدمة الخالصة وحدها.
 *
 * وللأخيرة: مجموعُ إيصالات IN المكتملة **النقديّة وحدها** — لا `paidAmount` الإجماليّ.
 */
async function reverseCashOut(
  tx: Tx,
  workOrderId: number,
  invoiceId: number | null,
): Promise<ReturnType<typeof money>> {
  if (invoiceId != null) {
    const anyItem = (
      await tx.select({ id: invoiceItems.id }).from(invoiceItems)
        .where(eq(invoiceItems.invoiceId, invoiceId)).limit(1)
    )[0];
    // مسارُ التفويض (`returnSaleInTx`) لا يمسّ درجاً — فلا نُطالب بواحد.
    if (anyItem) return money(0);
  }
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
  const cashOut = operation === "CANCEL"
    ? await cancelCashOut(tx, workOrderId, wo.deposit ?? null)
    : await reverseCashOut(tx, workOrderId, wo.invoiceId == null ? null : Number(wo.invoiceId));
  const needsCashDrawer = cashOut.gt(0);
  return {
    needsCashDrawer,
    estimatedCashOut: toDbMoney(cashOut),
    branchId,
    // لا نُحمّل الأدراج حين لا نقدَ يخرج — استعلامٌ بلا مستهلك.
    drawers: needsCashDrawer ? await eligibleDrawers(tx, branchId, "RECEPTION", { needed: cashOut, exposeCash: opts.exposeCash }) : [],
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
            eq(receipts.status, "COMPLETED"),
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
    // مسارُ التوصيل يقبل أيّ درجٍ مفتوح بالفرع (`resolveBranchCashShiftTx`) — لا RECEPTION وحدها.
    drawers: needsCashDrawer ? await eligibleDrawers(tx, branchId, null, { needed: cashOut, exposeCash: opts.exposeCash }) : [],
  };
}
