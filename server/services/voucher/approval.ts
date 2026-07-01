// اعتماد/رفض سند مُعلَّق (Maker-Checker، SOD-04: المُعتمِد ≠ المُنشئ إلا الـadmin).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { receipts } from "../../../drizzle/schema";
import { adjustCustomerBalance, adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, toDateStr, toDbMoney } from "../money";
import { openShiftIdTx, shiftIdForCashTx } from "../shiftService";
import { type Actor, withTx } from "../tx";
import { assertBranchOwnership, computeSignature } from "./helpers";
import type { PartyType, PaymentMethod } from "./types";

export interface ApproveVoucherResult {
  receiptId: number;
  voucherNumber: string;
  approvalStatus: "APPROVED";
  signatureHash: string;
}

/** اعتماد سند مُعلَّق (Maker-Checker): يُسجّل الأثر المالي ويُختم بـsignatureHash.
 *
 * شرط SOD-04 (فصل المهام، vouchers-pro): المُعتمِد ≠ المُنشئ، إلا الـadmin (مُستثنى للتصحيح الإداري).
 * شرط الفرع: غير الـadmin يَلزمه فرع السند.
 * شرط الحالة: السند يَجب أن يَكون PENDING_APPROVAL (لا APPROVED مُكرَّر، لا REJECTED).
 */
export async function approveVoucher(receiptId: number, actor: Actor): Promise<ApproveVoucherResult> {
  return withTx(async (tx) => {
    const r = (
      await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update").limit(1)
    )[0];
    if (!r || r.voucherNumber == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    if (r.approvalStatus === "APPROVED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السند مُعتمَد بالفعل" });
    }
    if (r.approvalStatus === "REJECTED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السند مرفوض — لا يمكن اعتماده" });
    }
    if (r.status === "REVERSED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السند ملغى — لا يمكن اعتماده" });
    }
    // SOD-04: المُنشئ لا يُعتمد سنده.
    if (actor.role !== "admin" && r.createdBy != null && Number(r.createdBy) === actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يجوز اعتماد سند أنشأته بنفسك — يلزم مدير آخر (فصل المهام).",
      });
    }
    await assertBranchOwnership(tx, actor, r.branchId != null ? Number(r.branchId) : null, "سند");

    const amount = money(r.amount);
    const direction = r.direction as "IN" | "OUT";
    const branchId = Number(r.branchId);
    const partyType = r.partyType as PartyType | null;
    const partyId = r.partyId != null ? Number(r.partyId) : null;
    const paymentMethod = r.paymentMethod as PaymentMethod;

    // تَحديد shiftId/cashBucket عند الاعتماد (لا عند الإنشاء ⇒ يَتسق مع وردية المُعتمِد لا المُنشئ
    // — وهو الصحيح: لحظة الاعتماد هي لحظة التأثير على الصندوق).
    let shiftId: number | null;
    let cashBucket: "DRAWER" | "TREASURY" | null = null;
    if (paymentMethod === "CASH") {
      const g = await shiftIdForCashTx(tx, actor, branchId, "اعتماد سند نقدي");
      shiftId = g.shiftId;
      cashBucket = g.cashBucket;
    } else {
      shiftId = await openShiftIdTx(tx, actor.userId, branchId);
    }

    const voucherDate = (r.voucherDate as string | null) ?? toDateStr();

    await tx.update(receipts).set({
      approvalStatus: "APPROVED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      shiftId,
      cashBucket,
    }).where(eq(receipts.id, receiptId));

    // الأثر المالي:
    await postEntry(tx, {
      entryType: direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT",
      branchId,
      receiptId,
      customerId: partyType === "CUSTOMER" ? partyId : null,
      supplierId: partyType === "SUPPLIER" ? partyId : null,
      amount,
    });
    if (partyType === "CUSTOMER" && partyId) {
      await adjustCustomerBalance(tx, partyId, direction === "IN" ? amount.neg() : amount);
    } else if (partyType === "SUPPLIER" && partyId) {
      await adjustSupplierBalance(tx, partyId, direction === "OUT" ? amount.neg() : amount);
    }

    // البَصمة بعد إكمال كل التَغييرات.
    const hash = computeSignature({
      id: receiptId,
      amount: toDbMoney(amount),
      partyType: partyType ?? "OTHER",
      partyId,
      paymentMethod,
      voucherDate: String(voucherDate).slice(0, 10),
      voucherNumber: String(r.voucherNumber),
      createdBy: r.createdBy != null ? Number(r.createdBy) : 0,
      approvedBy: actor.userId,
      branchId,
    });
    await tx.update(receipts).set({ signatureHash: hash }).where(eq(receipts.id, receiptId));

    return {
      receiptId,
      voucherNumber: String(r.voucherNumber),
      approvalStatus: "APPROVED" as const,
      signatureHash: hash,
    };
  });
}

export interface RejectVoucherResult {
  receiptId: number;
  voucherNumber: string;
  approvalStatus: "REJECTED";
}

/** رفض سند مُعلَّق — لا أثر مالي (لم يُسجَّل قيد ولا تَغيَّر رصيد). يَبقى للسجل التَدقيقي.
 *  نفس قاعدة SOD-04: لا يَرفض المُنشئ سنده (إلا admin). */
export async function rejectVoucher(
  receiptId: number,
  actor: Actor,
  reason: string,
): Promise<RejectVoucherResult> {
  return withTx(async (tx) => {
    const r = (
      await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update").limit(1)
    )[0];
    if (!r || r.voucherNumber == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    if (r.approvalStatus !== "PENDING_APPROVAL") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السند ليس في انتظار الموافقة" });
    }
    if (actor.role !== "admin" && r.createdBy != null && Number(r.createdBy) === actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يجوز رفض سند أنشأته بنفسك — يلزم مدير آخر (فصل المهام).",
      });
    }
    await assertBranchOwnership(tx, actor, r.branchId != null ? Number(r.branchId) : null, "سند");

    const trimmedReason = reason.trim().slice(0, 500);
    if (!trimmedReason) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الرفض مطلوب (للسجل التَدقيقي)" });
    }
    const noteSuffix = `\n[رُفض ${new Date().toISOString().slice(0, 19)}: ${trimmedReason}]`;
    const newInternal = (r.internalNote ?? "") + noteSuffix;

    await tx.update(receipts).set({
      approvalStatus: "REJECTED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      internalNote: newInternal,
    }).where(eq(receipts.id, receiptId));

    return {
      receiptId,
      voucherNumber: String(r.voucherNumber),
      approvalStatus: "REJECTED" as const,
    };
  });
}
