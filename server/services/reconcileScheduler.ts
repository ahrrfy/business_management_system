/* ============================================================================
 * جدولةُ التحقّق النقديّ الليليّ (Nightly Reconcile Scheduler)
 *
 * **Tier-2 #3 (٢٥/٨):** كانت فحوصُ الاتّزان الخمسة في `reconcileService.ts`
 * (`reconcileCustomerBalances`، `reconcileSupplierBalances`، `reconcileDeliveryFloat`،
 * `reconcileInventory`، `reconcileLedgerProfit`) تُشغَّل يدوياً وحسب — من شاشة تقرير
 * الاتّزان أو من `getManagementAlerts`. الأثر: انحرافٌ يظهر بين تشغيلَين قد يمرّ يومٌ
 * كامل بلا اكتشاف. النمط هنا مطابقٌ لـ`purchaseIntegrityMonitor`: **قراءة فقط**، مرّةً
 * كل ليلة على عامل الخلفية الوحيد، تُصدر ملخّصاً في السجلّ (WARN إن وُجد انحراف، INFO إن لم
 * يوجد) — بلا كتابةٍ في جداول الأعمال ولا سنداتٍ ولا قيود.
 *
 * **قرارات محفوظة:**
 * - `DEFAULT_CRON = "10 2 * * *"` — ٠٢:١٠ UTC (بعد كنّاس المسوّدات ٠١:١٥ وسلامة المشتريات ٠١:٤٠).
 * - `RECONCILE_SCHEDULER_CRON` env override.
 * - قفلٌ داخليٌّ `running` يمنع تداخلَ دورتَين إن استغرقت الأولى وقتاً أطول من دوراتها.
 * - لا يعمل في `NODE_ENV=test` — الاختبار يستدعي `runReconcileScanOnce()` مباشرةً.
 * - المؤقّت `unref()` — لا يمنع خروج العملية إن كان الخادم يُغلَق.
 * ========================================================================== */
import cron, { type ScheduledTask } from "node-cron";
import { logger } from "../logger";
import { runAcrossActiveTenants } from "../tenancy/backgroundTenants";
import {
  getFinancialReconciliationDetails,
  toFinancialReconciliationSummary,
  type FinancialReconciliationSummary,
} from "./reports/reconcileSummary";

/** الجدول الافتراضي: ٠٢:١٠ UTC يومياً — بعد كنّاس المسوّدات (٠١:١٥) وسلامة المشتريات (٠١:٤٠). */
const DEFAULT_CRON = "10 2 * * *";

let task: ScheduledTask | null = null;
let running = false;

/**
 * دورةٌ واحدة، قراءة فقط. تُصدَّر للاختبار وللتشغيل التشخيصيّ من CLI.
 * لا تكتب في جداول الأعمال ولا تُحدث سنداً أو قيداً — تُعيد الملخّص وحسب.
 */
export async function runReconcileScanOnce(): Promise<FinancialReconciliationSummary> {
  const details = await getFinancialReconciliationDetails();
  return toFinancialReconciliationSummary(details);
}

export function startReconcileScheduler(): void {
  if (process.env.NODE_ENV === "test") return;
  stopReconcileScheduler();
  const cronExpression =
    process.env.RECONCILE_SCHEDULER_CRON || DEFAULT_CRON;
  if (!cron.validate(cronExpression)) {
    logger.error(
      { cronExpression },
      "[reconcile-scheduler] cron expression is invalid; scheduler disabled",
    );
    return;
  }
  task = cron.schedule(
    cronExpression,
    async () => {
      if (running) return;
      running = true;
      try {
        // Codex P1 (٢٥/٨): في وضع multi-tenancy، `getDb()` بلا ALS context يفشل — كل شركةٍ
        // تحتاج تشغيلاً مستقلاً داخل `runWithCompany`. `runAcrossActiveTenants` يُقصّر
        // على مسارٍ واحد في الوضع الأحادي (`isMultiTenantModeActive=false`) ⇒ لا انحدار.
        const summaries = await runAcrossActiveTenants(
          "reconcile_nightly_scan",
          () => runReconcileScanOnce(),
        );
        // WARN إن وُجد انحرافٌ ماليّ في أيّ شركة — يُلتقط في سجلّات pino/PM2 بمستوى تنبيه.
        // INFO إن كان الكلّ نظيفاً — يبقى أثرٌ يوميٌّ على العمل يُثبت أن الفحص جرى.
        const anyDrift = summaries.some((s) => !s.balanced);
        const write = anyDrift
          ? logger.warn.bind(logger)
          : logger.info.bind(logger);
        write(
          { summaries },
          anyDrift
            ? "[reconcile-scheduler] nightly scan surfaced drift"
            : "[reconcile-scheduler] nightly scan clean",
        );
      } catch (error) {
        logger.error({ err: error }, "[reconcile-scheduler] nightly scan failed");
      } finally {
        running = false;
      }
    },
    { timezone: "UTC" },
  );
  logger.info(
    { cronExpression },
    "[reconcile-scheduler] nightly read-only scheduler started",
  );
}

export function stopReconcileScheduler(): void {
  task?.stop();
  task = null;
}
