import cron, { type ScheduledTask } from "node-cron";
import { isMultiTenantModeActive } from "../db";
import { logger } from "../logger";
import { runAcrossActiveTenants } from "../tenancy/backgroundTenants";
import { getCurrentCompanyId } from "../tenancy/context";
import {
  sendStudioDueNotifications,
  type ProductStudioActor,
} from "./productStudioService";

export const PRODUCT_STUDIO_NOTIFICATION_CRON = "*/5 * * * *";

const SYSTEM_ACTOR: ProductStudioActor = {
  userId: 0,
  branchId: null,
  role: "admin",
  isOwner: true,
};

export async function sweepProductStudioNotificationsOnce(
  now = new Date(),
): Promise<{ createdCount: number }> {
  if (isMultiTenantModeActive() && getCurrentCompanyId() == null) {
    const results: Array<{ createdCount: number }> = await runAcrossActiveTenants(
      "product_studio_due_notifications",
      () => sweepProductStudioNotificationsOnce(now),
    );
    return {
      createdCount: results.reduce(
        (sum, result) => sum + result.createdCount,
        0,
      ),
    };
  }
  return sendStudioDueNotifications(SYSTEM_ACTOR, now, 24);
}

let task: ScheduledTask | null = null;
let running = false;

export function startProductStudioNotificationWorker(): void {
  if (process.env.NODE_ENV === "test") return;
  task?.stop();
  void sweepProductStudioNotificationsOnce().catch((error: unknown) =>
    logger.warn(
      { err: error },
      "productStudio.notifications.startup_sweep_failed",
    ),
  );
  task = cron.schedule(
    PRODUCT_STUDIO_NOTIFICATION_CRON,
    async () => {
      if (running) return;
      running = true;
      try {
        const result = await sweepProductStudioNotificationsOnce();
        if (result.createdCount > 0) {
          logger.info(
            { createdCount: result.createdCount },
            "productStudio.notifications.sent",
          );
        }
      } catch (error) {
        logger.warn(
          { err: error },
          "productStudio.notifications.sweep_failed",
        );
      } finally {
        running = false;
      }
    },
    { timezone: "UTC" },
  );
}

export function stopProductStudioNotificationWorker(): void {
  task?.stop();
  task = null;
}
