/**
 * معالجة أحداث WhatsApp Cloud API webhook — قلب شريحة #١ (نواة Cloud API). يعمل فوق صندوق الأحداث
 * الخام `waWebhookEvents` (سِجلّ خام تسلسلي — تشخيص/إعادة معالجة عند الفشل):
 *
 *   1. `persistWaEvent`: يُدرج الحمولة الخام PENDING فور نجاح HMAC (channelWebhooks.ts) — الحفظ
 *      مستقلٌّ عن نجاح المعالجة، فرسالة وصلت فعلياً لا تُفقَد حتى لو رمت المعالجة استثناءً غير متوقّع.
 *   2. `processWaEvent`: idempotent (PROCESSED ⇒ خروج فوري) — يوجّه كل `value` لفرعه الحاكم عبر
 *      `phone_number_id`، يُدرج الرسائل الواردة (مع ربط تلقائي بالعميل + جدولة جلب وسائط مؤجَّل)،
 *      يُسجّل صدى تطبيق الهاتف (تعايش)، ويُحدّث حالات التسليم برتابة صارمة. أي استثناء ⇒ الحدث
 *      كاملاً FAILED (attempts+1) ليُعاد عبر `retryFailedWaEvents` — لا نصف معالجة صامتة.
 *   3. `retryFailedWaEvents`: يلتقط FAILED بـ`attempts<5` الأقدم فالأقدم ويعيد المحاولة — يُستدعى
 *      من نبضة `outboxSweeper` بعد معالجة الصندوق الصادر (نفس الدقيقة، لا جدولة مستقلّة).
 *
 * **لماذا لا معاملة واحدة كبرى لكل حدث:** الخطوات الفرعية (upsertConversation/addMessage/
 * enqueueOutbox) كلٌّ منها يفتح معاملته الذرّية الخاصة (تصميم موروث من conversationService/
 * outboxService — راجع تعليق outboxService.ts §finalizeSendSuccess لنفس القيد). التركيب متسلسلٌ
 * لا ذرّيٌّ عبر كامل الحدث، لكن **كل خطوة idempotent بذاتها** (dedup بـexternalId/dedupeKey) ⇒
 * إعادة معالجة حدثٍ فشل جزئياً تُكمل بأمان بلا ازدواج (الخطوات المكتملة سلفاً تصير no-op).
 */
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { isDupEntry } from "@shared/errorMap.ar";
import {
  channelIntegrations,
  conversationMessages,
  conversations,
  waOutbox,
  waWebhookEvents,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { phoneMatchSuffix } from "../../lib/similarMatch";
import { logger } from "../../logger";
import { addMessage, upsertConversation } from "../conversationService";
import { maybeCreateTaskForInbound } from "../tasks/autoCreate";
import { requireDb, withTx } from "../tx";
import { resolveWaSender } from "./contactResolver";
import { enqueueOutbox } from "./outboxService";

// ── أشكال حمولة Cloud API (تفكيك متسامح — أي حقل غائب لا يرمي) ──────────────────────────────

interface WaMediaRef {
  id?: string;
  mime_type?: string;
  caption?: string;
}

interface WaInboundMessage {
  from?: string;
  to?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: WaMediaRef;
  document?: WaMediaRef;
  audio?: WaMediaRef;
  video?: WaMediaRef;
  sticker?: WaMediaRef;
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}

interface WaStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  errors?: Array<{ code?: number | string; title?: string }>;
}

interface WaWebhookValue {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ profile?: { name?: string } }>;
  messages?: WaInboundMessage[];
  statuses?: WaStatus[];
  /** حمولات تعايش تطبيق الهاتف — رسائل أُرسلت مباشرةً من واتساب للأعمال على الجوال (بيتا Meta). */
  message_echoes?: WaInboundMessage[];
}

interface WaWebhookPayload {
  entry?: Array<{ changes?: Array<{ value?: WaWebhookValue }> }>;
}

// ── وصف نوع الرسالة (نصّ للعرض + مرجع وسائط إن وُجد) ─────────────────────────────────────────

interface DescribedMessage {
  body: string;
  mediaType: string | null;
  mediaId: string | null;
  mimeTypeHint: string | null;
}

const MEDIA_LABEL_AR: Record<string, string> = {
  image: "[صورة]",
  document: "[مستند]",
  audio: "[رسالة صوتية]",
  video: "[فيديو]",
  sticker: "[ملصق]",
};

/** يبني نصّاً عربياً موجزاً + مرجع وسائط (إن وُجد) من رسالة Cloud API — بلا رمي لأي نوعٍ غير متوقّع. */
function describeInboundMessage(msg: WaInboundMessage): DescribedMessage {
  const type = msg.type ?? "";
  if (type === "text") {
    return { body: msg.text?.body?.trim() || "(رسالة فارغة)", mediaType: null, mediaId: null, mimeTypeHint: null };
  }
  const mediaRef =
    type === "image" ? msg.image
    : type === "document" ? msg.document
    : type === "audio" ? msg.audio
    : type === "video" ? msg.video
    : type === "sticker" ? msg.sticker
    : undefined;
  if (mediaRef) {
    const label = MEDIA_LABEL_AR[type] ?? "[وسائط]";
    const caption = typeof mediaRef.caption === "string" && mediaRef.caption.trim() ? `: ${mediaRef.caption.trim()}` : "";
    return {
      body: `${label}${caption}`,
      mediaType: mediaRef.mime_type ?? null,
      mediaId: mediaRef.id ?? null,
      mimeTypeHint: mediaRef.mime_type ?? null,
    };
  }
  if (type === "location") return { body: "[موقع]", mediaType: null, mediaId: null, mimeTypeHint: null };
  if (type === "contacts") return { body: "[جهة اتصال]", mediaType: null, mediaId: null, mimeTypeHint: null };
  if (type === "button") {
    return { body: msg.button?.text?.trim() || "[زرّ ردّ]", mediaType: null, mediaId: null, mimeTypeHint: null };
  }
  if (type === "interactive") {
    const title = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title;
    return { body: title?.trim() || "[رسالة تفاعلية]", mediaType: null, mediaId: null, mimeTypeHint: null };
  }
  // بند ٥ في المواصفة: نوع غير معروف ⇒ تجاهل مسجَّل، لا فشل. نُدرج وصفاً عاماً كي لا تختفي
  // الرسالة من صندوق الوارد (العميل راسل فعلياً — إسقاطها صامتاً أسوأ من وصفٍ غامض).
  logger.info({ type }, "wa-webhook: نوع رسالة غير مدعوم — أُدرج بوصف عام");
  return { body: `[نوع رسالة غير مدعوم: ${type || "?"}]`, mediaType: null, mediaId: null, mimeTypeHint: null };
}

// ── التوجيه: أي فرعٍ يحكم هذا الـvalue؟ ──────────────────────────────────────────────────────

/** phone_number_id ⇒ تكامل WHATSAPP نشط مطابق ⇒ فرعه؛ غيابه ⇒ فرع التكامل الذي مرّر HMAC. */
async function resolveGoverningBranch(value: WaWebhookValue, fallbackIntegrationId: number | null): Promise<number | null> {
  const db = requireDb();
  const phoneNumberId = value.metadata?.phone_number_id;
  if (phoneNumberId) {
    const row = (
      await db
        .select({ branchId: channelIntegrations.branchId })
        .from(channelIntegrations)
        .where(
          and(
            eq(channelIntegrations.phoneNumberId, phoneNumberId),
            eq(channelIntegrations.channel, "WHATSAPP"),
            eq(channelIntegrations.status, "ACTIVE"),
          ),
        )
        .limit(1)
    )[0];
    if (row) return Number(row.branchId);
  }
  if (fallbackIntegrationId != null) {
    const row = (
      await db.select({ branchId: channelIntegrations.branchId }).from(channelIntegrations).where(eq(channelIntegrations.id, fallbackIntegrationId)).limit(1)
    )[0];
    if (row) return Number(row.branchId);
  }
  return null;
}

// ── ربط تلقائي بالعميل (فقط لو المحادثة بلا customerId بعد) ─────────────────────────────────

async function maybeLinkCustomer(conv: { id: number; isNew: boolean }, from: string): Promise<void> {
  const db = requireDb();
  let shouldTry = conv.isNew;
  if (!shouldTry) {
    const row = (await db.select({ customerId: conversations.customerId }).from(conversations).where(eq(conversations.id, conv.id)).limit(1))[0];
    shouldTry = row != null && row.customerId == null;
  }
  if (!shouldTry) return;
  const resolved = await resolveWaSender(from);
  if (resolved.kind !== "single") return; // multiple/none ⇒ لا ربط (قاعدة صلبة — الخطر ٤).
  // حارس customerId IS NULL في WHERE: لا يستبدل ربطاً وقع بين الفحص أعلاه وهذا التحديث (سباق نادر).
  await db
    .update(conversations)
    .set({ customerId: resolved.customerId })
    .where(and(eq(conversations.id, conv.id), isNull(conversations.customerId)));
}

// ── الرسائل الواردة (messages[]) ──────────────────────────────────────────────────────────────

async function processInboundMessages(value: WaWebhookValue, branchId: number): Promise<void> {
  const db = requireDb();
  const businessSuffix = phoneMatchSuffix(value.metadata?.display_phone_number ?? null);
  const displayName = value.contacts?.[0]?.profile?.name ?? null;

  for (const msg of value.messages ?? []) {
    const from = String(msg.from ?? "").trim();
    const externalId = String(msg.id ?? "").trim();
    if (!from || !externalId) continue; // تسامح — حقول أساسية ناقصة تُهمَل بصمت.

    // صدى تعايش داخل messages[] نفسها: from == رقم العمل ⇒ OUT لا IN (بند ٣ في المواصفة).
    if (businessSuffix && phoneMatchSuffix(from) === businessSuffix) {
      await recordEcho(branchId, msg);
      continue;
    }

    const conv = await upsertConversation({ branchId, channel: "WHATSAPP", channelHandle: from, displayName });
    await maybeLinkCustomer(conv, from);

    const desc = describeInboundMessage(msg);
    const { messageId, deduped } = await addMessage({
      conversationId: conv.id,
      direction: "IN",
      body: desc.body,
      mediaType: desc.mediaType,
      externalId,
    });

    // lastInboundAt فقط لأوّل استلام حقيقي — إعادة webhook (retry مطابق بexternalId) لا تُنعش
    // نافذة الردّ الحرّ ٢٤ ساعة زوراً. لكن جدولة الوسائط أدناه **لا** تُشرَط بـ!deduped: enqueueOutbox
    // idempotent بذاتها (dedupeKey فريد) ⇒ استدعاؤها مجدَّداً آمن دائماً، وشرطها بعدم التكرار كان
    // يُفلت ثغرة صامتة: لو فشل الحدث **بعد** إدراج الرسالة (مثلاً بسبب حدثٍ لاحق في نفس الدفعة)
    // فإن retryFailedWaEvents كان سيُعيد معالجة رسالةٍ مُكرَّرة (deduped=true) فيتخطّى جدولة الوسائط
    // للأبد — لا فرصة ثانية لجلبها.
    if (!deduped) {
      await db.update(conversations).set({ lastInboundAt: sql`NOW()` }).where(eq(conversations.id, conv.id));

      // نظام المهام (S2، ٢٣/٧/٢٦): كل رسالة IN أولى (غير مُكرَّرة) قد تُنشئ مهمة تلقائياً حسب وضع
      // فرز waHubSettings. نقطة الاستدعاء هنا لا في addMessage (الأقلّ تدخلاً — addMessage عامّة
      // تُستعمَل أيضاً لصدى OUT ولقنوات أخرى بلا سياق فرع/قناة كافٍ لبناء مهمة). معاملة مستقلّة
      // (maybeCreateTaskForInbound تفتح withTx خاصة بها لأن addMessage أعلاه أغلقت معاملتها
      // بالفعل) محميّة بـtry: فشل الفرز التلقائي **لا يجب** أن يُفشل استقبال رسالة واتساب فعلية
      // (وإلا الحدث كاملاً FAILED فيُعاد لاحقاً عبر retryFailedWaEvents رغم نجاح استلام الرسالة).
      try {
        const convNow = (
          await db.select({ customerId: conversations.customerId }).from(conversations).where(eq(conversations.id, conv.id)).limit(1)
        )[0];
        await withTx((tx) =>
          maybeCreateTaskForInbound(tx, {
            conversationId: conv.id,
            branchId,
            customerId: convNow?.customerId != null ? Number(convNow.customerId) : null,
            messageBody: desc.body,
            sourceChannel: "WHATSAPP",
          }),
        );
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, "wa-webhook: تعذّر إنشاء مهمة تلقائية من الوارد — تُجوهل");
      }
    }

    if (desc.mediaId) {
      // جلب مؤجَّل فقط — روابط Graph تنتهي بسرعة، الخفّة هنا مقصودة (mediaService.fetchInboundMedia
      // يتولّى الجلب الفعلي عبر الصندوق الصادر). dedupeKey يمنع ازدواج جدولة عند إعادة webhook/retry.
      await enqueueOutbox({
        dedupeKey: `MF:${externalId}`,
        branchId,
        kind: "MEDIA_FETCH",
        payloadJson: { mediaId: desc.mediaId, messageId, mimeTypeHint: desc.mimeTypeHint },
      });
    }
  }
}

/** يسجّل رسالة صدى (تعايش تطبيق الهاتف) كـOUT — تسامح كامل: أي شكل غير مفهوم لا يرمي (بند ٣). */
async function recordEcho(branchId: number, msg: WaInboundMessage): Promise<void> {
  try {
    const to = String(msg.to ?? "").trim();
    const externalId = String(msg.id ?? "").trim();
    if (!to || !externalId) return; // شكل غير مفهوم (لا مستلم مُعرَّف) ⇒ تجاهل صامت.
    const conv = await upsertConversation({ branchId, channel: "WHATSAPP", channelHandle: to });
    const desc = describeInboundMessage(msg);
    const db = requireDb();
    try {
      await db.insert(conversationMessages).values({
        conversationId: conv.id,
        direction: "OUT",
        body: desc.body,
        mediaType: desc.mediaType,
        externalId,
        origin: "PHONE_APP",
      });
    } catch (e) {
      if (!isDupEntry(e)) throw e; // uq_msg_external: صدى مُعاد (retry) ⇒ نجاح صامت.
    }
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "wa-webhook: صدى تعايش بشكلٍ غير متوقّع — تُجوهل");
  }
}

async function processEchoArray(branchId: number, echoes: WaInboundMessage[]): Promise<void> {
  for (const msg of echoes) await recordEcho(branchId, msg);
}

// ── حالات التسليم (statuses[]) — رتابة صارمة ─────────────────────────────────────────────────

const STATUS_RANK: Record<string, number> = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3 };

function parseWaTimestamp(raw: string | undefined): Date | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000);
}

async function processStatuses(statuses: WaStatus[]): Promise<void> {
  const db = requireDb();
  for (const st of statuses) {
    const wamid = String(st?.id ?? "").trim();
    const rawStatus = String(st?.status ?? "").trim().toLowerCase();
    if (!wamid || !rawStatus) continue; // تسامح — بلا id/status لا شيء نطابقه.

    const row = (
      await db
        .select({ id: conversationMessages.id, deliveryStatus: conversationMessages.deliveryStatus })
        .from(conversationMessages)
        .where(eq(conversationMessages.externalId, wamid))
        .limit(1)
    )[0];
    if (!row) {
      // سباق الترتيب (بند ٤): الحالة سبقت صفّ الرسالة (finalizeSendSuccess لم يكتب بعد، أو
      // حدثا webhook متزامنان). نرمي خطأً مميّزاً يُعلِّم الحدث **كاملاً** FAILED ليُعاد عبر
      // retryFailedWaEvents بعد وصول الرسالة — لا نُسقط تحديث الحالة صامتاً.
      throw new Error(`wa-status-race: wamid ${wamid} لا يطابق أيّ رسالة صادرة بعد.`);
    }

    const waTimestamp = parseWaTimestamp(st.timestamp);

    if (rawStatus === "failed") {
      const errorCode = st.errors?.[0]?.code != null ? String(st.errors[0].code).slice(0, 20) : null;
      const lastError = (st.errors?.[0]?.title ?? "فشل تسليم الرسالة عبر واتساب.").slice(0, 500);
      // ذرّي: تحديث حالة الرسالة + إعلام waOutbox معاً — عملية عمل واحدة (بند §٥ الذرّية).
      await withTx(async (tx) => {
        await tx
          .update(conversationMessages)
          .set({
            deliveryStatus: "FAILED",
            errorCode,
            statusUpdatedAt: sql`NOW()`,
            ...(waTimestamp ? { waTimestamp } : {}),
          })
          .where(eq(conversationMessages.id, row.id));
        await tx.update(waOutbox).set({ status: "FAILED", lastError }).where(eq(waOutbox.wamid, wamid));
      });
      continue;
    }

    const normalized = rawStatus.toUpperCase();
    const newRank = STATUS_RANK[normalized];
    if (newRank == null) {
      logger.info({ status: rawStatus, wamid }, "wa-webhook: حالة غير معروفة — تُجوهل (بند ٥)");
      continue;
    }
    const currentRank = STATUS_RANK[row.deliveryStatus ?? "PENDING"] ?? 0;
    if (newRank <= currentRank) continue; // رتابة: delivered بعد read لا تُخفّض الحالة.

    await db
      .update(conversationMessages)
      .set({
        deliveryStatus: normalized as "SENT" | "DELIVERED" | "READ",
        statusUpdatedAt: sql`NOW()`,
        ...(waTimestamp ? { waTimestamp } : {}),
      })
      .where(eq(conversationMessages.id, row.id));
  }
}

// ── صندوق الأحداث الخام: حفظ + معالجة + إعادة محاولة ─────────────────────────────────────────

/** يُدرج الحمولة الخام PENDING فور نجاح HMAC — الحفظ سابق للمعالجة ومستقلّ عنها (لا فقد رسالة). */
export async function persistWaEvent(payload: unknown, integrationId: number | null): Promise<{ id: number }> {
  const db = requireDb();
  const res = await db.insert(waWebhookEvents).values({
    channel: "WHATSAPP",
    integrationId: integrationId ?? null,
    payloadJson: (payload ?? {}) as Record<string, unknown>,
    status: "PENDING",
  });
  return { id: extractInsertId(res) };
}

/** يعالج حدثاً واحداً — idempotent (PROCESSED ⇒ خروج فوري). أي استثناء ⇒ الحدث كاملاً FAILED. */
export async function processWaEvent(eventId: number): Promise<void> {
  const db = requireDb();
  const event = (await db.select().from(waWebhookEvents).where(eq(waWebhookEvents.id, eventId)).limit(1))[0];
  if (!event) return; // غير موجود — لا يُفترض حدوثه في الاستعمال الطبيعي؛ لا شيء لفعله.
  if (event.status === "PROCESSED") return;

  try {
    const payload = event.payloadJson as WaWebhookPayload;
    const fallbackIntegrationId = event.integrationId != null ? Number(event.integrationId) : null;

    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        if (!value) continue;

        const hasInbound = (value.messages?.length ?? 0) > 0 || (value.message_echoes?.length ?? 0) > 0;
        let branchId: number | null = null;
        if (hasInbound) {
          branchId = await resolveGoverningBranch(value, fallbackIntegrationId);
          if (branchId == null) {
            throw new Error(
              "wa-webhook: تعذّر تحديد الفرع الحاكم لهذا الحدث (phone_number_id لا يطابق تكاملاً نشطاً، ولا تكامل احتياطي مرّر HMAC).",
            );
          }
        }

        if (value.messages?.length) await processInboundMessages(value, branchId!);
        if (value.message_echoes?.length) await processEchoArray(branchId!, value.message_echoes);
        if (value.statuses?.length) await processStatuses(value.statuses);
      }
    }

    await db.update(waWebhookEvents).set({ status: "PROCESSED", processedAt: sql`NOW()` }).where(eq(waWebhookEvents.id, eventId));
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await db
      .update(waWebhookEvents)
      .set({ status: "FAILED", attempts: sql`${waWebhookEvents.attempts} + 1`, lastError: message })
      .where(eq(waWebhookEvents.id, eventId));
    logger.warn({ err: message, eventId }, "wa-webhook: processWaEvent فشلت — الحدث FAILED للإعادة");
  }
}

/** يعيد محاولة الأحداث الفاشلة (attempts<5) الأقدم فالأقدم — تُستدعى من نبضة outboxSweeper. */
export async function retryFailedWaEvents(limit = 10): Promise<{ retried: number }> {
  const db = requireDb();
  const rows = await db
    .select({ id: waWebhookEvents.id })
    .from(waWebhookEvents)
    .where(and(eq(waWebhookEvents.status, "FAILED"), lt(waWebhookEvents.attempts, 5)))
    .orderBy(asc(waWebhookEvents.receivedAt))
    .limit(limit);
  for (const r of rows) await processWaEvent(Number(r.id));
  return { retried: rows.length };
}
