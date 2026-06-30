// سندات قبض/صرف مستقلّة (B1) — receipts بلا فاتورة بل بطرف مستقلّ (راتب، إيجار، دفعة لعميل، …).
// سند قبض (RV): direction='IN'، طرف يدفع للمحلّ (مثل مورد يَستلم دفعة، عميل يَدفع توقعاً).
// سند صرف (PV): direction='OUT'، المحلّ يَدفع لطرف (مثل راتب موظف، إيجار، دفعة لمورّد).
//
// التأثيرات:
//   - receipts row (مع voucherNumber فريد + partyType/partyId + description + voucherCategoryId + …)
//   - accountingEntries (PAYMENT_IN لـRV، PAYMENT_OUT لـPV)  ⇐ يُؤجَّل إن كانت الموافقة مُعلَّقة
//   - currentBalance للطرف (إن كان CUSTOMER أو SUPPLIER): ينقص لـCUSTOMER عند IN، يزيد عند OUT.
//   - shiftId يُشتقّ تلقائياً من وردية الموظّف المفتوحة (تسوية الصندوق).
//
// vouchers-pro (٣٠/٦/٢٦):
//   - Maker-Checker: مبالغ > VOUCHER_APPROVAL_THRESHOLD ⇒ approvalStatus=PENDING_APPROVAL ⇒ لا قيد/لا
//     رصيد/لا تأثير على الصندوق حتى approveVoucher() بواسطة مديرٍ آخر (SOD).
//   - signatureHash: SHA-256 على (id|amount|partyId|paymentMethod|voucherDate|createdBy|approvalStatus)
//     يُحسب بعد الاعتماد ويُحفظ ⇒ أي تَلاعب لاحق بـDB قابل للكشف.
//   - voucherCategoryId: اختياري مَوصى به للسندات OTHER (إيجار/راتب/خدمات/…) للتجميع في التَقارير.
//   - referenceNumber إلزامي لـTRANSFER؛ cardLastFour إلزامي لـCARD.
//   - attachmentUrl إلزامي فوق VOUCHER_ATTACHMENT_THRESHOLD.
//
// الذرّية: كلّها داخل withTx ⇒ rollback كامل عند أي خطأ.
import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { and, desc, eq, gte, isNotNull, like, lt, ne, sql } from "drizzle-orm";
import {
  customers,
  receipts,
  shifts,
  suppliers,
  users,
  voucherCategories,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { localDayStart, localNextDayStart } from "./dateRange";
import {
  adjustCustomerBalance,
  adjustSupplierBalance,
  postEntry,
} from "./ledgerService";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { money, toDateStr, toDbMoney } from "./money";
import { openShiftIdTx, resolveActorRoleTx, shiftIdForCashTx } from "./shiftService";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
type PartyType = "CUSTOMER" | "SUPPLIER" | "OTHER";

/** عَتبة Maker-Checker: مبالغ ≥ هذه القيمة (IQD) تَحتاج موافقة مدير ثانٍ.
 *  الافتراضي ١.٠٠٠.٠٠٠ IQD — قابل للتجاوز عبر ENV VOUCHER_APPROVAL_THRESHOLD_IQD. */
export function getApprovalThreshold(): number {
  const raw = process.env.VOUCHER_APPROVAL_THRESHOLD_IQD;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1_000_000;
}

/** عَتبة إلزام المُرفق: سند ≥ هذه القيمة (IQD) يَلزمه attachmentUrl.
 *  الافتراضي ٢٥٠.٠٠٠ IQD — قابل للتجاوز عبر ENV VOUCHER_ATTACHMENT_THRESHOLD_IQD. */
export function getAttachmentThreshold(): number {
  const raw = process.env.VOUCHER_ATTACHMENT_THRESHOLD_IQD;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 250_000;
}

export interface VoucherInput {
  /** نوع السند: RECEIPT = قبض (IN)، PAYMENT = صرف (OUT). */
  voucherType: "RECEIPT" | "PAYMENT";
  branchId: number;
  amount: string; // موجبة بالطريقة money
  paymentMethod: PaymentMethod;
  partyType: PartyType;
  partyId?: number | null; // لـCUSTOMER/SUPPLIER، إلزامي؛ لـOTHER null.
  description: string;
  referenceNumber?: string | null;
  checkNumber?: string | null;
  cardLastFour?: string | null;
  // vouchers-pro:
  voucherCategoryId?: number | null;
  counterpartyName?: string | null;
  voucherDate?: string | null;       // YYYY-MM-DD (الافتراضي = اليوم المحلي)
  attachmentUrl?: string | null;
  internalNote?: string | null;
  /** Idempotency: نفس المفتاح ⇒ سند واحد (لا صرف/قبض نقدي مزدوج عند النقر المزدوج/إعادة الشبكة). */
  clientRequestId?: string | null;
}

export interface VoucherResult {
  receiptId: number;
  voucherNumber: string;
  direction: "IN" | "OUT";
  /** APPROVED = أَثَّر مباشرةً؛ PENDING_APPROVAL = يَحتاج اعتماد مدير ثانٍ قبل التأثير. */
  approvalStatus: "APPROVED" | "PENDING_APPROVAL" | "REJECTED";
}

/** يَحسب SHA-256 لخَتم السند ⇒ سَلامة سجل تَدقيقي ضدّ التَلاعب بـDB. */
function computeSignature(parts: {
  id: number;
  amount: string;
  partyType: PartyType;
  partyId: number | null;
  paymentMethod: PaymentMethod;
  voucherDate: string;
  voucherNumber: string;
  createdBy: number;
  approvedBy: number | null;
  branchId: number;
}): string {
  const canonical = [
    parts.id,
    parts.amount,
    parts.partyType,
    parts.partyId ?? "",
    parts.paymentMethod,
    parts.voucherDate,
    parts.voucherNumber,
    parts.createdBy,
    parts.approvedBy ?? "",
    parts.branchId,
  ].join("|");
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/** يولّد رقم سند تسلسلي يومي للفرع: RV-1-20260609-00001 أو PV-1-20260609-00001
 *
 * Race protection عبر GET_LOCK المربوط بالاتصال: SELECT...FOR UPDATE بنطاق LIKE
 * لا يَقفل صفوفاً غير موجودة في InnoDB ⇒ معاملتان متزامنتان قد تَقرآن نفس MAX
 * وتُولّدان نفس seq. القفل بنطاق (voucher:type:branchId:ymd) يَمنع التضارب على
 * مستوى الفرع/النوع/اليوم. الفهرس الفريد على voucherNumber يبقى الحارس الأخير
 * (راوتر يُعيد المحاولة على ER_DUP_ENTRY).
 */
async function nextVoucherNumber(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  voucherType: "RECEIPT" | "PAYMENT",
  branchId: number,
): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `${voucherType === "RECEIPT" ? "RV" : "PV"}-${branchId}-${ymd}-`;
  const lockName = `voucher:${voucherType}:${branchId}:${ymd}`;
  const lockRes: any = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`);
  const lockedRow = Array.isArray(lockRes) ? lockRes[0]?.[0] : lockRes?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) {
    throw new Error(`voucher numbering lock timeout for ${lockName}`);
  }
  try {
    const rows = await tx
      .select({ n: receipts.voucherNumber })
      .from(receipts)
      .where(like(receipts.voucherNumber, `${prefix}%`))
      .orderBy(desc(receipts.id))
      .for("update")
      .limit(1);
    const last = rows[0]?.n;
    const seq = last ? parseInt(String(last).slice(prefix.length), 10) + 1 : 1;
    return prefix + String(seq).padStart(5, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

/** يحلّ دور الفاعل: من actor.role إن مرّره الموجّه، وإلا يقرأه من قاعدة البيانات (مرّة واحدة).
 *  يَستعمل resolveActorRoleTx المُشترك في shiftService (نُقِل ليُستعمَل أيضاً في expenseService/saleService). */
async function resolveActorRole(tx: Parameters<Parameters<typeof withTx>[0]>[0], actor: Actor): Promise<string> {
  if (actor.role) return actor.role;
  return resolveActorRoleTx(tx, actor.userId);
}

/** يفرض ملكية الفرع للفاعل لعمليات التغيير الحرجة: admin يمرّ، وغيره يجب أن يطابق فرع الكيان.
 *  يسدّ نمطاً جذرياً ٢: managerProcedure معاملة سابقاً كأنها عبر-فرعية، فمدير فرعٍ يعكس سند فرعٍ آخر. */
async function assertBranchOwnership(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  actor: Actor,
  targetBranchId: number | null,
  entityLabel: string,
): Promise<void> {
  const role = await resolveActorRole(tx, actor);
  if (role === "admin") return;
  if (targetBranchId == null) return; // كيان بلا فرع مُسنَد ⇒ لا يُمكن فرض الانتماء
  if (Number(actor.branchId) !== Number(targetBranchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `لا تستطيع تعديل ${entityLabel} لفرع آخر`,
    });
  }
}

/** يَتحقّق من فئة السند: موجودة + نشطة + اتجاهها يَسمح بنوع السند. */
async function validateCategory(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  categoryId: number,
  direction: "IN" | "OUT",
): Promise<void> {
  const c = (await tx.select().from(voucherCategories).where(eq(voucherCategories.id, categoryId)).limit(1))[0];
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "فئة السند غير موجودة" });
  if (!c.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: `فئة «${c.name}» مُعطَّلة` });
  if (c.direction !== "BOTH" && c.direction !== direction) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `فئة «${c.name}» مخصّصة لسندات ${c.direction === "IN" ? "القبض" : "الصرف"} فقط`,
    });
  }
}

/** يُنشئ سند قبض (IN) أو صرف (OUT) ذريّاً.
 *
 * Maker-Checker: لو المَبلغ ≥ getApprovalThreshold() يُسجَّل بـapprovalStatus=PENDING_APPROVAL
 * بلا قيد دفتر ولا تأثير على الرصيد/الصندوق — فقط الصفّ في receipts. الاعتماد لاحقاً
 * عبر approveVoucher() يُكمل الأثر المالي. النَموذج: «المُسجِّل ≠ المُعتمِد» (SOD).
 */
export async function createVoucher(input: VoucherInput, actor: Actor): Promise<VoucherResult> {
  return withTx(async (tx) => {
    // Idempotency: تكرار نفس المفتاح يُعاد بنتيجة السند الأول (لا قيد/نقد مزدوج).
    if (input.clientRequestId) {
      const existingRefId = await findIdempotentRefId(tx, "voucher.create", input.clientRequestId);
      if (existingRefId != null) {
        const r = (await tx.select().from(receipts).where(eq(receipts.id, existingRefId)).limit(1))[0];
        if (!r) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "سند idempotency مفقود — تحقّق من الإيصال" });
        }
        const storedPartyId = r.partyId != null ? Number(r.partyId) : null;
        const requestedPartyId = input.partyType === "OTHER" ? null : (input.partyId ?? null);
        if (
          Number(r.branchId) !== Number(input.branchId) ||
          (r.partyType ?? null) !== (input.partyType ?? null) ||
          storedPartyId !== requestedPartyId ||
          money(r.amount).toFixed(2) !== money(input.amount).toFixed(2)
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لسند بطرف/فرع/مبلغ مختلف",
          });
        }
        return {
          receiptId: existingRefId,
          voucherNumber: r.voucherNumber ?? "",
          direction: (r.direction as "IN" | "OUT") ?? "IN",
          approvalStatus: (r.approvalStatus as VoucherResult["approvalStatus"]) ?? "APPROVED",
        };
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

    const direction: "IN" | "OUT" = input.voucherType === "RECEIPT" ? "IN" : "OUT";

    // تَحقّق الفئة (إن مُرّرت) — الاتجاه يَجب أن يَتسق مع نوع السند.
    if (input.voucherCategoryId != null) {
      await validateCategory(tx, input.voucherCategoryId, direction);
    }

    // تَحقّق الطرف: يَجب أن يَكون نشطاً.
    if (input.partyType === "CUSTOMER") {
      if (!input.partyId) throw new TRPCError({ code: "BAD_REQUEST", message: "العميل مطلوب لسند مرتبط بعميل" });
      const c = (await tx.select().from(customers).where(eq(customers.id, input.partyId)).limit(1))[0];
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
      if (!c.isActive) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إصدار سند لعميل مُعطَّل" });
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

/** قائمة السندات مع فلاتر (للسجلّ والتقارير). */
export interface ListVouchersInput {
  branchId?: number;
  voucherType?: "RECEIPT" | "PAYMENT";
  partyType?: PartyType;
  partyId?: number;
  /** فلتر حالة اختياري — افتراضياً تُعرض كل السندات (المكتملة والملغاة معاً). */
  status?: "COMPLETED" | "REVERSED";
  approvalStatus?: "APPROVED" | "PENDING_APPROVAL" | "REJECTED";
  voucherCategoryId?: number;
  paymentMethod?: PaymentMethod;
  /** فترة على createdAt (YYYY-MM-DD) — «إلى» شاملاً عبر نصف مفتوح [from, to+يوم). */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}


export async function listVouchers(input: ListVouchersInput = {}) {
  const db = getDb();
  if (!db) return [];
  const wheres: any[] = [isNotNull(receipts.voucherNumber)];
  if (input.status) wheres.push(eq(receipts.status, input.status));
  if (input.branchId) wheres.push(eq(receipts.branchId, input.branchId));
  if (input.voucherType) wheres.push(eq(receipts.direction, input.voucherType === "RECEIPT" ? "IN" : "OUT"));
  if (input.partyType) wheres.push(eq(receipts.partyType, input.partyType));
  if (input.partyId) wheres.push(eq(receipts.partyId, input.partyId));
  if (input.approvalStatus) wheres.push(eq(receipts.approvalStatus, input.approvalStatus));
  if (input.voucherCategoryId) wheres.push(eq(receipts.voucherCategoryId, input.voucherCategoryId));
  if (input.paymentMethod) wheres.push(eq(receipts.paymentMethod, input.paymentMethod));
  if (input.from) wheres.push(gte(receipts.createdAt, localDayStart(input.from)));
  if (input.to) wheres.push(lt(receipts.createdAt, localNextDayStart(input.to)));

  return db
    .select({
      id: receipts.id,
      voucherNumber: receipts.voucherNumber,
      branchId: receipts.branchId,
      shiftId: receipts.shiftId,
      direction: receipts.direction,
      amount: receipts.amount,
      paymentMethod: receipts.paymentMethod,
      partyType: receipts.partyType,
      partyId: receipts.partyId,
      description: receipts.description,
      referenceNumber: receipts.referenceNumber,
      cardLastFour: receipts.cardLastFour,
      checkNumber: receipts.checkNumber,
      status: receipts.status,
      createdAt: receipts.createdAt,
      createdBy: receipts.createdBy,
      // vouchers-pro:
      voucherCategoryId: receipts.voucherCategoryId,
      counterpartyName: receipts.counterpartyName,
      voucherDate: receipts.voucherDate,
      attachmentUrl: receipts.attachmentUrl,
      approvalStatus: receipts.approvalStatus,
      approvedBy: receipts.approvedBy,
      approvedAt: receipts.approvedAt,
      signatureHash: receipts.signatureHash,
      cashBucket: receipts.cashBucket,
    })
    .from(receipts)
    .where(and(...wheres))
    .orderBy(desc(receipts.id))
    .limit(input.limit ?? 100)
    .offset(input.offset ?? 0);
}

/** قراءة سند منفرد + معلومات مَوسَّعة (اسم المُنشئ/المُعتمِد/الفئة) للطباعة. */
export async function getVoucher(receiptId: number) {
  const db = getDb();
  if (!db) return null;
  const r = (await db.select().from(receipts).where(eq(receipts.id, receiptId)).limit(1))[0];
  if (!r || !r.voucherNumber) return null;
  // اسم المُنشئ
  let createdByName: string | null = null;
  let approvedByName: string | null = null;
  let categoryName: string | null = null;
  let partyName: string | null = null;
  if (r.createdBy != null) {
    const u = (await db.select({ name: users.name }).from(users).where(eq(users.id, Number(r.createdBy))).limit(1))[0];
    createdByName = u?.name ?? null;
  }
  if (r.approvedBy != null) {
    const u = (await db.select({ name: users.name }).from(users).where(eq(users.id, Number(r.approvedBy))).limit(1))[0];
    approvedByName = u?.name ?? null;
  }
  if (r.voucherCategoryId != null) {
    const c = (await db.select({ name: voucherCategories.name })
      .from(voucherCategories).where(eq(voucherCategories.id, Number(r.voucherCategoryId))).limit(1))[0];
    categoryName = c?.name ?? null;
  }
  if (r.partyType === "CUSTOMER" && r.partyId != null) {
    const c = (await db.select({ name: customers.name }).from(customers).where(eq(customers.id, Number(r.partyId))).limit(1))[0];
    partyName = c?.name ?? null;
  } else if (r.partyType === "SUPPLIER" && r.partyId != null) {
    const s = (await db.select({ name: suppliers.name }).from(suppliers).where(eq(suppliers.id, Number(r.partyId))).limit(1))[0];
    partyName = s?.name ?? null;
  } else if (r.partyType === "OTHER") {
    partyName = r.counterpartyName ?? null;
  }
  return { ...r, createdByName, approvedByName, categoryName, partyName };
}

/** يَجلب السندات الأخيرة لنفس الطرف خلال نافذة أيام محدّدة — للتحذير من الازدواج (دفعة مكرّرة).
 *  للسندات OTHER: يَستعمل counterpartyName نصّياً (LIKE مُطابق تماماً) — أرخص من ngram.
 *  لـCUSTOMER/SUPPLIER: يَستعمل partyId. */
export async function recentVouchersForParty(opts: {
  partyType: PartyType;
  partyId?: number | null;
  counterpartyName?: string | null;
  branchId?: number | null;
  windowDays?: number; // افتراضي ٧
  limit?: number; // افتراضي ٥
}) {
  const db = getDb();
  if (!db) return [];
  const days = opts.windowDays ?? 7;
  const since = new Date(Date.now() - days * 86400_000);
  const wheres: any[] = [
    isNotNull(receipts.voucherNumber),
    gte(receipts.createdAt, since),
    ne(receipts.status, "REVERSED"),
    eq(receipts.partyType, opts.partyType),
  ];
  if (opts.partyType === "OTHER") {
    if (!opts.counterpartyName?.trim()) return [];
    wheres.push(eq(receipts.counterpartyName, opts.counterpartyName.trim()));
  } else {
    if (!opts.partyId) return [];
    wheres.push(eq(receipts.partyId, opts.partyId));
  }
  if (opts.branchId) wheres.push(eq(receipts.branchId, opts.branchId));
  return db
    .select({
      id: receipts.id,
      voucherNumber: receipts.voucherNumber,
      direction: receipts.direction,
      amount: receipts.amount,
      paymentMethod: receipts.paymentMethod,
      description: receipts.description,
      voucherDate: receipts.voucherDate,
      createdAt: receipts.createdAt,
      approvalStatus: receipts.approvalStatus,
    })
    .from(receipts)
    .where(and(...wheres))
    .orderBy(desc(receipts.id))
    .limit(opts.limit ?? 5);
}
