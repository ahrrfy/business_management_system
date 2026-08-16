/**
 * دفتر أستاذ حساب واحد من journalEntries/journalLines (P2/ش٣).
 *
 * الرصيد الجاري محسوب بترتيب (التاريخ، رقم رأس القيد) قبل LIMIT/OFFSET، لذلك يبقى صحيحاً في
 * كل صفحة وفي تصدير Excel. نجمّع سطور الدور داخل القيد أولاً لأن القيد قد يحمل الدور نفسه أكثر
 * من مرة، ثم نربط الحدث المالي بمستنده الأصلي للتدقيق.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  accounts,
  doubleEntrySettings,
  journalEntries,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { DoubleEntryMode } from "../accounting/journalStore";
import { money, toDbMoney } from "../money";
import type { AccountType } from "../accountsService";

export type BalanceSide = "DEBIT" | "CREDIT" | "ZERO";

export interface GeneralLedgerRow {
  journalId: number;
  entryId: number | null;
  sourceType: "ACCOUNTING_ENTRY" | "SHADOW_OPENING";
  postingProfile: string | null;
  entryDate: string;
  entryType: string;
  branchId: number | null;
  branchName: string | null;
  notes: string | null;
  debit: string;
  credit: string;
  runningBalance: string;
  runningSide: BalanceSide;
  invoiceId: number | null;
  invoiceNumber: string | null;
  purchaseOrderId: number | null;
  receiptId: number | null;
  voucherNumber: string | null;
  customerId: number | null;
  customerName: string | null;
  supplierId: number | null;
  supplierName: string | null;
  createdBy: number | null;
  createdByName: string | null;
  dedupeKey: string | null;
  createdAt: string;
}

export interface GeneralLedgerResult {
  mode: DoubleEntryMode;
  cycleId: string | null;
  shadowStartedAt: string | null;
  availableFrom: string | null;
  from: string;
  to: string;
  branchId: number | null;
  account: {
    id: number;
    code: string;
    name: string;
    type: AccountType;
    systemRole: string;
  };
  openingBalance: string;
  openingSide: BalanceSide;
  rows: GeneralLedgerRow[];
  total: number;
  openingUnmappedCount: number;
  periodUnmappedCount: number;
  unmappedCount: number;
  totals: {
    debit: string;
    credit: string;
    closingBalance: string;
    closingSide: BalanceSide;
  };
}

type RawMovement = Omit<
  GeneralLedgerRow,
  "debit" | "credit" | "runningBalance" | "runningSide"
> & {
  debit: string | null;
  credit: string | null;
  periodRunning: string | null;
};

function rowsOf<T>(result: unknown): T[] {
  const data = (result as any)?.[0] ?? result;
  return Array.isArray(data) ? (data as T[]) : [];
}

function timestampText(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 19).replace("T", " ");
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function baghdadYmd(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: "year" | "month" | "day") =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function balanceView(value: ReturnType<typeof money>): {
  balance: string;
  side: BalanceSide;
} {
  if (value.isZero()) return { balance: "0.00", side: "ZERO" };
  return {
    balance: toDbMoney(value.abs()),
    side: value.isNegative() ? "CREDIT" : "DEBIT",
  };
}

export async function getGeneralLedger(input: {
  accountId: number;
  from: string;
  to: string;
  branchId?: number;
  limit?: number;
  offset?: number;
}): Promise<GeneralLedgerResult> {
  const db = getDb();
  if (!db) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "قاعدة البيانات غير متاحة",
    });
  }

  const [account] = await db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      systemRole: accounts.systemRole,
    })
    .from(accounts)
    .where(eq(accounts.id, input.accountId))
    .limit(1);
  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "الحساب غير موجود" });
  }
  if (!account.systemRole) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "حساب الرأس لا يقبل الترحيل؛ اختر حساباً تفصيلياً",
    });
  }

  const [setting] = await db
    .select({
      mode: doubleEntrySettings.mode,
      cycleId: doubleEntrySettings.shadowCycleId,
      shadowStartedAt: doubleEntrySettings.shadowStartedAt,
    })
    .from(doubleEntrySettings)
    .limit(1);
  const mode = (setting?.mode as DoubleEntryMode | undefined) ?? "OFF";
  const cycleId = setting?.cycleId ?? "";
  const availableFrom = setting?.shadowStartedAt
    ? baghdadYmd(setting.shadowStartedAt)
    : null;
  if (cycleId && availableFrom && input.from < availableFrom) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `دفتر الأستاذ متاح من ${availableFrom}؛ لا يشمل أرباحاً وخسائر قبل تاريخ القطع.`,
    });
  }
  if (cycleId && input.branchId != null) {
    const [globalOpening] = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.cycleId, cycleId),
          eq(journalEntries.sourceType, "SHADOW_OPENING"),
          isNull(journalEntries.branchId),
        ),
      )
      .limit(1);
    if (globalOpening) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "هذه الدورة تحمل رأس افتتاح عالمياً للذمم/حقوق الملكية؛ دفتر الأستاذ متاح للشركة كلها فقط، وأي رأس غير POSTED يُعالج قبل الاعتماد ولا يجوز إخفاؤه بتقرير فرع ناقص.",
      });
    }
  }
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 2000);
  const offset = Math.max(input.offset ?? 0, 0);
  const branchClause =
    input.branchId == null ? sql`` : sql` AND je.branchId = ${input.branchId}`;
  const availabilityClause = availableFrom
    ? sql` AND je.entryDate >= ${availableFrom}`
    : sql``;

  const [openingRow] = rowsOf<{ balance: string | null }>(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(jl.debit - jl.credit), 0) AS CHAR) AS balance
      FROM journalLines jl
      INNER JOIN journalEntries je ON je.id = jl.journalId
      WHERE je.status = 'POSTED'
        AND je.cycleId = ${cycleId}
        ${availabilityClause}
        AND jl.role = ${account.systemRole}
        AND (je.sourceType = 'SHADOW_OPENING' OR je.entryDate < ${input.from})
        ${branchClause}
    `),
  );
  const openingSigned = money(openingRow?.balance);

  const [totalRow] = rowsOf<{
    count: number | string;
    debit: string | null;
    credit: string | null;
  }>(
    await db.execute(sql`
      SELECT
        COUNT(*) AS count,
        CAST(COALESCE(SUM(m.debit), 0) AS CHAR) AS debit,
        CAST(COALESCE(SUM(m.credit), 0) AS CHAR) AS credit
      FROM (
        SELECT je.id, SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
        FROM journalEntries je
        INNER JOIN journalLines jl ON jl.journalId = je.id
        WHERE je.status = 'POSTED'
          AND je.cycleId = ${cycleId}
          ${availabilityClause}
          AND jl.role = ${account.systemRole}
          AND je.sourceType <> 'SHADOW_OPENING'
          AND je.entryDate >= ${input.from}
          AND je.entryDate <= ${input.to}
          ${branchClause}
        GROUP BY je.id
      ) m
    `),
  );
  const totalDebit = money(totalRow?.debit);
  const totalCredit = money(totalRow?.credit);
  const closing = balanceView(openingSigned.add(totalDebit).sub(totalCredit));

  const rawRows = rowsOf<RawMovement>(
    await db.execute(sql`
      WITH movements AS (
        SELECT
          je.id AS journalId,
          je.entryId AS entryId,
          je.sourceType AS sourceType,
          je.postingProfile AS postingProfile,
          DATE_FORMAT(je.entryDate, '%Y-%m-%d') AS entryDate,
          COALESCE(ae.entryType, je.sourceType) AS entryType,
          je.branchId AS branchId,
          b.name AS branchName,
          COALESCE(ae.notes, 'رصيد افتتاح دورة الدفتر المزدوج') AS notes,
          SUM(jl.debit) AS debit,
          SUM(jl.credit) AS credit,
          ae.invoiceId AS invoiceId,
          i.invoiceNumber AS invoiceNumber,
          ae.purchaseOrderId AS purchaseOrderId,
          ae.receiptId AS receiptId,
          r.voucherNumber AS voucherNumber,
          ae.customerId AS customerId,
          c.name AS customerName,
          ae.supplierId AS supplierId,
          s.name AS supplierName,
          ae.createdBy AS createdBy,
          COALESCE(u.name, ae.createdByNameSnapshot) AS createdByName,
          COALESCE(ae.dedupeKey, je.sourceKey) AS dedupeKey,
          DATE_FORMAT(COALESCE(ae.createdAt, je.createdAt), '%Y-%m-%d %H:%i:%s') AS createdAt
        FROM journalEntries je
        INNER JOIN journalLines jl ON jl.journalId = je.id
        LEFT JOIN accountingEntries ae ON ae.id = je.entryId
        LEFT JOIN branches b ON b.id = je.branchId
        LEFT JOIN invoices i ON i.id = ae.invoiceId
        LEFT JOIN receipts r ON r.id = ae.receiptId
        LEFT JOIN customers c ON c.id = ae.customerId
        LEFT JOIN suppliers s ON s.id = ae.supplierId
        LEFT JOIN users u ON u.id = ae.createdBy
        WHERE je.status = 'POSTED'
          AND je.cycleId = ${cycleId}
          ${availabilityClause}
          AND jl.role = ${account.systemRole}
          AND je.sourceType <> 'SHADOW_OPENING'
          AND je.entryDate >= ${input.from}
          AND je.entryDate <= ${input.to}
          ${branchClause}
        GROUP BY
          je.id, je.entryId, je.sourceType, je.postingProfile, je.entryDate, ae.entryType, je.branchId, b.name,
          ae.notes, ae.invoiceId, i.invoiceNumber, ae.purchaseOrderId,
          ae.receiptId, r.voucherNumber, ae.customerId, c.name, ae.supplierId,
          s.name, ae.createdBy, u.name, ae.createdByNameSnapshot, ae.dedupeKey,
          ae.createdAt
      ), running AS (
        SELECT
          movements.*,
          SUM(movements.debit - movements.credit) OVER (
            ORDER BY movements.entryDate, movements.journalId
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS periodRunning
        FROM movements
      )
      SELECT
        running.*,
        CAST(running.debit AS CHAR) AS debit,
        CAST(running.credit AS CHAR) AS credit,
        CAST(running.periodRunning AS CHAR) AS periodRunning
      FROM running
      ORDER BY running.entryDate, running.journalId
      LIMIT ${limit} OFFSET ${offset}
    `),
  );

  const rows: GeneralLedgerRow[] = rawRows.map((row) => {
    const running = balanceView(openingSigned.add(money(row.periodRunning)));
    return {
      journalId: Number(row.journalId),
      entryId: row.entryId == null ? null : Number(row.entryId),
      sourceType: row.sourceType,
      postingProfile: row.postingProfile ?? null,
      entryDate: String(row.entryDate),
      entryType: String(row.entryType),
      branchId: row.branchId == null ? null : Number(row.branchId),
      branchName: row.branchName ?? null,
      notes: row.notes ?? null,
      debit: toDbMoney(row.debit ?? 0),
      credit: toDbMoney(row.credit ?? 0),
      runningBalance: running.balance,
      runningSide: running.side,
      invoiceId: row.invoiceId == null ? null : Number(row.invoiceId),
      invoiceNumber: row.invoiceNumber ?? null,
      purchaseOrderId:
        row.purchaseOrderId == null ? null : Number(row.purchaseOrderId),
      receiptId: row.receiptId == null ? null : Number(row.receiptId),
      voucherNumber: row.voucherNumber ?? null,
      customerId: row.customerId == null ? null : Number(row.customerId),
      customerName: row.customerName ?? null,
      supplierId: row.supplierId == null ? null : Number(row.supplierId),
      supplierName: row.supplierName ?? null,
      createdBy: row.createdBy == null ? null : Number(row.createdBy),
      createdByName: row.createdByName ?? null,
      dedupeKey: row.dedupeKey ?? null,
      createdAt: String(row.createdAt),
    };
  });

  const gapBranchClause =
    input.branchId == null
      ? sql``
      : sql` AND ${journalEntries.branchId} = ${input.branchId}`;
  const gapAvailabilityClause = availableFrom
    ? sql` AND ${journalEntries.entryDate} >= ${availableFrom}`
    : sql``;
  const [gapRow] = rowsOf<{
    openingCount: number | string;
    periodCount: number | string;
  }>(
    await db.execute(sql`
      SELECT
        SUM(CASE WHEN ${journalEntries.sourceType} = 'SHADOW_OPENING' OR ${journalEntries.entryDate} < ${input.from} THEN 1 ELSE 0 END) AS openingCount,
        SUM(CASE WHEN ${journalEntries.sourceType} <> 'SHADOW_OPENING' AND ${journalEntries.entryDate} >= ${input.from} THEN 1 ELSE 0 END) AS periodCount
      FROM ${journalEntries}
      WHERE ${journalEntries.status} = 'UNMAPPED'
        AND ${journalEntries.cycleId} = ${cycleId}
        ${gapAvailabilityClause}
        AND ${journalEntries.entryDate} <= ${input.to}
        ${gapBranchClause}
    `),
  );
  const openingUnmappedCount = Number(gapRow?.openingCount ?? 0);
  const periodUnmappedCount = Number(gapRow?.periodCount ?? 0);
  const opening = balanceView(openingSigned);

  return {
    mode,
    cycleId: setting?.cycleId ?? null,
    shadowStartedAt: timestampText(setting?.shadowStartedAt),
    availableFrom,
    from: input.from,
    to: input.to,
    branchId: input.branchId ?? null,
    account: {
      id: Number(account.id),
      code: account.code,
      name: account.name,
      type: account.type as AccountType,
      systemRole: account.systemRole,
    },
    openingBalance: opening.balance,
    openingSide: opening.side,
    rows,
    total: Number(totalRow?.count ?? 0),
    openingUnmappedCount,
    periodUnmappedCount,
    unmappedCount: openingUnmappedCount + periodUnmappedCount,
    totals: {
      debit: toDbMoney(totalDebit),
      credit: toDbMoney(totalCredit),
      closingBalance: closing.balance,
      closingSide: closing.side,
    },
  };
}
