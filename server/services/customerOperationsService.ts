import { sql, type SQL } from "drizzle-orm";
import { arReminders, customerNotes, customers, invoices, tasks, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { escLike } from "../lib/sqlLike";
import { normalizeSearchText } from "../../shared/searchNormalize";
import { phoneSuffix10 } from "../lib/phone";
import type { CustomerType, PriceTier } from "./customerService";
import { money, toDbMoney } from "./money";

export type CustomerBalanceFilter = "RECEIVABLE" | "CREDIT" | "ZERO";
export type CustomerCollectionFilter =
  | "OVERDUE"
  | "PROMISE_DUE"
  | "PROMISE_FUTURE"
  | "NO_FOLLOWUP";
export type CustomerCreditFilter = "CASH_ONLY" | "NEAR_LIMIT" | "OVER_LIMIT" | "UNLIMITED";
export type CustomerOperationsSort = "NAME" | "BALANCE_DESC" | "OLDEST_DUE" | "LAST_PURCHASE";

export interface CustomerOperationsInput {
  q?: string;
  customerType?: CustomerType;
  priceTier?: PriceTier;
  includeInactive?: boolean;
  balance?: CustomerBalanceFilter;
  collection?: CustomerCollectionFilter;
  credit?: CustomerCreditFilter;
  inactivityDays?: 30 | 60 | 90;
  sort?: CustomerOperationsSort;
  limit?: number;
  offset?: number;
}

export interface CustomerOperationsRow {
  id: number;
  name: string;
  phone: string | null;
  whatsapp: string | null;
  city: string | null;
  district: string | null;
  customerType: CustomerType | null;
  defaultPriceTier: PriceTier;
  creditLimit: string | null;
  currentBalance: string;
  legacyCode: string | null;
  isActive: boolean;
  createdAt: Date;
  overdueAmount: string;
  oldestDueDate: string | null;
  lastPurchaseDate: string | null;
  lastContactAt: string | null;
  promisedDate: string | null;
  lastReminderAt: string | null;
  openTasks: number;
  collectionStatus:
    | "CREDIT"
    | "CLEAR"
    | "OVER_LIMIT"
    | "PROMISE_BROKEN"
    | "PROMISE_DUE"
    | "PROMISE_FUTURE"
    | "SEVERELY_OVERDUE"
    | "OVERDUE"
    | "DUE_SOON"
    | "REGULAR";
  daysOverdue: number;
  creditUsagePct: number | null;
}

export interface CustomerOperationsSummary {
  total: number;
  active: number;
  inactive: number;
  cashOnly: number;
  unlimited: number;
  receivable: string;
  customerCredit: string;
  net: string;
  debtors: number;
  creditors: number;
  overdueAmount: string;
  overdueCustomers: number;
  promiseDue: number;
  promiseBroken: number;
  overLimit: number;
  nearLimit: number;
  noRecentPurchase30: number;
  highestDebtor: { customerId: number; customerName: string; amount: string } | null;
  topFiveConcentrationPct: number;
  collectorActivity30d: Array<{
    userId: number;
    userName: string;
    sent: number;
    promisesRecorded: number;
  }>;
}

type DbRow = Omit<CustomerOperationsRow, "collectionStatus" | "daysOverdue" | "creditUsagePct">;

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(from: string | null, to: string): number {
  if (!from) return 0;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.floor((b - a) / 86_400_000)) : 0;
}

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function collectionMeta(row: DbRow): Pick<CustomerOperationsRow, "collectionStatus" | "daysOverdue" | "creditUsagePct"> {
  const today = todayYmd();
  const balance = n(row.currentBalance);
  const limit = row.creditLimit == null ? null : n(row.creditLimit);
  const daysOverdue = daysBetween(row.oldestDueDate, today);
  const creditUsagePct = limit && limit > 0 ? (balance / limit) * 100 : null;

  let collectionStatus: CustomerOperationsRow["collectionStatus"];
  if (balance < 0) collectionStatus = "CREDIT";
  else if (balance === 0) collectionStatus = "CLEAR";
  else if (row.promisedDate && row.promisedDate < today) collectionStatus = "PROMISE_BROKEN";
  else if (row.promisedDate === today) collectionStatus = "PROMISE_DUE";
  else if (row.promisedDate && row.promisedDate > today) collectionStatus = "PROMISE_FUTURE";
  else if (limit != null && limit > 0 && balance > limit) collectionStatus = "OVER_LIMIT";
  else if (daysOverdue > 90) collectionStatus = "SEVERELY_OVERDUE";
  else if (daysOverdue > 0) collectionStatus = "OVERDUE";
  else if (balance > 0 && row.oldestDueDate) collectionStatus = "DUE_SOON";
  else collectionStatus = "REGULAR";

  return { collectionStatus, daysOverdue, creditUsagePct };
}

function baseConditions(input: CustomerOperationsInput): SQL[] {
  const conditions: SQL[] = [];
  if (!input.includeInactive) conditions.push(sql`${customers.isActive} = TRUE`);
  if (input.customerType) conditions.push(sql`${customers.customerType} = ${input.customerType}`);
  if (input.priceTier) conditions.push(sql`${customers.defaultPriceTier} = ${input.priceTier}`);
  if (input.q?.trim()) {
    const raw = input.q.trim();
    const likeRaw = `%${escLike(raw)}%`;
    const likeFolded = `%${escLike(normalizeSearchText(raw))}%`;
    const phoneSuffix = phoneSuffix10(raw);
    conditions.push(sql`(
      COALESCE(${customers.searchNorm}, '') LIKE ${likeFolded} ESCAPE '!'
      OR ${customers.phone} LIKE ${likeRaw} ESCAPE '!'
      OR ${customers.phone2} LIKE ${likeRaw} ESCAPE '!'
      OR ${customers.phone3} LIKE ${likeRaw} ESCAPE '!'
      OR ${customers.whatsapp} LIKE ${likeRaw} ESCAPE '!'
      OR ${customers.legacyCode} LIKE ${likeRaw} ESCAPE '!'
      ${phoneSuffix ? sql`OR ${customers.phone} LIKE ${`%${escLike(phoneSuffix)}`} ESCAPE '!'
        OR ${customers.phone2} LIKE ${`%${escLike(phoneSuffix)}`} ESCAPE '!'
        OR ${customers.phone3} LIKE ${`%${escLike(phoneSuffix)}`} ESCAPE '!'
        OR ${customers.whatsapp} LIKE ${`%${escLike(phoneSuffix)}`} ESCAPE '!'` : sql``}
    )`);
  }
  return conditions;
}

function derivedCustomers(input: CustomerOperationsInput): SQL {
  const base = baseConditions(input);
  return sql`
    SELECT
      ${customers.id} AS id,
      ${customers.name} AS name,
      ${customers.phone} AS phone,
      ${customers.whatsapp} AS whatsapp,
      ${customers.city} AS city,
      ${customers.district} AS district,
      ${customers.customerType} AS customerType,
      ${customers.defaultPriceTier} AS defaultPriceTier,
      ${customers.creditLimit} AS creditLimit,
      ${customers.currentBalance} AS currentBalance,
      ${customers.legacyCode} AS legacyCode,
      ${customers.isActive} AS isActive,
      ${customers.createdAt} AS createdAt,
      COALESCE((
        SELECT SUM(GREATEST(i.total - i.paidAmount - i.returnedTotal, 0))
        FROM ${invoices} i
        WHERE i.customerId = ${customers.id}
          AND i.invoiceStatus IN ('PENDING', 'PARTIALLY_PAID')
          AND DATE(COALESCE(i.dueDate, i.invoiceDate)) < UTC_DATE()
      ), 0) AS overdueAmount,
      (
        SELECT DATE_FORMAT(MIN(DATE(COALESCE(i.dueDate, i.invoiceDate))), '%Y-%m-%d')
        FROM ${invoices} i
        WHERE i.customerId = ${customers.id}
          AND i.invoiceStatus IN ('PENDING', 'PARTIALLY_PAID')
          AND GREATEST(i.total - i.paidAmount - i.returnedTotal, 0) > 0
      ) AS oldestDueDate,
      (
        SELECT DATE_FORMAT(MAX(DATE(i.invoiceDate)), '%Y-%m-%d')
        FROM ${invoices} i
        WHERE i.customerId = ${customers.id}
          AND i.invoiceStatus NOT IN ('CANCELLED', 'RETURNED')
      ) AS lastPurchaseDate,
      (
        SELECT DATE_FORMAT(MAX(n.createdAt), '%Y-%m-%d')
        FROM ${customerNotes} n
        WHERE n.customerId = ${customers.id}
      ) AS lastContactAt,
      (
        SELECT r.promisedDate
        FROM ${arReminders} r
        WHERE r.customerId = ${customers.id}
        ORDER BY r.id DESC
        LIMIT 1
      ) AS promisedDate,
      (
        SELECT DATE_FORMAT(r.createdAt, '%Y-%m-%d')
        FROM ${arReminders} r
        WHERE r.customerId = ${customers.id}
        ORDER BY r.id DESC
        LIMIT 1
      ) AS lastReminderAt,
      (
        SELECT COUNT(*)
        FROM ${tasks} t
        WHERE t.customerId = ${customers.id}
          AND t.taskStatus NOT IN ('RESOLVED', 'CANCELLED')
      ) AS openTasks
    FROM ${customers}
    ${base.length ? sql`WHERE ${sql.join(base, sql` AND `)}` : sql``}
  `;
}

function operationalConditions(input: CustomerOperationsInput): SQL[] {
  const conditions: SQL[] = [];
  if (input.balance === "RECEIVABLE") conditions.push(sql`op.currentBalance > 0`);
  if (input.balance === "CREDIT") conditions.push(sql`op.currentBalance < 0`);
  if (input.balance === "ZERO") conditions.push(sql`op.currentBalance = 0`);
  if (input.collection === "OVERDUE") conditions.push(sql`op.overdueAmount > 0`);
  if (input.collection === "PROMISE_DUE") conditions.push(sql`op.promisedDate <= UTC_DATE() AND op.currentBalance > 0`);
  if (input.collection === "PROMISE_FUTURE") conditions.push(sql`op.promisedDate > UTC_DATE() AND op.currentBalance > 0`);
  if (input.collection === "NO_FOLLOWUP") conditions.push(sql`op.currentBalance > 0 AND op.lastContactAt IS NULL AND op.lastReminderAt IS NULL`);
  if (input.credit === "CASH_ONLY") conditions.push(sql`op.creditLimit = 0`);
  if (input.credit === "UNLIMITED") conditions.push(sql`op.creditLimit IS NULL`);
  if (input.credit === "OVER_LIMIT") conditions.push(sql`op.creditLimit > 0 AND op.currentBalance > op.creditLimit`);
  if (input.credit === "NEAR_LIMIT") conditions.push(sql`op.creditLimit > 0 AND op.currentBalance >= op.creditLimit * 0.8 AND op.currentBalance <= op.creditLimit`);
  if (input.inactivityDays) {
    conditions.push(sql`(op.lastPurchaseDate IS NULL OR op.lastPurchaseDate < DATE_SUB(UTC_DATE(), INTERVAL ${input.inactivityDays} DAY))`);
  }
  return conditions;
}

function orderBy(sort: CustomerOperationsSort | undefined): SQL {
  if (sort === "BALANCE_DESC") return sql`op.currentBalance DESC, op.name ASC`;
  if (sort === "OLDEST_DUE") return sql`op.oldestDueDate IS NULL, op.oldestDueDate ASC, op.currentBalance DESC`;
  if (sort === "LAST_PURCHASE") return sql`op.lastPurchaseDate IS NULL, op.lastPurchaseDate ASC, op.name ASC`;
  return sql`op.name ASC, op.id DESC`;
}

function dataRows(result: unknown): any[] {
  const payload = result as any;
  const rows = payload?.[0] ?? payload;
  return Array.isArray(rows) ? rows : [];
}

export async function getCustomerOperations(input: CustomerOperationsInput = {}): Promise<{
  rows: CustomerOperationsRow[];
  total: number;
  summary: CustomerOperationsSummary;
}> {
  const db = getDb();
  if (!db) {
    return {
      rows: [],
      total: 0,
      summary: {
        total: 0, active: 0, inactive: 0, cashOnly: 0, unlimited: 0,
        receivable: "0.00", customerCredit: "0.00", net: "0.00", debtors: 0, creditors: 0,
        overdueAmount: "0.00", overdueCustomers: 0, promiseDue: 0, promiseBroken: 0,
        overLimit: 0, nearLimit: 0, noRecentPurchase30: 0, highestDebtor: null,
        topFiveConcentrationPct: 0, collectorActivity30d: [],
      },
    };
  }

  const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);
  const derived = derivedCustomers(input);
  const ops = operationalConditions(input);
  const filteredWhere = ops.length ? sql`WHERE ${sql.join(ops, sql` AND `)}` : sql``;

  const [pageResult, summaryResult, topResult, activityResult] = await Promise.all([
    db.execute(sql`
      SELECT * FROM (${derived}) op
      ${filteredWhere}
      ORDER BY ${orderBy(input.sort)}
      LIMIT ${limit} OFFSET ${offset}
    `),
    db.execute(sql`
      SELECT
        COUNT(*) AS total,
        SUM(op.isActive = TRUE) AS active,
        SUM(op.isActive = FALSE) AS inactive,
        SUM(op.creditLimit = 0) AS cashOnly,
        SUM(op.creditLimit IS NULL) AS unlimited,
        CAST(COALESCE(SUM(CASE WHEN op.currentBalance > 0 THEN op.currentBalance ELSE 0 END), 0) AS CHAR) AS receivable,
        CAST(COALESCE(SUM(CASE WHEN op.currentBalance < 0 THEN -op.currentBalance ELSE 0 END), 0) AS CHAR) AS customerCredit,
        CAST(COALESCE(SUM(op.currentBalance), 0) AS CHAR) AS net,
        SUM(op.currentBalance > 0) AS debtors,
        SUM(op.currentBalance < 0) AS creditors,
        CAST(COALESCE(SUM(LEAST(op.overdueAmount, GREATEST(op.currentBalance, 0))), 0) AS CHAR) AS overdueAmount,
        SUM(op.overdueAmount > 0 AND op.currentBalance > 0) AS overdueCustomers,
        SUM(op.promisedDate = UTC_DATE() AND op.currentBalance > 0) AS promiseDue,
        SUM(op.promisedDate < UTC_DATE() AND op.currentBalance > 0) AS promiseBroken,
        SUM(op.creditLimit > 0 AND op.currentBalance > op.creditLimit) AS overLimit,
        SUM(op.creditLimit > 0 AND op.currentBalance >= op.creditLimit * 0.8 AND op.currentBalance <= op.creditLimit) AS nearLimit,
        SUM(op.lastPurchaseDate IS NULL OR op.lastPurchaseDate < DATE_SUB(UTC_DATE(), INTERVAL 30 DAY)) AS noRecentPurchase30
      FROM (${derived}) op
      ${filteredWhere}
    `),
    db.execute(sql`
      SELECT op.id, op.name, op.currentBalance
      FROM (${derived}) op
      ${filteredWhere}
      ${ops.length ? sql`AND` : sql`WHERE`} op.currentBalance > 0
      ORDER BY op.currentBalance DESC
      LIMIT 5
    `),
    db.execute(sql`
      SELECT
        ${arReminders.createdBy} AS userId,
        ${users.name} AS userName,
        SUM(${arReminders.status} = 'SENT') AS sent,
        SUM(${arReminders.status} = 'SKIPPED' AND ${arReminders.promisedDate} IS NOT NULL) AS promisesRecorded
      FROM ${arReminders}
      INNER JOIN ${users} ON ${users.id} = ${arReminders.createdBy}
      WHERE ${arReminders.createdAt} >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
      GROUP BY ${arReminders.createdBy}, ${users.name}
      ORDER BY sent DESC, promisesRecorded DESC
      LIMIT 10
    `),
  ]);

  const rawRows = dataRows(pageResult) as DbRow[];
  const rows = rawRows.map((row) => ({
    ...row,
    id: Number(row.id),
    isActive: !!row.isActive,
    openTasks: Number(row.openTasks ?? 0),
    ...collectionMeta(row),
  }));
  const s = dataRows(summaryResult)[0] ?? {};
  const top = dataRows(topResult);
  const receivable = n(s.receivable);
  const topFive = top.reduce((sum, row) => sum + n(row.currentBalance), 0);
  const highest = top[0];

  return {
    rows,
    total: n(s.total),
    summary: {
      total: n(s.total),
      active: n(s.active),
      inactive: n(s.inactive),
      cashOnly: n(s.cashOnly),
      unlimited: n(s.unlimited),
      receivable: toDbMoney(money(s.receivable ?? 0)),
      customerCredit: toDbMoney(money(s.customerCredit ?? 0)),
      net: toDbMoney(money(s.net ?? 0)),
      debtors: n(s.debtors),
      creditors: n(s.creditors),
      overdueAmount: toDbMoney(money(s.overdueAmount ?? 0)),
      overdueCustomers: n(s.overdueCustomers),
      promiseDue: n(s.promiseDue),
      promiseBroken: n(s.promiseBroken),
      overLimit: n(s.overLimit),
      nearLimit: n(s.nearLimit),
      noRecentPurchase30: n(s.noRecentPurchase30),
      highestDebtor: highest
        ? { customerId: n(highest.id), customerName: String(highest.name), amount: toDbMoney(money(highest.currentBalance ?? 0)) }
        : null,
      topFiveConcentrationPct: receivable > 0 ? Math.round((topFive / receivable) * 10_000) / 100 : 0,
      collectorActivity30d: dataRows(activityResult).map((row) => ({
        userId: n(row.userId),
        userName: String(row.userName ?? "—"),
        sent: n(row.sent),
        promisesRecorded: n(row.promisesRecorded),
      })),
    },
  };
}
