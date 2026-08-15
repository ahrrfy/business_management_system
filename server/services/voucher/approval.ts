// اعتماد/رفض سند مُعلَّق (Maker-Checker، SOD-04: مالك نشط والمُعتمِد ≠ المُنشئ بلا استثناء).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { receipts, suppliers, users } from "../../../drizzle/schema";
import { activateAdvanceForApprovedVoucherTx } from "../advancesService";
import { adjustCustomerBalance, adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, toDateStr, toDbMoney } from "../money";
import { openShiftIdTx, shiftIdForCashTx } from "../shiftService";
import { assertCashOutAvailable, assertNonPhysicalOutReceipt, lockCashSourceForUpdate } from "../cash/cashAvailability";
import { type Actor, withTx } from "../tx";
import { computeSignature } from "./helpers";
import type { PartyType, PaymentMethod } from "./types";

export interface ApproveVoucherResult {
  receiptId: number;
  voucherNumber: string;
  approvalStatus: "APPROVED";
  signatureHash: string;
  replayed: boolean;
}

/** اعتماد سند مُعلَّق (Maker-Checker): يُسجّل الأثر المالي ويُختم بـsignatureHash.
 *
 * عقد المالك: المُعتمِد حساب users نشط وisOwner=true، ومختلف عن المُنشئ بلا استثناء دور.
 * إعادة اعتماد سند APPROVED idempotent: تعيد البصمة بلا أي كتابة أو أثر مالي ثانٍ.
 */
export async function approveVoucher(receiptId: number, actor: Actor): Promise<ApproveVoucherResult> {
  return withTx(async (tx) => {
    const [preview] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).limit(1);
    if (!preview || preview.voucherNumber == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    const [approverPreview] = await tx.select().from(users).where(eq(users.id, actor.userId)).limit(1);
    if (!approverPreview?.isActive || !approverPreview.isOwner) {
      throw new TRPCError({ code: "FORBIDDEN", message: "اعتماد السندات محصور بحساب مالك نشط" });
    }
    const previewApproverActor: Actor = {
      userId: actor.userId,
      branchId: Number(approverPreview.branchId ?? actor.branchId),
      role: approverPreview.role,
      isOwner: true,
    };
    const cashOutPreview = preview.direction === "OUT" && preview.paymentMethod === "CASH";
    const cashInPreview = preview.direction === "IN" && preview.paymentMethod === "CASH";
    let preResolvedCashIn: { shiftId: number | null; cashBucket: "DRAWER" | "TREASURY" } | null = null;
    if (cashOutPreview) {
      await lockCashSourceForUpdate(tx, {
        branchId: Number(preview.branchId),
        cashBucket: "TREASURY",
        shiftId: null,
      });
    } else if (cashInPreview) {
      preResolvedCashIn = await shiftIdForCashTx(
        tx, previewApproverActor, Number(preview.branchId), "اعتماد سند قبض نقدي",
      );
      await lockCashSourceForUpdate(tx, {
        branchId: Number(preview.branchId),
        cashBucket: preResolvedCashIn.cashBucket,
        shiftId: preResolvedCashIn.shiftId,
      });
    }
    // قفل مشاركة يكفي لتثبيت isActive/isOwner حتى نهاية المعاملة، ويبقى متوافقاً
    // مع FK createdBy في كتّاب النقد الآخرين. الترتيب الحاكم للنقد: source → user SHARE → receipt.
    const [approver] = await tx.select().from(users).where(eq(users.id, actor.userId)).for("share").limit(1);
    if (!approver?.isActive || !approver.isOwner) {
      throw new TRPCError({ code: "FORBIDDEN", message: "اعتماد السندات محصور بحساب مالك نشط" });
    }
    if (
      approver.role !== approverPreview.role ||
      Number(approver.branchId ?? actor.branchId) !== Number(approverPreview.branchId ?? actor.branchId)
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّرت صلاحيات المالك أثناء الاعتماد — أعد المحاولة" });
    }
    const r = (
      await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update").limit(1)
    )[0];
    if (!r || r.voucherNumber == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    if (
      (cashOutPreview || cashInPreview) &&
      (r.direction !== preview.direction || r.paymentMethod !== "CASH" || Number(r.branchId) !== Number(preview.branchId))
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر مصدر السند النقدي أثناء الاعتماد — أعد المحاولة" });
    }
    if (r.createdBy != null && Number(r.createdBy) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز اعتماد سند أنشأته بنفسك — يلزم مالك آخر" });
    }
    if (r.approvalStatus === "APPROVED") {
      if (!r.signatureHash) throw new TRPCError({ code: "CONFLICT", message: "السند معتمد بلا بصمة سلامة — راجع التدقيق" });
      return {
        receiptId,
        voucherNumber: String(r.voucherNumber),
        approvalStatus: "APPROVED" as const,
        signatureHash: String(r.signatureHash),
        replayed: true,
      };
    }
    if (r.approvalStatus === "REJECTED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السند مرفوض — لا يمكن اعتماده" });
    }
    if (r.status === "REVERSED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السند ملغى — لا يمكن اعتماده" });
    }
    const amount = money(r.amount);
    const direction = r.direction as "IN" | "OUT";
    const branchId = Number(r.branchId);
    const partyType = r.partyType as PartyType | null;
    const partyId = r.partyId != null ? Number(r.partyId) : null;
    const paymentMethod = r.paymentMethod as PaymentMethod;

    // سند الصرف النقدي يُموَّل من خزينة الفرع دائماً، لا من درج/وردية المالك.
    let shiftId: number | null;
    let cashBucket: "DRAWER" | "TREASURY" | null = null;
    const approverActor: Actor = {
      userId: actor.userId,
      branchId: Number(approver.branchId ?? actor.branchId),
      role: approver.role,
      isOwner: true,
    };
    if (paymentMethod === "CASH" && direction === "OUT") {
      shiftId = null;
      cashBucket = "TREASURY";
    } else if (paymentMethod === "CASH") {
      const g = preResolvedCashIn ?? await shiftIdForCashTx(tx, approverActor, branchId, "اعتماد سند قبض نقدي");
      shiftId = g.shiftId;
      cashBucket = g.cashBucket;
    } else {
      shiftId = await openShiftIdTx(tx, approverActor.userId, branchId);
    }

    // بضاعة الأمانة (ش٥): إعادة فحص السقف تحت قفل صف المودِع — مرتجعٌ بين الإصدار والاعتماد قد يكون
    // خفّض المستحق فيصير الصرف زائداً (السقف عند الإنشاء صار مسرحياً لولا هذا). §٥ حاصرة ٢/ث٤.
    if (partyType === "SUPPLIER" && partyId != null && direction === "OUT") {
      const [sup] = await tx.select({ kind: suppliers.supplierKind, bal: suppliers.currentBalance })
        .from(suppliers).where(eq(suppliers.id, partyId)).for("update").limit(1);
      if (sup?.kind === "CONSIGNOR" && money(sup.bal ?? "0").lt(amount)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `مستحقّ المودِع (${money(sup.bal ?? "0").toFixed(2)}) أقلّ من مبلغ الصرف — أعِد توليد كشف التسوية` });
      }
    }

    if (
      direction === "OUT" &&
      paymentMethod === "CASH" &&
      cashBucket != null
    ) {
      await assertCashOutAvailable(tx, {
        branchId,
        cashBucket,
        shiftId,
        amount,
        operation: "اعتماد سند الصرف النقدي",
      });
    } else if (direction === "OUT") {
      assertNonPhysicalOutReceipt({
        classification: "NON_CASH_METHOD", paymentMethod, cashBucket,
        operation: "اعتماد سند صرف غير نقدي",
      });
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
      // قفل الفترة على تاريخ السند الفعلي لا لحظة الاعتماد (تدقيق ١٧/٧) — يمنع اعتماد سند بتاريخ رجعي
      // داخل فترة مُقفَلة. voucherDate عمود DATE (drizzle يُصنّفه string لكن mysql2 يعيد Date) ⇒ new Date
      // يعمل للحالتين، وtoDateStr = toISOString.slice(0,10) مطابق لدلالة assertPeriodOpen.
      entryDate: new Date(r.voucherDate ? toDateStr(new Date(r.voucherDate)) : toDateStr()),
    });
    if (partyType === "CUSTOMER" && partyId) {
      await adjustCustomerBalance(tx, partyId, direction === "IN" ? amount.neg() : amount);
    } else if (partyType === "SUPPLIER" && partyId) {
      await adjustSupplierBalance(tx, partyId, direction === "OUT" ? amount.neg() : amount);
    }

    await activateAdvanceForApprovedVoucherTx(tx, {
      id: receiptId,
      branchId: r.branchId != null ? Number(r.branchId) : null,
      direction,
      amount: String(r.amount),
      paymentMethod,
      internalNote: r.internalNote,
      createdBy: r.createdBy != null ? Number(r.createdBy) : null,
    });

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
      replayed: false,
    };
  });
}

export interface RejectVoucherResult {
  receiptId: number;
  voucherNumber: string;
  approvalStatus: "REJECTED";
}

/** رفض سند مُعلَّق — لا أثر مالي (لم يُسجَّل قيد ولا تَغيَّر رصيد). يَبقى للسجل التَدقيقي.
 *  نفس عقد المالك وفصل المهام: مالك نشط مختلف عن المنشئ فقط. */
export async function rejectVoucher(
  receiptId: number,
  actor: Actor,
  reason: string,
): Promise<RejectVoucherResult> {
  return withTx(async (tx) => {
    // لا يلزم قفل X على حساب المالك؛ SHARE يثبت صفات التفويض ويتوافق مع FK createdBy.
    const [approver] = await tx.select().from(users).where(eq(users.id, actor.userId)).for("share").limit(1);
    if (!approver?.isActive || !approver.isOwner) {
      throw new TRPCError({ code: "FORBIDDEN", message: "رفض السندات محصور بحساب مالك نشط" });
    }
    const r = (
      await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update").limit(1)
    )[0];
    if (!r || r.voucherNumber == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    if (r.approvalStatus !== "PENDING_APPROVAL") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السند ليس في انتظار الموافقة" });
    }
    if (r.createdBy != null && Number(r.createdBy) === actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يجوز رفض سند أنشأته بنفسك — يلزم مالك آخر",
      });
    }

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
