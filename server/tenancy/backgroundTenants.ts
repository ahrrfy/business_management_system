import { getCurrentCompanyId, runWithCompany } from "./context";
import { isMultiTenantModeActive, withTenantDb } from "../db";
import { logger } from "../logger";
import { listActiveCompanyConnections } from "./registry";
import { logAudit } from "../services/auditService";
import { AsyncLocalStorage } from "node:async_hooks";

const backgroundOperationScope = new AsyncLocalStorage<ReadonlySet<string>>();

/** يمنع الاستدعاء الذاتي عند إدخال الدالة المصدّرة نفسها إلى مشغّل الشركات. */
export function isBackgroundOperationActive(job: string): boolean {
  return backgroundOperationScope.getStore()?.has(job) === true;
}

function runInBackgroundOperationScope<T>(job: string, operation: () => Promise<T>): Promise<T> {
  const jobs = new Set(backgroundOperationScope.getStore() ?? []);
  jobs.add(job);
  return backgroundOperationScope.run(jobs, operation);
}

const EFFECT_KEYS = new Set([
  "affected",
  "cancelled",
  "claimed",
  "created",
  "createdCount",
  "dead",
  "deleted",
  "delivered",
  "dispatched",
  "escalated",
  "expired",
  "inserted",
  "notified",
  "processed",
  "removed",
  "retried",
  "revoked",
  "sent",
  "updated",
]);

/** يحوّل نتائج العمال المختلفة إلى رقم أثر واحد من دون حفظ تفاصيل قد تكون حساسة. */
export function backgroundOperationEffectCount(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + backgroundOperationEffectCount(item), 0);
  if (value === null || typeof value !== "object") return 0;
  let count = 0;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (EFFECT_KEYS.has(key) && typeof item === "number" && Number.isFinite(item) && item > 0) {
      count = Math.max(count, Math.trunc(item));
    }
  }
  return count;
}

async function auditBackgroundResult(job: string, result: unknown): Promise<void> {
  const effectCount = backgroundOperationEffectCount(result);
  if (effectCount <= 0) return;
  await logAudit(
    { user: null },
    {
      action: `system.job.${job}`.slice(0, 100),
      entityType: "systemJob",
      entityId: job.slice(0, 50),
      actor: { source: "system", label: "عامل النظام" },
      newValue: { effectCount },
    },
  );
}

async function auditBackgroundFailure(job: string): Promise<void> {
  await logAudit(
    { user: null },
    {
      action: `system.job.${job}`.slice(0, 100),
      entityType: "systemJob",
      entityId: job.slice(0, 50),
      actor: { source: "system", label: "عامل النظام" },
      outcome: "FAILURE",
    },
  );
}

/**
 * يشغّل دورة خلفية مرة لكل شركة فعّالة. التنفيذ تسلسلي عمداً كي لا تُفتح تجمعات كل
 * الشركات دفعة واحدة، ويحمل كل تشغيل lease وسياق ALS كاملين حتى نهايته.
 */
export async function runAcrossActiveTenants<T>(
  job: string,
  operation: () => Promise<T>,
): Promise<T[]> {
  if (!isMultiTenantModeActive() || getCurrentCompanyId() != null) {
    try {
      const result = await runInBackgroundOperationScope(job, operation);
      await auditBackgroundResult(job, result);
      return [result];
    } catch (error) {
      await auditBackgroundFailure(job);
      throw error;
    }
  }

  const companies = await listActiveCompanyConnections();
  const results: T[] = [];
  for (const company of companies) {
    try {
      const result = await withTenantDb(company.id, (db) =>
        runWithCompany(company.id, db, async () => {
          try {
            const value = await runInBackgroundOperationScope(job, operation);
            await auditBackgroundResult(job, value);
            return value;
          } catch (error) {
            await auditBackgroundFailure(job);
            throw error;
          }
        }),
      );
      results.push(result);
    } catch (error) {
      logger.error({ err: error, companyId: company.id, job }, "tenant.background_job.failed");
    }
  }
  return results;
}
