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
import { and, eq, inArray, sql } from "drizzle-orm";
import { DELIVERY_AGE_ESCALATE_HOURS } from "@shared/deliveryAging";
import { isDupEntry } from "@shared/errorMap.ar";
import { deliveryConsignments, deliveryEvents, deliveryParties, users } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { logger } from "../../logger";
import { rolloutMode } from "../../config/rolloutFlags";
import { isBackgroundOperationActive, runAcrossActiveTenants } from "../../tenancy/backgroundTenants";
import { createTask } from "../tasks/create";
import { withTx } from "../tx";
import { appendDeliveryEvent, assertParcelTransition, type ParcelStatus } from "./lifecycle";

export const STALE_ESCALATED_EVENT = "STALE_ESCALATED";
/** م١ (PR-4): وسمُ التعذّر الآليّ بانقضاء SLA — حدثٌ واحدٌ لكلّ طرد (مفتاحه `CN:{id}:AUTO_FAILED_SLA`). */
export const AUTO_FAILED_SLA_EVENT = "AUTO_FAILED_SLA";

/** سقف الدفعة الواحدة — الكنّاس يعود كلّ ساعة، والباقي يلحق في الدورة التالية. */
const SWEEP_BATCH_LIMIT = 200;
/**
 * م١ (PR-4، الخطّة §١١ خطر ١): سقفٌ يوميّ لوسم التعذّر الآليّ — أتمتةٌ تُخطئ مرّةً تُخطئ مئةً في
 * الليلة نفسها، فالسقفُ يجعل أسوأ يومٍ قابلاً للمراجعة يدوياً صباحاً. البيئة `DELIVERY_MAX_AUTO_FAILS_PER_DAY`
 * تغيّره، وغيابُها = الافتراض.
 */
export const MAX_AUTO_FAILS_PER_DAY_DEFAULT = 50;

export interface StaleSweepResult {
  /** عدد الإرساليات التي كُتب لها حدث تصعيدٍ في هذه الدورة. */
  escalated: number;
  /** عدد المرشّحات التي وجدنا مفتاح يومها مكتوباً سلفاً (سباق عاملَين) — صفرٌ في التشغيل العاديّ. */
  skippedDuplicates: number;
  /** م١ (PR-4): ما وُسم متعذّراً آلياً بانقضاء SLA في هذه الدورة (صفرٌ والعلَم مطفأ). */
  autoFailed: number;
}

export interface AutoFailSweepResult {
  failed: number;
  /** مرشّحاتٌ تُركت لأنّ السقف اليوميّ بلغ حدّه — تلحق غداً أو يحسمها الموظّف. */
  skippedByDailyCap: number;
  /** سباقُ عاملَين على الطرد نفسه (المفتاح الفريد حسم) — صفرٌ عادةً. */
  skippedDuplicates: number;
}

const AUTO_FAILABLE_PARCEL_STATUSES: ParcelStatus[] = ["ASSIGNED", "ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY"];

/**
 * السقفُ اليوميّ من البيئة أو الافتراض. ⚠️ `Number("")` يساوي صفراً لا NaN — فالمتغيّرُ الغائب أو
 * الفارغ كان يُقرأ «سقف = 0» ويُطفئ الأتمتة صامتاً بينما العلَم مفتوح (أمسكه `deliveryAutoFailSla`:
 * كلُّ مرشَّحٍ يعود `skippedByDailyCap`). الفارغُ = الافتراض، والصفرُ الصريح وحده يعني «لا وسمَ اليوم».
 */
export function dailyAutoFailCap(): number {
  const raw = process.env.DELIVERY_MAX_AUTO_FAILS_PER_DAY?.trim();
  if (!raw) return MAX_AUTO_FAILS_PER_DAY_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : MAX_AUTO_FAILS_PER_DAY_DEFAULT;
}

/**
 * **أتمتة ١ — تعذّرٌ بانقضاء SLA** (م١، PR-4؛ سجلّ الأتمتة `deliveryParcel:*->FAILED`).
 *
 * الدليل: طردٌ حيّ (`status='DISPATCHED'`) في حالةٍ فيزيائيّة مفتوحة، مضى على إسناده أكثر من
 * `deliveryParties.maxOpenParcelAgeDays` — **العمرُ بساعة القاعدة** (`TIMESTAMPDIFF(DAY, dispatchedAt, NOW())`،
 * نفسُ مسند حارس الإسناد `staleOpenParcelCondition`): ربطُ `now` من الخادم كان يقصّ يوماً كاملاً عند
 * أدنى انحرافٍ بين ساعتَي الخادم والقاعدة (TIMESTAMPDIFF يبتر)، **بلا أيّ قبض** (`collectedAmount = 0` ولا `COD_COLLECTED`
 * ولا `SHORTFALL_ASSIGNED` في الدفتر) ولا إعلانِ رجوع. هذا الطردُ لن يُغلقه أحد: الجهةُ صامتة والزبون
 * لم يدفع، فيُوسَم FAILED (نفس الانتقال الذي يُصرّح به `assertParcelTransition`) بحدث
 * `AUTO_FAILED_SLA` يحمل العمر والعتبة، وتُفتَح مهمّةُ متابعةٍ للمالك تحمل رقم الطرد.
 *
 * التراجع: إعادةُ الإسناد FAILED→ASSIGNED (`parties.reassignDeliveryConsignment`) أو الاسترجاع
 * FAILED→RETURNED — لا مالَ يتحرّك هنا فلا شيءَ يُعكَس.
 *
 * ⛔ خلف علَم `deliveryAutoFailSla` (الافتراض OFF) وسقفٍ يوميّ — أتمتةٌ تُعرَض وتُراقَب قبل أن تُعتمَد.
 */
export async function autoFailStaleParcels(
  opts: { /** مرساةُ **يوم السقف** (UTC) وحدها — العمرُ يُقاس بساعة القاعدة. */ now?: Date; maxPerDay?: number } = {},
): Promise<AutoFailSweepResult> {
  const zero: AutoFailSweepResult = { failed: 0, skippedByDailyCap: 0, skippedDuplicates: 0 };
  if (rolloutMode("deliveryAutoFailSla") !== "ON") return zero;
  const db = getDb();
  if (!db) return zero;
  const now = opts.now ?? new Date();
  const cap = opts.maxPerDay ?? dailyAutoFailCap();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const doneToday = (
    await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(deliveryEvents)
      .where(and(eq(deliveryEvents.eventType, AUTO_FAILED_SLA_EVENT), sql`${deliveryEvents.occurredAt} >= ${dayStart}`))
  )[0];
  const budget = Math.max(0, cap - Number(doneToday?.n ?? 0));

  const candidates = await db
    .select({
      id: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      branchId: deliveryConsignments.branchId,
      invoiceId: deliveryConsignments.invoiceId,
      partyId: deliveryConsignments.partyId,
      partyName: deliveryParties.name,
      parcelStatus: deliveryConsignments.parcelStatus,
      dispatchedAt: deliveryConsignments.dispatchedAt,
      thresholdDays: deliveryParties.maxOpenParcelAgeDays,
      ageDays: sql<number>`TIMESTAMPDIFF(DAY, ${deliveryConsignments.dispatchedAt}, NOW())`,
    })
    .from(deliveryConsignments)
    .innerJoin(deliveryParties, eq(deliveryParties.id, deliveryConsignments.partyId))
    .where(and(
      eq(deliveryConsignments.status, "DISPATCHED"),
      inArray(deliveryConsignments.parcelStatus, AUTO_FAILABLE_PARCEL_STATUSES),
      sql`${deliveryConsignments.returnDeclaredAt} IS NULL`,
      sql`CAST(${deliveryConsignments.collectedAmount} AS DECIMAL(15,2)) = 0`,
      sql`TIMESTAMPDIFF(DAY, ${deliveryConsignments.dispatchedAt}, NOW()) > ${deliveryParties.maxOpenParcelAgeDays}`,
      sql`NOT EXISTS (
        SELECT 1 FROM deliveryLedgerEntries dle
        WHERE dle.consignmentId = ${deliveryConsignments.id}
          AND dle.entryType IN ('COD_COLLECTED', 'SHORTFALL_ASSIGNED')
      )`,
      sql`NOT EXISTS (
        SELECT 1 FROM deliveryEvents de
        WHERE de.consignmentId = ${deliveryConsignments.id}
          AND de.eventType = ${AUTO_FAILED_SLA_EVENT}
      )`,
    ))
    .orderBy(deliveryConsignments.dispatchedAt)
    .limit(SWEEP_BATCH_LIMIT);

  // مهمّةُ المتابعة تُسنَد إلى المالك (يعبُر الفروع) إن وُجد حسابٌ فعّال — وإلّا تبقى بلا مُسنَد
  // إليه في طابور الفرع؛ الغيابُ لا يُسقط الوسم.
  const owner = (
    await db.select({ id: users.id }).from(users).where(and(eq(users.isOwner, true), eq(users.isActive, true))).limit(1)
  )[0];

  const result: AutoFailSweepResult = { failed: 0, skippedByDailyCap: 0, skippedDuplicates: 0 };
  for (const cn of candidates) {
    if (result.failed >= budget) {
      result.skippedByDailyCap += 1;
      continue;
    }
    try {
      await withTx(async (tx) => {
        const locked = (
          await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, Number(cn.id))).for("update").limit(1)
        )[0];
        if (!locked || locked.status !== "DISPATCHED" || !AUTO_FAILABLE_PARCEL_STATUSES.includes(locked.parcelStatus as ParcelStatus)) return;
        if (locked.returnDeclaredAt != null || Number(locked.collectedAmount ?? 0) !== 0) return;
        assertParcelTransition(locked.parcelStatus as ParcelStatus, "FAILED");
        const failedAt = new Date();
        const reason = `تجاوز مهلة التوصيل (${Number(cn.thresholdDays)} يوماً، عمر الطرد ${Number(cn.ageDays)} يوماً) بلا تسليم — وُسم متعذّراً آلياً`;
        await tx
          .update(deliveryConsignments)
          .set({ parcelStatus: "FAILED", failedAt, failureReason: reason.slice(0, 500) })
          .where(eq(deliveryConsignments.id, Number(cn.id)));
        await appendDeliveryEvent(tx, {
          eventKey: `CN:${cn.id}:${AUTO_FAILED_SLA_EVENT}`,
          consignmentId: Number(cn.id),
          eventType: AUTO_FAILED_SLA_EVENT,
          fromParcelStatus: locked.parcelStatus,
          toParcelStatus: "FAILED",
          actorUserId: null,
          payload: {
            authority: "SYSTEM_SLA_SWEEP",
            thresholdDays: Number(cn.thresholdDays),
            ageDays: Number(cn.ageDays),
            partyId: Number(cn.partyId),
            reason,
            rollback: "reassign FAILED->ASSIGNED من شاشة الإرساليات، أو الاسترجاع بعد استلام الطرد",
          },
        });
        await createTask(
          {
            branchId: Number(cn.branchId),
            kind: "FOLLOW_UP",
            priority: "HIGH",
            title: `طرد ${cn.consignmentNumber} تجاوز مهلة التوصيل — وُسم متعذّراً آلياً`,
            description: `الجهة «${cn.partyName}» لم تُثبت تسليمَ الطرد ${cn.consignmentNumber} خلال ${Number(cn.thresholdDays)} يوماً (عمره ${Number(cn.ageDays)} يوماً) ولم يُقبض منه شيء. القرار: أعد إسناده لجهةٍ أخرى، أو سجّل استلامه راجعاً، أو ألغِ الإسناد بسبب.`,
            linkedInvoiceId: Number(cn.invoiceId),
            sourceChannel: "OTHER",
            assignedTo: owner ? Number(owner.id) : null,
            creationNote: "أُنشئت تلقائياً من كنّاس SLA للطرود (AUTO_FAILED_SLA)",
          },
          { userId: null, branchId: Number(cn.branchId) },
          tx,
        );
        result.failed += 1;
      });
    } catch (error) {
      if (isDupEntry(error)) {
        result.skippedDuplicates += 1;
        continue;
      }
      logger.error({ err: error, consignmentId: cn.id }, "delivery auto-fail (SLA) failed");
    }
  }
  if (result.failed > 0 || result.skippedByDailyCap > 0) {
    logger.info({ ...result, cap }, "delivery stale sweep auto-failed parcels past SLA");
  }
  return result;
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
      autoFailed: runs.reduce((s, r) => s + r.autoFailed, 0),
    };
  }
  const db = getDb();
  if (!db) return { escalated: 0, skippedDuplicates: 0, autoFailed: 0 };

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
  // م١ (PR-4): بعد التصعيد الإعلاميّ، الوسمُ الآليّ لما تجاوز SLA بلا قبض — خلف علَمه وسقفه.
  const auto = await autoFailStaleParcels({ now });
  return { escalated, skippedDuplicates, autoFailed: auto.failed };
}
