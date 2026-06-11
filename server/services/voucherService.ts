// سندات قبض/صرف مستقلّة (B1) — receipts بلا فاتورة بل بطرف مستقلّ (راتب، إيجار، دفعة لعميل، …).
// سند قبض (RV): direction='IN'، طرف يدفع للمحلّ (مثل مورد يَستلم دفعة، عميل يَدفع توقعاً).
// سند صرف (PV): direction='OUT'، المحلّ يَدفع لطرف (مثل راتب موظف، إيجار، دفعة لمورّد).
//
// التأثيرات:
//   - receipts row (مع voucherNumber فريد + partyType/partyId + description)
//   - accountingEntries (PAYMENT_IN لـRV، PAYMENT_OUT لـPV)
//   - currentBalance للطرف (إن كان CUSTOMER أو SUPPLIER): ينقص لـCUSTOMER عند IN، يزيد عند OUT.
//   - shiftId يُشتقّ تلقائياً من وردية الموظّف المفتوحة (تسوية الصندوق).
//
// الذرّية: كلّها داخل withTx ⇒ rollback كامل عند أي خطأ.
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, isNotNull, like, lt } from "drizzle-orm";
import {
  customers,
  receipts,
  shifts,
  suppliers,
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
import { openShiftIdTx } from "./shiftService";
import { withTx, type Actor } from "./tx";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
type PartyType = "CUSTOMER" | "SUPPLIER" | "OTHER";

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
  /** Idempotency: نفس المفتاح ⇒ سند واحد (لا صرف/قبض نقدي مزدوج عند النقر المزدوج/إعادة الشبكة). */
  clientRequestId?: string | null;
}

export interface VoucherResult {
  receiptId: number;
  voucherNumber: string;
  direction: "IN" | "OUT";
}

/** يولّد رقم سند تسلسلي يومي للفرع: RV-1-20260609-00001 أو PV-1-20260609-00001 */
async function nextVoucherNumber(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  voucherType: "RECEIPT" | "PAYMENT",
  branchId: number,
): Promise<string> {
  const prefix = `${voucherType === "RECEIPT" ? "RV" : "PV"}-${branchId}-${toDateStr().replace(/-/g, "")}-`;
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
}

/** يُنشئ سند قبض (IN) أو صرف (OUT) ذريّاً. */
export async function createVoucher(input: VoucherInput, actor: Actor): Promise<VoucherResult> {
  return withTx(async (tx) => {
    // Idempotency: تكرار نفس المفتاح يُعاد بنتيجة السند الأول (لا قيد/نقد مزدوج).
    if (input.clientRequestId) {
      const existingRefId = await findIdempotentRefId(tx, "voucher.create", input.clientRequestId);
      if (existingRefId != null) {
        const r = (await tx.select({ voucherNumber: receipts.voucherNumber, direction: receipts.direction }).from(receipts).where(eq(receipts.id, existingRefId)).limit(1))[0];
        return { receiptId: existingRefId, voucherNumber: r?.voucherNumber ?? "", direction: (r?.direction as "IN" | "OUT") ?? "IN" };
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

    // التحقّق من الطرف:
    if (input.partyType === "CUSTOMER") {
      if (!input.partyId) throw new TRPCError({ code: "BAD_REQUEST", message: "العميل مطلوب لسند مرتبط بعميل" });
      const c = (await tx.select().from(customers).where(eq(customers.id, input.partyId)).limit(1))[0];
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
    } else if (input.partyType === "SUPPLIER") {
      if (!input.partyId) throw new TRPCError({ code: "BAD_REQUEST", message: "المورد مطلوب لسند مرتبط بمورد" });
      const sup = (await tx.select().from(suppliers).where(eq(suppliers.id, input.partyId)).limit(1))[0];
      if (!sup) throw new TRPCError({ code: "NOT_FOUND", message: "المورد غير موجود" });
    }

    const direction: "IN" | "OUT" = input.voucherType === "RECEIPT" ? "IN" : "OUT";
    const voucherNumber = await nextVoucherNumber(tx, input.voucherType, input.branchId);

    // shiftId من وردية الموظّف المفتوحة (لتسوية الصندوق Z-report).
    const shiftId = await openShiftIdTx(tx, actor.userId, input.branchId);

    const rRes = await tx.insert(receipts).values({
      branchId: input.branchId,
      shiftId,
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
    });
    const receiptId = Number((rRes as any)[0]?.insertId ?? (rRes as any).insertId);

    // قيد دفتر: PAYMENT_IN/OUT حسب نوع السند.
    await postEntry(tx, {
      entryType: direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT",
      branchId: input.branchId,
      receiptId,
      customerId: input.partyType === "CUSTOMER" ? (input.partyId ?? null) : null,
      supplierId: input.partyType === "SUPPLIER" ? (input.partyId ?? null) : null,
      amount,
    });

    // تحديث رصيد الطرف (إن وُجد):
    if (input.partyType === "CUSTOMER" && input.partyId) {
      // قبض من عميل ⇒ AR -= amount. صرف لعميل (مثل مرتجع نقدي مستقلّ) ⇒ AR += amount.
      await adjustCustomerBalance(tx, input.partyId, direction === "IN" ? amount.neg() : amount);
    } else if (input.partyType === "SUPPLIER" && input.partyId) {
      // صرف لمورّد ⇒ AP -= amount. قبض من مورّد (مثل استرداد) ⇒ AP += amount.
      await adjustSupplierBalance(tx, input.partyId, direction === "OUT" ? amount.neg() : amount);
    }

    // Idempotency: سجّل المفتاح بعد الكتابة (refId = الإيصال). سباق نفس المفتاح ⇒ ER_DUP_ENTRY.
    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "voucher.create", input.clientRequestId, receiptId);
    }

    return { receiptId, voucherNumber, direction };
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
 * يُمنع الإلغاء على وردية مغلقة (Z-report صدر بالأرقام القديمة).
 */
export async function cancelVoucher(receiptId: number, actor: Actor): Promise<CancelVoucherResult> {
  return withTx(async (tx) => {
    const r = (
      await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update").limit(1)
    )[0];
    // ليس سنداً مستقلّاً (voucherNumber=null) ⇒ غير موجود من منظور السندات.
    if (!r || r.voucherNumber == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    // دفاع متعمّق: السندات المستقلّة لا تحمل invoiceId/workOrderId أبداً (دفعات الفواتير تمرّ
    // عبر sales.pay بلا voucherNumber) — لكن نحرس بنيوياً كي لا يُفسد إلغاءٌ حالةَ سداد فاتورة.
    if (r.invoiceId != null || r.workOrderId != null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء إيصال مرتبط بفاتورة/أمر شغل من هنا" });
    }
    if (r.status === "REVERSED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السند ملغى بالفعل" });
    }
    if (r.status !== "COMPLETED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء سند غير مكتمل" });
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
    const amount = money(r.amount);
    const direction = r.direction as "IN" | "OUT";

    await tx.update(receipts).set({ status: "REVERSED" }).where(eq(receipts.id, receiptId));

    // إيصال تعويضي معاكس على نفس الوردية ⇒ نقد الصندوق يتصافر بنظافة.
    // voucherNumber=null: يبقى خارج قائمة السندات ولا يصطدم بالقيد الفريد.
    const compRes = await tx.insert(receipts).values({
      invoiceId: null,
      branchId: r.branchId != null ? Number(r.branchId) : null,
      shiftId: r.shiftId != null ? Number(r.shiftId) : null,
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
    });
    const compReceiptId = Number((compRes as any)[0]?.insertId ?? (compRes as any).insertId);

    // قيد معاكس بمبلغ موجب (لا ADJUST — تتجاهله صيَغ reconcile فيتولّد انحراف وهمي دائم).
    await postEntry(tx, {
      entryType: direction === "IN" ? "PAYMENT_OUT" : "PAYMENT_IN",
      branchId: r.branchId != null ? Number(r.branchId) : null,
      receiptId: compReceiptId,
      customerId: r.partyType === "CUSTOMER" && r.partyId != null ? Number(r.partyId) : null,
      supplierId: r.partyType === "SUPPLIER" && r.partyId != null ? Number(r.partyId) : null,
      amount,
      notes: `إلغاء سند ${voucherNumber}`,
    });

    // عكس رصيد الطرف — المعكوس الدقيق لاستدعاءات createVoucher:
    //   create CUSTOMER: IN ⇒ −amount، OUT ⇒ +amount  ⟹  cancel: IN ⇒ +amount، OUT ⇒ −amount.
    //   create SUPPLIER: OUT ⇒ −amount، IN ⇒ +amount  ⟹  cancel: OUT ⇒ +amount، IN ⇒ −amount.
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
  /** فترة على createdAt (YYYY-MM-DD) — «إلى» شاملاً عبر نصف مفتوح [from, to+يوم). */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}


export async function listVouchers(input: ListVouchersInput = {}) {
  const db = getDb();
  if (!db) return [];
  // فقط السندات المستقلّة (voucherNumber IS NOT NULL) ⇒ تُستثنى receipts الفواتير
  // والإيصالات التعويضية للإلغاء. الملغاة (REVERSED) تبقى ظاهرة — السجلّ لا يُخفي شيئاً.
  const wheres: any[] = [isNotNull(receipts.voucherNumber)];
  if (input.status) wheres.push(eq(receipts.status, input.status));
  if (input.branchId) wheres.push(eq(receipts.branchId, input.branchId));
  if (input.voucherType) wheres.push(eq(receipts.direction, input.voucherType === "RECEIPT" ? "IN" : "OUT"));
  if (input.partyType) wheres.push(eq(receipts.partyType, input.partyType));
  if (input.partyId) wheres.push(eq(receipts.partyId, input.partyId));
  // فلتر الفترة على createdAt (تاريخ إنشاء السند).
  // نصف مفتوح [from, to+يوم) بمنتصف ليلٍ محلي (Date("YYYY-MM-DD") = UTC ⇒ انزياح +03:00).
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
      status: receipts.status,
      createdAt: receipts.createdAt,
      createdBy: receipts.createdBy,
    })
    .from(receipts)
    .where(and(...wheres))
    .orderBy(desc(receipts.id))
    .limit(input.limit ?? 100)
    .offset(input.offset ?? 0);
}

/** قراءة سند منفرد. */
export async function getVoucher(receiptId: number) {
  const db = getDb();
  if (!db) return null;
  const r = (await db.select().from(receipts).where(eq(receipts.id, receiptId)).limit(1))[0];
  if (!r || !r.voucherNumber) return null;
  return r;
}
