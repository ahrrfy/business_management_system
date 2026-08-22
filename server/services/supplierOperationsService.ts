import { sql, type SQL } from "drizzle-orm";
import { suppliers } from "../../drizzle/schema";
import { getDb } from "../db";
import { normalizeSearchText } from "../../shared/searchNormalize";
import { phoneSuffix10 } from "../lib/phone";
import { escLike } from "../lib/sqlLike";

export interface SupplierSummaryInput {
  q?: string;
  includeInactive?: boolean;
  kind?: "REGULAR" | "CONSIGNOR";
}

export interface SupplierSummary {
  total: number;
  active: number;
  inactive: number;
  regular: number;
  consignors: number;
  payableIqd: string;
  receivableIqd: string;
  netIqd: string;
  payableUsd: string;
  receivableUsd: string;
  netUsd: string;
  nonZeroBalances: number;
  highestPayable: { supplierId: number; supplierName: string; amount: string } | null;
}

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowsOf(result: unknown): any[] {
  const payload = result as any;
  const rows = payload?.[0] ?? payload;
  return Array.isArray(rows) ? rows : [];
}

function conditions(input: SupplierSummaryInput): SQL[] {
  const conds: SQL[] = [];
  if (!input.includeInactive) conds.push(sql`${suppliers.isActive} = TRUE`);
  if (input.kind) conds.push(sql`${suppliers.supplierKind} = ${input.kind}`);
  if (input.q?.trim()) {
    const raw = input.q.trim();
    const likeRaw = `%${escLike(raw)}%`;
    const likeFolded = `%${escLike(normalizeSearchText(raw))}%`;
    const suffix = phoneSuffix10(raw);
    // ⚠️ حرف الهروب `!` لا الشرطة المائلة. كان هنا `ESCAPE '\\'` في القالب النصّي، وهو يُنتج
    // في SQL `ESCAPE '\'` — ونصٌّ غير منتهٍ عند MySQL (`\'` هروبُ اقتباس) ⇒ **خطأ نحويّ يُسقط
    // كلّ استعلام بحثٍ عن مورّد**، وظلّ ساقطاً من ١٧/٨ إلى ٢١/٨ بلا أن يمسكه اختبار.
    // النظير `customerOperationsService` وُلد صحيحاً بـ`escLike` + `ESCAPE '!'`، وهو اصطلاح
    // المستودع كلّه لأنّه لا يعتمد على `sql_mode` (راجع `server/lib/sqlLike.ts`).
    conds.push(sql`(
      COALESCE(${suppliers.searchNorm}, '') LIKE ${likeFolded} ESCAPE '!'
      OR ${suppliers.phone} LIKE ${likeRaw} ESCAPE '!'
      OR ${suppliers.phone2} LIKE ${likeRaw} ESCAPE '!'
      OR ${suppliers.phone3} LIKE ${likeRaw} ESCAPE '!'
      OR ${suppliers.city} LIKE ${likeRaw} ESCAPE '!'
      OR ${suppliers.supplierCategory} LIKE ${likeRaw} ESCAPE '!'
      OR ${suppliers.legacyCode} LIKE ${likeRaw} ESCAPE '!'
      ${suffix ? sql`OR ${suppliers.phone} LIKE ${`%${escLike(suffix)}`} ESCAPE '!'
        OR ${suppliers.phone2} LIKE ${`%${escLike(suffix)}`} ESCAPE '!'
        OR ${suppliers.phone3} LIKE ${`%${escLike(suffix)}`} ESCAPE '!'
        OR ${suppliers.whatsapp} LIKE ${`%${escLike(suffix)}`} ESCAPE '!'` : sql``}
    )`);
  }
  return conds;
}

export async function getSupplierSummary(input: SupplierSummaryInput = {}): Promise<SupplierSummary> {
  const db = getDb();
  if (!db) {
    return {
      total: 0, active: 0, inactive: 0, regular: 0, consignors: 0,
      payableIqd: "0.00", receivableIqd: "0.00", netIqd: "0.00",
      payableUsd: "0.00", receivableUsd: "0.00", netUsd: "0.00",
      nonZeroBalances: 0, highestPayable: null,
    };
  }
  const conds = conditions(input);
  const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;
  const [summaryResult, topResult] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*) AS total,
        SUM(${suppliers.isActive} = TRUE) AS active,
        SUM(${suppliers.isActive} = FALSE) AS inactive,
        SUM(${suppliers.supplierKind} = 'REGULAR') AS regular,
        SUM(${suppliers.supplierKind} = 'CONSIGNOR') AS consignors,
        CAST(COALESCE(SUM(CASE WHEN ${suppliers.currentBalance} > 0 THEN ${suppliers.currentBalance} ELSE 0 END), 0) AS CHAR) AS payableIqd,
        CAST(COALESCE(SUM(CASE WHEN ${suppliers.currentBalance} < 0 THEN -${suppliers.currentBalance} ELSE 0 END), 0) AS CHAR) AS receivableIqd,
        CAST(COALESCE(SUM(${suppliers.currentBalance}), 0) AS CHAR) AS netIqd,
        CAST(COALESCE(SUM(CASE WHEN ${suppliers.currentBalanceUsd} > 0 THEN ${suppliers.currentBalanceUsd} ELSE 0 END), 0) AS CHAR) AS payableUsd,
        CAST(COALESCE(SUM(CASE WHEN ${suppliers.currentBalanceUsd} < 0 THEN -${suppliers.currentBalanceUsd} ELSE 0 END), 0) AS CHAR) AS receivableUsd,
        CAST(COALESCE(SUM(${suppliers.currentBalanceUsd}), 0) AS CHAR) AS netUsd,
        SUM(${suppliers.currentBalance} <> 0 OR ${suppliers.currentBalanceUsd} <> 0) AS nonZeroBalances
      FROM ${suppliers}
      ${where}
    `),
    db.execute(sql`
      SELECT ${suppliers.id} AS id, ${suppliers.name} AS name, CAST(${suppliers.currentBalance} AS CHAR) AS amount
      FROM ${suppliers}
      ${where}
      ${conds.length ? sql`AND` : sql`WHERE`} ${suppliers.currentBalance} > 0
      ORDER BY ${suppliers.currentBalance} DESC
      LIMIT 1
    `),
  ]);
  const s = rowsOf(summaryResult)[0] ?? {};
  const top = rowsOf(topResult)[0];
  return {
    total: n(s.total),
    active: n(s.active),
    inactive: n(s.inactive),
    regular: n(s.regular),
    consignors: n(s.consignors),
    payableIqd: String(s.payableIqd ?? "0.00"),
    receivableIqd: String(s.receivableIqd ?? "0.00"),
    netIqd: String(s.netIqd ?? "0.00"),
    payableUsd: String(s.payableUsd ?? "0.00"),
    receivableUsd: String(s.receivableUsd ?? "0.00"),
    netUsd: String(s.netUsd ?? "0.00"),
    nonZeroBalances: n(s.nonZeroBalances),
    highestPayable: top
      ? { supplierId: n(top.id), supplierName: String(top.name), amount: String(top.amount) }
      : null,
  };
}
