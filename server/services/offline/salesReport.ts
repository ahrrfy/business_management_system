// تقرير «المبيعات الأوفلاين» للإدارة — الشريحة ٥ من خطة الأوفلاين.
// عين المالك على التجربة المُقاسة: كل فاتورة التُقطت دون اتصال، بربط الرقم المؤقّت بالرسمي،
// وزمن الترحيل (replay-lag = createdAt − capturedAt)، ووسم «مُزامنة لاحقاً» (رُحِّلت بعد إغلاق
// ورديتها) — وهي معايير نجاح التجربة المقرَّرة (نسبة نجاح المزامنة/الزمن/صفر ازدواج).

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { invoices, shifts } from "../../../drizzle/schema";
import { TRPCError } from "@trpc/server";
import { getDb } from "../../db";

export interface OfflineSalesReportRow {
  invoiceId: number;
  invoiceNumber: string;
  offlineReceiptNumber: string | null;
  branchId: number;
  shiftId: number | null;
  total: string;
  capturedAt: string | null;
  syncedAt: string;
  /** دقائق بين الالتقاط على الجهاز والترحيل للخادم. */
  replayLagMinutes: number | null;
  /** رُحِّلت بعد إغلاق ورديتها (قسم «مُزامنة لاحقاً» في Z). */
  lateSynced: boolean;
  status: string;
}

export interface OfflineSalesReport {
  rows: OfflineSalesReportRow[];
  totals: {
    count: number;
    total: string;
    avgLagMinutes: number | null;
    maxLagMinutes: number | null;
    lateSyncedCount: number;
  };
}

export async function buildOfflineSalesReport(filter: {
  from?: string;
  to?: string;
  branchId?: number;
}): Promise<OfflineSalesReport> {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

  const conds = [eq(invoices.originatedOffline, true)];
  // نطاق التاريخ على لحظة الترحيل (createdAt) — يوم UTC كامل الحدود (إطار businessDay).
  if (filter.from) conds.push(gte(invoices.createdAt, new Date(`${filter.from}T00:00:00Z`)));
  if (filter.to) conds.push(lte(invoices.createdAt, new Date(`${filter.to}T23:59:59.999Z`)));
  if (filter.branchId) conds.push(eq(invoices.branchId, filter.branchId));

  const raw = await db
    .select({
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      offlineReceiptNumber: invoices.offlineReceiptNumber,
      branchId: invoices.branchId,
      shiftId: invoices.shiftId,
      total: invoices.total,
      capturedAt: invoices.capturedAt,
      createdAt: invoices.createdAt,
      status: invoices.status,
      shiftClosedAt: shifts.closedAt,
    })
    .from(invoices)
    .leftJoin(shifts, eq(invoices.shiftId, shifts.id))
    .where(and(...conds))
    .orderBy(desc(invoices.id))
    .limit(500);

  const rows: OfflineSalesReportRow[] = raw.map((r) => {
    const captured = r.capturedAt ? new Date(r.capturedAt) : null;
    const synced = new Date(r.createdAt);
    const lagMinutes = captured
      ? Math.max(0, Math.round((synced.getTime() - captured.getTime()) / 60_000))
      : null;
    const lateSynced = !!(r.shiftClosedAt && synced.getTime() > new Date(r.shiftClosedAt).getTime());
    return {
      invoiceId: Number(r.invoiceId),
      invoiceNumber: r.invoiceNumber,
      offlineReceiptNumber: r.offlineReceiptNumber,
      branchId: Number(r.branchId),
      shiftId: r.shiftId == null ? null : Number(r.shiftId),
      total: String(r.total),
      capturedAt: captured ? captured.toISOString() : null,
      syncedAt: synced.toISOString(),
      replayLagMinutes: lagMinutes,
      lateSynced,
      status: String(r.status),
    };
  });

  const [agg] = await db
    .select({
      count: sql<number>`count(*)`,
      total: sql<string>`coalesce(sum(${invoices.total}), 0)`,
    })
    .from(invoices)
    .where(and(...conds));

  const lags = rows.map((r) => r.replayLagMinutes).filter((v): v is number => v != null);
  return {
    rows,
    totals: {
      count: Number(agg?.count ?? 0),
      total: String(agg?.total ?? "0"),
      avgLagMinutes: lags.length ? Math.round(lags.reduce((s, v) => s + v, 0) / lags.length) : null,
      maxLagMinutes: lags.length ? Math.max(...lags) : null,
      lateSyncedCount: rows.filter((r) => r.lateSynced).length,
    },
  };
}
