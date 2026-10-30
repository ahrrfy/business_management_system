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
import { randomUUID } from "node:crypto";
import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { isDupEntry } from "@shared/errorMap.ar";
import {
  channelIntegrations,
  conversationMessages,
  conversations,
  customers,
  reservations,
  waBroadcastRecipients,
  waBroadcasts,
  waHubSettings,
  waOutbox,
  type WaOutbox,
} from "../../../drizzle/schema";
import { getDb, type DB, type Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { logger } from "../../logger";
import { decryptSecret } from "../cryptoService";
import {
  generateOfficialDocumentPdf,
  type OfficialDocumentPdfData,
} from "../officialDocumentPdf";
import { requireDb, withTx } from "../tx";
import type { MaybeScopedActor } from "../tx";
import { logAuditTx } from "../auditService";
import { appErrorMessage } from "@shared/errors";
import { operationDecision } from "@shared/operationPermissions";
import { loadOperationUserTx } from "../authorization/operationAuthority";
import type { GraphIntegration } from "./graph";
import { fetchInboundMedia } from "./mediaService";
import {
  GRAPH_ERROR_AR,
  sendDocumentByMediaId,
  sendDocumentTemplate,
  sendInteractiveButtons,
  sendSessionText,
  sendTemplate,
  uploadMedia,
  type GraphErrorClassification,
  type SendResult,
} from "./sendService";

interface OutgoingPdfPayload {
  pdfData: OfficialDocumentPdfData;
  filename: string;
  caption?: string | null;
}

export interface EnqueueOutboxInput {
  dedupeKey: string;
  branchId: number;
  conversationId?: number | null;
  toPhoneE164?: string | null;
  customerId?: number | null;
  kind: "SESSION_TEXT" | "TEMPLATE" | "MEDIA" | "MEDIA_FETCH";
  payloadJson: Record<string, unknown>;
  templateName?: string | null;
  templateLang?: string | null;
  scheduledAt?: Date | null;
  campaignId?: number | null;
  taskId?: number | null;
  createdBy?: number | null;
  /** يعيد صف dedupe نهائياً إلى QUEUED بعد أن يثبت المستدعي أن الحدث صالح الآن (تنبيه الحجز فقط). */
  reviveTerminalDuplicate?: boolean;
}

export interface EnqueueOutboxResult {
  id: number;
  isNew: boolean;
  status: WaOutbox["status"];
  revived: boolean;
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
export async function enqueueOutbox(input: EnqueueOutboxInput, tx?: Tx): Promise<EnqueueOutboxResult> {
  if (!input.dedupeKey.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "dedupeKey مطلوب لضمان عدم الإرسال المزدوج." });
  }
  const run = async (t: Tx): Promise<EnqueueOutboxResult> => {
    const values = {
      branchId: input.branchId,
      dedupeKey: input.dedupeKey,
      conversationId: input.conversationId ?? null,
      toPhoneE164: input.toPhoneE164 ?? null,
      customerId: input.customerId ?? null,
      kind: input.kind,
      payloadJson: input.payloadJson,
      templateName: input.templateName ?? null,
      templateLang: input.templateLang ?? null,
      status: "QUEUED" as const,
      nextAttemptAt: input.scheduledAt ?? sql`NOW()`,
      scheduledAt: input.scheduledAt ?? null,
      campaignId: input.campaignId ?? null,
      taskId: input.taskId ?? null,
      createdBy: input.createdBy ?? null,
    };
    try {
      const res = await t.insert(waOutbox).values(values);
      return { id: extractInsertId(res), isNew: true, status: "QUEUED", revived: false };
    } catch (e) {
      if (isDupEntry(e)) {
        const existing = (
          await t
            .select({ id: waOutbox.id, status: waOutbox.status })
            .from(waOutbox)
            .where(eq(waOutbox.dedupeKey, input.dedupeKey))
            .limit(1)
        )[0];
        if (existing) {
          const terminal = existing.status === "FAILED" || existing.status === "CANCELLED";
          if (terminal && input.reviveTerminalDuplicate) {
            await t
              .update(waOutbox)
              .set({
                ...values,
                attempts: 0,
                wamid: null,
                lastError: null,
              })
              .where(and(eq(waOutbox.id, existing.id), inArray(waOutbox.status, ["FAILED", "CANCELLED"])));
            return { id: Number(existing.id), isNew: false, status: "QUEUED", revived: true };
          }
          return { id: Number(existing.id), isNew: false, status: existing.status, revived: false };
        }
      }
      throw e;
    }
  };
  return tx ? run(tx) : withTx(run);
}

/** enqueue ثم محاولة إرسال فورية غير متزامنة (لا تنتظر النتيجة — الكنّاس يلتقط أي فشل خلال دقيقة). */
export async function enqueueAndDispatch(input: EnqueueOutboxInput): Promise<EnqueueOutboxResult> {
  const res = await enqueueOutbox(input);
  scheduleOutboxDispatch(res.id);
  return res;
}

const pendingImmediateDispatches = new Set<Promise<void>>();

/** Register before scheduling; completion includes the actual dispatch and error logging. */
export function scheduleOutboxDispatch(
  id: number,
  context: "wa-outbox" | "flowNotify" = "wa-outbox",
): void {
  let start!: () => void;
  const scheduled = new Promise<void>((resolve) => { start = resolve; });
  const task = scheduled.then(() => dispatchOutboxRow(id)).catch((err) => {
    logger.error({ err, outboxId: id }, `${context}: immediate dispatch attempt failed`);
  });
  pendingImmediateDispatches.add(task);
  const remove = () => { pendingImmediateDispatches.delete(task); };
  // Both handlers consume rejection, including an unexpected logging failure.
  void task.then(remove, remove);
  setImmediate(start);
}

/** Await scheduled and running attempts, including attempts added while draining. */
export async function drainPendingOutboxDispatches(): Promise<void> {
  while (pendingImmediateDispatches.size)
    await Promise.allSettled(Array.from(pendingImmediateDispatches));
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

/** إعادة تحقق رخيصة من أن التكامل المخبّأ ما زال هو التكامل النشط للفرع، بلا فك التوكن من جديد. */
export async function isActiveWaIntegrationId(branchId: number, integrationId: number): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const row = (await db
    .select({ id: channelIntegrations.id })
    .from(channelIntegrations)
    .where(and(
      eq(channelIntegrations.id, integrationId),
      eq(channelIntegrations.branchId, branchId),
      eq(channelIntegrations.channel, "WHATSAPP"),
      eq(channelIntegrations.status, "ACTIVE"),
    ))
    .limit(1))[0];
  return Boolean(row);
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

export type BroadcastDeliveryStatus =
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "FAILED"
  | "UNKNOWN"
  | "CANCELLED"
  | "SKIPPED_OPTOUT";

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
  params: {
    outboxId: number;
    wamid: string | null;
    status: BroadcastDeliveryStatus;
    errorCode: string | null;
  },
): Promise<void> {
  const recip = (
    await runner
      .select({
        id: waBroadcastRecipients.id,
        recipientStatus: waBroadcastRecipients.recipientStatus,
      })
      .from(waBroadcastRecipients)
      .where(eq(waBroadcastRecipients.outboxId, params.outboxId))
      .limit(1)
  )[0];
  if (!recip) return;

  if (
    ["FAILED", "UNKNOWN", "CANCELLED", "SKIPPED_OPTOUT"].includes(params.status)
  ) {
    if (
      recip.recipientStatus === "DELIVERED" ||
      recip.recipientStatus === "READ"
    )
      return;
    await runner
      .update(waBroadcastRecipients)
      .set({
        recipientStatus: params.status,
        errorCode: params.errorCode,
        ...(params.wamid ? { wamid: params.wamid } : {}),
      })
      .where(eq(waBroadcastRecipients.id, recip.id));
    return;
  }

  const newRank = RECIPIENT_STATUS_RANK[params.status];
  const currentRank = RECIPIENT_STATUS_RANK[recip.recipientStatus] ?? 0;
  if (newRank <= currentRank) return;
  await runner
    .update(waBroadcastRecipients)
    .set({
      recipientStatus: params.status,
      ...(params.wamid ? { wamid: params.wamid } : {}),
    })
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
async function finalizeSendSuccess(
  row: WaOutbox,
  wamid: string,
): Promise<void> {
  await withClaimTx(row, async (tx) => finalizeAcceptedInTx(tx, row, wamid));
}

async function finalizeAcceptedInTx(
  tx: Tx,
  row: WaOutbox,
  wamid: string,
): Promise<void> {
  const bodyText =
    row.kind === "TEMPLATE"
      ? `قالب: ${row.templateName ?? ""}`
      : row.kind === "MEDIA"
        ? String(
            (
              row.payloadJson as {
                document?: { caption?: string; filename?: string };
              } | null
            )?.document?.caption ??
              (row.payloadJson as { document?: { filename?: string } } | null)
                ?.document?.filename ??
              "مستند PDF",
          )
        : String((row.payloadJson as { text?: string } | null)?.text ?? "");
  await tx
    .update(waOutbox)
    .set({ status: "SENT", wamid, lastError: null, claimExpiresAt: null })
    .where(eq(waOutbox.id, row.id));
  if (row.conversationId != null) {
    await tx
      .insert(conversationMessages)
      .values({
        conversationId: row.conversationId,
        direction: "OUT",
        body: bodyText.slice(0, 65500) || null,
        externalId: wamid,
        deliveryStatus: "PENDING",
        origin: "API",
        templateName: row.kind === "TEMPLATE" ? row.templateName : null,
      })
      .onDuplicateKeyUpdate({
        set: { externalId: sql`${conversationMessages.externalId}` },
      });
    await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`NOW()`,
        lastMessagePreview: previewForOutbound(bodyText),
      })
      .where(eq(conversations.id, row.conversationId));
  }
  await syncCampaignRecipientIfAny(tx, row, "SENT", wamid, null);
}

const CLAIM_LEASE_MS = 5 * 60_000;
const UNKNOWN_ERROR =
  "نتيجة الإرسال غير محسومة؛ راجع سجل المزود ثم سجّل تسوية موثقة قبل أي إعادة إرسال.";

/** Every completion is fenced by the durable claim, including responses arriving after lease expiry. */
async function withClaimTx<T>(
  row: WaOutbox,
  work: (tx: Tx, current: WaOutbox) => Promise<T>,
): Promise<T | undefined> {
  return withTx(async (tx) => {
    const current = (
      await tx
        .select()
        .from(waOutbox)
        .where(eq(waOutbox.id, row.id))
        .for("update")
        .limit(1)
    )[0];
    if (
      !current ||
      !["SENDING", "UNKNOWN"].includes(current.status) ||
      current.claimToken !== row.claimToken
    )
      return;
    return work(tx, current);
  });
}

export function outboxClaimValues() {
  return {
    status: "SENDING" as const,
    claimToken: randomUUID(),
    claimExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS),
    providerStartedAt: null,
    providerAttemptId: null,
  };
}

async function markUnknown(row: WaOutbox): Promise<void> {
  await withClaimTx(row, async (tx, current) => {
    if (current.wamid) {
      await finalizeAcceptedInTx(tx, current, current.wamid);
      return;
    }
    await tx
      .update(waOutbox)
      .set({
        status: "UNKNOWN",
        claimExpiresAt: null,
        lastError: UNKNOWN_ERROR,
      })
      .where(eq(waOutbox.id, row.id));
    await syncCampaignRecipientIfAny(
      tx,
      row,
      "UNKNOWN",
      null,
      "OUTCOME_UNKNOWN",
    );
  });
}

/** Legacy SENDING has no proof that I/O did not start, so it is always reconciled explicitly. */
export async function recoverStaleOutboxClaims(): Promise<void> {
  await withTx(async (tx) => {
    const rows = await tx
      .select()
      .from(waOutbox)
      .where(
        and(
          eq(waOutbox.status, "SENDING"),
          or(
            lte(waOutbox.claimExpiresAt, sql`NOW()`),
            and(
              isNull(waOutbox.claimExpiresAt),
              lt(waOutbox.updatedAt, sql`DATE_SUB(NOW(), INTERVAL 5 MINUTE)`),
            ),
          ),
        ),
      )
      .limit(100)
      .for("update", { skipLocked: true });
    for (const current of rows) {
      if (current.wamid) {
        await finalizeAcceptedInTx(tx, current, current.wamid);
        continue;
      }
      const safeToRetry =
        current.kind === "MEDIA_FETCH" ||
        (current.claimToken != null && current.providerStartedAt == null);
      await tx
        .update(waOutbox)
        .set(
          safeToRetry
            ? {
                status: "QUEUED",
                claimToken: null,
                claimExpiresAt: null,
                nextAttemptAt: sql`NOW()`,
              }
            : {
                status: "UNKNOWN",
                claimExpiresAt: null,
                lastError: UNKNOWN_ERROR,
              },
        )
        .where(eq(waOutbox.id, current.id));
      if (!safeToRetry)
        await syncCampaignRecipientIfAny(
          tx,
          current,
          "UNKNOWN",
          null,
          "OUTCOME_UNKNOWN",
        );
    }
  });
}

export interface OutboxReconciliation {
  outcome: "ACCEPTED" | "NOT_SENT";
  reason: string;
  evidence: string;
  wamid?: string;
}

/** Includes automation rows that never belonged to a conversation or campaign. */
export async function getUnknownOutboxForBranch(branchId: number) {
  return withTx(async (tx) => {
    const where = and(eq(waOutbox.branchId, branchId), eq(waOutbox.status, "UNKNOWN"));
    const counts = (await tx.select({ total: sql<number>`COUNT(*)` }).from(waOutbox).where(where))[0];
    const rows = await tx.select({ id: waOutbox.id, toPhoneE164: waOutbox.toPhoneE164, templateName: waOutbox.templateName, createdAt: waOutbox.createdAt }).from(waOutbox).where(where).orderBy(waOutbox.id).limit(50);
    return { total: Number(counts?.total ?? 0), rows };
  }, { gate: "NONE" });
}

/** Human evidence is mandatory and committed with the state transition; UNKNOWN is never a retry shortcut. */
export async function retryOutbox(
  id: number,
  actor: MaybeScopedActor,
  reconciliation?: OutboxReconciliation,
): Promise<{ status: "SENT" | "QUEUED" }> {
  return withTx(async (tx) => {
    const authority = await loadOperationUserTx(tx, actor.userId);
    const administrative = authority.role === "admin" || authority.isOwner === true;
    if (
      !operationDecision(authority, "conversations.retrySend").allowed ||
      (reconciliation && !administrative)
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّرت تسوية الإرسال",
          why: "التفويض الحالي لحسابك لا يسمح بهذا القرار",
          doThis: "حدّث الصفحة واطلب من الإدارة مراجعة صلاحية القنوات وقرار التسوية",
        }),
      });
    }
    if (
      !administrative && actor.branchId != null &&
      authority.branchId !== undefined &&
      Number(actor.branchId) !== Number(authority.branchId)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تغيّر فرع الحساب قبل إعادة الإرسال",
          why: "الفرع الحالي يختلف عن الفرع الذي فُتح به الطلب",
          doThis: "حدّث الصفحة وأعد المحاولة من الفرع الحالي",
        }),
      });
    }
    const row = (
      await tx
        .select()
        .from(waOutbox)
        .where(eq(waOutbox.id, id))
        .for("update")
        .limit(1)
    )[0];
    if (
      !row ||
      (!administrative &&
        (authority.branchId == null ||
          Number(authority.branchId) !== row.branchId))
    ) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر العثور على الإرسال",
          why: "السجل غير موجود ضمن الفرع المسموح",
          doThis: "ارجع إلى قائمة محادثات فرعك وحدّثها",
        }),
      });
    }
    if (!reconciliation) {
      if (row.status !== "FAILED") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّرت إعادة الإرسال",
            why: "النتيجة ليست فشلاً مؤكداً قبل قبول المزود",
            doThis:
              "راجع سجل المزود وسوِّ النتيجة المجهولة بدليل قبل أي محاولة جديدة",
          }),
        });
      }
      await logAuditTx(
        tx,
        { userId: actor.userId, branchId: row.branchId },
        {
          action: "whatsapp.retryOutbox",
          entityType: "waOutbox",
          entityId: id,
          oldValue: {
            providerAttemptId: row.providerAttemptId,
            wamid: row.wamid,
          },
          newValue: { status: "QUEUED" },
        },
      );
      await tx
        .update(waOutbox)
        .set({
          status: "QUEUED",
          attempts: 0,
          wamid: null,
          nextAttemptAt: sql`NOW()`,
          lastError: null,
          claimToken: null,
          claimExpiresAt: null,
        })
        .where(eq(waOutbox.id, id));
      return { status: "QUEUED" as const };
    }
    if (
      row.status !== "UNKNOWN" ||
      reconciliation.reason.trim().length < 10 ||
      reconciliation.evidence.trim().length < 10
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّرت تسوية الإرسال",
          why: "يلزم سجل بنتيجة مجهولة وسبب ودليل واضحان",
          doThis: "حدّث السجل واكتب مرجع المراجعة وسبب القرار",
        }),
      });
    }
    const wamid = reconciliation.wamid?.trim();
    if (reconciliation.outcome === "ACCEPTED") {
      const duplicate = wamid
        ? (
            await tx
              .select({ id: waOutbox.id })
              .from(waOutbox)
              .where(and(eq(waOutbox.wamid, wamid), ne(waOutbox.id, id)))
              .limit(1)
          )[0]
        : null;
      if (
        !wamid?.startsWith("wamid.") ||
        !/^\S{7,200}$/.test(wamid) ||
        duplicate ||
        (row.wamid != null && row.wamid !== wamid)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر إثبات قبول المزود",
            why: "معرّف wamid مفقود أو غير صالح أو مرتبط بإرسال آخر",
            doThis: "انسخ معرّف الرسالة الصحيح من سجل المزود",
          }),
        });
      }
      await finalizeAcceptedInTx(tx, row, wamid);
    } else if (row.wamid == null) {
      await tx
        .update(waOutbox)
        .set({
          status: "QUEUED",
          claimToken: null,
          claimExpiresAt: null,
          providerStartedAt: null,
          nextAttemptAt: sql`NOW()`,
          lastError: null,
        })
        .where(eq(waOutbox.id, id));
      if (row.campaignId != null)
        await tx
          .update(waBroadcastRecipients)
          .set({ recipientStatus: "QUEUED", errorCode: null })
          .where(eq(waBroadcastRecipients.outboxId, id));
    } else {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إقرار عدم القبول",
          why: "السجل يحمل معرّف قبول سابقاً من المزود",
          doThis: "راجع معرّف الرسالة وسجّل إثبات القبول المطابق",
        }),
      });
    }
    await logAuditTx(
      tx,
      { userId: actor.userId, branchId: row.branchId },
      {
        action: "whatsapp.reconcileOutbox",
        entityType: "waOutbox",
        entityId: id,
        oldValue: {
          status: row.status,
          providerAttemptId: row.providerAttemptId,
          providerStartedAt: row.providerStartedAt,
          wamid: row.wamid,
        },
        newValue: {
          outcome: reconciliation.outcome,
          reason: reconciliation.reason.trim(),
          evidence: reconciliation.evidence.trim(),
          wamid: wamid ?? null,
        },
      },
    );
    return {
      status: reconciliation.outcome === "ACCEPTED" ? "SENT" as const : "QUEUED" as const,
    };
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
async function applyFailure(
  row: WaOutbox,
  classification: GraphErrorClassification,
  detail: string,
  code: number | null = null,
): Promise<void> {
  const message = detail.slice(0, 500);
  const errorCode = code != null ? String(code) : null;
  if (classification === "retryable") {
    const attempts = row.attempts + 1;
    if (attempts >= 6) {
      await withClaimTx(row, async (tx) => {
        await tx
          .update(waOutbox)
          .set({ status: "FAILED", attempts, lastError: message })
          .where(eq(waOutbox.id, row.id));
        await syncCampaignRecipientIfAny(
          tx,
          row,
          "FAILED",
          row.wamid ?? null,
          errorCode,
        );
      });
      return;
    }
    const backoffMinutes = Math.min(2 ** attempts, 32);
    const jitterFactor = 1 + (Math.random() * 0.4 - 0.2); // ± ٢٠٪
    const nextAttemptAt = new Date(
      Date.now() + backoffMinutes * 60_000 * jitterFactor,
    );
    await withClaimTx(row, async (tx) => {
      await tx
        .update(waOutbox)
        .set({ status: "QUEUED", attempts, nextAttemptAt, lastError: message })
        .where(eq(waOutbox.id, row.id));
      // لا مزامنة مستلم هنا عمداً — الصفّ لا يزال QUEUED (إعادة محاولة لاحقة)، وcheckCircuitBreaker
      // يتجاهل QUEUED أصلاً (يقرأ فقط SENT/DELIVERED/READ/FAILED).
    });
    return;
  }
  await withClaimTx(row, async (tx) => {
    await tx
      .update(waOutbox)
      .set({ status: "FAILED", lastError: message })
      .where(eq(waOutbox.id, row.id));
    await syncCampaignRecipientIfAny(
      tx,
      row,
      "FAILED",
      row.wamid ?? null,
      errorCode,
    );
  });
}

// ── المعالجة (بعد الالتقاط) ───────────────────────────────────────────────────

async function cancelClaimedRow(row: WaOutbox, reason: string): Promise<void> {
  await withClaimTx(row, async (tx) => {
    await tx
      .update(waOutbox)
      .set({
        status: "CANCELLED",
        claimExpiresAt: null,
        lastError: reason.slice(0, 500),
      })
      .where(eq(waOutbox.id, row.id));
    await syncCampaignRecipientIfAny(tx, row, "CANCELLED", null, "CANCELLED");
  });
}

export type DispatchClaimedOutcome =
  | "PROCESSED"
  | "CANCELLED"
  | "SKIPPED"
  | "DEFERRED";

/** This commit is the cancellation boundary. Requests whose attempt already started may finish. */
async function beginProviderAttempt(
  row: WaOutbox,
  start = true,
): Promise<"READY" | Exclude<DispatchClaimedOutcome, "PROCESSED">> {
  return withTx<"READY" | Exclude<DispatchClaimedOutcome, "PROCESSED">>(async (tx) => {
    const campaign =
      row.campaignId == null
        ? null
        : (
            await tx
              .select()
              .from(waBroadcasts)
              .where(eq(waBroadcasts.id, row.campaignId))
              .for("update")
              .limit(1)
          )[0];
    const current = (
      await tx
        .select()
        .from(waOutbox)
        .where(eq(waOutbox.id, row.id))
        .for("update")
        .limit(1)
    )[0];
    if (
      !current ||
      current.status !== "SENDING" ||
      current.claimToken !== row.claimToken ||
      current.providerStartedAt
    )
      return "SKIPPED";
    const recipient =
      row.campaignId == null
        ? null
        : (
            await tx
              .select()
              .from(waBroadcastRecipients)
              .where(
                and(
                  eq(waBroadcastRecipients.outboxId, row.id),
                  eq(waBroadcastRecipients.broadcastId, row.campaignId),
                ),
              )
              .for("update")
              .limit(1)
          )[0];
    const customerId = current.customerId ?? recipient?.customerId ?? null;
    const customer =
      customerId == null
        ? null
        : (
            await tx
              .select({ waConsent: customers.waConsent })
              .from(customers)
              .where(eq(customers.id, customerId))
              .for("share")
              .limit(1)
          )[0];
    if (
      current.campaignId != null &&
      (!campaign || !recipient || campaign.broadcastStatus === "CANCELLED")
    ) {
      await tx
        .update(waOutbox)
        .set({
          status: "CANCELLED",
          claimExpiresAt: null,
          lastError: "أُلغيت الحملة أو لم يعد مصدر المستلم صالحاً.",
        })
        .where(eq(waOutbox.id, row.id));
      await syncCampaignRecipientIfAny(
        tx,
        current,
        "CANCELLED",
        null,
        "CAMPAIGN_CANCELLED",
      );
      return "CANCELLED";
    }
    if (
      current.campaignId != null &&
      !["RUNNING", "COMPLETED"].includes(campaign!.broadcastStatus)
    ) {
      await tx
        .update(waOutbox)
        .set({
          status: "QUEUED",
          claimToken: null,
          claimExpiresAt: null,
          nextAttemptAt: sql`DATE_ADD(NOW(), INTERVAL 1 MINUTE)`,
          lastError: "WA_CAMPAIGN_PAUSED",
        })
        .where(eq(waOutbox.id, row.id));
      return "DEFERRED";
    }
    if (
      (current.campaignId != null &&
        (!customer || customer.waConsent !== "OPTED_IN")) ||
      (customerId != null && (!customer || customer.waConsent === "OPTED_OUT"))
    ) {
      await tx
        .update(waOutbox)
        .set({
          status: "CANCELLED",
          customerId,
          claimExpiresAt: null,
          lastError: "أُلغي الإرسال لأن موافقة واتساب لم تعد صالحة.",
        })
        .where(eq(waOutbox.id, row.id));
      await syncCampaignRecipientIfAny(
        tx,
        current,
        current.campaignId != null ? "SKIPPED_OPTOUT" : "CANCELLED",
        null,
        "CONSENT_REVOKED",
      );
      return "CANCELLED";
    }
    if (!start) return "READY";
    const providerAttemptId = randomUUID();
    const providerStartedAt = new Date();
    await tx
      .update(waOutbox)
      .set({ providerAttemptId, providerStartedAt, customerId })
      .where(eq(waOutbox.id, row.id));
    await logAuditTx(
      tx,
      {
        branchId: row.branchId,
        actor: { source: "system", label: "عامل واتساب" },
      },
      {
        action: "whatsapp.providerAttemptStarted",
        entityType: "waOutbox",
        entityId: row.id,
        newValue: { providerAttemptId, providerStartedAt },
      },
    );
    row.providerAttemptId = providerAttemptId;
    row.providerStartedAt = providerStartedAt;
    return "READY";
  });
}

async function processClaimedRow(
  row: WaOutbox,
): Promise<DispatchClaimedOutcome> {
  const deliveryGuard = (
    row.payloadJson as {
      deliveryGuard?: {
        type?: unknown;
        reservationId?: unknown;
        expiresAt?: unknown;
      };
    } | null
  )?.deliveryGuard;
  if (deliveryGuard?.type === "RESERVATION_NEAR_EXPIRY") {
    const reservationId = Number(deliveryGuard.reservationId);
    const expiresAt = new Date(String(deliveryGuard.expiresAt ?? ""));
    const guardIsValid =
      Number.isSafeInteger(reservationId) &&
      reservationId > 0 &&
      !Number.isNaN(expiresAt.getTime());
    const reservation = guardIsValid
      ? (
          await requireDb()
            .select({ id: reservations.id })
            .from(reservations)
            .where(
              and(
                eq(reservations.id, reservationId),
                eq(reservations.status, "ACTIVE"),
                inArray(reservations.channel, ["PHONE", "WHATSAPP"]),
                eq(reservations.expiresAt, expiresAt),
                gt(reservations.expiresAt, sql`NOW()`),
                lt(
                  reservations.expiresAt,
                  sql`DATE_ADD(NOW(), INTERVAL 4 HOUR)`,
                ),
              ),
            )
            .limit(1)
        )[0]
      : null;
    if (!reservation) {
      await cancelClaimedRow(
        row,
        "أُلغي الإرسال لأن الحجز لم يعد قريب الانتهاء أو تغيّر موعده.",
      );
      return "CANCELLED";
    }
    const settings = (
      await requireDb()
        .select({ enabled: waHubSettings.flowReservationNearExpiry })
        .from(waHubSettings)
        .where(eq(waHubSettings.id, 1))
        .limit(1)
    )[0];
    if (!settings?.enabled) {
      await cancelClaimedRow(
        row,
        "أُلغي الإرسال لأن تدفق تنبيه قرب انتهاء الحجز معطّل.",
      );
      return "CANCELLED";
    }
  }

  if (row.customerId != null && row.campaignId == null) {
    const customer = (
      await requireDb()
        .select({ waConsent: customers.waConsent })
        .from(customers)
        .where(eq(customers.id, row.customerId))
        .limit(1)
    )[0];
    if (!customer || customer.waConsent === "OPTED_OUT") {
      await cancelClaimedRow(
        row,
        customer
          ? "أُلغي الإرسال لأن العميل ألغى موافقة واتساب."
          : "أُلغي الإرسال لأن سجل العميل لم يعد موجوداً.",
      );
      return "CANCELLED";
    }
  }

  if (row.kind !== "MEDIA_FETCH") {
    const eligibility = await beginProviderAttempt(row, false);
    if (eligibility !== "READY") return eligibility;
  }
  const integration = await getActiveWaIntegration(row.branchId);
  if (!integration) {
    await applyFailure(row, "permanent", "لا تكامل واتساب نشطاً لهذا الفرع.");
    return "PROCESSED";
  }
  const graphIntegration: GraphIntegration = {
    accessToken: integration.accessToken,
    phoneNumberId: integration.phoneNumberId,
    apiBaseUrl: integration.apiBaseUrl,
  };

  // فحص النافذة لـSESSION_TEXT وMEDIA فقط (القوالب معفاة) — الخادم مصدر الحقيقة لا فحص الواجهة.
  if (row.kind === "SESSION_TEXT" || row.kind === "MEDIA") {
    if (!(await isWithinFreeWindow(row.conversationId))) {
      await applyFailure(
        row,
        "permanent",
        GRAPH_ERROR_AR[131047] ??
          "نافذة المحادثة مغلقة — استخدم قالباً معتمداً.",
        131047,
      );
      return "PROCESSED";
    }
  }

  if (row.kind === "MEDIA_FETCH") {
    const result = await fetchInboundMedia(row, graphIntegration);
    if (result.ok) {
      await finalizeMediaFetchSuccess(row.id);
    } else {
      await applyFailure(
        row,
        result.permanent ? "permanent" : "retryable",
        result.detail,
      );
    }
    return "PROCESSED";
  }

  // PDF document media: render the immutable payload snapshot, upload it to
  // Meta, then send either a free-window document or a DOCUMENT-header
  // utility template.
  const documentPayload =
    (row.payloadJson as { document?: OutgoingPdfPayload } | null)?.document ??
    null;
  if ((row.kind === "MEDIA" || row.kind === "TEMPLATE") && documentPayload) {
    let bytes: Uint8Array;
    try {
      bytes = await generateOfficialDocumentPdf(documentPayload.pdfData);
    } catch (error) {
      await applyFailure(
        row,
        "permanent",
        error instanceof Error
          ? `تعذّر إنشاء ملف PDF: ${error.message}`
          : "تعذّر إنشاء ملف PDF.",
      );
      return "PROCESSED";
    }
    const uploadEligibility = await beginProviderAttempt(row, false);
    if (uploadEligibility !== "READY") return uploadEligibility;
    const uploaded = await uploadMedia(
      graphIntegration,
      bytes,
      "application/pdf",
      documentPayload.filename,
    );
    if (!uploaded.ok) {
      await applyFailure(
        row,
        uploaded.classification,
        uploaded.detail,
        uploaded.code,
      );
      return "PROCESSED";
    }
    const eligibility = await beginProviderAttempt(row);
    if (eligibility !== "READY") return eligibility;
    const sendResult =
      row.kind === "MEDIA"
        ? await sendDocumentByMediaId(
            graphIntegration,
            row.toPhoneE164 ?? "",
            uploaded.mediaId,
            documentPayload.filename,
            documentPayload.caption,
          )
        : await sendDocumentTemplate(
            graphIntegration,
            row.toPhoneE164 ?? "",
            row.templateName ?? "",
            row.templateLang ?? "ar",
            uploaded.mediaId,
            documentPayload.filename,
            (row.payloadJson as { bodyParams?: string[] }).bodyParams ?? [],
          );
    if (sendResult.ok) {
      await finalizeSendSuccess(row, sendResult.wamid);
    } else if (sendResult.outcomeUnknown) {
      await markUnknown(row);
    } else {
      await applyFailure(
        row,
        sendResult.classification,
        sendResult.detail,
        sendResult.code,
      );
    }
    return "PROCESSED";
  }

  if (row.kind === "MEDIA") {
    await applyFailure(row, "permanent", "حمولة الوسائط الصادرة غير صالحة.");
    return "PROCESSED";
  }

  // SESSION_TEXT / TEMPLATE
  const eligibility = await beginProviderAttempt(row);
  if (eligibility !== "READY") return eligibility;
  let sendResult: SendResult;
  if (row.kind === "SESSION_TEXT") {
    // `buttons` في الحمولة (T4.2/CSAT) ⇒ رسالة تفاعلية بأزرار ردّ سريع بدل نصّ عادي — بلا قيمة kind
    // جديدة (لا هجرة: "INTERACTIVE" غير موجود في تعداد waOutbox.kind). فحص النافذة أعلاه يشملها
    // (SESSION_TEXT/MEDIA فقط) تماماً كالنصّ العادي — القوالب فقط معفاة.
    const payload = row.payloadJson as {
      text?: string;
      buttons?: Array<{ id: string; title: string }>;
    };
    sendResult =
      payload.buttons && payload.buttons.length > 0
        ? await sendInteractiveButtons(
            graphIntegration,
            row.toPhoneE164 ?? "",
            payload.text ?? "",
            payload.buttons,
          )
        : await sendSessionText(
            graphIntegration,
            row.toPhoneE164 ?? "",
            payload.text ?? "",
          );
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
  } else if (sendResult.outcomeUnknown) {
    await markUnknown(row);
  } else {
    // إغلاق حلقة قاطع الجودة (T5.2 hotfix): sendResult.code هو رمز خطأ Meta الرقمي (131048/131056/
    // 130429/...) حين وصل متزامناً على استجابة Graph POST نفسها — يُمرَّر إلى applyFailure ليصل
    // بدوره لمستلم الحملة (syncCampaignRecipientIfAny) فيراه checkCircuitBreaker.
    await applyFailure(
      row,
      sendResult.classification,
      sendResult.detail,
      sendResult.code,
    );
  }
  return "PROCESSED";
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
        .where(
          and(
            eq(waOutbox.id, id),
            eq(waOutbox.status, "QUEUED"),
            or(
              isNull(waOutbox.nextAttemptAt),
              lte(waOutbox.nextAttemptAt, sql`NOW()`),
            ),
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    if (!row) return null;
    const claim = outboxClaimValues();
    await tx.update(waOutbox).set(claim).where(eq(waOutbox.id, id));
    return { ...row, ...claim };
  });
}

/** يُنفَّذ بعد أن يكون الصفّ SENDING فعلاً (من claimRowForDispatch أو من التقاط دفعة الكنّاس) — لا
 *  يُعيد الالتقاط، فقط يُعالج. مُصدَّرة ليستعملها outboxSweeper بعد SELECT...FOR UPDATE SKIP LOCKED
 *  الدفعي (يُشارك نفس منطق الإرسال/التصنيف/الباكوف دون تكرار — «صمّم التقسيم الداخلي كيف شئت»). */
export async function dispatchClaimedRow(
  id: number,
): Promise<DispatchClaimedOutcome> {
  const db = requireDb();
  const row = (
    await db.select().from(waOutbox).where(eq(waOutbox.id, id)).limit(1)
  )[0];
  if (!row || row.status !== "SENDING") return "SKIPPED"; // تأمين إضافي — لا يُفترض حدوثه في الاستعمال الطبيعي.
  try {
    return await processClaimedRow(row);
  } catch (e) {
    logger.error(
      { err: e, outboxId: id },
      "wa-outbox: dispatch threw an unexpected error",
    );
    // خطأ غير متوقّع (لا SendResult ولا MediaFetchResult) ⇒ نعامله retryable حتى لا يعلق الصفّ
    // SENDING للأبد (بلا هذه المعالجة، استثناء برمجي يُسقِط الصفّ من كل دورات الكنّاس التالية).
    if (row.providerStartedAt && row.kind !== "MEDIA_FETCH")
      await markUnknown(row);
    else
      await applyFailure(
        row,
        "retryable",
        e instanceof Error ? e.message : "خطأ غير متوقّع أثناء الإرسال.",
      );
    return "PROCESSED";
  }
}

/** نقطة الدخول العامة لإرسال صفّ واحد فوراً — تلتقطه (SENDING) ثم تُعالجه. idempotent: صفّ ليس
 *  QUEUED أو موعده لم يحن بعد ⇒ خروج صامت بلا أثر (استدعاء متزامن مع الكنّاس آمن دائماً). */
export async function dispatchOutboxRow(id: number): Promise<void> {
  const claimed = await claimRowForDispatch(id);
  if (!claimed) return;
  await dispatchClaimedRow(id);
}
