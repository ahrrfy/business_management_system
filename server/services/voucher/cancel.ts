// إلغاء سند قبض/صرف مستقلّ — المرآة الدقيقة لـcreateVoucher (إيصال تعويضي + قيد معاكس + عكس رصيد).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { receipts, shifts } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { adjustCustomerBalance, adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, toDbMoney } from "../money";
import { getActiveLock } from "../periodLockService";
import { type Actor, withTx } from "../tx";
import { assertBranchOwnership } from "./helpers";

export interface CancelVoucherResult {
  receiptId: number;
  voucherNumber: string;
  status: "REVERSED";
}

/**
 * إلغاء سند قبض/صرف مستقلّ — المرآة الدقيقة لـcreateVoucher:
 *   - الأصل يُعلَّم REVERSED (يبقى في السجلّ للتدقيق).
 *   - إيصال تعويضي بالاتجاه المعاكس على نفس الوردية/الطريقة/المبلغ
 *     (تسوية الصندوق تجمع كل receipts بغضّ النظر عن status ⇒ قلب الحالة وحده يُفسد الصندوق).
 *   - قيد دفتر معاكس (PAYMENT_OUT لإلغاء قبض، PAYMENT_IN لإلغاء صرف) بمبلغ موجب —
 *     ⚠️ ليس ADJUST: صيَغ reconcile تتجاهل ADJUST ⇒ انحراف وهمي دائم.
 *   - عكس رصيد الطرف بإشارة معاكسة تماماً لما كتبه createVoucher.
 *
 * إن كان السند PENDING_APPROVAL ⇒ لا أثر مالي لإلغائه (لم يُسجَّل أصلاً) ⇒ نُعلّمه REVERSED مباشرة.
 * يُمنع الإلغاء على وردية مغلقة (Z-report صدر بالأرقام القديمة).
 */
export async function cancelVoucher(receiptId: number, actor: Actor): Promise<CancelVoucherResult> {
  return withTx(async (tx) => {
    const r = (
      await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update").limit(1)
    )[0];
    if (!r || r.voucherNumber == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    if (r.invoiceId != null || r.workOrderId != null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء إيصال مرتبط بفاتورة/طلب خدمة من هنا" });
    }
    if (r.status === "REVERSED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السند ملغى بالفعل" });
    }
    if (r.status !== "COMPLETED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء سند غير مكتمل" });
    }
    if (actor.role !== "admin" && r.createdBy != null && Number(r.createdBy) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز إلغاء سند أنشأته بنفسك — يلزم مدير آخر (فصل المهام)." });
    }
    await assertBranchOwnership(tx, actor, r.branchId != null ? Number(r.branchId) : null, "سند");

    // قفل الفترة (تدقيق ١٧/٧): الإلغاء يقلب الأصل إلى REVERSED فيختفي من تدفّق الشهر النقدي — لو كان
    // السند مؤرَّخاً داخل فترة مُقفَلة تتغيّر أرقامها بأثر رجعي. نرفض الإلغاء ونطلب فتح الفترة أولاً
    // (يبقى مبدأ العكس بقيد مؤرَّخ اليوم للحالات المفتوحة فقط — مطابق لدلالة assertPeriodOpen).
    const lock = await getActiveLock(tx);
    if (lock) {
      // voucherDate عمود DATE: drizzle يُصنّفه string لكن mysql2 يعيد Date وقت التشغيل ⇒ new Date()
      // يعمل للحالتين، ثم toISOString (UTC) مطابقاً لدلالة assertPeriodOpen.
      const vDay = r.voucherDate ? new Date(r.voucherDate).toISOString().slice(0, 10) : "";
      if (vDay && vDay <= lock.cutoffDate) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `الفترة المالية مُقفَلة حتى ${lock.cutoffDate} — لا يمكن إلغاء سند مؤرَّخ داخلها. يلزم فتح الفترة أوّلاً (admin).`,
        });
      }
    }

    if (r.shiftId != null) {
      const sh = (
        await tx.select({ status: shifts.status }).from(shifts).where(eq(shifts.id, Number(r.shiftId))).limit(1)
      )[0];
      if (sh && sh.status === "CLOSED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء سند على وردية مغلقة" });
      }
    }

    const voucherNumber = String(r.voucherNumber);

    // سند مُعلَّق غير مُعتمَد ⇒ لا أثَر مالي لعَكسه. نَكتفي بتَعليمه REVERSED.
    if (r.approvalStatus === "PENDING_APPROVAL" || r.approvalStatus === "REJECTED") {
      await tx.update(receipts).set({ status: "REVERSED" }).where(eq(receipts.id, receiptId));
      return { receiptId, voucherNumber, status: "REVERSED" as const };
    }

    const amount = money(r.amount);
    const direction = r.direction as "IN" | "OUT";

    await tx.update(receipts).set({ status: "REVERSED" }).where(eq(receipts.id, receiptId));

    const compRes = await tx.insert(receipts).values({
      invoiceId: null,
      branchId: r.branchId != null ? Number(r.branchId) : null,
      shiftId: r.shiftId != null ? Number(r.shiftId) : null,
      cashBucket: (r as { cashBucket?: "DRAWER" | "TREASURY" | null }).cashBucket ?? null,
      direction: direction === "IN" ? "OUT" : "IN",
      amount: toDbMoney(amount),
      paymentMethod: r.paymentMethod,
      status: "COMPLETED",
      referenceNumber: `CANCEL-VCH-${receiptId}`,
      voucherNumber: null,
      partyType: r.partyType ?? null,
      partyId: r.partyId != null ? Number(r.partyId) : null,
      description: `إلغاء سند ${voucherNumber}`,
      createdBy: actor.userId,
      approvalStatus: "APPROVED", // إيصال تَعويضي فوري لا يَحتاج موافقة
    });
    const compReceiptId = extractInsertId(compRes);

    await postEntry(tx, {
      entryType: direction === "IN" ? "PAYMENT_OUT" : "PAYMENT_IN",
      branchId: r.branchId != null ? Number(r.branchId) : null,
      receiptId: compReceiptId,
      customerId: r.partyType === "CUSTOMER" && r.partyId != null ? Number(r.partyId) : null,
      supplierId: r.partyType === "SUPPLIER" && r.partyId != null ? Number(r.partyId) : null,
      amount,
      notes: `إلغاء سند ${voucherNumber}`,
    });

    if (r.partyType === "CUSTOMER" && r.partyId != null) {
      await adjustCustomerBalance(tx, Number(r.partyId), direction === "IN" ? amount : amount.neg());
    } else if (r.partyType === "SUPPLIER" && r.partyId != null) {
      await adjustSupplierBalance(tx, Number(r.partyId), direction === "OUT" ? amount : amount.neg());
    }

    return { receiptId, voucherNumber, status: "REVERSED" as const };
  });
}
