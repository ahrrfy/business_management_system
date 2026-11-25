import { AsyncLocalStorage } from "node:async_hooks";
import { runtimeWorkDrain } from "./workDrain";
import { logAudit } from "../services/auditService";

const backgroundOperationScope = new AsyncLocalStorage<ReadonlySet<string>>();

/** يمنع الاستدعاء الذاتي عند إدخال الدالة المصدّرة نفسها إلى مشغّل الوظائف الخلفية. */
export function isBackgroundOperationActive(job: string): boolean {
  return backgroundOperationScope.getStore()?.has(job) === true;
}

function runInBackgroundOperationScope<T>(
  job: string,
  operation: () => Promise<T>,
): Promise<T> {
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
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + backgroundOperationEffectCount(item), 0);
  }
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
 * يشغّل دورة عامل خلفي داخل بوابة التفريغ الرشيق (`runtimeWorkDrain`) مع تسجيل أثر التدقيق
 * المركزي `system.job.<job>`. يُعيد `[result]` عند التنفيذ و`[]` عند رفض بدء دورة جديدة أثناء الإغلاق.
 */
export async function runBackgroundJob<T>(
  job: string,
  operation: () => Promise<T>,
): Promise<T[]> {
  if (!runtimeWorkDrain.isAccepting && !runtimeWorkDrain.hasActiveParent) return [];
  return runtimeWorkDrain.run(async () => {
    try {
      const result = await runInBackgroundOperationScope(job, operation);
      await auditBackgroundResult(job, result);
      return [result];
    } catch (error) {
      await auditBackgroundFailure(job);
      throw error;
    }
  });
}
