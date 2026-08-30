// الكنّاس الدوريّ للطرود الجامدة — القناة الرابعة للحقيقة حين تصمت الثلاث.
//
// السياق (٢٢/٨): ٧٩/٨٤ طرداً «مُسنَداً» بلا أيّ حدثٍ ٩-١٣ يوماً، لأنّ تقدّم `parcelStatus`
// كان حكراً على بوّابة مندوبٍ لا تملكها أغلبُ الجهات — والصمتُ لا يُنتج إشعاراً بطبيعته.
// الكنّاس يقلب المعادلة: **غيابُ الأحداث نفسُه حدثٌ** (`STALE_ESCALATED`) يُكتب في
// `deliveryEvents` فيتدفّق عبر outbox الإشعاريّ القائم إلى مديري الفرع — بلا قناةِ إشعارٍ
// ثانية تنجرف عن الأولى.
//
// ⚠️ ليس ماسحَ تصحيح: لا يُغيّر `parcelStatus` ولا يمسّ مالاً — التصعيد إعلامٌ، والحسم قرارُ
// موظّفٍ (كشف شركة، إرجاع، إعادة إسناد) من شاشة «قيد التوصيل».
import { and, eq, sql } from "drizzle-orm";
import { DELIVERY_AGE_ESCALATE_HOURS } from "@shared/deliveryAging";
import { isDupEntry } from "@shared/errorMap.ar";
import { deliveryConsignments } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { logger } from "../../logger";
import { isBackgroundOperationActive, runAcrossActiveTenants } from "../../tenancy/backgroundTenants";
import { withTx } from "../tx";
import { appendDeliveryEvent } from "./lifecycle";

export const STALE_ESCALATED_EVENT = "STALE_ESCALATED";

/** سقف الدفعة الواحدة — الكنّاس يعود كلّ ساعة، والباقي يلحق في الدورة التالية. */
const SWEEP_BATCH_LIMIT = 200;

export interface StaleSweepResult {
  /** عدد الإرساليات التي كُتب لها حدث تصعيدٍ في هذه الدورة. */
  escalated: number;
  /** عدد المرشّحات التي وجدنا مفتاح يومها مكتوباً سلفاً (سباق عاملَين) — صفرٌ في التشغيل العاديّ. */
  skippedDuplicates: number;
}

/**
 * يلتقط الإرساليات الحيّة المتجاوزة عتبة التصعيد **بلا أيّ حدثٍ** أحدث من العتبة، ويكتب لكلٍّ
 * منها `STALE_ESCALATED` بمفتاحٍ يوميّ idempotent: `CN:{id}:STALE:{yyyy-mm-dd}` (يوم UTC).
 *
 * المعاملات صريحة كي تبقى الدالّة قابلةً للاستدعاء المباشر (اختبار/تشخيص) بلا cron:
 * `now` مرساةُ الزمن و`escalateHours` العتبة — الافتراضان هما سلوك الإنتاج.
 */
export async function sweepStaleConsignments(
  opts: { now?: Date; escalateHours?: number } = {},
): Promise<StaleSweepResult> {
  // نفس تعميم sweepDeliveryOutboxOnce متعدّد الشركات: الاستدعاء بلا سياق شركةٍ يمسح الجميع.
  if (!isBackgroundOperationActive("delivery_stale_sweep")) {
    const runs = await runAcrossActiveTenants("delivery_stale_sweep", () => sweepStaleConsignments(opts));
    return {
      escalated: runs.reduce((s, r) => s + r.escalated, 0),
      skippedDuplicates: runs.reduce((s, r) => s + r.skippedDuplicates, 0),
    };
  }
  const db = getDb();
  if (!db) return { escalated: 0, skippedDuplicates: 0 };

  const now = opts.now ?? new Date();
  const escalateHours = opts.escalateHours ?? DELIVERY_AGE_ESCALATE_HOURS;
  const cutoff = new Date(now.getTime() - escalateHours * 3_600_000);
  const utcDay = now.toISOString().slice(0, 10);

  // «جامد» = حيّ + أُرسل قبل العتبة + لا حدث **حقيقيّ** بعدها. تصعيدُ الأمس مُستثنى من فحص
  // الحداثة عمداً: لولا ذلك لكتم كلُّ تصعيدٍ ما بعده ٧٢ ساعةً فصار التذكير كلّ ثلاثة أيام —
  // والمطلوب يوميّ (مفتاح اليوم هو الضابط). وفحص مفتاح اليوم داخل الاستعلام نفسه يجعل
  // الدورات الساعيّة المتكرّرة في اليوم الواحد صفريّةَ الأثر لا سيلَ ER_DUP_ENTRY.
  const candidates = await db
    .select({
      id: deliveryConsignments.id,
      parcelStatus: deliveryConsignments.parcelStatus,
      moneyStatus: deliveryConsignments.moneyStatus,
      dispatchedAt: deliveryConsignments.dispatchedAt,
    })
    .from(deliveryConsignments)
    .where(and(
      eq(deliveryConsignments.status, "DISPATCHED"),
      sql`${deliveryConsignments.dispatchedAt} <= ${cutoff}`,
      sql`NOT EXISTS (
        SELECT 1 FROM deliveryEvents de
        WHERE de.consignmentId = ${deliveryConsignments.id}
          AND de.eventType <> ${STALE_ESCALATED_EVENT}
          AND de.occurredAt > ${cutoff}
      )`,
      sql`NOT EXISTS (
        SELECT 1 FROM deliveryEvents dd
        WHERE dd.eventKey = CONCAT('CN:', ${deliveryConsignments.id}, ':STALE:', ${utcDay})
      )`,
    ))
    .limit(SWEEP_BATCH_LIMIT);

  let escalated = 0;
  let skippedDuplicates = 0;
  for (const cn of candidates) {
    try {
      // معاملة لكل إرسالية: تعثّرُ واحدةٍ (سباق مفتاح) لا يُسقط تصعيد البقيّة.
      await withTx(async (tx) => {
        await appendDeliveryEvent(tx, {
          eventKey: `CN:${cn.id}:STALE:${utcDay}`,
          consignmentId: Number(cn.id),
          eventType: STALE_ESCALATED_EVENT,
          // لا انتقالَ حالة — التصعيد شاهدُ جمودٍ لا حركة؛ من/إلى تبقى فارغة عمداً.
          actorUserId: null,
          payload: {
            // مصدر السلطة: ماسحُ النظام الدوريّ لا فعلُ مستخدم — يُقرأ في سجلّ الأحداث والتدقيق.
            authority: "SYSTEM_STALE_SWEEP",
            thresholdHours: escalateHours,
            dispatchedAt: cn.dispatchedAt instanceof Date ? cn.dispatchedAt.toISOString() : String(cn.dispatchedAt),
            parcelStatus: cn.parcelStatus,
            moneyStatus: cn.moneyStatus,
          },
        });
      });
      escalated += 1;
    } catch (error) {
      if (isDupEntry(error)) {
        // عاملان تسابقا على نفس اليوم — المفتاح الفريد حسم، والنتيجة المطلوبة (حدثٌ واحد) قائمة.
        skippedDuplicates += 1;
        continue;
      }
      logger.error({ err: error, consignmentId: cn.id }, "delivery stale sweep escalation failed");
    }
  }
  if (escalated > 0) {
    logger.info({ escalated, skippedDuplicates, escalateHours }, "delivery stale sweep escalated consignments");
  }
  return { escalated, skippedDuplicates };
}
