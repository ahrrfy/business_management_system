import { TRPCError } from "@trpc/server";
import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, externalPaymentAttempts, receipts, productVariants, products } from "../../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import type { ReceptionPaymentAllocation, ReceptionPaymentLeg, ReceptionPaymentMetadata, ReceptionPaymentSummary } from "@shared/receptionPayments";
import { positiveMoneyString } from "../../lib/schemas";
import type { Tx } from "../../db";
import type { Actor } from "../tx";
import { money, round2 } from "../money";
import type { ReceptionCheckoutInput } from "../receptionCheckoutService";
import { consumeExternalReceiptAllocationsTx, lockConfirmedExternalPaymentAttempt, type ExternalPaymentBindingInput } from "../posExternalPayment";

export const receptionPaymentsSchema = z.array(z.object({
  amount: positiveMoneyString,
  method: z.enum(["CASH", "CARD", "TRANSFER", "WALLET"]),
  externalPaymentAttemptId: z.number().int().positive().nullish(),
  externalPaymentDeviceId: z.string().trim().min(1).max(64).nullish(),
})).min(1).max(10);

export function splitPaymentError(why: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
    what: "تعذّر تثبيت الدفعات المقسّمة", why,
    doThis: "راجع مبالغ الدفعات وإثبات كل دفعة غير نقدية ثم أعد التثبيت بنفس مفتاح الطلب",
  }) });
}

type Allocation = { paymentIndex: number; amount: string; method: ReceptionPaymentLeg["method"]; reference: string | null };
export interface ReceptionSplitPlan {
  legs: ReceptionPaymentLeg[];
  summary: ReceptionPaymentSummary;
  targets: Map<string, Allocation[]>;
  bindings: Map<number, ExternalPaymentBindingInput>;
  references: Map<number, string>;
  feeBinding: ExternalPaymentBindingInput | null;
  allCash: boolean;
  roundingEligible: boolean;
}

export function normalizeReceptionPayments(input: ReceptionCheckoutInput): ReceptionSplitPlan {
  const parsed = receptionPaymentsSchema.safeParse(input.payments);
  if (!parsed.success) splitPaymentError("أرسل من دفعة واحدة إلى 10 دفعات موجبة بوسائل قبض مدعومة");
  if (input.paymentMethod != null || input.paymentReference != null || input.paymentExternalPaymentAttemptId != null || input.paymentExternalPaymentDeviceId != null)
    splitPaymentError("لا تجمع مصفوفة الدفعات مع حقول طريقة القبض المفردة");
  const legs = parsed.data;
  const attempts = new Set<number>();
  for (const leg of legs) {
    if (leg.method === "CASH") {
      if (leg.externalPaymentAttemptId != null || leg.externalPaymentDeviceId != null) splitPaymentError("الدفعة النقدية لا تحمل إثبات دفع خارجي");
    } else {
      if (leg.externalPaymentAttemptId == null || !leg.externalPaymentDeviceId) splitPaymentError("أكّد الدفع الخارجي وحدّد جهاز كل دفعة غير نقدية");
      if (attempts.has(leg.externalPaymentAttemptId)) splitPaymentError("لا تستعمل إثبات الدفع نفسه لدفعتين");
      attempts.add(leg.externalPaymentAttemptId);
    }
  }
  const total = round2(money(input.regularSale?.amount ?? "0").plus(input.printSale?.amount ?? "0").plus(
    (input.workOrders ?? []).reduce((sum, row) => sum.plus(money(row.salePrice)), money(0)),
  ));
  const held = round2(money(input.preCollected?.total ?? "0"));
  if (held.gt(total)) splitPaymentError("المقبوض سلفاً يتجاوز إجمالي الطلب");
  const remaining = total.minus(held);
  const tendered = legs.reduce((sum, leg) => sum.plus(money(leg.amount)), money(0));
  const nonCash = legs.reduce((sum, leg) => leg.method === "CASH" ? sum : sum.plus(money(leg.amount)), money(0));
  if (nonCash.gt(remaining)) splitPaymentError("مجموع الدفعات غير النقدية يتجاوز المستحقّ الآن");
  const applied = tendered.gte(remaining) ? remaining : tendered;
  if (input.paidAmount != null && !money(input.paidAmount).eq(applied)) splitPaymentError("paidAmount لا يطابق المبلغ المطبّق من الدفعات");
  let cashLeft = applied.minus(nonCash);
  const legLeft = legs.map(leg => {
    if (leg.method !== "CASH") return money(leg.amount);
    const portion = money(leg.amount).lte(cashLeft) ? money(leg.amount) : cashLeft;
    cashLeft = cashLeft.minus(portion);
    return portion;
  });
  const destinations = [
    ...(input.regularSale ? [{ key: "SALE", amount: input.regularSale.amount }] : []),
    ...(input.printSale ? [{ key: "PRINT", amount: input.printSale.amount }] : []),
    ...(input.workOrders ?? []).map((order, i) => ({ key: `WO:${i}`, amount: order.salePrice })),
  ];
  if (input.delivery && input.regularSale && input.printSale) destinations.splice(0, 2, destinations[1], destinations[0]);
  let heldLeft = held;
  let appliedLeft = applied;
  const targets = new Map<string, Allocation[]>();
  for (const target of destinations) {
    const due = money(target.amount);
    const pre = heldLeft.gte(due) ? due : heldLeft;
    heldLeft = heldLeft.minus(pre);
    let need = due.minus(pre).lte(appliedLeft) ? due.minus(pre) : appliedLeft;
    appliedLeft = appliedLeft.minus(need);
    const portions: Allocation[] = [];
    for (let i = 0; i < legs.length && need.gt(0); i++) {
      const portion = legLeft[i].lte(need) ? legLeft[i] : need;
      if (portion.lte(0)) continue;
      portions.push({ paymentIndex: i, method: legs[i].method, amount: portion.toFixed(2), reference: null });
      legLeft[i] = legLeft[i].minus(portion);
      need = need.minus(portion);
    }
    targets.set(target.key, portions);
  }
  return { legs, targets, allCash: legs.every(l => l.method === "CASH"),
    roundingEligible: legs.every(l => l.method === "CASH") && tendered.gte(remaining) && input.deferredDirect !== true && input.paymentMode !== "CREDIT",
    summary: { tenderedAmount: tendered.toFixed(2), appliedAmount: applied.toFixed(2), changeAmount: tendered.minus(applied).toFixed(2) },
    bindings: new Map(), references: new Map(), feeBinding: null };
}

export async function lockReceptionSplitProofs(tx: Tx, input: ReceptionCheckoutInput, plan: ReceptionSplitPlan, actor: Actor, replay = false) {
  if (!replay) {
    const variantIds = Array.from(new Set([
      ...(input.regularSale?.lines ?? []).map(l => l.variantId),
      ...(input.printSale?.lines ?? []).map(l => l.variantId),
      ...(input.workOrders ?? []).flatMap(o => o.baseVariantId == null ? [] : [o.baseVariantId]),
    ]));
    if (variantIds.length) {
      const digital = await tx.select({ id: productVariants.id }).from(productVariants).innerJoin(products, eq(products.id, productVariants.productId))
        .where(and(inArray(productVariants.id, variantIds), eq(products.productType, "DIGITAL_CARD"))).limit(1);
      if (digital.length) splitPaymentError("تقسيم الدفع غير متاح للبطاقات الرقمية");
    }
  }
  const fee = money(input.deliveryFeeHeld ?? "0");
  const tender = input.deliveryFeeTender;
  const combined = tender?.combinedWithPaymentIndex;
  if (combined != null && (!plan.legs[combined] || tender!.method !== plan.legs[combined].method || !fee.gt(0)))
    splitPaymentError("فهرس أو وسيلة قبض الأجرة الموحّد لا يطابق دفعة البضاعة");
  for (let index = 0; index < plan.legs.length; index++) {
    const leg = plan.legs[index];
    if (leg.method === "CASH") continue;
    if (combined === index && (tender!.externalPaymentAttemptId !== leg.externalPaymentAttemptId || tender!.externalPaymentDeviceId !== leg.externalPaymentDeviceId))
      splitPaymentError("إثبات الأجرة الموحّد يجب أن يطابق إثبات دفعة البضاعة وجهازها");
    plan.bindings.set(index, { branchId: input.branchId, channel: "PRINT_POS", method: leg.method,
      amount: money(leg.amount).plus(combined === index ? fee : 0).toFixed(2), attemptId: leg.externalPaymentAttemptId, deviceId: leg.externalPaymentDeviceId });
  }
  if (tender?.method === "CASH" && (tender.externalPaymentAttemptId != null || tender.externalPaymentDeviceId != null)) splitPaymentError("أجرة نقدية لا تحمل إثباتاً خارجياً");
  if (tender && fee.gt(0) && tender.method !== "CASH" && combined == null) {
    if (!tender.externalPaymentAttemptId || !tender.externalPaymentDeviceId) splitPaymentError("أكّد إثبات أجرة التوصيل المستقلة");
    if (plan.legs.some(l => l.externalPaymentAttemptId === tender.externalPaymentAttemptId)) splitPaymentError("إثبات الأجرة المستقلة مستعمل لدفعة أخرى");
    plan.feeBinding = { branchId: input.branchId, channel: "PRINT_POS", method: tender.method, amount: fee.toFixed(2), attemptId: tender.externalPaymentAttemptId, deviceId: tender.externalPaymentDeviceId };
  }
  const bindings = [...Array.from(plan.bindings.entries()), ...(plan.feeBinding ? [[-1, plan.feeBinding] as const] : [])].sort((a,b) => Number(a[1].attemptId) - Number(b[1].attemptId));
  for (const [index, binding] of bindings) {
    const attempt = replay
      ? (await tx.select().from(externalPaymentAttempts).where(eq(externalPaymentAttempts.id, binding.attemptId!)).for("update").limit(1))[0]
      : await lockConfirmedExternalPaymentAttempt(tx, binding, actor);
    if (!attempt) splitPaymentError("إثبات الدفع غير موجود");
    plan.references.set(index, attempt.externalReference);
  }
  for (const portions of Array.from(plan.targets.values())) for (const portion of portions) portion.reference = plan.references.get(portion.paymentIndex) ?? null;
}

const ACTION = "reception.splitPayments";
export async function readReceptionSplitMetadata(tx: Tx, requestId: string): Promise<ReceptionPaymentMetadata | null> {
  const [audit] = await tx.select({ value: auditLogs.newValue }).from(auditLogs).where(and(eq(auditLogs.action, ACTION), eq(auditLogs.entityId, requestId))).limit(1);
  if (!audit) return null;
  const metadata = (typeof audit.value === "string" ? JSON.parse(audit.value) : audit.value) as ReceptionPaymentMetadata;
  const allocations = metadata.paymentAllocations ?? [];
  if (allocations.length) {
    const rows = await tx.select().from(receipts).where(inArray(receipts.id, allocations.map(a => a.receiptId)));
    for (const allocation of allocations) {
      const row = rows.find(r => Number(r.id) === allocation.receiptId);
      if (!row || !money(row.amount).eq(allocation.amount) || row.paymentMethod !== allocation.method) splitPaymentError("إيصال التخصيص المثبّت لا يطابق بيانات العملية الأصلية");
    }
  }
  return metadata;
}

export async function finishReceptionSplit(tx: Tx, input: ReceptionCheckoutInput, plan: ReceptionSplitPlan, targets: { regularSale?: { invoiceId: number } | null; printSale?: { invoiceId: number } | null; workOrders: Array<{ workOrderId: number }> }, actor: Actor, replay = false): Promise<ReceptionPaymentMetadata> {
  if (replay) {
    const metadata = await readReceptionSplitMetadata(tx, input.clientRequestId);
    if (!metadata) splitPaymentError("العملية الأصلية لا تملك تخصيص دفعات مقسّمة موثقاً");
    return metadata;
  }
  const invoiceIds = [targets.regularSale?.invoiceId, targets.printSale?.invoiceId].filter((n): n is number => n != null);
  const workOrderIds = targets.workOrders.map(w => w.workOrderId);
  const conditions = [...(invoiceIds.length ? [inArray(receipts.invoiceId, invoiceIds)] : []), ...(workOrderIds.length ? [inArray(receipts.workOrderId, workOrderIds)] : [])];
  const rows = (conditions.length ? await tx.select().from(receipts).where(and(eq(receipts.direction, "IN"), or(...conditions))).orderBy(receipts.id) : []).filter(r =>
    (r.invoiceId != null && invoiceIds.includes(Number(r.invoiceId)) || r.workOrderId != null && workOrderIds.includes(Number(r.workOrderId))) && r.status === "COMPLETED" && r.approvalStatus === "APPROVED");
  const allocations: ReceptionPaymentAllocation[] = [];
  for (const [target, portions] of Array.from(plan.targets)) {
    const invoiceId = target === "SALE" ? targets.regularSale?.invoiceId : target === "PRINT" ? targets.printSale?.invoiceId : undefined;
    const workOrderId = target.startsWith("WO:") ? targets.workOrders[Number(target.slice(3))]?.workOrderId : undefined;
    const available = rows.filter(r => (invoiceId != null ? r.invoiceId === invoiceId : r.workOrderId === workOrderId) && !r.referenceNumber?.startsWith("DLV-FEE-")).sort((a,b)=>Number(a.id)-Number(b.id));
    for (const portion of portions) {
      const pos = available.findIndex(r => r.paymentMethod === portion.method && money(r.amount).eq(portion.amount) && (r.referenceNumber ?? null) === portion.reference);
      if (pos < 0) splitPaymentError("لم يُنشأ إيصال يطابق تخصيص دفعة البضاعة");
      const receipt = available.splice(pos, 1)[0];
      allocations.push({ ...portion, receiptId: Number(receipt.id), ...(invoiceId != null ? { invoiceId } : { workOrderId }) });
    }
  }
  const feeRows = rows.filter(r => r.referenceNumber?.startsWith("DLV-FEE-"));
  if (!allocations.reduce((sum, row) => sum.plus(money(row.amount)), money(0)).eq(plan.summary.appliedAmount)) splitPaymentError("إجمالي إيصالات التخصيص لا يطابق المقبوض المطبّق");
  for (const [index, binding] of Array.from(plan.bindings)) {
    const ids = allocations.filter(a => a.paymentIndex === index).map(a => a.receiptId);
    if (input.deliveryFeeTender?.combinedWithPaymentIndex === index) ids.push(...feeRows.map(r => Number(r.id)));
    await consumeExternalReceiptAllocationsTx(tx, binding, ids, actor);
  }
  if (plan.feeBinding) await consumeExternalReceiptAllocationsTx(tx, plan.feeBinding, feeRows.map(r => Number(r.id)), actor);
  const metadata = { paymentSummary: plan.summary, paymentAllocations: allocations };
  await tx.insert(auditLogs).values({ branchId: input.branchId, userId: actor.userId, action: ACTION, entityType: "receptionCheckout", entityId: input.clientRequestId, newValue: JSON.stringify(metadata) });
  return metadata;
}
