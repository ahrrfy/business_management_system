import { asc, eq } from "drizzle-orm";
import cron, { type ScheduledTask } from "node-cron";
import { branches } from "../../../drizzle/schema";
import { logger } from "../../logger";
import { getDb } from "../../db";
import {
  getPurchaseIntegrityReport,
  type PurchaseIntegrityCode,
  type PurchaseIntegritySeverity,
} from "../purchaseIntegrityService";

const DEFAULT_CRON = "40 1 * * *";
const PAGE_SIZE = 200;
const DEFAULT_MAX_ORDERS_PER_BRANCH = 50_000;

export interface PurchaseIntegrityMonitorSummary {
  generatedAt: string;
  branchCount: number;
  scannedOrderCount: number;
  findingCount: number;
  severityCounts: Record<PurchaseIntegritySeverity, number>;
  codeCounts: Partial<Record<PurchaseIntegrityCode, number>>;
  truncatedBranchIds: number[];
}

let task: ScheduledTask | null = null;
let running = false;

function maxOrdersPerBranch(): number {
  const raw = Number(process.env.PURCHASE_INTEGRITY_MONITOR_MAX_ORDERS);
  return Number.isSafeInteger(raw) && raw >= PAGE_SIZE
    ? raw
    : DEFAULT_MAX_ORDERS_PER_BRANCH;
}

/**
 * دورة مراقبة واحدة، قراءة فقط. تُصدّر للاختبار والتشغيل التشخيصي، ولا تخزن نتيجةً
 * في جداول الأعمال ولا تنشئ سنداً أو قيداً.
 */
export async function runPurchaseIntegrityMonitorOnce(): Promise<PurchaseIntegrityMonitorSummary> {
  const db = getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لمراقب سلامة المشتريات");

  const branchRows = await db
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.isActive, true))
    .orderBy(asc(branches.id));
  const severityCounts: Record<PurchaseIntegritySeverity, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    INFO: 0,
  };
  const codeCounts: Partial<Record<PurchaseIntegrityCode, number>> = {};
  const truncatedBranchIds: number[] = [];
  let scannedOrderCount = 0;
  let findingCount = 0;
  const branchLimit = maxOrdersPerBranch();

  for (const row of branchRows) {
    const branchId = Number(row.id);
    let offset = 0;
    while (offset < branchLimit) {
      const report = await getPurchaseIntegrityReport({
        branchId,
        limit: PAGE_SIZE,
        offset,
      });
      scannedOrderCount += report.page.scannedOrderCount;
      findingCount += report.summary.findingCount;
      for (const severity of ["CRITICAL", "HIGH", "MEDIUM", "INFO"] as const) {
        severityCounts[severity] += report.summary.severityCounts[severity];
      }
      for (const [code, count] of Object.entries(report.summary.codeCounts)) {
        const typedCode = code as PurchaseIntegrityCode;
        codeCounts[typedCode] = (codeCounts[typedCode] ?? 0) + Number(count);
      }
      if (!report.page.hasMore) break;
      offset = report.page.nextOffset ?? offset + report.page.scannedOrderCount;
    }
    if (offset >= branchLimit) truncatedBranchIds.push(branchId);
  }

  return {
    generatedAt: new Date().toISOString(),
    branchCount: branchRows.length,
    scannedOrderCount,
    findingCount,
    severityCounts,
    codeCounts,
    truncatedBranchIds,
  };
}

export function startPurchaseIntegrityMonitor(): void {
  if (process.env.NODE_ENV === "test") return;
  stopPurchaseIntegrityMonitor();
  const cronExpression =
    process.env.PURCHASE_INTEGRITY_MONITOR_CRON || DEFAULT_CRON;
  if (!cron.validate(cronExpression)) {
    logger.error(
      { cronExpression },
      "[purchase-integrity] cron expression is invalid; monitor disabled",
    );
    return;
  }
  task = cron.schedule(
    cronExpression,
    async () => {
      if (running) return;
      running = true;
      try {
        const summary = await runPurchaseIntegrityMonitorOnce();
        const hasMaterialFinding =
          summary.severityCounts.CRITICAL > 0 ||
          summary.severityCounts.HIGH > 0;
        const write = hasMaterialFinding
          ? logger.warn.bind(logger)
          : logger.info.bind(logger);
        write(summary, "[purchase-integrity] daily read-only scan completed");
      } catch (error) {
        logger.error({ err: error }, "[purchase-integrity] daily scan failed");
      } finally {
        running = false;
      }
    },
    { timezone: "UTC" },
  );
  logger.info(
    { cronExpression },
    "[purchase-integrity] daily read-only monitor started",
  );
}

export function stopPurchaseIntegrityMonitor(): void {
  task?.stop();
  task = null;
}
