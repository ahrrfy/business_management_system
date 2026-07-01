// قراءات السندات: القائمة المفلترة، سند منفرد موسَّع، والسندات الأخيرة لنفس الطرف (تحذير الازدواج).
import { and, desc, eq, gte, isNotNull, lt, ne } from "drizzle-orm";
import { customers, receipts, suppliers, users, voucherCategories } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { localDayStart, localNextDayStart } from "../dateRange";
import type { PartyType, PaymentMethod } from "./types";

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
