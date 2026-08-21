// قراءات السندات: القائمة المفلترة، سند منفرد موسَّع، والسندات الأخيرة لنفس الطرف (تحذير الازدواج).
import { and, desc, eq, gte, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { customers, exchangeHouses, exchangeTransactions, idempotencyKeys, invoices, receipts, suppliers, users, voucherCategories } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { escLike } from "../../lib/sqlLike";
import { localDayStart, localNextDayStart } from "../dateRange";
import type { PartyType, PaymentMethod } from "./types";
import {
  expensePaymentResubmitKey,
  parseExpensePaymentResubmitDescription,
  parseExpensePaymentResubmitKey,
} from "./resubmitLineage";

const resubmitLineageKeySql = sql<string | null>`(
  SELECT lineageKey.clientRequestId
  FROM idempotencyKeys AS lineageKey
  WHERE lineageKey.operation = 'voucher.create'
    AND lineageKey.refId = ${receipts.id}
    AND lineageKey.clientRequestId REGEXP '^system-(asset|expense)-resubmit-[1-9][0-9]*-A[1-9][0-9]*$'
  ORDER BY lineageKey.id DESC
  LIMIT 1
)`;
const resubmitLineageCountSql = sql<number>`(
  SELECT COUNT(*)
  FROM idempotencyKeys AS lineageCount
  WHERE lineageCount.operation = 'voucher.create'
    AND lineageCount.refId = ${receipts.id}
    AND lineageCount.clientRequestId REGEXP '^system-(asset|expense)-resubmit-[1-9][0-9]*-A[1-9][0-9]*$'
)`;

async function attachResubmitLineage<
  T extends {
    id: number;
    description: string | null;
    resubmitClientRequestId: string | null;
    resubmitLineageCount: number;
  },
>(db: NonNullable<ReturnType<typeof getDb>>, rows: T[]) {
  const parsed = rows.map((row) => ({
    row,
    key: row.resubmitClientRequestId == null
      ? null
      : parseExpensePaymentResubmitKey(row.resubmitClientRequestId),
    description: parseExpensePaymentResubmitDescription(row.description),
  }));
  const priorKeys = parsed.flatMap(({ key }) =>
    key != null && key.attempt > 1
      ? [expensePaymentResubmitKey({ ...key, attempt: key.attempt - 1 })]
      : [],
  );
  const priorRows = priorKeys.length === 0
    ? []
    : await db
        .select({ clientRequestId: idempotencyKeys.clientRequestId, refId: idempotencyKeys.refId })
        .from(idempotencyKeys)
        .where(and(
          eq(idempotencyKeys.operation, "voucher.create"),
          inArray(idempotencyKeys.clientRequestId, priorKeys),
        ));
  const priorByKey = new Map(
    priorRows.map((row) => [row.clientRequestId, Number(row.refId)]),
  );

  return parsed.map(({ row, key, description }) => {
    const { resubmitClientRequestId: _key, resubmitLineageCount: _count, ...base } = row;
    if (row.resubmitLineageCount === 0 && row.resubmitClientRequestId == null) {
      return {
        ...base,
        resubmitLineageStatus: "NONE" as const,
        resubmitRootReceiptId: null,
        resubmitAttempt: null,
        resubmitPriorReceiptId: null,
        resubmitReason: null,
      };
    }
    const expectedPriorReceiptId = key == null
      ? null
      : key.attempt === 1
        ? key.rootReceiptId
        : priorByKey.get(expensePaymentResubmitKey({ ...key, attempt: key.attempt - 1 })) ?? null;
    const valid =
      row.resubmitLineageCount === 1 &&
      key != null &&
      description != null &&
      description.attempt === key.attempt &&
      description.priorReceiptId === expectedPriorReceiptId &&
      description.priorReceiptId !== Number(row.id);
    return {
      ...base,
      resubmitLineageStatus: valid ? "VALID" as const : "BROKEN" as const,
      resubmitRootReceiptId: key?.rootReceiptId ?? null,
      resubmitAttempt: key?.attempt ?? null,
      resubmitPriorReceiptId: valid ? description.priorReceiptId : null,
      resubmitReason: valid ? description.reissueReason : null,
    };
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
  /** بحث في رقم السند/الوصف/الطرف/المرجع/الصك/الفاتورة المرتبطة. */
  q?: string;
  /** فترة على createdAt (YYYY-MM-DD) — «إلى» شاملاً عبر نصف مفتوح [from, to+يوم). */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function listVouchers(input: ListVouchersInput = {}) {
  const db = getDb();
  if (!db) return [];
  const creator = alias(users, "voucherListCreator");
  const partyCustomer = alias(customers, "voucherListCustomer");
  const partySupplier = alias(suppliers, "voucherListSupplier");
  // receiptId ليس فريداً بنيوياً في exchangeTransactions. join مباشر يضاعف السند ويشوّه
  // limit/offset عند وجود أكثر من حركة تاريخية مرتبطة به. نختار أحدث حركة لكل سند داخل
  // subquery مجمّع، فيبقى الاستعلام واحداً وصفٌ واحدٌ حتماً لكل receipt (بلا N+1).
  const latestExchangeTxn = db
    .select({
      receiptId: exchangeTransactions.receiptId,
      transactionId: sql<number>`MAX(${exchangeTransactions.id})`.as("transactionId"),
    })
    .from(exchangeTransactions)
    .where(isNotNull(exchangeTransactions.receiptId))
    .groupBy(exchangeTransactions.receiptId)
    .as("voucherListLatestExchangeTxn");
  const wheres: any[] = [isNotNull(receipts.voucherNumber)];
  if (input.status) wheres.push(eq(receipts.status, input.status));
  if (input.branchId) wheres.push(eq(receipts.branchId, input.branchId));
  if (input.voucherType) wheres.push(eq(receipts.direction, input.voucherType === "RECEIPT" ? "IN" : "OUT"));
  if (input.partyType) wheres.push(eq(receipts.partyType, input.partyType));
  if (input.partyId) wheres.push(eq(receipts.partyId, input.partyId));
  if (input.approvalStatus) wheres.push(eq(receipts.approvalStatus, input.approvalStatus));
  if (input.voucherCategoryId) wheres.push(eq(receipts.voucherCategoryId, input.voucherCategoryId));
  if (input.paymentMethod) wheres.push(eq(receipts.paymentMethod, input.paymentMethod));
  if (input.q?.trim()) {
    const like = `%${escLike(input.q.trim())}%`;
    wheres.push(or(
      sql`coalesce(${receipts.voucherNumber}, '') LIKE ${like} ESCAPE '!'`,
      sql`coalesce(${receipts.description}, '') LIKE ${like} ESCAPE '!'`,
      sql`coalesce(${receipts.counterpartyName}, '') LIKE ${like} ESCAPE '!'`,
      sql`coalesce(${receipts.referenceNumber}, '') LIKE ${like} ESCAPE '!'`,
      sql`coalesce(${receipts.checkNumber}, '') LIKE ${like} ESCAPE '!'`,
      sql`coalesce(${invoices.invoiceNumber}, '') LIKE ${like} ESCAPE '!'`,
      sql`coalesce(${creator.name}, ${creator.username}, '') LIKE ${like} ESCAPE '!'`,
      sql`coalesce(${partyCustomer.name}, '') LIKE ${like} ESCAPE '!'`,
      sql`coalesce(${partySupplier.name}, '') LIKE ${like} ESCAPE '!'`,
    ));
  }
  if (input.from) wheres.push(gte(receipts.createdAt, localDayStart(input.from)));
  if (input.to) wheres.push(lt(receipts.createdAt, localNextDayStart(input.to)));

  const rows = await db
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
      createdByName: sql<string | null>`COALESCE(${creator.name}, ${creator.username})`,
      // vouchers-pro:
      voucherCategoryId: receipts.voucherCategoryId,
      counterpartyName: receipts.counterpartyName,
      partyName: sql<string | null>`CASE
        WHEN ${receipts.partyType} = 'CUSTOMER' THEN ${partyCustomer.name}
        WHEN ${receipts.partyType} = 'SUPPLIER' THEN ${partySupplier.name}
        ELSE ${receipts.counterpartyName}
      END`,
      voucherDate: receipts.voucherDate,
      attachmentUrl: receipts.attachmentUrl,
      approvalStatus: receipts.approvalStatus,
      approvedBy: receipts.approvedBy,
      approvedAt: receipts.approvedAt,
      signatureHash: receipts.signatureHash,
      cashBucket: receipts.cashBucket,
      // attachment-upload (٥/٧): ربط الفاتورة — رقم الفاتورة للعرض (بلا استعلام إضافي بالواجهة).
      invoiceId: receipts.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      exchangeHouseId: exchangeTransactions.exchangeHouseId,
      exchangeHouseName: exchangeHouses.name,
      resubmitClientRequestId: resubmitLineageKeySql,
      resubmitLineageCount: resubmitLineageCountSql,
    })
    .from(receipts)
    .leftJoin(invoices, eq(receipts.invoiceId, invoices.id))
    .leftJoin(creator, eq(creator.id, receipts.createdBy))
    .leftJoin(partyCustomer, and(eq(receipts.partyType, "CUSTOMER"), eq(partyCustomer.id, receipts.partyId)))
    .leftJoin(partySupplier, and(eq(receipts.partyType, "SUPPLIER"), eq(partySupplier.id, receipts.partyId)))
    .leftJoin(latestExchangeTxn, eq(latestExchangeTxn.receiptId, receipts.id))
    .leftJoin(exchangeTransactions, eq(exchangeTransactions.id, latestExchangeTxn.transactionId))
    .leftJoin(exchangeHouses, eq(exchangeHouses.id, exchangeTransactions.exchangeHouseId))
    .where(and(...wheres))
    .orderBy(desc(receipts.id))
    .limit(input.limit ?? 100)
    .offset(input.offset ?? 0);
  return attachResubmitLineage(db, rows);
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
  let invoiceNumber: string | null = null;
  let exchangeHouseId: number | null = null;
  let exchangeHouseName: string | null = null;
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
  if (r.invoiceId != null) {
    const inv = (await db.select({ invoiceNumber: invoices.invoiceNumber })
      .from(invoices).where(eq(invoices.id, Number(r.invoiceId))).limit(1))[0];
    invoiceNumber = inv?.invoiceNumber ?? null;
  }
  if (r.paymentMethod === "EXCHANGE") {
    const source = (await db.select({ id: exchangeHouses.id, name: exchangeHouses.name })
      .from(exchangeTransactions).innerJoin(exchangeHouses, eq(exchangeHouses.id, exchangeTransactions.exchangeHouseId))
      .where(eq(exchangeTransactions.receiptId, receiptId)).limit(1))[0];
    exchangeHouseId = source ? Number(source.id) : null;
    exchangeHouseName = source?.name ?? null;
  }
  return { ...r, createdByName, approvedByName, categoryName, partyName, invoiceNumber, exchangeHouseId, exchangeHouseName };
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
