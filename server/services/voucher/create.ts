// إنشاء سند قبض/صرف مستقلّ ذرّياً (Maker-Checker + idempotency).
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { customers, idempotencyKeys, invoices, receipts, suppliers } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, toDateStr, toDbMoney } from "../money";
import { openShiftIdTx, shiftIdForCashTx } from "../shiftService";
import { type Actor, withTx } from "../tx";
import { getApprovalThreshold, getAttachmentThreshold } from "./thresholds";
import { computeSignature, nextVoucherNumber, validateCategory } from "./helpers";
import type { VoucherInput, VoucherResult } from "./types";

/** يُنشئ سند قبض (IN) أو صرف (OUT) ذريّاً.
 *
 * Maker-Checker: لو المَبلغ ≥ getApprovalThreshold() يُسجَّل بـapprovalStatus=PENDING_APPROVAL
 * بلا قيد دفتر ولا تأثير على الرصيد/الصندوق — فقط الصفّ في receipts. الاعتماد لاحقاً
 * عبر approveVoucher() يُكمل الأثر المالي. النَموذج: «المُسجِّل ≠ المُعتمِد» (SOD).
 */
export async function createVoucher(input: VoucherInput, actor: Actor): Promise<VoucherResult> {
  return withTx(async (tx) => {
    // Idempotency: تكرار نفس المفتاح يُعاد بنتيجة السند الأول (لا قيد/نقد مزدوج).
    // #installments-3 (تدقيق التثبيت): كان الـreplay يُرجع أي سند مخزَّن — بما فيها المرفوض/الملغى —
    // فمسار الأقساط يستعمل clientRequestId ثابتاً `instpay-${lineId}`، ومحاولةٌ بعد رفض السند تُرجع
    // السند المرفوض فيُوسم القسط PAID خطأً بمعرِّف سند رُفض (والذمة لا تُخفَّض). الحلّ: نتخطّى الـreplay
    // إن كان السند المخزَّن في حالة ميتة (REVERSED/FAILED أو REJECTED) — دلالة idempotency: نمنع تكرار
    // أثر جانبيّ نافذ؛ سند رُبِط في الدفتر ثم عُكس/رُفض ليس له أثر نافذ لنعيد إرجاعه.
    if (input.clientRequestId) {
      const existingRefId = await findIdempotentRefId(tx, "voucher.create", input.clientRequestId);
      if (existingRefId != null) {
        const r = (await tx.select().from(receipts).where(eq(receipts.id, existingRefId)).limit(1))[0];
        if (!r) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "سند idempotency مفقود — تحقّق من الإيصال" });
        }
        const isDead = r.status === "REVERSED" || r.status === "FAILED" || r.approvalStatus === "REJECTED";
        if (!isDead) {
          const storedPartyId = r.partyId != null ? Number(r.partyId) : null;
          const requestedPartyId = input.partyType === "OTHER" ? null : (input.partyId ?? null);
          const storedInvoiceId = r.invoiceId != null ? Number(r.invoiceId) : null;
          const requestedInvoiceId = input.invoiceId ?? null;
          if (
            Number(r.branchId) !== Number(input.branchId) ||
            (r.partyType ?? null) !== (input.partyType ?? null) ||
            storedPartyId !== requestedPartyId ||
            storedInvoiceId !== requestedInvoiceId ||
            money(r.amount).toFixed(2) !== money(input.amount).toFixed(2)
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "تعارض idempotency: المفتاح مستعمَل لسند بطرف/فرع/مبلغ/فاتورة مختلفة",
            });
          }
          return {
            receiptId: existingRefId,
            voucherNumber: r.voucherNumber ?? "",
            direction: (r.direction as "IN" | "OUT") ?? "IN",
            approvalStatus: (r.approvalStatus as VoucherResult["approvalStatus"]) ?? "APPROVED",
          };
        }
        // سند ميت (مرفوض/معكوس/فاشل) ⇒ نتخطّى الـreplay ونُنشئ سنداً جديداً بنفس المفتاح.
        // recordIdempotencyKey أدناه سيُحاول INSERT وسيصطدم بـUNIQUE ⇒ نحذف السجلّ الميت أوّلاً.
        await tx.delete(idempotencyKeys).where(
          and(eq(idempotencyKeys.operation, "voucher.create"), eq(idempotencyKeys.clientRequestId, input.clientRequestId)),
        );
      }
    }
    const amount = money(input.amount);
    if (amount.lte(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ السند يجب أن يكون موجباً" });
    }
    const description = input.description?.trim();
    if (!description) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "وصف السند مطلوب" });
    }
    // تَحقّقات الإلزام المَشروط (vouchers-pro):
    if (input.paymentMethod === "TRANSFER" && !input.referenceNumber?.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الرقم المرجعي إلزامي لطريقة الدفع «تحويل» (للتطابق مع كَشف البنك)" });
    }
    if (input.paymentMethod === "CARD") {
      const tail = input.cardLastFour?.trim() ?? "";
      if (!/^\d{4}$/.test(tail)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "آخر ٤ من البطاقة إلزامي لطريقة الدفع «بطاقة» (٤ أرقام)" });
      }
    }
    if (input.paymentMethod === "CHECK" && !input.checkNumber?.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "رقم الصكّ إلزامي لطريقة الدفع «صكّ»" });
    }
    if (amount.toNumber() >= getAttachmentThreshold() && !input.attachmentUrl?.trim()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `المُرفق إلزامي للمبالغ ${getAttachmentThreshold().toLocaleString("ar-IQ-u-nu-latn")} د.ع فما فوق (إيصال/فاتورة/صورة المُستند الأصلي)`,
      });
    }
    // attachment-upload (٥/٧): المُرفق إمّا data URL صورة مضغوطة (رفع من الواجهة الجديدة) أو رابط/مَسار
    // نصّي كما كان سابقاً (اختبارات vouchers-pro القائمة تُرسل روابط https:// عادية عمداً — تبقى صالحة).
    // لا فرض صيغة صورة هنا؛ الطباعة/العرض يُميّزان data:image بأنفسهما (voucherPrint.ts، Vouchers.tsx).

    const direction: "IN" | "OUT" = input.voucherType === "RECEIPT" ? "IN" : "OUT";

    // تَحقّق الفئة (إن مُرّرت) — الاتجاه يَجب أن يَتسق مع نوع السند.
    if (input.voucherCategoryId != null) {
      await validateCategory(tx, input.voucherCategoryId, direction);
    }

    // attachment-upload (٥/٧): ربط سند بفاتورة — العميل فقط (السندات receipts.invoiceId يُشير لـinvoices
    // وهي فواتير بيع دائماً؛ المشتريات/الموردون تُدار عبر أوامر الشراء بلا عمود مماثل بعد).
    if (input.invoiceId != null && input.partyType !== "CUSTOMER") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "ربط السند بفاتورة مُتاح لسندات العميل فقط" });
    }

    // تَحقّق الطرف: يَجب أن يَكون نشطاً.
    if (input.partyType === "CUSTOMER") {
      if (!input.partyId) throw new TRPCError({ code: "BAD_REQUEST", message: "العميل مطلوب لسند مرتبط بعميل" });
      const c = (await tx.select().from(customers).where(eq(customers.id, input.partyId)).limit(1))[0];
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
      if (!c.isActive) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إصدار سند لعميل مُعطَّل" });
      }
      if (input.invoiceId != null) {
        const inv = (await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1))[0];
        if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة المرتبطة غير موجودة" });
        if (Number(inv.customerId) !== Number(input.partyId)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة المرتبطة لا تخصّ هذا العميل" });
        }
        if (inv.status === "CANCELLED" || inv.status === "RETURNED") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن الربط بفاتورة ملغاة أو مرتجعة" });
        }
      }
    } else if (input.partyType === "SUPPLIER") {
      if (!input.partyId) throw new TRPCError({ code: "BAD_REQUEST", message: "المورد مطلوب لسند مرتبط بمورد" });
      const sup = (await tx.select().from(suppliers).where(eq(suppliers.id, input.partyId)).limit(1))[0];
      if (!sup) throw new TRPCError({ code: "NOT_FOUND", message: "المورد غير موجود" });
      if (!sup.isActive) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إصدار سند لمورد مُعطَّل" });
      }
    } else if (input.partyType === "OTHER") {
      // counterpartyName مَوصى به (تَحذير ناعم بأن يُعرَض في الواجهة) لكنّ ليس إلزامياً —
      // الـdescription يَكفي لتَحديد الهوية. النَموذج المُلزم يَكون عبر فئة الإيجار/الراتب.
    }

    const voucherNumber = await nextVoucherNumber(tx, input.voucherType, input.branchId);
    const needsApproval = amount.toNumber() >= getApprovalThreshold();

    // shiftId + cashBucket — سياسة الخزينة الإدارية vs درج الكاشير (تدقيق ١٧/٦).
    //  - PENDING_APPROVAL: لا نَقفل وردية ولا نُحدّد دلواً (لا تأثير على الصندوق حتى الاعتماد).
    let shiftId: number | null = null;
    let cashBucket: "DRAWER" | "TREASURY" | null = null;
    if (!needsApproval) {
      if (input.paymentMethod === "CASH") {
        const g = await shiftIdForCashTx(tx, actor, input.branchId, "سند نقدي");
        shiftId = g.shiftId;
        cashBucket = g.cashBucket;
      } else {
        shiftId = await openShiftIdTx(tx, actor.userId, input.branchId);
      }
    }

    const voucherDate = (input.voucherDate?.trim() || toDateStr()).slice(0, 10);

    const rRes = await tx.insert(receipts).values({
      branchId: input.branchId,
      invoiceId: input.partyType === "CUSTOMER" ? (input.invoiceId ?? null) : null,
      shiftId,
      cashBucket,
      direction,
      amount: toDbMoney(amount),
      paymentMethod: input.paymentMethod,
      referenceNumber: input.referenceNumber?.trim() || null,
      checkNumber: input.checkNumber?.trim() || null,
      cardLastFour: input.cardLastFour?.trim() || null,
      status: "COMPLETED",
      voucherNumber,
      partyType: input.partyType,
      partyId: input.partyType === "OTHER" ? null : (input.partyId ?? null),
      description,
      createdBy: actor.userId,
      // vouchers-pro:
      voucherCategoryId: input.voucherCategoryId ?? null,
      counterpartyName: input.counterpartyName?.trim() || null,
      voucherDate: new Date(voucherDate),
      attachmentUrl: input.attachmentUrl?.trim() || null,
      internalNote: input.internalNote?.trim() || null,
      approvalStatus: needsApproval ? "PENDING_APPROVAL" : "APPROVED",
    });
    const receiptId = extractInsertId(rRes);

    // الأثر المالي يُطبَّق فقط عند الاعتماد (PENDING_APPROVAL ⇒ صفّ معلَّق بلا أثَر).
    if (!needsApproval) {
      await postEntry(tx, {
        entryType: direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT",
        branchId: input.branchId,
        receiptId,
        customerId: input.partyType === "CUSTOMER" ? (input.partyId ?? null) : null,
        supplierId: input.partyType === "SUPPLIER" ? (input.partyId ?? null) : null,
        amount,
        // يُفرض قفل الفترة على تاريخ السند الفعلي لا تاريخ اليوم — سند بتاريخ رجعي داخل فترة مُقفَلة
        // كان يمرّ لأن postEntry يأخذ new Date() افتراضاً (تدقيق ١٧/٧: قفل الفترة مخترَق عبر السندات).
        entryDate: new Date(voucherDate),
      });

      if (input.partyType === "CUSTOMER" && input.partyId) {
        await adjustCustomerBalance(tx, input.partyId, direction === "IN" ? amount.neg() : amount);
      } else if (input.partyType === "SUPPLIER" && input.partyId) {
        await adjustSupplierBalance(tx, input.partyId, direction === "OUT" ? amount.neg() : amount);
      }

      // البَصمة بَعد كل الكتابات ⇒ تَختم السند بكل عناصره المُستقرّة.
      const hash = computeSignature({
        id: receiptId,
        amount: toDbMoney(amount),
        partyType: input.partyType,
        partyId: input.partyType === "OTHER" ? null : (input.partyId ?? null),
        paymentMethod: input.paymentMethod,
        voucherDate,
        voucherNumber,
        createdBy: actor.userId,
        approvedBy: null, // لا اعتماد مَطلوب
        branchId: input.branchId,
      });
      await tx.update(receipts).set({ signatureHash: hash }).where(eq(receipts.id, receiptId));
    }

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "voucher.create", input.clientRequestId, receiptId);
    }

    return {
      receiptId,
      voucherNumber,
      direction,
      approvalStatus: needsApproval ? "PENDING_APPROVAL" : "APPROVED",
    };
  });
}
