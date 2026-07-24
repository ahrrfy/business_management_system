/**
 * تقطير البث التسويقي عبر الكنّاس (S5، T5.2) — يستهلك `waBroadcasts.broadcastStatus='RUNNING'`
 * (أنتجتها T5.1: `launchBroadcast`/`approveBroadcast`) فيُدرج مستلميها كسولاً ويُغذّي `waOutbox`
 * بسرعة مقنَّنة (`throttlePerMinute`)، مع قاطع جودة يوقف الحملة تلقائياً عند تصاعد الفشل.
 *
 * **🔴 القاعدة الذهبية (قرار امتثال ملزم — سياسة Meta + خطر حظر الحساب):** الإدراج الفعلي لمستلمي
 * أي حملة يفرض `requireOptIn: true` **حتماً** عبر `resolveSegmentList`، بغضّ النظر عمّا اختاره منشئ
 * الحملة في `segmentJson` (الذي قد يشمل `UNKNOWN` وقت المعاينة في T5.1 فقط — راجع تعليق رأس
 * `segmentService.ts`). الفرض هنا في الكود لا في خيار — `{ ...criteria, requireOptIn: true }` يطغى
 * دائماً على أي `requireOptIn: false` مخزَّن في اللقطة.
 *
 * **دورة التقطير لكل حملة RUNNING (تُستدعى من `outboxSweeper.sweepWaOutboxOnce` كل دقيقة):**
 *   ١) قاطع الجودة يُفحص أولاً بنتائج الدورات **السابقة** (لا معنى لفحصه بعد هذه الدورة مباشرة —
 *      الصفوف المُقطَّرة الآن تبقى QUEUED حتى الدورة التالية للكنّاس، فلا إشارة نجاح/فشل جديدة بعد).
 *      تجاوزٌ ⇒ `PAUSED` فوراً وتخطّي بقية الخطوات لهذه الحملة هذه الدورة.
 *   ٢) الإدراج الكسول: أول دورة تقطير لكل حملة تُدرج **كل** المستلمين المؤهّلين دفعة واحدة (PENDING)
 *      — idempotent عبر `uq_wa_broadcast_recipient` (`onDuplicateKeyUpdate` no-op = تجاهل تكرار).
 *   ٣) التقطير المقنَّن: تلتقط حتى `throttlePerMinute` صفاً PENDING (`FOR UPDATE SKIP LOCKED`)، ولكلٍّ
 *      **إعادة فحص opt-out** (القاعدة الذهبية تسري عند كل مرحلة لا الإدراج فقط — عميل صار OPTED_OUT
 *      بعد إدراج صفّه PENDING ⇒ `SKIPPED_OPTOUT` ولا يُرسَل أبداً) ثم `enqueueOutbox` بـ`campaignId`.
 *   ٤) الإكمال: لا PENDING متبقٍّ ⇒ `COMPLETED`.
 *
 * **ربط حالات التسليم (مصدر منطق واحد — T5.2 hotfix):** `syncBroadcastRecipientFromOutbox` تعيش
 * فعلياً في `outboxService.ts` (يُعاد تصديرها هنا لأن `webhookProcessor.ts` وbarrel `index.ts`
 * يستوردانها من هذا الملف تاريخياً) وتُستدعى من مكانين: (أ) `webhookProcessor.processStatuses` —
 * تحديث `waOutbox` غير المتزامن من webhook Meta (رسائل الحملات لا تُنشئ صفّ `conversationMessages`،
 * فتحديث حالتها لا يمرّ من هناك)؛ (ب) `outboxService.finalizeSendSuccess`/`applyFailure` — تحديث
 * `waOutbox` **المتزامن** على استجابة Graph POST نفسها مباشرة (كان هذا المسار **مفقوداً بالكامل**
 * قبل T5.2 hotfix: أكواد حدود المعدّل/الجودة الحرجة من Meta — 131048/131056/130429 — تصل غالباً
 * متزامنةً على استجابة POST لا عبر webhook لاحق فقط كما ظُنّ سابقاً؛ بدون (ب) كان صفّ
 * `waBroadcastRecipients` يبقى `QUEUED` للأبد رغم فشل الإرسال الفعلي، فلا يراه `checkCircuitBreaker`
 * أدناه أبداً — القاطع كان معطَّلاً فعلياً أمام أشيَع أسباب فشل البثّ التسويقي تحديداً).
 */
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  channelIntegrations,
  customers,
  waBroadcastRecipients,
  waBroadcasts,
  waTemplates,
  type WaBroadcast,
} from "../../../drizzle/schema";
import { logger } from "../../logger";
import { requireDb, withTx } from "../tx";
import { getWaHubSettings } from "./flowNotify";
import { enqueueOutbox, getActiveWaIntegration } from "./outboxService";
import { resolveSegmentList, type SegmentCriteria } from "./segmentService";

// ── حلّ فرع الإرسال (waOutbox.branchId إلزاميّ NOT NULL) ────────────────────────────────────────

/** بثّ لفرعٍ محدَّد ⇒ يُرسَل منه — `dripOneBroadcast` يتحقّق **مسبقاً** (قبل استدعاء هذه الدالة) أن
 *  لهذا الفرع تحديداً تكاملاً ACTIVE (`getActiveWaIntegration`، T5.2 hotfix — راجع تعليقها هناك)
 *  فيُوقِف الحملة PAUSED بسببٍ واضح لو لا؛ فحين تُستدعى هذه الدالة بـ`broadcastBranchId` غير null فهو
 *  مضمونٌ سلفاً أن له تكاملاً نشطاً. بثّ عامّ (`branchId=null`، كل الفروع) ⇒ لا معنى فرعيّ للإرسال
 *  فعلياً (رقم واتساب واحد فعلياً على الأغلب) — يُحَلّ إلى أوّل تكامل واتساب ACTIVE (نفس الحارس الذي
 *  يمنع الكنّاس من العمل أصلاً بلا تكامل — `hasAnyActiveWaIntegration`). لا تكامل نشط إطلاقاً ⇒
 *  `null` (المستدعي يتخطّى تقطير هذه الحملة هذه الدورة بأمان — لا رمي؛ حالة نادرة عملياً لأن
 *  `hasAnyActiveWaIntegration` في `outboxSweeper` تمنع الوصول لهنا أصلاً لو لا تكامل إطلاقاً). */
async function resolveSendingBranchId(broadcastBranchId: number | null): Promise<number | null> {
  if (broadcastBranchId != null) return broadcastBranchId;
  const row = (
    await requireDb()
      .select({ branchId: channelIntegrations.branchId })
      .from(channelIntegrations)
      .where(and(eq(channelIntegrations.channel, "WHATSAPP"), eq(channelIntegrations.status, "ACTIVE")))
      .orderBy(asc(channelIntegrations.id))
      .limit(1)
  )[0];
  return row ? Number(row.branchId) : null;
}

// ── الإدراج الكسول (مرّة واحدة لكل حملة) ────────────────────────────────────────────────────────

/** سقف مُوثَّق لإدراج مستلمي حملة واحدة **ذرّياً** (معاملة واحدة، صفّ الحملة نفسه مقفولاً طوال
 *  العملية). الكتالوج الفعلي ~١٤٥٣ عميلاً، والجمهور التسويقي المؤهَّل (OPTED_IN بعد فرض القاعدة
 *  الذهبية) مجموعة فرعية منه — أصغر بكثير من هذا الحدّ عملياً. تجاوزه لا يُقتطَع صامتاً: يُسجَّل
 *  خطأً صريحاً (`logger.error`) ويُقتطع الجمهور إلى الحدّ (بدل إدراج آلاف الصفوف في عبارة واحدة أو
 *  الفشل الصامت) — راجع اللوق عند حدوثه ووسّع الحدّ بقرارٍ صريح لو لزم فعلاً. */
const MAX_BROADCAST_RECIPIENTS = 10_000;

/**
 * لا أثر لو سبق إدراج أي صفّ لهذه الحملة (فحص وجود بسيط — لا حاجة لعلَم إضافي: حملة بجمهور صفريّ
 * حقيقي تبقى بلا صفوف للأبد، و`maybeCompleteBroadcast` يتعامل معها بإكمالٍ فوريّ بلا حاجة لتمييزها
 * عن «لم تُدرَج بعد» — النتيجة العملية متطابقة: صفر PENDING).
 *
 * **ذرّية الإدراج (T5.2 hotfix):** الفحص («هل يوجد صفّ؟») والإدراج الكامل يجريان الآن داخل
 * **معاملة واحدة** (لا دفعات 500 عبر معاملات منفصلة كما كان سابقاً) مع قفل صفّ الحملة نفسه
 * (`FOR UPDATE`) طوال العملية — انهيارٌ في منتصف الإدراج القديم كان يترك جمهوراً جزئياً **دائماً**
 * (المحاولة التالية تجد صفوفاً موجودة فتتخطّى الإدراج بالكامل ⇒ `COMPLETED` بعدد أصغر بصمت). معاملة
 * واحدة ذرّية تعني: إمّا كل الجمهور المؤهَّل يُدرَج، أو لا شيء (rollback كامل) فتُعاد المحاولة كاملةً
 * في الدورة التالية — لا حالة وسيطة دائمة ممكنة.
 */
async function ensureRecipientsSeeded(broadcast: WaBroadcast): Promise<void> {
  await withTx(async (tx) => {
    // قفل صفّ الحملة نفسها (لا صفوف waBroadcastRecipients — لا وجود لها بعد وقت الفحص) يمنع سباق
    // إدراج مزدوج لو استُدعيت الدالة لنفس الحملة من دورتَي كنّاس متداخلتين؛ ويضمن أن «هل يوجد صفّ؟»
    // والإدراج الكامل يريان لقطة بيانات واحدة متّسقة.
    const lockedBroadcast = (
      await tx.select({ id: waBroadcasts.id }).from(waBroadcasts).where(eq(waBroadcasts.id, broadcast.id)).for("update").limit(1)
    )[0];
    if (!lockedBroadcast) return; // حُذفت الحملة بين الفحص والقفل (سباق نادر جداً) — لا شيء لفعله.

    const already = (
      await tx.select({ id: waBroadcastRecipients.id }).from(waBroadcastRecipients).where(eq(waBroadcastRecipients.broadcastId, broadcast.id)).limit(1)
    )[0];
    if (already) return;

    // 🔴 القاعدة الذهبية: فرض requireOptIn=true حتماً — يطغى على أي قيمة مخزَّنة في segmentJson.
    const criteria: SegmentCriteria = { ...(broadcast.segmentJson as SegmentCriteria), requireOptIn: true };
    // نطلب حدّاً واحداً أكبر من MAX_BROADCAST_RECIPIENTS لنكتشف التجاوز فعلياً (لا اقتطاع صامت).
    let recipients = await resolveSegmentList(criteria, { limit: MAX_BROADCAST_RECIPIENTS + 1 }, tx);
    if (recipients.length === 0) return;
    if (recipients.length > MAX_BROADCAST_RECIPIENTS) {
      logger.error(
        { broadcastId: broadcast.id, resolvedCount: recipients.length, cap: MAX_BROADCAST_RECIPIENTS },
        "wa-broadcast: الجمهور المؤهَّل يتجاوز الحدّ الأقصى المدعوم للإدراج الذرّي — يُقتطَع إلى الحدّ (راجع الحملة يدوياً)",
      );
      recipients = recipients.slice(0, MAX_BROADCAST_RECIPIENTS);
    }

    const rows = recipients.map((r) => ({
      broadcastId: broadcast.id,
      customerId: r.customerId,
      phoneE164: r.phoneE164,
      recipientStatus: "PENDING" as const,
    }));
    await tx
      .insert(waBroadcastRecipients)
      .values(rows)
      // idempotent (uq_wa_broadcast_recipient) — تحديث no-op يحاكي INSERT IGNORE (نمط inventoryService.ts).
      .onDuplicateKeyUpdate({ set: { id: sql`${waBroadcastRecipients.id}` } });
  });
}

// ── بناء متغيّرات القالب من حقول العميل ─────────────────────────────────────────────────────────

interface CustomerFields {
  name: string;
  currentBalance: string;
  phone: string | null;
}

/** حقول مدعومة حالياً — مطابقة لمثال تعليق `waBroadcasts.varsMapJson` في المخطّط
 *  (`{"1":"name","2":"currentBalance",...}`). حقل غير معروف ⇒ سلسلة فارغة (لا رمي؛ توسيع الخريطة
 *  لاحقاً إن احتاجت حملات مستقبلية حقولاً أخرى — خارج نطاق هذا التكليف). */
const CUSTOMER_FIELD_RESOLVERS: Record<string, (c: CustomerFields) => string> = {
  name: (c) => c.name ?? "",
  currentBalance: (c) => c.currentBalance ?? "0",
  phone: (c) => c.phone ?? "",
  phoneE164: (c) => c.phone ?? "",
};

function buildBodyParams(varsMap: Record<string, string> | null | undefined, customer: CustomerFields | undefined): string[] {
  if (!varsMap || !customer) return [];
  const keys = Object.keys(varsMap)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  return keys.map((k) => {
    const field = varsMap[String(k)];
    const resolver = field ? CUSTOMER_FIELD_RESOLVERS[field] : undefined;
    return resolver ? resolver(customer) : "";
  });
}

// ── التقطير المقنَّن: التقاط دفعة + إعادة فحص opt-out + enqueue ─────────────────────────────────

async function throttleAndEnqueue(broadcast: WaBroadcast, sendingBranchId: number, templateName: string): Promise<void> {
  const throttle = Math.max(1, Number(broadcast.throttlePerMinute) || 10);
  await withTx(async (tx) => {
    const claimed = await tx
      .select({ id: waBroadcastRecipients.id, customerId: waBroadcastRecipients.customerId, phoneE164: waBroadcastRecipients.phoneE164 })
      .from(waBroadcastRecipients)
      .where(and(eq(waBroadcastRecipients.broadcastId, broadcast.id), eq(waBroadcastRecipients.recipientStatus, "PENDING")))
      .orderBy(asc(waBroadcastRecipients.id))
      .limit(throttle)
      .for("update", { skipLocked: true });
    if (claimed.length === 0) return;

    const customerIds = claimed.map((r) => (r.customerId != null ? Number(r.customerId) : null)).filter((id): id is number => id != null);
    const custRows = customerIds.length
      ? await tx
          .select({ id: customers.id, waConsent: customers.waConsent, name: customers.name, currentBalance: customers.currentBalance, phone: customers.phone })
          .from(customers)
          .where(inArray(customers.id, customerIds))
      : [];
    const custMap = new Map(custRows.map((c) => [Number(c.id), c]));

    for (const r of claimed) {
      const cust = r.customerId != null ? custMap.get(Number(r.customerId)) : undefined;
      // 🔴 القاعدة الذهبية عند كل مرحلة — لا الإدراج فقط: عميل صار OPTED_OUT (أو حُذف/لم يعُد
      // معروفاً) بعد إدراج صفّه PENDING يُستبعَد الآن حتماً — «انسحاب منتصف الحملة يُحترَم».
      if (!cust || cust.waConsent !== "OPTED_IN") {
        await tx.update(waBroadcastRecipients).set({ recipientStatus: "SKIPPED_OPTOUT" }).where(eq(waBroadcastRecipients.id, r.id));
        continue;
      }
      const bodyParams = buildBodyParams(broadcast.varsMapJson as Record<string, string> | null, {
        name: cust.name,
        currentBalance: cust.currentBalance,
        phone: cust.phone,
      });
      const { id: outboxId } = await enqueueOutbox(
        {
          dedupeKey: `BC:${broadcast.id}:${r.id}`,
          branchId: sendingBranchId,
          toPhoneE164: r.phoneE164,
          kind: "TEMPLATE",
          payloadJson: { bodyParams },
          templateName,
          templateLang: broadcast.templateLang,
          campaignId: broadcast.id,
        },
        tx,
      );
      await tx.update(waBroadcastRecipients).set({ recipientStatus: "QUEUED", outboxId }).where(eq(waBroadcastRecipients.id, r.id));
    }
  });
}

// ── الإكمال ──────────────────────────────────────────────────────────────────────────────────

async function maybeCompleteBroadcast(broadcastId: number): Promise<void> {
  await withTx(async (tx) => {
    const pending = await tx
      .select({ id: waBroadcastRecipients.id })
      .from(waBroadcastRecipients)
      .where(and(eq(waBroadcastRecipients.broadcastId, broadcastId), eq(waBroadcastRecipients.recipientStatus, "PENDING")))
      .limit(1);
    if (pending.length > 0) return;
    // إعادة فحص RUNNING تحت القفل — سباق نادر: أُوقفت/أُلغيت الحملة يدوياً بين خطوات هذه الدورة.
    const row = (await tx.select({ status: waBroadcasts.broadcastStatus }).from(waBroadcasts).where(eq(waBroadcasts.id, broadcastId)).for("update").limit(1))[0];
    if (!row || row.status !== "RUNNING") return;
    await tx.update(waBroadcasts).set({ broadcastStatus: "COMPLETED", completedAt: new Date() }).where(eq(waBroadcasts.id, broadcastId));
  });
}

// ── قاطع الجودة (circuit breaker) ────────────────────────────────────────────────────────────

const CIRCUIT_WINDOW = 50;
const CIRCUIT_FAILURE_RATE = 0.2; // > 20%
/** أكواد أخطاء Meta لحدود المعدّل/الجودة (الخطر ٥/٩ في وثيقة التصميم) — ظهور أيٍّ منها في آخر
 *  النافذة يوقف الحملة فوراً بصرف النظر عن نسبة الفشل الكلية. */
const PAUSEWORTHY_ERROR_CODES = new Set(["131048", "131056", "130429"]);

interface CircuitBreakerResult {
  shouldPause: boolean;
  reason: string | null;
}

/** يفحص آخر ~٥٠ مستلماً «مُرسَلاً فعلياً» (SENT/DELIVERED/READ/FAILED — يستبعد PENDING/QUEUED/
 *  SKIPPED_OPTOUT التي لم تُرسَل بعد ولا تحمل إشارة نجاح/فشل) لهذه الحملة تحديداً. */
async function checkCircuitBreaker(broadcastId: number): Promise<CircuitBreakerResult> {
  const recent = await requireDb()
    .select({ status: waBroadcastRecipients.recipientStatus, errorCode: waBroadcastRecipients.errorCode })
    .from(waBroadcastRecipients)
    .where(and(eq(waBroadcastRecipients.broadcastId, broadcastId), inArray(waBroadcastRecipients.recipientStatus, ["SENT", "DELIVERED", "READ", "FAILED"])))
    .orderBy(desc(waBroadcastRecipients.id))
    .limit(CIRCUIT_WINDOW);
  if (recent.length === 0) return { shouldPause: false, reason: null };

  const failed = recent.filter((r) => r.status === "FAILED");
  const failureRate = failed.length / recent.length;
  if (failureRate > CIRCUIT_FAILURE_RATE) {
    return {
      shouldPause: true,
      reason: `أُوقفت تلقائياً: تصاعد فشل الإرسال (${failed.length} من ${recent.length} من آخر الرسائل المُرسَلة).`,
    };
  }
  if (failed.some((r) => r.errorCode != null && PAUSEWORTHY_ERROR_CODES.has(r.errorCode))) {
    return { shouldPause: true, reason: "أُوقفت تلقائياً: حدّ معدّل/جودة الرسائل من واتساب (Meta) — استأنفها يدوياً بعد أن يهدأ المعدّل." };
  }
  return { shouldPause: false, reason: null };
}

/** يُوقِف حملة RUNNING بسبب مُعطى (قاطع الجودة أو فرع بلا تكامل — أي سببٍ يقتضي إيقافاً تلقائياً
 *  فورياً). تحت قفل `FOR UPDATE` على صفّ الحملة فيعيد فحص RUNNING قبل الكتابة — سباق نادر: أُوقفت/
 *  أُلغيت يدوياً بين خطوات هذه الدورة ⇒ `false` (لا تجاوز حالة يدوية بحالة تلقائية متأخّرة). */
async function pauseBroadcast(broadcastId: number, reason: string): Promise<boolean> {
  return withTx(async (tx) => {
    const row = (await tx.select({ status: waBroadcasts.broadcastStatus }).from(waBroadcasts).where(eq(waBroadcasts.id, broadcastId)).for("update").limit(1))[0];
    if (!row || row.status !== "RUNNING") return false;
    await tx.update(waBroadcasts).set({ broadcastStatus: "PAUSED", pausedReason: reason.slice(0, 200) }).where(eq(waBroadcasts.id, broadcastId));
    return true;
  });
}

// ── دورة تقطير حملة واحدة ────────────────────────────────────────────────────────────────────

async function dripOneBroadcast(broadcast: WaBroadcast): Promise<void> {
  const breaker = await checkCircuitBreaker(broadcast.id);
  if (breaker.shouldPause && breaker.reason) {
    const paused = await pauseBroadcast(broadcast.id, breaker.reason);
    if (paused) logger.warn({ broadcastId: broadcast.id, reason: breaker.reason }, "wa-broadcast: قاطع الجودة أوقف الحملة تلقائياً");
    return;
  }

  // فرع محدَّد (لا بثّ عامّ): تحقّق أن لفرع الحملة تحديداً تكاملاً WHATSAPP ACTIVE **قبل** أي
  // إدراج/تقطير (T5.2 hotfix). `hasAnyActiveWaIntegration` في outboxSweeper (بوّابة الدخول الحقيقية
  // لهذا الملف) عامّة عبر كل الفروع — قد تمرّ بفضل فرعٍ آخر تماماً بينما فرع هذه الحملة تحديداً بلا
  // تكامل، فكانت الحملة تُدرِج مستلمين وتُقطِّر رسائل إلى outbox تفشل واحدة تلو الأخرى عند الإرسال
  // الفعلي (`processClaimedRow` في outboxService: «لا تكامل واتساب نشطاً لهذا الفرع») — إدراج/تقطير
  // في فراغ. فحصٌ مبكر صريح هنا أوضح ويوفّر دورات كنّاس مهدورة.
  if (broadcast.branchId != null) {
    const branchIntegration = await getActiveWaIntegration(Number(broadcast.branchId));
    if (!branchIntegration) {
      const paused = await pauseBroadcast(broadcast.id, "لا تكامل واتساب نشط لفرع الحملة.");
      if (paused) {
        logger.warn({ broadcastId: broadcast.id, branchId: broadcast.branchId }, "wa-broadcast: أُوقفت — لا تكامل واتساب نشط لفرع الحملة");
      }
      return;
    }
  }

  await ensureRecipientsSeeded(broadcast);

  const sendingBranchId = await resolveSendingBranchId(broadcast.branchId == null ? null : Number(broadcast.branchId));
  if (sendingBranchId == null) {
    logger.warn({ broadcastId: broadcast.id }, "wa-broadcast: لا تكامل واتساب نشط لحلّ فرع الإرسال — تخطّي التقطير هذه الدورة");
  } else {
    const template = (await requireDb().select({ name: waTemplates.name }).from(waTemplates).where(eq(waTemplates.id, broadcast.templateId)).limit(1))[0];
    if (!template) {
      logger.error({ broadcastId: broadcast.id, templateId: broadcast.templateId }, "wa-broadcast: القالب المرتبط بالحملة لم يعُد موجوداً — تخطّي التقطير هذه الدورة");
    } else {
      await throttleAndEnqueue(broadcast, sendingBranchId, template.name);
    }
  }

  await maybeCompleteBroadcast(broadcast.id);
}

// ── نقطة الدخول العامة (تُستدعى من outboxSweeper.sweepWaOutboxOnce) ─────────────────────────────

export interface DripBroadcastsResult {
  processed: number;
}

/** تُقطِّر كل حملة `RUNNING` (وموعدها حان أو بلا موعد). لا ترمي أبداً على مستوى حملة واحدة — فشل
 *  معالجة حملة لا يوقف تقطير البقية (نفس بروتوكول الحلقة القائم في outboxSweeper/webhookProcessor).
 *  killSwitch عامّ ⇒ لا شيء (نفس بوّابة checkAutomationGate). */
export async function dripRunningBroadcasts(): Promise<DripBroadcastsResult> {
  const settings = await getWaHubSettings();
  if (settings.killSwitch) return { processed: 0 };

  const running = await requireDb()
    .select()
    .from(waBroadcasts)
    .where(and(eq(waBroadcasts.broadcastStatus, "RUNNING"), or(isNull(waBroadcasts.scheduledAt), lte(waBroadcasts.scheduledAt, sql`NOW()`))))
    .orderBy(asc(waBroadcasts.id));

  for (const broadcast of running) {
    try {
      await dripOneBroadcast(broadcast);
    } catch (e) {
      logger.error({ err: e, broadcastId: broadcast.id }, "wa-broadcast: dripOneBroadcast فشلت لحملة — تُجوهل وتُكمل بقية الحملات هذه النبضة");
    }
  }
  return { processed: running.length };
}

// ── ربط حالات التسليم بالمستلمين ─────────────────────────────────────────────────────────────

// `syncBroadcastRecipientFromOutbox` انتقلت فعلياً إلى outboxService.ts (T5.2 hotfix — راجع تعليق
// رأس الملف): مصدر منطقها الوحيد هناك الآن (يستدعيها outboxService داخلياً للمسار المتزامن على
// استجابة Graph POST، ومن هنا webhookProcessor.processStatuses للمسار غير المتزامن من webhook Meta).
// يُعاد تصديرها هنا فقط لأن webhookProcessor.ts وbarrel index.ts يستوردانها من هذا الملف تاريخياً —
// لا تُعِد تعريفها هنا (تكرار منطق يكسر «مصدر واحد»).
export { syncBroadcastRecipientFromOutbox } from "./outboxService";
export type { BroadcastDeliveryStatus } from "./outboxService";
