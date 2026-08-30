import cron, { type ScheduledTask } from "node-cron";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { onlineOrders } from "../../drizzle/schema";
import { extractAffectedRows } from "../lib/insertId";
import { logger } from "../logger";
import { isBackgroundOperationActive, runAcrossActiveTenants } from "../tenancy/backgroundTenants";
import { withTx } from "./tx";

const DEFAULT_BATCH = 200;
const EXPIRED_REASON = "انتهت مهلة حجز المخزون (24 ساعة) قبل تأكيد الطلب";

/** دورة واحدة محدودة؛ القفل + UPDATE الشرطي يجعلانها idempotent حتى عند إعادة المحاولة. */
export async function sweepExpiredOnlineOrdersOnce(
  now?: Date,
  limit = DEFAULT_BATCH,
): Promise<{ cancelled: number }> {
  if (!isBackgroundOperationActive("online_order_reservation_expiry")) {
    const runs = await runAcrossActiveTenants(
      "online_order_reservation_expiry",
      () => sweepExpiredOnlineOrdersOnce(now, limit),
    );
    return { cancelled: runs.reduce((sum, run) => sum + run.cancelled, 0) };
  }
  const batch = Math.min(Math.max(Math.trunc(limit), 1), 1_000);
  return withTx(async (tx) => {
    // الإنتاج يستعمل ساعة MySQL نفسها التي كوّنت اللقطة؛ حقن now محصور بالاختبار الحتمي.
    const dueCondition = now
      ? sql`COALESCE(\`onlineOrders\`.\`reservationExpiresAt\`, DATE_ADD(\`onlineOrders\`.\`orderDate\`, INTERVAL 24 HOUR)) <= ${now}`
      : sql`COALESCE(\`onlineOrders\`.\`reservationExpiresAt\`, DATE_ADD(\`onlineOrders\`.\`orderDate\`, INTERVAL 24 HOUR)) <= CURRENT_TIMESTAMP(3)`;
    const due = await tx
      .select({ id: onlineOrders.id })
      .from(onlineOrders)
      .where(and(eq(onlineOrders.status, "PENDING"), dueCondition))
      .orderBy(
        asc(sql`COALESCE(\`onlineOrders\`.\`reservationExpiresAt\`, DATE_ADD(\`onlineOrders\`.\`orderDate\`, INTERVAL 24 HOUR))`),
        asc(onlineOrders.id),
      )
      .limit(batch)
      .for("update");
    const ids = due.map((row) => Number(row.id));
    if (!ids.length) return { cancelled: 0 };
    const updated = await tx
      .update(onlineOrders)
      .set({ status: "CANCELLED", cancelReason: EXPIRED_REASON })
      .where(
        and(
          inArray(onlineOrders.id, ids),
          eq(onlineOrders.status, "PENDING"),
          dueCondition,
        ),
      );
    return { cancelled: extractAffectedRows(updated) };
  });
}

let task: ScheduledTask | null = null;
let running = false;

/** العامل الخلفي 0 وحده يستدعيها من index.ts؛ كل خمس دقائق تكفي لدقة الحالة المرئية. */
export function startOnlineOrderExpirySweeper(): void {
  if (process.env.NODE_ENV === "test") return;
  stopOnlineOrderExpirySweeper();
  void sweepExpiredOnlineOrdersOnce()
    .then(
      ({ cancelled }) =>
        cancelled > 0 &&
        logger.info({ cancelled }, "storefront.order_expiry.swept"),
    )
    .catch((error) =>
      logger.error({ err: error }, "storefront.order_expiry.startup_failed"),
    );
  task = cron.schedule(
    // إزاحة طور (فحص الحمل ٣١/٨/٢٦): الثانية ٥٥ — تباعدٌ عن إشعارات الاستوديو (١٥) وانتهاء الحجوزات (٣٥).
    "55 */5 * * * *",
    async () => {
      if (running) return;
      running = true;
      try {
        const { cancelled } = await sweepExpiredOnlineOrdersOnce();
        if (cancelled > 0)
          logger.info({ cancelled }, "storefront.order_expiry.swept");
      } catch (error) {
        logger.error({ err: error }, "storefront.order_expiry.failed");
      } finally {
        running = false;
      }
    },
    { timezone: "UTC" },
  );
}

export function stopOnlineOrderExpirySweeper(): void {
  task?.stop();
  task = null;
}
