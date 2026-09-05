/**
 * أمانةُ أجرة التوصيل المقبوضة لحظة البيع (`feeCollection = COUNTER`) — م١ (PR-1).
 *
 * الكاتبُ المشترك لإيصال الأمانة وقيدها، يستدعيه البيعُ المباشر (`sale/create.ts`) بنفس
 * الثابت الذي يكتبه الاستقبال (`receptionCheckoutService.ts`، ش٦/V15):
 *
 *   · إيصال IN **نقديّ في الدرج حتماً** بمرجع `DLV-FEE-INV-{invoiceId}` — مهما كانت طريقة
 *     دفع السلّة؛ فهي تُصرف للمندوب نقداً من الدرج نفسه عند توريده، وقبضُها بغير النقد يترك
 *     OUT بلا IN يقابله (عجزُ درجٍ يمنع إغلاق الوردية).
 *   · قيد `DELIVERY_FEE_HELD` (CASH ← COURIER_PAYABLE): أمانةٌ لا إيراد. تُبرَّأ عند صرفها
 *     للمندوب في `fees.ts` بإشارةٍ سالبة ⇒ `Σ DELIVERY_FEE_HELD` للمستند = 0 ⇔ مُبرَّأة (§٥).
 *
 * وبهذا المرجع وحده يقبل `dispatchInvoiceInTx` طريقةَ COUNTER (يشترط مساواة الأمانة والأجرة)،
 * لذلك يُكتب الإيصال **قبل** الإسناد داخل المعاملة نفسها.
 */
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import type Decimal from "decimal.js";
import { receipts } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { postEntry } from "../ledgerService";
import { money, round2 } from "../money";

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
        doThis: "غيّر «التحصيل» إلى «مقبوضة في الاستقبال» (COUNTER)، أو احذف مبلغ الأمانة",
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

export interface RecordDeliveryFeeHeldInput {
  branchId: number;
  shiftId: number | null;
  invoiceId: number;
  amount: Decimal;
  actorUserId: number;
  /** وصفُ الإيصال — يُسمّي القناة (استقبال/كاشير) كي يُقرأ في تسوية الدرج. */
  description: string;
}

/** يكتب إيصال الأمانة وقيدها داخل معاملة المستدعي. `amount` موجبٌ حتماً (المستدعي يتحقّق). */
export async function recordDeliveryFeeHeldInTx(
  tx: Tx,
  input: RecordDeliveryFeeHeldInput,
): Promise<{ receiptId: number }> {
  const amount = round2(input.amount);
  const feeRes = await tx.insert(receipts).values({
    branchId: input.branchId,
    shiftId: input.shiftId,
    invoiceId: input.invoiceId,
    direction: "IN",
    amount: amount.toFixed(2),
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    status: "COMPLETED",
    partyType: "OTHER",
    referenceNumber: `DLV-FEE-INV-${input.invoiceId}`,
    description: input.description,
    createdBy: input.actorUserId,
  });
  const receiptId = extractInsertId(feeRes);
  const components = {
    roleDebits: { CASH: amount },
    roleCredits: { COURIER_PAYABLE: amount },
  };
  await postEntry(tx, {
    entryType: "DELIVERY_FEE_HELD",
    dedupeKey: `DELIVERY_FEE_HELD:INV:${input.invoiceId}`,
    branchId: input.branchId,
    invoiceId: input.invoiceId,
    receiptId,
    amount,
    notes: "أمانة أجرة توصيل — مقبوضة مع البيع",
    postingSourceComponents: components,
    postingIntent: createPostingIntent(
      "DELIVERY_FEE_HELD_RECEIPT",
      "DELIVERY_FEE_HELD",
      [debitLine("CASH", amount), creditLine("COURIER_PAYABLE", amount)],
      components,
    ),
  });
  return { receiptId };
}
