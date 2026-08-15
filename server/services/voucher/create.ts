// إنشاء سند قبض/صرف مستقلّ ذرّياً (Maker-Checker + idempotency).
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { customers, idempotencyKeys, invoices, receipts, suppliers } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, adjustSupplierBalance, postEntry } from "../ledgerService";
import { utcDayStart } from "../businessDay";
import { money, toDateStr, toDbMoney } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import { lockBranchMonthCloseGate } from "../reports/monthCloseGate";
import { openShiftIdTx, shiftIdForCashTx } from "../shiftService";
import { assertNonPhysicalOutReceipt } from "../cash/cashAvailability";
import type { Tx } from "../../db";
import { type Actor, withTx } from "../tx";
import { computeSignature, nextVoucherNumber, validateCategory } from "./helpers";
import type { VoucherInput, VoucherResult } from "./types";

const SYSTEM_REQUEST_PREFIX = "@SYSTEM_PAYMENT_REQUEST:";
const SYSTEM_REFERENCE_PREFIXES = [
  "ASSET-ACQ-",
  "ASSET-REACQ-",
  "ASSET-MAINT-",
  "PO-PAY-",
  "SHIP-",
  "EXCHANGE-IQD-DEP-",
  "DIGITAL-WALLET-DEP-",
  "CANCEL-VCH-",
] as const;

export function isSystemPaymentReference(reference: string | null | undefined): boolean {
  return !!reference && SYSTEM_REFERENCE_PREFIXES.some((prefix) => reference.startsWith(prefix));
}

export type SystemPaymentRequest =
  | { kind: "ASSET_ACQUISITION"; assetId: number }
  | {
      kind: "ASSET_REACQUISITION";
      assetId: number;
      sequence: number;
      source: AssetFinancialSnapshot;
      target: AssetFinancialSnapshot & { supplierId: null };
    }
  | { kind: "ASSET_MAINTENANCE"; assetId: number; maintenanceId: number }
  | {
      kind: "PURCHASE_SUPPLIER";
      purchaseOrderId: number;
      requestToken: string;
      expectedAmount: string;
      sourceTotal: string;
    }
  | {
      kind: "PURCHASE_SHIPPING";
      purchaseOrderId: number;
      requestToken: string;
      expectedAmount: string;
      sourceShippingTotal: string;
    }
  | {
      kind: "EXCHANGE_IQD_DEPOSIT";
      transactionId: number;
      exchangeHouseId: number;
      expectedAmount: string;
    }
  | {
      kind: "DIGITAL_WALLET_CASH_DEPOSIT";
      transactionId: number;
      walletId: number;
      expectedAmount: string;
    }
  | { kind: "VOUCHER_CANCELLATION"; originalReceiptId: number; originalCreatorId: number | null };

export interface AssetFinancialSnapshot {
  branchId: number | null;
  supplierId: number | null;
  purchaseDate: string;
  purchaseValue: string;
  salvageValue: string;
  usefulLifeYears: number;
  depreciationMethod: "sl" | "db";
  accumulatedDepreciation: string;
}

function encodeSystemPaymentRequest(request: SystemPaymentRequest): string {
  return `${SYSTEM_REQUEST_PREFIX}${JSON.stringify(request)}`;
}

export function parseSystemPaymentRequest(note: string | null | undefined): SystemPaymentRequest | null {
  if (!note?.startsWith(SYSTEM_REQUEST_PREFIX)) return null;
  try {
    const parsed = JSON.parse(note.slice(SYSTEM_REQUEST_PREFIX.length)) as SystemPaymentRequest;
    if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** يُنشئ سند قبض (IN) أو صرف (OUT) ذريّاً.
 *
 * Maker-Checker: كل سند صرف يُسجَّل بـapprovalStatus=PENDING_APPROVAL، بصرف النظر
 * عن المبلغ أو صفة المُنشئ، بلا قيد دفتر ولا تأثير على الرصيد/الصندوق. الاعتماد اللاحق
 * من مالك نشط مختلف عبر approveVoucher() هو منفذ الأثر المالي الوحيد (SOD).
 * سند القبض يحتفظ بسياسة الاعتماد القائمة.
 */
export async function createVoucherTx(
  tx: Tx,
  input: VoucherInput,
  actor: Actor,
  options?: { systemRequest?: SystemPaymentRequest },
): Promise<VoucherResult> {
    if (input.paymentMethod === "EXCHANGE") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "سند الصيرفة يُنشأ حصراً من شاشة «تسديد مورد عبر الصيرفة» لضمان تحريك الطرفين ذرّياً",
      });
    }
    if (!input.clientRequestId?.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مفتاح idempotency إلزامي لإنشاء السند" });
    }
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
          const requestedDirection = input.voucherType === "RECEIPT" ? "IN" : "OUT";
          const requestedReference = input.referenceNumber?.trim() || null;
          const requestedSystemNote = options?.systemRequest
            ? encodeSystemPaymentRequest(options.systemRequest)
            : null;
          if (
            Number(r.branchId) !== Number(input.branchId) ||
            r.direction !== requestedDirection ||
            r.paymentMethod !== input.paymentMethod ||
            (r.partyType ?? null) !== (input.partyType ?? null) ||
            storedPartyId !== requestedPartyId ||
            storedInvoiceId !== requestedInvoiceId ||
            (r.referenceNumber ?? null) !== requestedReference ||
            (requestedSystemNote != null && r.internalNote !== requestedSystemNote) ||
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
    if (!options?.systemRequest && input.internalNote?.startsWith(SYSTEM_REQUEST_PREFIX)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "بادئة الملاحظات النظامية محجوزة" });
    }
    if (!options?.systemRequest && isSystemPaymentReference(input.referenceNumber)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مرجع السند النظامي محجوز" });
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
    // المُرفق **اختياريّ دائماً** (٣١/٧، قرار المالك: لا مُرفق إلزامي في النظام كله) — أُلغيت عَتبة
    // إلزام المُرفق التي كانت تَرفض السندات ≥ ٢٥٠.٠٠٠ د.ع بلا attachmentUrl.
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

    // بضاعة الأمانة (ش٥): يُرفَع لو كان الصرف لمودِع أمانة (اعتماد ثنائيّ دائماً).
    let forcePendingApproval = false;
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
      // بضاعة الأمانة (ش٥): أيّ صرفٍ لمودِع أمانة يمرّ باعتمادٍ ثنائيّ **دائماً** مهما صغُر المبلغ
      // (قرار المالك ٣ — يغلق التفاف «سند حرّ تحت العتبة بفاعل واحد»). + سقف ≤ المستحق (currentBalance)
      // يُعاد فحصه عند الاعتماد تحت القفل. §٥ حاصرة ٢.
      if (direction === "OUT" && sup.supplierKind === "CONSIGNOR") {
        forcePendingApproval = true;
        if (money(sup.currentBalance ?? "0").lt(amount)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `مبلغ الصرف يتجاوز مستحقّ المودِع (${money(sup.currentBalance ?? "0").toFixed(2)})` });
        }
      }
    } else if (input.partyType === "OTHER") {
      if (!input.counterpartyName?.trim()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الطرف المقابل إلزامي لسندات «أخرى»" });
      }
      // قبض OTHER يخلق نقداً من مصدر خارجي مجهول وقابل للتجزئة؛ لذلك يخضع دائماً إلى Maker‑Checker.
      if (input.voucherType === "RECEIPT") forcePendingApproval = true;
    }

    const voucherDate = (input.voucherDate?.trim() || toDateStr()).slice(0, 10);
    if (voucherDate > toDateStr()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `لا يجوز تأريخ السند في المستقبل (${voucherDate})` });
    }

    // بوابة الفرع تتسلسل مع اعتماد إقفال الشركة. نعيد فحص تاريخ السند بعد نيلها حتى لا
    // يُنشأ PENDING_APPROVAL بأثر رجعي بعد أن التزم القفل في أثناء الانتظار.
    await lockBranchMonthCloseGate(tx, input.branchId);
    await assertPeriodOpen(tx, utcDayStart(voucherDate));

    const voucherNumber = await nextVoucherNumber(tx, input.voucherType, input.branchId);
    // عقد المالك: كل سند صرف يُنشأ طلباً معلّقاً، بصرف النظر عن المبلغ أو صفة المنشئ.
    // سند القبض يبقى على سياسته القائمة (OTHER يحتاج Maker-Checker، وغيره مباشر).
    const needsApproval = direction === "OUT" || forcePendingApproval;

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

    if (needsApproval && direction === "OUT") {
      assertNonPhysicalOutReceipt({
        classification: "DEFERRED_APPROVAL", paymentMethod: input.paymentMethod,
        cashBucket: null, approvalStatus: "PENDING_APPROVAL", operation: "إنشاء طلب سند صرف",
      });
    }
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
      status: needsApproval ? "PENDING" : "COMPLETED",
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
      internalNote: options?.systemRequest
        ? encodeSystemPaymentRequest(options.systemRequest)
        : (input.internalNote?.trim() || null),
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
        await adjustSupplierBalance(tx, input.partyId, amount);
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
}

/** طلب دفع نظامي يعيد استعمال عقد السند الواحد: معلّق دائماً وبلا أثر حتى اعتماد مالك آخر. */
export async function createSystemPaymentRequestTx(
  tx: Tx,
  input: Omit<VoucherInput, "voucherType">,
  actor: Actor,
  request: SystemPaymentRequest,
): Promise<VoucherResult> {
  return createVoucherTx(tx, { ...input, voucherType: "PAYMENT" }, actor, { systemRequest: request });
}

export async function createVoucher(input: VoucherInput, actor: Actor): Promise<VoucherResult> {
  return withTx((tx) => createVoucherTx(tx, input, actor));
}
