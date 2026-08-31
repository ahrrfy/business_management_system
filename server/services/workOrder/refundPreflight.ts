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
import { and, eq, isNull, notLike, or, sql } from "drizzle-orm";
import { deliveryConsignments, invoices, receipts, shifts, users, workOrders } from "../../../drizzle/schema";
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
      expectedCash: toDbMoney(round2(available)),
    });
  }
  return out;
}

/**
 * النقدُ الخارج عند **إلغاء** أمر الشغل — ثلاثةُ روافد، كما في
 * [`cancel.ts`](./cancel.ts) حرفاً بحرف:
 *  ١) إيصالُ العربون المباشر (بلا فاتورة، وليس أمانةَ أجرة) إن كانت طريقتُه نقدية.
 *  ٢) **حصصُ العربون المطبَّقة** من مسوّدة الاستقبال — وهي التي كان التخمينُ العميليّ يعميها
 *     كلّياً (`workOrders.deposit` صفرٌ و`paymentMethod` فارغة بينما النقدُ محتجزٌ فعلاً).
 *  ٣) أمانةُ أجرة التوصيل — **نقداً دائماً** ولو كان العربون بطاقة.
 */
async function cancelCashOut(tx: Tx, workOrderId: number): Promise<ReturnType<typeof money>> {
  let total = money(0);

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

  total = total.plus(await workOrderFeeHeldNet(tx, workOrderId));
  return round2(total);
}

/**
 * النقدُ الخارج عند **استرجاع تسليم** أمر الشغل — مجموعُ إيصالات IN المكتملة على المستند
 * **التي طريقتُها نقدية وحدها** ([`reverseDelivery.ts`](./reverseDelivery.ts)).
 * وهذا ما صحّحته المراجعة: `invoicePaidAmount` الإجماليّ كان يُطالب بدرجٍ لفاتورةٍ بطاقية.
 */
async function reverseCashOut(tx: Tx, workOrderId: number, invoiceId: number | null): Promise<ReturnType<typeof money>> {
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
): Promise<RefundPreflight | null> {
  const wo = (
    await tx
      .select({ id: workOrders.id, branchId: workOrders.branchId, invoiceId: workOrders.invoiceId })
      .from(workOrders)
      .where(eq(workOrders.id, workOrderId))
      .limit(1)
  )[0];
  if (!wo) return null;

  const branchId = Number(wo.branchId);
  const cashOut = operation === "CANCEL"
    ? await cancelCashOut(tx, workOrderId)
    : await reverseCashOut(tx, workOrderId, wo.invoiceId == null ? null : Number(wo.invoiceId));
  const needsCashDrawer = cashOut.gt(0);
  return {
    needsCashDrawer,
    estimatedCashOut: toDbMoney(cashOut),
    branchId,
    // لا نُحمّل الأدراج حين لا نقدَ يخرج — استعلامٌ بلا مستهلك.
    drawers: needsCashDrawer ? await eligibleDrawers(tx, branchId, "RECEPTION") : [],
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
): Promise<RefundPreflight | null> {
  const cn = (
    await tx
      .select({ branchId: deliveryConsignments.branchId, invoiceId: deliveryConsignments.invoiceId })
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
  const feeRow = (
    await tx
      .select({ v: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE -${receipts.amount} END), 0)` })
      .from(receipts)
      .where(and(
        eq(receipts.referenceNumber, `DLV-FEE-CN-${consignmentId}`),
        eq(receipts.status, "COMPLETED"),
        eq(receipts.approvalStatus, "APPROVED"),
      ))
  )[0];
  const cashOut = round2(paid.plus(money(feeRow?.v ?? "0")));
  const needsCashDrawer = cashOut.gt(0);
  return {
    needsCashDrawer,
    estimatedCashOut: toDbMoney(cashOut),
    branchId,
    // مسارُ التوصيل يقبل أيّ درجٍ مفتوح بالفرع (`resolveBranchCashShiftTx`) — لا RECEPTION وحدها.
    drawers: needsCashDrawer ? await eligibleDrawers(tx, branchId, null) : [],
  };
}
