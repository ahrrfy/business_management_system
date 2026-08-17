import cron, { type ScheduledTask } from "node-cron";
import { isMultiTenantModeActive } from "../db";
import { logger } from "../logger";
import { isImageStoreOperational } from "../lib/imageStore";
import { getCurrentCompanyId } from "../tenancy/context";
import { runAcrossActiveTenants } from "../tenancy/backgroundTenants";
import { cleanupStudioStaging } from "./productStudioService";

const SWEEP_BATCH = 25;

/** دورة صغيرة محدودة لكل شركة؛ الدورات اللاحقة تواصل التفريغ بلا ضغط مفاجئ على R2 أو MySQL. */
export async function sweepProductStudioStagingOnce(): Promise<number> {
  if (!isImageStoreOperational()) {
    logger.warn("productStudio.staging.disabled: R2 image store is not configured");
    return 0;
  }
  if (isMultiTenantModeActive() && getCurrentCompanyId() == null) {
    const runs = await runAcrossActiveTenants("product_studio_staging", sweepProductStudioStagingOnce);
    return runs.reduce((sum, removed) => sum + removed, 0);
  }
  return cleanupStudioStaging(SWEEP_BATCH);
}

let task: ScheduledTask | null = null;
let running = false;

export function startProductStudioStagingWorker(): void {
  if (process.env.NODE_ENV === "test") return;
  task?.stop();
  void sweepProductStudioStagingOnce()
    .then((removed) => removed > 0 && logger.info({ removed }, "productStudio.staging.swept"))
    .catch((error) => logger.warn({ err: error }, "productStudio.staging.startup_sweep_failed"));
  task = cron.schedule("17 */6 * * *", async () => {
    if (running) return;
    running = true;
    try {
      const removed = await sweepProductStudioStagingOnce();
      if (removed > 0) logger.info({ removed }, "productStudio.staging.swept");
    } catch (error) {
      logger.warn({ err: error }, "productStudio.staging.sweep_failed");
    } finally {
      running = false;
    }
  }, { timezone: "UTC" });
}

export function stopProductStudioStagingWorker(): void {
  task?.stop();
  task = null;
}
