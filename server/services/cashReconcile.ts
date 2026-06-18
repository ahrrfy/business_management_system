/**
 * CASH-CORE — تَقرير المُطابقة الذَرّية للصناديق.
 *
 * يَحلّ مَحلّ `cashOrphansReport` بَعد التَرحيل الكامل. يَتحقّق من invariants:
 *   I8: SUM(IN) - SUM(OUT) لكل bucket == currentBalance
 *   I5: كل OUT بـpairToken له IN مُقابل بنَفس pairToken (transfer كامل)
 *
 * يُستدعى يَدوياً من شاشة `/reports/cash-reconcile` + سيُجَدول كل ١٥د لاحقاً.
 */
import { eq, isNotNull, sql } from "drizzle-orm";
import { cashBuckets, receipts } from "../../drizzle/schema";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";

export interface BucketReconcile {
  bucketId: number;
  bucketName: string;
  kind: "DRAWER" | "TREASURY" | "BANK" | "SAFE";
  branchId: number;
  storedBalance: string;
  computedBalance: string;
  drift: string;
  isBalanced: boolean;
  txCount: number;
}

export interface TransferImbalance {
  pairToken: string;
  outCount: number;
  inCount: number;
  outSum: string;
  inSum: string;
}

export interface CashReconcileResult {
  buckets: BucketReconcile[];
  imbalancedTransfers: TransferImbalance[];
  totalDrift: string;
  totalBuckets: number;
  driftedBuckets: number;
  runAt: string;
}

function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

export async function getCashReconcileReport(): Promise<CashReconcileResult> {
  const db = getDb();
  const empty: CashReconcileResult = {
    buckets: [],
    imbalancedTransfers: [],
    totalDrift: "0.00",
    totalBuckets: 0,
    driftedBuckets: 0,
    runAt: new Date().toISOString(),
  };
  if (!db) return empty;

  // ١) لكل bucket: احسب IN-OUT من receipts.bucketId وقارن بـcurrentBalance.
  const bucketRows = rowsOf(
    await db.execute(sql`
      SELECT
        b.id AS bucketId,
        b.name AS bucketName,
        b.kind AS kind,
        b.branchId AS branchId,
        CAST(b.currentBalance AS CHAR) AS stored,
        CAST(COALESCE(SUM(CASE WHEN r.direction = 'IN' THEN r.amount ELSE 0 END), 0) AS CHAR) AS sumIn,
        CAST(COALESCE(SUM(CASE WHEN r.direction = 'OUT' THEN r.amount ELSE 0 END), 0) AS CHAR) AS sumOut,
        COUNT(r.id) AS txCount
      FROM cashBuckets b
      LEFT JOIN receipts r ON r.bucketId = b.id AND r.receiptStatus = 'COMPLETED'
      WHERE b.isActive = 1
      GROUP BY b.id, b.name, b.kind, b.branchId, b.currentBalance
      ORDER BY b.branchId, b.kind, b.id
    `)
  );

  let totalDrift = money(0);
  let driftedBuckets = 0;
  const buckets: BucketReconcile[] = bucketRows.map((r) => {
    const stored = money(r.stored ?? 0);
    const sumIn = money(r.sumIn ?? 0);
    const sumOut = money(r.sumOut ?? 0);
    const computed = sumIn.minus(sumOut);
    const drift = stored.minus(computed);
    const isBalanced = drift.abs().lt(money("0.01"));
    if (!isBalanced) {
      driftedBuckets++;
      totalDrift = totalDrift.plus(drift.abs());
    }
    return {
      bucketId: Number(r.bucketId),
      bucketName: String(r.bucketName ?? ""),
      kind: r.kind,
      branchId: Number(r.branchId),
      storedBalance: toDbMoney(stored),
      computedBalance: toDbMoney(computed),
      drift: toDbMoney(drift),
      isBalanced,
      txCount: Number(r.txCount ?? 0),
    };
  });

  // ٢) فَحص التَحويلات: كل pairToken يَجب أن يَكون له OUT + IN بمَجموع مُتساوٍ.
  const pairRows = rowsOf(
    await db.execute(sql`
      SELECT
        r.pairToken AS pairToken,
        SUM(CASE WHEN r.direction = 'OUT' THEN 1 ELSE 0 END) AS outCount,
        SUM(CASE WHEN r.direction = 'IN' THEN 1 ELSE 0 END) AS inCount,
        CAST(COALESCE(SUM(CASE WHEN r.direction = 'OUT' THEN r.amount ELSE 0 END), 0) AS CHAR) AS outSum,
        CAST(COALESCE(SUM(CASE WHEN r.direction = 'IN' THEN r.amount ELSE 0 END), 0) AS CHAR) AS inSum
      FROM receipts r
      WHERE r.pairToken IS NOT NULL AND r.receiptStatus = 'COMPLETED'
      GROUP BY r.pairToken
      HAVING outCount != 1 OR inCount != 1 OR outSum != inSum
    `)
  );

  const imbalancedTransfers: TransferImbalance[] = pairRows.map((r) => ({
    pairToken: String(r.pairToken),
    outCount: Number(r.outCount),
    inCount: Number(r.inCount),
    outSum: String(r.outSum ?? "0"),
    inSum: String(r.inSum ?? "0"),
  }));

  return {
    buckets,
    imbalancedTransfers,
    totalDrift: toDbMoney(totalDrift),
    totalBuckets: buckets.length,
    driftedBuckets,
    runAt: new Date().toISOString(),
  };
}
