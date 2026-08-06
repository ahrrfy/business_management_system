// ٥/٨ — إسناد **فاتورةٍ قائمة** للتوصيل (لا أمر شغل).
//
// الفجوة التي يعالجها: مسار الإرسال الوحيد كان dispatchToDelivery المفتاحُ فيه workOrderId، وهو
// **يُنشئ الفاتورة بنفسه**. فالبيع المباشر في الاستقبال (منتجات جاهزة/خدمات طباعة بلا تخصيص)
// يُنتج فاتورةً بلا أيّ أمر شغل ⇒ لا صفَّ له في الطابور ولا طريقةَ لإسناده لمندوب إطلاقاً.
// هنا نربط فاتورةً موجودةً بإرسالية: نفس محاسبة العهدة، بلا إنشاء فاتورةٍ ثانية وبلا لمس قيد
// SALE الأصليّ (الإيراد اعتُرف به لحظة البيع؛ التوصيل تسليمٌ لا بيع).
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryParties,
  invoices,
  receipts,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { adjustDeliveryBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { shiftIdForCashTx } from "../shiftService";
import { withTx } from "../tx";
import { nextConsignmentNumber } from "./numbering";
import type { DeliveryTxActor } from "./types";

export interface DispatchInvoiceInput {
  invoiceId: number;
  partyId: number;
  deliveryFee?: string | null;
  /** مَن يقبض الأجرة (تمريرٌ لا إيراد): COURIER افتراضاً. COUNTER يعني أنّها في الدرج الآن. */
  feeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryAddress?: string | null;
  clientRequestId?: string | null;
}

export async function dispatchInvoiceToDelivery(input: DispatchInvoiceInput, actor: DeliveryTxActor) {
  return withTx(async (tx) => {
    const feeCollection = input.feeCollection ?? "COURIER";
    // ش٦ (V15) — رُفع حظر COUNTER **مشروطاً**: يُقبل فقط إن سبق قبضُ الأمانة فعلاً (إيصال IN
    // بمرجع DLV-FEE-INV-{الفاتورة} يكتبه checkoutReception عبر deliveryFeeHeld) وبما يغطّي
    // الأجرة — وإلا بقي الرفض: OUT للمندوب بلا IN يقابله = عجز درجٍ يمنع إغلاق الوردية.
    if (feeCollection === "COUNTER") {
      const feeD = round2(money(input.deliveryFee ?? "0"));
      const heldRow = (
        await tx
          .select({ v: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE -${receipts.amount} END), 0)` })
          .from(receipts)
          .where(and(
            eq(receipts.invoiceId, input.invoiceId),
            eq(receipts.referenceNumber, `DLV-FEE-INV-${input.invoiceId}`),
            eq(receipts.status, "COMPLETED"),
          ))
      )[0];
      const heldD = round2(money(heldRow?.v ?? "0"));
      if (feeD.lte(0) || heldD.lt(feeD)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: heldD.gt(0)
            ? `أمانة الأجرة المقبوضة (${heldD.toFixed(2)}) لا تغطّي الأجرة (${feeD.toFixed(2)}) — صحّح المبلغ أو اختر «المندوب يقبضها»`
            : "«مقبوضة في الاستقبال» تتطلّب قبض الأجرة مع الطلب نفسه (خانة أجرة التوصيل في السلّة) — أو اختر «المندوب يقبضها من الزبون» / «على المكتبة»",
        });
      }
    }
    const payloadHash = idempotencyHash({
      invoiceId: Number(input.invoiceId),
      partyId: Number(input.partyId),
      deliveryFee: input.deliveryFee == null ? null : toDbMoney(round2(money(input.deliveryFee))),
      feeCollection,
      recipientName: input.recipientName ?? null,
      recipientPhone: input.recipientPhone ?? null,
      deliveryAddress: input.deliveryAddress ?? null,
    });
    if (input.clientRequestId) {
      const existingId = await checkIdempotency(tx, "delivery.dispatchInvoice", input.clientRequestId, payloadHash);
      if (existingId != null) {
        const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, existingId)).limit(1))[0];
        return {
          consignmentId: existingId,
          consignmentNumber: cn?.consignmentNumber ?? "",
          invoiceId: Number(cn?.invoiceId ?? 0),
          codAmount: String(cn?.codAmount ?? "0"),
          deliveryFee: String(cn?.deliveryFee ?? "0"),
          idempotentReplay: true as const,
        };
      }
    }

    // ترتيب أقفال موحّد مع dispatchToDelivery: الجهة ← الفاتورة (لا جمود متبادل).
    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party || !party.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل غير متاحة" });

    const inv = (await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
    const elevated = actor.role === "admin" || actor.role === "manager";
    if (!elevated && actor.branchId != null && Number(inv.branchId) !== actor.branchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك إسناد فاتورة فرعٍ آخر" });
    }
    if (party.branchId != null && Number(party.branchId) !== Number(inv.branchId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل لا تخصّ فرع الفاتورة" });
    }
    if (inv.status === "CANCELLED" || inv.status === "RETURNED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُسنَد فاتورة ملغاة أو مرتجعة للتوصيل" });
    }
    // حارس بنيويّ مساند لقيد uq_consignment_invoice: رسالةٌ مفهومة بدل خطأ قاعدة بيانات.
    const already = (await tx.select({ id: deliveryConsignments.id, n: deliveryConsignments.consignmentNumber })
      .from(deliveryConsignments).where(eq(deliveryConsignments.invoiceId, input.invoiceId)).limit(1))[0];
    if (already) {
      throw new TRPCError({ code: "CONFLICT", message: `الفاتورة مُسنَدة أصلاً للإرسالية ${already.n}` });
    }

    const fee = round2(money(input.deliveryFee ?? party.defaultFee ?? "0"));
    if (fee.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "أجرة التوصيل لا تصحّ أن تكون سالبة" });

    // COD = ما تبقّى على الفاتورة فقط (مالُنا). الأجرة **ليست** جزءاً منه — تمريرٌ للمندوب.
    const codAmount = round2(money(inv.total).minus(money(inv.paidAmount ?? "0")));
    if (codAmount.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة مدفوعةٌ بأكثر من قيمتها — راجعها قبل الإسناد" });
    const codPositive = codAmount.gt(0);
    // الأجرة تُصرَف الآن حين لا توريدَ يُنتظَر (نفس قاعدة dispatch.ts). بعد حظر COUNTER (ش٠)
    // بقي مسارٌ واحد للصرف الفوريّ: SHOP بفاتورةٍ مدفوعة كاملاً (codAmount=0) — لا توريد يُخصم منه.
    const settleFeeNow = fee.gt(0) && feeCollection === "SHOP" && !codPositive;

    const consignmentNumber = await nextConsignmentNumber(tx, Number(inv.branchId));
    const cnRes = await tx.insert(deliveryConsignments).values({
      consignmentNumber,
      branchId: Number(inv.branchId),
      partyId: input.partyId,
      invoiceId: Number(inv.id),
      workOrderId: null,
      endCustomerId: inv.customerId ?? null,
      codAmount: toDbMoney(codAmount),
      collectedAmount: "0",
      deliveryFee: toDbMoney(fee),
      feeCollection,
      feeSettledAt: settleFeeNow ? new Date() : null,
      recipientName: input.recipientName ?? inv.contactName ?? null,
      recipientPhone: input.recipientPhone ?? inv.contactPhone ?? null,
      deliveryAddress: input.deliveryAddress ?? null,
      status: codPositive ? "DISPATCHED" : "DELIVERED",
      settledAt: codPositive ? null : new Date(),
      dispatchedBy: actor.userId,
    });
    const consignmentId = extractInsertId(cnRes);

    if (codPositive) {
      await adjustDeliveryBalance(tx, input.partyId, codAmount);
      await postEntry(tx, {
        entryType: "DELIVERY_DISPATCH",
        dedupeKey: `DELIVERY_DISPATCH:${consignmentId}`,
        branchId: Number(inv.branchId),
        invoiceId: Number(inv.id),
        deliveryPartyId: input.partyId,
        amount: codAmount,
        notes: `إرسالية ${consignmentNumber}`,
      });
    }

    if (settleFeeNow) {
      const { shiftId, cashBucket } = await shiftIdForCashTx(
        tx,
        { userId: actor.userId, branchId: actor.branchId ?? undefined, role: actor.role },
        Number(inv.branchId),
        "صرف أجرة توصيل",
        "RECEPTION",
      );
      const feeOut = await tx.insert(receipts).values({
        branchId: Number(inv.branchId),
        shiftId,
        invoiceId: Number(inv.id),
        direction: "OUT",
        amount: toDbMoney(fee),
        paymentMethod: "CASH",
        cashBucket,
        status: "COMPLETED",
        partyType: "OTHER",
        referenceNumber: consignmentNumber,
        description: `أجرة توصيل إرسالية ${consignmentNumber}`,
        createdBy: actor.userId,
      });
      // ش٠: بعد حظر COUNTER لا يصل هنا إلا SHOP (مصروفٌ حقيقيّ) — DELIVERY_FEE_HELD يعود مع ش٦.
      await postEntry(tx, {
        entryType: "DELIVERY_FEE",
        dedupeKey: `DELIVERY_FEE_DISPATCH:${consignmentId}`,
        branchId: Number(inv.branchId),
        invoiceId: Number(inv.id),
        deliveryPartyId: input.partyId,
        receiptId: extractInsertId(feeOut),
        amount: fee,
        cost: fee,
        profit: fee.neg(),
        notes: `أجرة توصيل ${consignmentNumber}`,
      });
    }

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "delivery.dispatchInvoice", input.clientRequestId, consignmentId, payloadHash);
    }
    return {
      consignmentId,
      consignmentNumber,
      invoiceId: Number(inv.id),
      invoiceNumber: inv.invoiceNumber,
      codAmount: codAmount.toFixed(2),
      deliveryFee: fee.toFixed(2),
    };
  });
}
