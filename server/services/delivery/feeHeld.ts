import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import type Decimal from "decimal.js";
import { and, eq, inArray, or } from "drizzle-orm";
import { receipts, workOrders } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { deliveryFeeHeldReceiptIntent } from "./posting";
import { assertPosPaymentMethodEnabled } from "../posPaymentPolicy";
import { lockMaterializedCashReceiptSourceForWrite } from "../cash/cashAvailability";
import { postEntry } from "../ledgerService";
import { money, round2 } from "../money";

/** Call after source row locks. Include original WO fees after invoice linkage. */
export async function assertNoPendingHeldFeeRefundTx(
  tx: Tx,
  source: { invoiceId?: number; workOrderId?: number },
) {
  const linked =
    source.invoiceId == null
      ? []
      : await tx
          .select({ id: workOrders.id })
          .from(workOrders)
          .where(eq(workOrders.invoiceId, source.invoiceId))
          .for("share");
  const woIds = Array.from(
    new Set([
      ...(source.workOrderId == null ? [] : [source.workOrderId]),
      ...linked.map((r) => Number(r.id)),
    ]),
  );
  const refs = [
    ...(source.invoiceId == null ? [] : [`DLV-FEE-INV-${source.invoiceId}`]),
    ...woIds.map((id) => `DLV-FEE-WO-${id}`),
  ];
  if (!refs.length) return;
  const pending = await tx
    .select({ id: receipts.id })
    .from(receipts)
    .where(
      and(
        inArray(receipts.referenceNumber, refs),
        eq(receipts.direction, "OUT"),
        eq(receipts.status, "PENDING"),
        eq(receipts.approvalStatus, "PENDING_APPROVAL"),
        or(
          ...[
            ...(source.invoiceId == null
              ? []
              : [eq(receipts.invoiceId, source.invoiceId)]),
            ...(woIds.length ? [inArray(receipts.workOrderId, woIds)] : []),
          ],
        ),
      ),
    )
    .for("update")
    .limit(1);
  if (pending.length)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر إسناد مصدر له رد أجرة معلق",
        why: "أمانة الأجرة محجوزة لرد خارجي ولم يثبت تنفيذ الاسترداد بعد",
        doThis:
          "أكمل الاسترداد في تبويب رد المقبوضات وثبّت مرجع المزوّد أولاً، ثم أعد التجميع على الأمانة الباقية",
      }),
    });
}

/** ما يحتاجه الحارس من حمولة التوصيل — لا يعتمد على نوع الراوتر. */
export interface DeliveryFeeHeldCounterpart {
  fee?: string | null;
  feeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
}

/**
 * الأمانةُ لا تُقبَل إلّا مع توصيلٍ طريقتُه COUNTER وبمبلغٍ يساوي الأجرة بالضبط.
 *
 * مع COURIER يقبض المندوب أجرته من الزبون ثانيةً فتصير الأمانةُ قبضاً مزدوجاً لا مسارَ لتبرئته؛
 * ومبلغٌ يخالف الأجرة يترك فرقاً في الدرج بلا مسار ردّ (حارس المساواة في `dispatchInvoiceInTx`
 * يرفضه لاحقاً بأيّ حال — لكنّ الرفض هنا يسبق أيّ كتابة). **بلا توصيلٍ في نفس البيع** تبقى
 * الأمانة مشروعةً: الإسناد المؤجَّل من طابور الإرساليات يفرض المساواة لحظة الإسناد.
 */
export function assertDeliveryFeeHeldConsistent(
  feeHeld: Decimal,
  delivery: DeliveryFeeHeldCounterpart | null | undefined,
): void {
  if (!feeHeld.gt(0) || delivery == null) return;
  if ((delivery.feeCollection ?? "COURIER") !== "COUNTER") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "أمانة الأجرة لا تناسب طريقة التوصيل",
        why: `أرسلت مبلغ أمانة أجرة (${feeHeld.toFixed(2)}) مع توصيل أجرته على المندوب (COURIER) — المندوب سيقبضها من الزبون فيصير قبضاً مزدوجاً وأمانتك تعلق بلا تبرئة`,
        doThis:
          "غيّر «التحصيل» إلى «مقبوضة في الاستقبال» (COUNTER)، أو احذف مبلغ الأمانة",
      }),
    });
  }
  const feeD = round2(money(delivery.fee ?? "0"));
  if (!feeHeld.eq(feeD)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "قيمة الأمانة يجب أن تساوي أجرة التوصيل",
        why: `الأمانة المقبوضة ${feeHeld.toFixed(2)} لا تساوي أجرة التوصيل ${feeD.toFixed(2)} — الفرق سيترك مالاً بلا مسار ردٍّ عند التوريد`,
        doThis: `اضبط الأمانة على ${feeD.toFixed(2)} بالضبط، أو عدّل أجرة التوصيل لتطابقها`,
      }),
    });
  }
}

export const RECEPTION_FEE_ALLOCATION = Symbol("RECEPTION_FEE_ALLOCATION");

/** Omission preserves legacy CASH; combined index allocates one provider payment once. */
export interface DeliveryFeeTender {
  method: "CASH" | "CARD" | "TRANSFER" | "WALLET";
  reference?: string | null;
  externalPaymentAttemptId?: number | null;
  externalPaymentDeviceId?: string | null;
  combinedWithPaymentIndex?: number | null;
}

export interface RecordDeliveryFeeHeldInput {
  branchId: number;
  shiftId: number | null;
  invoiceId?: number | null;
  workOrderId?: number | null;
  tender?: DeliveryFeeTender | null;
  amount: Decimal;
  actorUserId: number;
  /** وصفُ الإيصال — يُسمّي القناة (استقبال/كاشير) كي يُقرأ في تسوية الدرج. */
  description: string;
}

/**
 * يكتب إيصال الأمانة وقيدها داخل معاملة المستدعي. `amount` موجبٌ حتماً (المستدعي يتحقّق).
 *
 * **الكاتبُ يحرس نفسه** (م١ PR-3، أمسكه `cashDayClosedWriteGate`/`cashNonnegativeCore`): الإيصالُ
 * نقدُ درجٍ ماديّ ⇒ بوّابةُ المصدر/اليوم (`lockMaterializedCashReceiptSourceForWrite`) تُقتنى هنا
 * قبل الـINSERT لا في المستدعي وحده — فمن يستدعيه من قناةٍ أخرى (استقبال/استيراد) لا يفلت من
 * قفل الوردية ولا من رفض اليوم المُغلَق. المستدعي القائم (`sale/create.ts`) يقفل الصفَّ نفسه قبلها؛
 * إعادةُ القفل داخل المعاملة نفسها لا تحجب ولا تُغيّر الترتيب (source → day → receipt).
 */
export async function recordDeliveryFeeHeldInTx(
  tx: Tx,
  input: RecordDeliveryFeeHeldInput,
): Promise<{ receiptId: number }> {
  const amount = round2(input.amount);
  const method = input.tender?.method ?? "CASH";
  assertPosPaymentMethodEnabled(method);
  const reference = input.tender?.reference?.trim();
  if (method !== "CASH" && !reference) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر قبض أجرة التوصيل",
        why: "مرجع القبض غير النقدي للأجرة غير مثبت",
        doThis:
          "أكّد نجاح الدفع لدى المزوّد ثم أعد الحفظ دون تمرير البطاقة مرة ثانية",
      }),
    });
  }
  if (
    (input.invoiceId == null) === (input.workOrderId == null) ||
    !amount.gt(0)
  ) {
    throw new Error(
      "Held delivery fee requires one source and a positive amount",
    );
  }
  const cashBucket = method === "CASH" ? ("DRAWER" as const) : null;
  if (method === "CASH")
    await lockMaterializedCashReceiptSourceForWrite(tx, {
      branchId: input.branchId,
      shiftId: input.shiftId,
      cashBucket: "DRAWER",
      paymentMethod: "CASH",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
    });
  const feeRes = await tx.insert(receipts).values({
    branchId: input.branchId,
    shiftId: input.shiftId,
    invoiceId: input.invoiceId ?? null,
    workOrderId: input.workOrderId ?? null,
    direction: "IN",
    amount: amount.toFixed(2),
    paymentMethod: method,
    cashBucket,
    status: "COMPLETED",
    partyType: "OTHER",
    referenceNumber:
      input.invoiceId != null
        ? `DLV-FEE-INV-${input.invoiceId}`
        : `DLV-FEE-WO-${input.workOrderId}`,
    internalNote: reference
      ? JSON.stringify({
          externalPaymentReference: reference,
          externalPaymentAttemptId:
            input.tender?.externalPaymentAttemptId ?? null,
        })
      : null,
    description: input.description,
    createdBy: input.actorUserId,
  });
  const receiptId = extractInsertId(feeRes);
  const intent = deliveryFeeHeldReceiptIntent(amount, method, cashBucket);
  await postEntry(tx, {
    entryType: "DELIVERY_FEE_HELD",
    dedupeKey:
      input.invoiceId != null
        ? `DELIVERY_FEE_HELD:INV:${input.invoiceId}`
        : `DELIVERY_FEE_HELD:WO:${input.workOrderId}`,
    branchId: input.branchId,
    invoiceId: input.invoiceId,
    receiptId,
    amount,
    notes: "أمانة أجرة توصيل — مقبوضة مع البيع",
    postingSourceComponents: intent.sourceComponents,
    postingIntent: intent,
  });
  return { receiptId };
}
