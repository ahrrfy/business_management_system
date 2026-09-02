import { logger } from "../logger";
import {
  isBackgroundOperationActive,
  runAcrossActiveTenants,
} from "../tenancy/backgroundTenants";
import { reconcileAppNotificationOutbox } from "./appNotificationOutboxService";

const DEFAULT_INTERVAL_MS = 15_000;

export type AppNotificationOutboxRunResult = {
  createdCount: number;
  claimedCount: number;
  failedCount: number;
};

/** مصالحة عامة لكل نوايا الإشعارات؛ لا تعتمد دورة المهام على عامل ميزة أخرى. */
export async function runAppNotificationOutboxBatch(): Promise<AppNotificationOutboxRunResult> {
  if (!isBackgroundOperationActive("app_notification_outbox")) {
    const runs = await runAcrossActiveTenants(
      "app_notification_outbox",
      runAppNotificationOutboxBatch,
    );
    return runs.reduce<AppNotificationOutboxRunResult>(
      (sum, run) => ({
        createdCount: sum.createdCount + run.createdCount,
        claimedCount: sum.claimedCount + run.claimedCount,
        failedCount: sum.failedCount + run.failedCount,
      }),
      { createdCount: 0, claimedCount: 0, failedCount: 0 },
    );
  }
  return reconcileAppNotificationOutbox();
}

export interface AppNotificationOutboxWorkerRuntime {
  start(): boolean;
  stop(): Promise<void>;
}

export function createAppNotificationOutboxWorkerRuntime(options: {
  intervalMs: number;
  runBatch: () => Promise<unknown>;
  onError: (error: unknown) => void;
}): AppNotificationOutboxWorkerRuntime {
  const intervalMs = Math.max(1_000, Math.min(options.intervalMs, 60_000));
  let timer: NodeJS.Timeout | null = null;
  let activeTick: Promise<void> | null = null;
  let stopping = true;

  const runNow = async (): Promise<void> => {
    if (activeTick) return activeTick;
    if (stopping) return;
    const task = (async () => {
      try {
        await options.runBatch();
      } catch (error) {
        options.onError(error);
      }
    })();
    activeTick = task;
    try {
      await task;
    } finally {
      if (activeTick === task) activeTick = null;
    }
  };

  return {
    start() {
      if (timer || activeTick) return false;
      stopping = false;
      timer = setInterval(() => void runNow(), intervalMs);
      timer.unref();
      void runNow();
      return true;
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (activeTick) await activeTick;
    },
  };
}

let workerRuntime: AppNotificationOutboxWorkerRuntime | null = null;

export function startAppNotificationOutboxWorker(): boolean {
  if (process.env.NODE_ENV === "test" || workerRuntime) return false;
  const raw = Number(process.env.APP_NOTIFICATION_OUTBOX_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const intervalMs = Math.max(1_000, Math.min(Number.isFinite(raw) ? raw : DEFAULT_INTERVAL_MS, 60_000));
  const runtime = createAppNotificationOutboxWorkerRuntime({
    intervalMs,
    runBatch: async () => {
      const result = await runAppNotificationOutboxBatch();
      if (result.claimedCount > 0) {
        logger.info(result, "appNotificationOutbox: تمت مصالحة دفعة الإشعارات");
      }
    },
    onError: (error) => logger.error({ err: error }, "appNotificationOutbox: فشل تشغيل عامل المصالحة"),
  });
  if (!runtime.start()) return false;
  workerRuntime = runtime;
  return true;
}

export async function stopAppNotificationOutboxWorker(): Promise<void> {
  const runtime = workerRuntime;
  if (!runtime) return;
  await runtime.stop();
  if (workerRuntime === runtime) workerRuntime = null;
}
