/**
 * الصندوق الصادر لواتساب (waOutbox) — مصدر الحقيقة الوحيد للإرسال. شريحة #١ (نواة Cloud API).
 * idempotent عبر dedupeKey + إعادة محاولة بتراجع أسّي (backoff) + فحص نافذة الردّ الحرّ ٢٤ ساعة قبل
 * SESSION_TEXT/MEDIA (القوالب معفاة).
 *
 * التزامن: الالتقاط (claim) يمرّ دائماً عبر SELECT...FOR UPDATE + تحديث الحالة إلى SENDING **داخل
 * نفس المعاملة** — يمنع محاولتين متزامنتين (dispatchOutboxRow المباشر + الكنّاس) من إرسال نفس
 * الصفّ مرّتين؛ idempotent بالبناء لا بالحظّ.
 *
 * قرار تصميمي (موثَّق كما يطلب التكليف — قسم ج): `addMessage` في conversationService لا تقبل tx
 * خارجية (تفتح withTx خاصة بها داخلياً) ⇒ لا يمكن استعمالها هنا مباشرة لأنّ نجاح الإرسال يشترط
 * معاملة واحدة تُحدّث outbox+conversationMessages معاً (تخفيف سباق «حالة webhook تصل قبل كتابة
 * الصفّ» — الخطر ١ في وثيقة التصميم). البديل: إدراج مباشر بنفس بنية `addMessage` (نفس الحقول ونفس
 * تحديث lastMessageAt/lastMessagePreview لاتجاه OUT، بلا لمس unreadCount الذي addMessage لا يزيده
 * أصلاً لـOUT) داخل withTx واحدة هنا (finalizeSendSuccess).
 *
 * **إصلاح قاطع جودة البث (T5.2 hotfix):** حالة `waOutbox` النهائية (SENT/FAILED) قد تُحسم هنا
 * **متزامنةً** على استجابة Graph POST نفسها (لا فقط لاحقاً عبر webhook) — أكواد حدود المعدّل/الجودة
 * الحرجة من Meta (131048/131056/130429) شائعة الوصول بهذا المسار المتزامن فعلياً. `finalizeSendSuccess`
 * و`applyFailure` أدناه يستدعيان `syncBroadcastRecipientFromOutbox` (**مصدر المنطق الوحيد** لتحديث
 * مستلم الحملة من outbox — يستدعيها أيضاً `webhookProcessor.processStatuses` للمسار غير المتزامن)
 * كلّما كان للصفّ `campaignId`؛ بدون هذا الاستدعاء يبقى صفّ `waBroadcastRecipients` QUEUED للأبد رغم
 * فشل الإرسال الفعلي، فلا يراه `checkCircuitBreaker` (broadcastDispatch.ts) أبداً.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { isDupEntry } from "@shared/errorMap.ar";
import {
  channelIntegrations,
  conversationMessages,
  conversations,
  waBroadcastRecipients,
  waOutbox,
  type WaOutbox,
} from "../../../drizzle/schema";
import { getDb, type DB, type Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { logger } from "../../logger";
import { decryptSecret } from "../cryptoService";
import { requireDb, withTx } from "../tx";
import type { GraphIntegration } from "./graph";
import { fetchInboundMedia } from "./mediaService";
import {
  GRAPH_ERROR_AR,
  sendInteractiveButtons,
  sendSessionText,
  sendTemplate,
  type GraphErrorClassification,
  type SendResult,
} from "./sendService";

export interface EnqueueOutboxInput {
  dedupeKey: string;
  branchId: number;
  conversationId?: number | null;
  toPhoneE164?: string | null;
  kind: "SESSION_TEXT" | "TEMPLATE" | "MEDIA" | "MEDIA_FETCH";
  payloadJson: Record<string, unknown>;
  templateName?: string | null;
  templateLang?: string | null;
  scheduledAt?: Date | null;
  campaignId?: number | null;
  taskId?: number | null;
  createdBy?: number | null;
}

// ── enqueue ──────────────────────────────────────────────────────────────────

/** يُدرج صفّ إرسال جديد (QUEUED، nextAttemptAt = scheduledAt ?? الآن). idempotent: ازدواج
 *  `uq_wa_outbox_dedupe` ⇒ يُعيد الصفّ القائم بلا رمي (لا إرسال مزدوج لنفس الحدث).
 *
 *  ⚠️ nextAttemptAt الفوري = `sql`NOW()`` (حساب MySQL نفسه) لا `new Date()` JS: عمود nextAttemptAt
 *  بلا كسور ثانية (TIMESTAMP fsp=0) ⇒ MySQL يُقرِّب قيمة JS المُرسَلة لأقرب ثانية (قد يُقرِّب لأعلى)،
 *  فتُصبح القيمة المخزَّنة أحدث بأقلّ من ثانية من لحظة الإدراج الفعلية ⇒ فحص «هل الموعد حان؟» اللاحق
 *  (claimRowForDispatch/claimDueBatch، كلاهما SQL-side بـNOW()) قد يراها مستقبلية ظُلماً في محاولة
 *  الإرسال الفورية (enqueueAndDispatch). `NOW()` من MySQL نفسه يُطابق أي `NOW()` لاحق تماماً. */
export async function enqueueOutbox(input: EnqueueOutboxInput, tx?: Tx): Promise<{ id: number; isNew: boolean }> {
  if (!input.dedupeKey.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "dedupeKey مطلوب لضمان عدم الإرسال المزدوج." });
  }
  const run = async (t: Tx): Promise<{ id: number; isNew: boolean }> => {
    try {
      const res = await t.insert(waOutbox).values({
        branchId: input.branchId,
        dedupeKey: input.dedupeKey,
        conversationId: input.conversationId ?? null,
        toPhoneE164: input.toPhoneE164 ?? null,
        kind: input.kind,
        payloadJson: input.payloadJson,
        templateName: input.templateName ?? null,
        templateLang: input.templateLang ?? null,
        status: "QUEUED",
        nextAttemptAt: input.scheduledAt ?? sql`NOW()`,
        scheduledAt: input.scheduledAt ?? null,
        campaignId: input.campaignId ?? null,
        taskId: input.taskId ?? null,
        createdBy: input.createdBy ?? null,
      });
      return { id: extractInsertId(res), isNew: true };
    } catch (e) {
      if (isDupEntry(e)) {
        const existing = (
          await t.select({ id: waOutbox.id }).from(waOutbox).where(eq(waOutbox.dedupeKey, input.dedupeKey)).limit(1)
        )[0];
        if (existing) return { id: Number(existing.id), isNew: false };
      }
      throw e;
    }
  };
  return tx ? run(tx) : withTx(run);
}

/** enqueue ثم محاولة إرسال فورية غير متزامنة (لا تنتظر النتيجة — الكنّاس يلتقط أي فشل خلال دقيقة). */
export async function enqueueAndDispatch(input: EnqueueOutboxInput): Promise<{ id: number; isNew: boolean }> {
  const res = await enqueueOutbox(input);
  setImmediate(() => {
    void dispatchOutboxRow(res.id).catch((e) => {
      logger.error({ err: e, outboxId: res.id }, "wa-outbox: immediate dispatch attempt failed");
    });
  });
  return res;
}

// ── تكامل واتساب النشط ───────────────────────────────────────────────────────

export interface ActiveWaIntegration {
  branchId: number;
  integrationId: number;
  accessToken: string;
  phoneNumberId: string;
  apiBaseUrl: string | null;
}

function safeDecryptToken(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decryptSecret(ciphertext);
  } catch {
    return null;
  }
}

/** التكامل النشط لواتساب على فرع مُعطى (فوق getDecryptedIntegration في integrationService — تلك
 *  لا تفلتر ACTIVE تحديداً ولا تُعيد apiBaseUrl). null لو لا تكامل ACTIVE أو accessToken/phoneNumberId
 *  مفقودان بعد الفكّ. */
export async function getActiveWaIntegration(branchId: number): Promise<ActiveWaIntegration | null> {
  const db = getDb();
  if (!db) return null;
  const row = (
    await db
      .select({
        id: channelIntegrations.id,
        encAccess: channelIntegrations.encryptedAccessToken,
        phoneNumberId: channelIntegrations.phoneNumberId,
        apiBaseUrl: channelIntegrations.apiBaseUrl,
      })
      .from(channelIntegrations)
      .where(and(
        eq(channelIntegrations.branchId, branchId),
        eq(channelIntegrations.channel, "WHATSAPP"),
        eq(channelIntegrations.status, "ACTIVE"),
      ))
      .limit(1)
  )[0];
  if (!row) return null;
  const accessToken = safeDecryptToken(row.encAccess);
  if (!accessToken || !row.phoneNumberId) return null;
  return {
    branchId,
    integrationId: Number(row.id),
    accessToken,
    phoneNumberId: row.phoneNumberId,
    apiBaseUrl: row.apiBaseUrl,
  };
}

/** فحص رخيص للكنّاس: هل يوجد تكامل واتساب نشط على أي فرع؟ لا ⇒ خروج فوري (صفر أثر بلا تفعيل). */
export async function hasAnyActiveWaIntegration(): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const row = (
    await db
      .select({ id: channelIntegrations.id })
      .from(channelIntegrations)
      .where(and(eq(channelIntegrations.channel, "WHATSAPP"), eq(channelIntegrations.status, "ACTIVE")))
      .limit(1)
  )[0];
  return !!row;
}

// ── النافذة الحرّة (٢٤ ساعة) ──────────────────────────────────────────────────

/** SESSION_TEXT/MEDIA فقط (القوالب معفاة). لا محادثة مرتبطة ⇒ يستحيل التحقّق من النافذة فنفشل
 *  بأمان (fail-closed) بدل الإرسال بلا ضمان — المواصفة لم تُحدّد هذه الحالة صراحةً؛ منطقياً
 *  SESSION_TEXT يفترض محادثة قائمة أصلاً. */
async function isWithinFreeWindow(conversationId: number | null): Promise<boolean> {
  if (conversationId == null) return false;
  const db = requireDb();
  const row = (
    await db
      .select({ lastInboundAt: conversations.lastInboundAt })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
  )[0];
  if (!row?.lastInboundAt) return false;
  return Date.now() - row.lastInboundAt.getTime() < 24 * 3600 * 1000;
}

// ── ربط حالات outbox النهائية بمستلمي الحملات (مصدر منطق واحد — T5.2 hotfix) ──────────────────

type DbOrTx = DB | Tx;

export type BroadcastDeliveryStatus = "SENT" | "DELIVERED" | "READ" | "FAILED";

const RECIPIENT_STATUS_RANK: Record<string, number> = { SENT: 1, DELIVERED: 2, READ: 3 };

/**
 * يربط تحديث حالة `waOutbox` النهائية بصفّ `waBroadcastRecipients` المطابق عبر `outboxId` — لا أثر
 * لو لا صفّ مستلم مرتبط بهذا `outboxId` (رسالة عادية خارج أي حملة). **مصدر المنطق الوحيد** لهذا
 * الربط — يُستدعى من هنا (finalizeSendSuccess/applyFailure أدناه، المسار **المتزامن** على استجابة
 * Graph POST مباشرة) ومن `webhookProcessor.processStatuses` (المسار **غير المتزامن** من webhook
 * Meta لاحقاً؛ تستورده عبر إعادة تصدير `broadcastDispatch.ts`).
 *
 * رتابة صارمة لـSENT/DELIVERED/READ (delivered بعد read لا تُخفّض الحالة)؛ FAILED لا يتراجع عن
 * DELIVERED/READ مؤكَّدَين سلفاً (فشل متأخّر نادر لا يُلغي نجاحاً سابقاً). `wamid` قد يكون `null`
 * هنا خصيصاً (المسار المتزامن يصل **قبل** توليد أي wamid — الفشل حدث في استجابة الـPOST نفسها) ⇒
 * لا يُكتب فوق `wamid` مخزَّن سابقاً لو لم يُمرَّر جديد.
 */
export async function syncBroadcastRecipientFromOutbox(
  runner: DbOrTx,
  params: { outboxId: number; wamid: string | null; status: BroadcastDeliveryStatus; errorCode: string | null },
): Promise<void> {
  const recip = (
    await runner
      .select({ id: waBroadcastRecipients.id, recipientStatus: waBroadcastRecipients.recipientStatus })
      .from(waBroadcastRecipients)
      .where(eq(waBroadcastRecipients.outboxId, params.outboxId))
      .limit(1)
  )[0];
  if (!recip) return;

  if (params.status === "FAILED") {
    if (recip.recipientStatus === "DELIVERED" || recip.recipientStatus === "READ") return;
    await runner
      .update(waBroadcastRecipients)
      .set({ recipientStatus: "FAILED", errorCode: params.errorCode, ...(params.wamid ? { wamid: params.wamid } : {}) })
      .where(eq(waBroadcastRecipients.id, recip.id));
    return;
  }

  const newRank = RECIPIENT_STATUS_RANK[params.status];
  const currentRank = RECIPIENT_STATUS_RANK[recip.recipientStatus] ?? 0;
  if (newRank <= currentRank) return;
  await runner
    .update(waBroadcastRecipients)
    .set({ recipientStatus: params.status, ...(params.wamid ? { wamid: params.wamid } : {}) })
    .where(eq(waBroadcastRecipients.id, recip.id));
}

/** يستدعي syncBroadcastRecipientFromOutbox فقط لو الصفّ ينتمي لحملة (campaignId مضبوط) — no-op
 *  صامت لرسائل خارج أي حملة (الغالبية العظمى). تُستعمَل داخلياً من finalizeSendSuccess/applyFailure. */
async function syncCampaignRecipientIfAny(
  tx: Tx,
  row: WaOutbox,
  status: BroadcastDeliveryStatus,
  wamid: string | null,
  errorCode: string | null,
): Promise<void> {
  if (row.campaignId == null) return;
  await syncBroadcastRecipientFromOutbox(tx, { outboxId: row.id, wamid, status, errorCode });
}

// ── نتائج الإرسال ─────────────────────────────────────────────────────────────

function previewForOutbound(body: string): string {
  const t = (body || "").trim().replace(/\s+/g, " ");
  if (!t) return "(رسالة فارغة)";
  return t.length > 280 ? t.slice(0, 277) + "…" : t;
}

/** نجاح إرسال فعلي (SESSION_TEXT/TEMPLATE) — معاملة واحدة: outbox SENT+wamid + صفّ conversationMessages
 *  OUT + تحديث lastMessageAt/lastMessagePreview للمحادثة (يطابق سلوك addMessage لاتجاه OUT). */
async function finalizeSendSuccess(row: WaOutbox, wamid: string): Promise<void> {
  const bodyText =
    row.kind === "TEMPLATE"
      ? `قالب: ${row.templateName ?? ""}`
      : String((row.payloadJson as { text?: string } | null)?.text ?? "");
  await withTx(async (tx) => {
    await tx.update(waOutbox).set({ status: "SENT", wamid, lastError: null }).where(eq(waOutbox.id, row.id));
    if (row.conversationId != null) {
      await tx.insert(conversationMessages).values({
        conversationId: row.conversationId,
        direction: "OUT",
        body: bodyText.slice(0, 65500) || null,
        externalId: wamid,
        deliveryStatus: "PENDING",
        origin: "API",
        templateName: row.kind === "TEMPLATE" ? row.templateName : null,
      });
      await tx
        .update(conversations)
        .set({ lastMessageAt: sql`NOW()`, lastMessagePreview: previewForOutbound(bodyText) })
        .where(eq(conversations.id, row.conversationId));
    }
    await syncCampaignRecipientIfAny(tx, row, "SENT", wamid, null);
  });
}

/** نجاح جلب وسائط (MEDIA_FETCH) — waMedia/conversationMessages.mediaUrl كُتبا فعلاً داخل
 *  mediaService.fetchInboundMedia نفسها؛ هنا فقط نُنهي صفّ الطابور. */
async function finalizeMediaFetchSuccess(id: number): Promise<void> {
  await withTx(async (tx) => {
    await tx.update(waOutbox).set({ status: "SENT", lastError: null }).where(eq(waOutbox.id, id));
  });
}

/** فشل — retryable: attempts+1، FAILED عند بلوغ ٦ وإلا QUEUED بموعد باكوف أسّي (min(2^attempts,32)
 *  دقيقة ± ٢٠٪ عشوائية). permanent/pauseworthy: FAILED فوراً (محاولة واحدة — القوالب التسويقية
 *  pauseworthy مثل 131048 هي بالضبط ما يُغذّي قاطع جودة البث T5.2). `code` رمز خطأ Meta الرقمي إن
 *  وُجد (من classifyGraphError) — يُمرَّر كـerrorCode لمستلم الحملة (إن وُجدت) ليقرأه
 *  checkCircuitBreaker. المزامنة مع waBroadcastRecipients تحدث **فقط** عند الحالة النهائية FAILED
 *  (لا عند إعادة محاولة تبقي الصفّ QUEUED — تلك ليست حالة outbox نهائية بعد). */
async function applyFailure(row: WaOutbox, classification: GraphErrorClassification, detail: string, code: number | null = null): Promise<void> {
  const message = detail.slice(0, 500);
  const errorCode = code != null ? String(code) : null;
  if (classification === "retryable") {
    const attempts = row.attempts + 1;
    if (attempts >= 6) {
      await withTx(async (tx) => {
        await tx.update(waOutbox).set({ status: "FAILED", attempts, lastError: message }).where(eq(waOutbox.id, row.id));
        await syncCampaignRecipientIfAny(tx, row, "FAILED", row.wamid ?? null, errorCode);
      });
      return;
    }
    const backoffMinutes = Math.min(2 ** attempts, 32);
    const jitterFactor = 1 + (Math.random() * 0.4 - 0.2); // ± ٢٠٪
    const nextAttemptAt = new Date(Date.now() + backoffMinutes * 60_000 * jitterFactor);
    await withTx(async (tx) => {
      await tx.update(waOutbox).set({ status: "QUEUED", attempts, nextAttemptAt, lastError: message }).where(eq(waOutbox.id, row.id));
      // لا مزامنة مستلم هنا عمداً — الصفّ لا يزال QUEUED (إعادة محاولة لاحقة)، وcheckCircuitBreaker
      // يتجاهل QUEUED أصلاً (يقرأ فقط SENT/DELIVERED/READ/FAILED).
    });
    return;
  }
  await withTx(async (tx) => {
    await tx.update(waOutbox).set({ status: "FAILED", lastError: message }).where(eq(waOutbox.id, row.id));
    await syncCampaignRecipientIfAny(tx, row, "FAILED", row.wamid ?? null, errorCode);
  });
}

// ── المعالجة (بعد الالتقاط) ───────────────────────────────────────────────────

async function processClaimedRow(row: WaOutbox): Promise<void> {
  const integration = await getActiveWaIntegration(row.branchId);
  if (!integration) {
    await applyFailure(row, "permanent", "لا تكامل واتساب نشطاً لهذا الفرع.");
    return;
  }
  const graphIntegration: GraphIntegration = {
    accessToken: integration.accessToken,
    phoneNumberId: integration.phoneNumberId,
    apiBaseUrl: integration.apiBaseUrl,
  };

  // فحص النافذة لـSESSION_TEXT وMEDIA فقط (القوالب معفاة) — الخادم مصدر الحقيقة لا فحص الواجهة.
  if (row.kind === "SESSION_TEXT" || row.kind === "MEDIA") {
    if (!(await isWithinFreeWindow(row.conversationId))) {
      await applyFailure(row, "permanent", GRAPH_ERROR_AR[131047] ?? "نافذة المحادثة مغلقة — استخدم قالباً معتمداً.", 131047);
      return;
    }
  }

  if (row.kind === "MEDIA") {
    await applyFailure(row, "permanent", "إرسال الوسائط الصادر غير مدعوم بعد.");
    return;
  }

  if (row.kind === "MEDIA_FETCH") {
    const result = await fetchInboundMedia(row, graphIntegration);
    if (result.ok) {
      await finalizeMediaFetchSuccess(row.id);
    } else {
      await applyFailure(row, result.permanent ? "permanent" : "retryable", result.detail);
    }
    return;
  }

  // SESSION_TEXT / TEMPLATE
  let sendResult: SendResult;
  if (row.kind === "SESSION_TEXT") {
    // `buttons` في الحمولة (T4.2/CSAT) ⇒ رسالة تفاعلية بأزرار ردّ سريع بدل نصّ عادي — بلا قيمة kind
    // جديدة (لا هجرة: "INTERACTIVE" غير موجود في تعداد waOutbox.kind). فحص النافذة أعلاه يشملها
    // (SESSION_TEXT/MEDIA فقط) تماماً كالنصّ العادي — القوالب فقط معفاة.
    const payload = row.payloadJson as { text?: string; buttons?: Array<{ id: string; title: string }> };
    sendResult =
      payload.buttons && payload.buttons.length > 0
        ? await sendInteractiveButtons(graphIntegration, row.toPhoneE164 ?? "", payload.text ?? "", payload.buttons)
        : await sendSessionText(graphIntegration, row.toPhoneE164 ?? "", payload.text ?? "");
  } else {
    const payload = row.payloadJson as { bodyParams?: string[] };
    sendResult = await sendTemplate(
      graphIntegration,
      row.toPhoneE164 ?? "",
      row.templateName ?? "",
      row.templateLang ?? "ar",
      payload.bodyParams ?? [],
    );
  }

  if (sendResult.ok) {
    await finalizeSendSuccess(row, sendResult.wamid);
  } else {
    // إغلاق حلقة قاطع الجودة (T5.2 hotfix): sendResult.code هو رمز خطأ Meta الرقمي (131048/131056/
    // 130429/...) حين وصل متزامناً على استجابة Graph POST نفسها — يُمرَّر إلى applyFailure ليصل
    // بدوره لمستلم الحملة (syncCampaignRecipientIfAny) فيراه checkCircuitBreaker.
    await applyFailure(row, sendResult.classification, sendResult.detail, sendResult.code);
  }
}

// ── الالتقاط + نقاط الدخول ────────────────────────────────────────────────────

async function claimRowForDispatch(id: number): Promise<WaOutbox | null> {
  return withTx(async (tx) => {
    // «الموعد حان؟» يُفحَص بمقارنة SQL-side (NOW()) لا JS-side (Date.now()): عمود nextAttemptAt
    // بلا كسور ثانية (TIMESTAMP fsp=0) ⇒ MySQL يُقرِّب لأقرب ثانية عند الإدراج (قد يُقرِّب لأعلى ⇒
    // القيمة المخزَّنة أحدث بأقلّ من ثانية من الوقت الفعلي)؛ مقارنتها بـDate.now() في JS كانت تُخطئ
    // فتُسقِط محاولات إرسال حديثة الالتقاط ظُلماً. نفس أسلوب claimDueBatch في outboxSweeper.
    const row = (
      await tx
        .select()
        .from(waOutbox)
        .where(and(
          eq(waOutbox.id, id),
          eq(waOutbox.status, "QUEUED"),
          or(isNull(waOutbox.nextAttemptAt), lte(waOutbox.nextAttemptAt, sql`NOW()`)),
        ))
        .for("update")
        .limit(1)
    )[0];
    if (!row) return null;
    await tx.update(waOutbox).set({ status: "SENDING" }).where(eq(waOutbox.id, id));
    return row;
  });
}

/** يُنفَّذ بعد أن يكون الصفّ SENDING فعلاً (من claimRowForDispatch أو من التقاط دفعة الكنّاس) — لا
 *  يُعيد الالتقاط، فقط يُعالج. مُصدَّرة ليستعملها outboxSweeper بعد SELECT...FOR UPDATE SKIP LOCKED
 *  الدفعي (يُشارك نفس منطق الإرسال/التصنيف/الباكوف دون تكرار — «صمّم التقسيم الداخلي كيف شئت»). */
export async function dispatchClaimedRow(id: number): Promise<void> {
  const db = requireDb();
  const row = (await db.select().from(waOutbox).where(eq(waOutbox.id, id)).limit(1))[0];
  if (!row || row.status !== "SENDING") return; // تأمين إضافي — لا يُفترض حدوثه في الاستعمال الطبيعي.
  try {
    await processClaimedRow(row);
  } catch (e) {
    logger.error({ err: e, outboxId: id }, "wa-outbox: dispatch threw an unexpected error");
    // خطأ غير متوقّع (لا SendResult ولا MediaFetchResult) ⇒ نعامله retryable حتى لا يعلق الصفّ
    // SENDING للأبد (بلا هذه المعالجة، استثناء برمجي يُسقِط الصفّ من كل دورات الكنّاس التالية).
    await applyFailure(row, "retryable", e instanceof Error ? e.message : "خطأ غير متوقّع أثناء الإرسال.");
  }
}

/** نقطة الدخول العامة لإرسال صفّ واحد فوراً — تلتقطه (SENDING) ثم تُعالجه. idempotent: صفّ ليس
 *  QUEUED أو موعده لم يحن بعد ⇒ خروج صامت بلا أثر (استدعاء متزامن مع الكنّاس آمن دائماً). */
export async function dispatchOutboxRow(id: number): Promise<void> {
  const claimed = await claimRowForDispatch(id);
  if (!claimed) return;
  await dispatchClaimedRow(id);
}
