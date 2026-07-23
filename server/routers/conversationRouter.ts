import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { channelIntegrations, conversationMessages, conversations, customers, users, waOutbox } from "../../drizzle/schema";
import { getDb } from "../db";
import { logger } from "../logger";
import { branchScopedProcedure, cashierProcedure, requireModule, router } from "../trpc";
import { logAudit } from "../services/auditService";
import {
  addMessage,
  linkConversationToWorkOrder,
  listConversations,
  markConversationRead,
  setConversationStatus,
  upsertConversation,
} from "../services/conversationService";
// الاستهلاك الخارجي لِمَركَز واتساب الأَعمال يَمُرّ عَبر البِرميل `services/whatsapp` حَصراً (تَعليق
// index.ts) — لا اِستيراد مُباشر مِن outboxService/sendService داخِل هَذا الراوتر.
import { dispatchOutboxRow, enqueueAndDispatch, getActiveWaIntegration } from "../services/whatsapp";

const channelEnum = z.enum(["WHATSAPP", "INSTAGRAM", "TIKTOK", "STORE", "PHONE", "WALK_IN", "OTHER"]);

/**
 * صَندوق الوارد المُوحَّد — tRPC.
 *
 * الصَلاحيات:
 *   - list/get/messages: branchScopedProcedure (عَزل فُروع تِلقائي عبر ctx.scopedBranchId).
 *   - create/send/mark/link/setStatus: channelsWrite (الكاشير يَتعامل مع الزَبائن مُباشرة).
 *
 * IDOR: نَفحص branchId المحادثة قَبل أَي تَعديل ⇒ مَنع كاشير الفَرع X مِن تَعديل مُحادثات الفَرع Y.
 */

/** يَستخرج scopedBranchId مِن ctx.user (للـcashierProcedure الذي لا يَحقنها).
 *  مدير/أدمن ⇒ null (لا قَيد فرع)؛ غَيرهما ⇒ branchId الإلزامي (مَفروض في requireOwnBranch). */
function deriveScopedBranchId(ctxUser: { role: string; branchId?: number | string | null }): number | null {
  const elevated = ctxUser.role === "admin" || ctxUser.role === "manager";
  if (elevated) return null;
  return ctxUser.branchId != null ? Number(ctxUser.branchId) : null;
}

/** يَتحقّق مِن عَزل الفَرع ويُعيد صَفّ المحادثة كامِلاً (channel/channelHandle/lastInboundAt) — مُعظَم
 *  المُستدعين يَستعملونها لِأَثَرها الجانِبي فَقط (الرَمي عِند IDOR) ويُهملون القيمة المُعادة؛
 *  sendMessage يَستهلك الحُقول الإضافِية لِقَرار إعادة التَوصيل عبر الصَندوق الصادِر. */
async function assertConversationBranch(conversationId: number, scopedBranchId: number | null) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البَيانات غَير مُتاحة" });
  const row = (
    await db
      .select({
        id: conversations.id,
        branchId: conversations.branchId,
        channel: conversations.channel,
        channelHandle: conversations.channelHandle,
        lastInboundAt: conversations.lastInboundAt,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
  )[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "المحادثة غَير مَوجودة" });
  if (scopedBranchId != null && Number(row.branchId) !== scopedBranchId) {
    // لا نَكشف وجود مُحادثة فَرع آخَر ⇒ NOT_FOUND بَدل FORBIDDEN.
    throw new TRPCError({ code: "NOT_FOUND", message: "المحادثة غَير مَوجودة" });
  }
  return { ...row, branchId: Number(row.branchId) };
}

// إنفاذ وحدة «القنوات» (channels) فَوق عَزل الفرع/الدور: قراءة للعرض، FULL للتعديل.
// (admin يَتجاوز requireModule؛ القوالب تُطابق الوصول الحالي ⇒ صفر تَغيير للأدوار المبنية،
//  ودَور مُخصَّص بـchannels=NONE يُحجَب فِعلياً — لا «وهم اكتمال».)
const channelsRead = branchScopedProcedure.use(requireModule("channels", "READ"));
const channelsWrite = cashierProcedure.use(requireModule("channels", "FULL"));

export const conversationRouter = router({
  /** قائمة الـinbox للفَرع الحالي. */
  list: channelsRead
    .input(z.object({
      filter: z.enum(["all", "unread", "archived", "closed"]).optional(),
      channel: channelEnum.optional(),
      limit: z.number().int().positive().max(500).optional(),
      branchId: z.number().int().positive().optional(),
    }).optional())
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      const effectiveBranchId = ctx.scopedBranchId ?? input?.branchId;
      if (effectiveBranchId == null) {
        // أَدمن بَلا فَلتر فَرع ⇒ يَلزمه تَحديد branchId صَراحة.
        throw new TRPCError({ code: "BAD_REQUEST", message: "حَدّد branchId للقائمة" });
      }
      const rows = await listConversations(
        { branchId: effectiveBranchId, filter: input?.filter, channel: input?.channel, limit: input?.limit },
      );
      if (rows.length === 0) return [];

      // إثراء (بَند ٤ — نَواة Cloud API): lastInboundAt/windowExpiresAt/assignedTo لَيسَت في
      // مُخرَجات listConversations القائمة (تَخدم شَرائح أُخرى بِلا حاجة لَها) ⇒ اِستعلام إضافي
      // خَفيف على نَفس الصُفوف (استهلاك الخدمة القائمة + إثراء هُنا — لا تَعديل conversationService).
      const ids = rows.map((r) => Number(r.id));
      const extra = await db
        .select({ id: conversations.id, lastInboundAt: conversations.lastInboundAt, assignedTo: conversations.assignedTo })
        .from(conversations)
        .where(inArray(conversations.id, ids));
      const extraMap = new Map(extra.map((e) => [Number(e.id), e]));

      // apiActive: كل صُفوف القائمة تَتبَع effectiveBranchId نَفسه (فَرع واحِد لِكُلّ نِداء list)
      // ⇒ فَحص واحِد يَكفي بَدل استعلام لِكُلّ مُحادثة.
      const activeWa = (
        await db
          .select({ id: channelIntegrations.id })
          .from(channelIntegrations)
          .where(and(
            eq(channelIntegrations.branchId, effectiveBranchId),
            eq(channelIntegrations.channel, "WHATSAPP"),
            eq(channelIntegrations.status, "ACTIVE"),
          ))
          .limit(1)
      )[0];
      const hasActiveWa = !!activeWa;

      return rows.map((r) => {
        const ex = extraMap.get(Number(r.id));
        const lastInboundAt = ex?.lastInboundAt ?? null;
        const windowExpiresAt = lastInboundAt ? new Date(lastInboundAt.getTime() + 24 * 3600 * 1000) : null;
        return {
          ...r,
          lastInboundAt,
          windowExpiresAt,
          assignedTo: ex?.assignedTo ?? null,
          // تَعطيل الملحن واجهياً مَشروط بِتَكامل ACTIVE فِعلي (§المَبدأ الحاكِم) — قَناة غَير
          // WHATSAPP أَو بِلا تَكامل ⇒ false دائماً (السُلوك القَديم بِلا أَي قَيد نافِذة).
          apiActive: r.channel === "WHATSAPP" && hasActiveWa,
        };
      });
    }),

  /** رَسائل مُحادثة مُحدَّدة (بَعد التَحقّق من عَزل الفُروع) — مُثراة بِحُقول التَسليم/المَصدر (بَند ٤)
   *  ومُلحَقة بِصُفوف الصَندوق الصادِر المُعلَّقة/الفاشِلة كَعَناصر زائفة (pending) — SENT تَظهر
   *  كصَفّ حَقيقي أَصلاً بَعد finalizeSendSuccess، فلا ازدواج. اِستعلام مُباشِر هُنا (لا
   *  getConversationMessages مِن conversationService، القاصِرة عن الحُقول الجَديدة) — نَمط
   *  assertConversationBranch القائم في هَذا المِلَفّ. */
  messages: channelsRead
    .input(z.object({ conversationId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      await assertConversationBranch(input.conversationId, ctx.scopedBranchId);
      const db = getDb();
      if (!db) return [];

      const real = await db
        .select({
          id: conversationMessages.id,
          direction: conversationMessages.direction,
          body: conversationMessages.body,
          mediaUrl: conversationMessages.mediaUrl,
          mediaType: conversationMessages.mediaType,
          authorUserId: conversationMessages.authorUserId,
          authorName: users.name,
          deliveryStatus: conversationMessages.deliveryStatus,
          statusUpdatedAt: conversationMessages.statusUpdatedAt,
          errorCode: conversationMessages.errorCode,
          origin: conversationMessages.origin,
          templateName: conversationMessages.templateName,
          createdAt: conversationMessages.createdAt,
        })
        .from(conversationMessages)
        .leftJoin(users, eq(conversationMessages.authorUserId, users.id))
        .where(eq(conversationMessages.conversationId, input.conversationId))
        .orderBy(conversationMessages.createdAt);

      const pendingRows = await db
        .select({
          outboxId: waOutbox.id,
          status: waOutbox.status,
          lastError: waOutbox.lastError,
          payloadJson: waOutbox.payloadJson,
          createdAt: waOutbox.createdAt,
        })
        .from(waOutbox)
        .where(and(
          eq(waOutbox.conversationId, input.conversationId),
          eq(waOutbox.kind, "SESSION_TEXT"),
          inArray(waOutbox.status, ["QUEUED", "SENDING", "FAILED"]),
        ))
        .orderBy(waOutbox.createdAt);

      const merged = [
        ...real.map((r) => ({ ...r, pending: null as null | { outboxId: number; status: string; lastError: string | null } })),
        ...pendingRows.map((p) => ({
          // مُعَرّف سالِب — لا يَتقاطِع أَبداً مَع bigint autoincrement الحَقيقي (دائماً > 0)، بَديل
          // مِفتاح React مُستقرّ بَلا استعارة نِطاق مُعَرّفات الرَسائل الحَقيقية.
          id: -Number(p.outboxId),
          direction: "OUT" as const,
          body: String((p.payloadJson as { text?: string } | null)?.text ?? ""),
          mediaUrl: null as string | null,
          mediaType: null as string | null,
          authorUserId: null as number | null,
          authorName: null as string | null,
          deliveryStatus: null as "PENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED" | null,
          statusUpdatedAt: null as Date | null,
          errorCode: null as string | null,
          origin: null as "API" | "PHONE_APP" | "SYSTEM" | null,
          templateName: null as string | null,
          createdAt: p.createdAt,
          pending: { outboxId: Number(p.outboxId), status: p.status, lastError: p.lastError },
        })),
      ];

      return merged.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }),

  /** إنشاء/upsert مُحادثة (إدخال يَدوي مِن الكاشير: اتصال هاتفي، حُضوري، ...). */
  upsert: channelsWrite
    .input(z.object({
      branchId: z.number().int().positive().optional(),
      channel: channelEnum,
      channelHandle: z.string().min(1).max(120),
      customerId: z.number().int().positive().nullable().optional(),
      displayName: z.string().max(200).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const scopedBranchId = deriveScopedBranchId(ctx.user);
      const effectiveBranchId = scopedBranchId ?? input.branchId;
      if (effectiveBranchId == null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "حَدّد branchId" });
      }
      return upsertConversation({
        branchId: effectiveBranchId,
        channel: input.channel,
        channelHandle: input.channelHandle,
        customerId: input.customerId ?? null,
        displayName: input.displayName ?? null,
      });
    }),

  /** إرسال رِسالة OUT، أو تَسجيل IN/NOTE يَدوياً (لاتصال هاتفي/مُلاحظة داخِلية).
   *
   *  إعادة تَوصيل (نَواة Cloud API، شَريحة #١): OUT نَصّي لِمُحادثة WHATSAPP لَها تَكامل WHATSAPP
   *  بِحالة ACTIVE على فَرعِها ⇒ يُسلَك عَبر الصَندوق الصادِر (`enqueueAndDispatch`) بَدل إدراج صَفّ
   *  مُباشِر — الصَفّ الحَقيقي يُدرَج ذَرّياً عِند نَجاح الإرسال الفِعلي (outboxService.finalizeSendSuccess)
   *  لا هُنا. **المَبدأ الحاكِم (صِفر تَغيير سُلوكي بِلا تَكامل مُفعَّل):** IN/NOTE (سِجلّ يَدوي دائماً،
   *  لَيسَ إرسالاً فِعلياً)، قَنوات غَير WHATSAPP، مُحادثات WHATSAPP بِلا تَكامل ACTIVE، ورَسائل
   *  OUT بِلا نَصّ (وَسائط فَقط — الصَندوق الصادِر لا يَدعم إرسال وَسائط صادِرة بَعد، kind=MEDIA
   *  في outboxService لا يَزال طَريقاً مَسدوداً) — كُلّها تَسلُك المَسار القَديم حَرفياً. */
  sendMessage: channelsWrite
    .input(z.object({
      conversationId: z.number().int().positive(),
      direction: z.enum(["IN", "OUT", "NOTE"]),
      body: z.string().max(65500).nullable().optional(),
      mediaUrl: z.string().url().nullable().optional(),
      mediaType: z.string().max(40).nullable().optional(),
      clientRequestId: z.string().max(64).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const conv = await assertConversationBranch(input.conversationId, deriveScopedBranchId(ctx.user));
      if (!input.body?.trim() && !input.mediaUrl) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "رِسالة فارِغة — أَدخل نَصّاً أو مَرفقاً" });
      }

      if (input.direction === "OUT" && conv.channel === "WHATSAPP" && input.body?.trim()) {
        const integration = await getActiveWaIntegration(conv.branchId);
        if (integration) {
          // فَحص النافِذة هُنا أَيضاً (رِسالة خَطأ مُبكِّرة أَوضَح) — الفَحص النِهائي داخِل dispatch
          // (isWithinFreeWindow) يَبقى الحاكِم فِعلياً (fail-closed حَتى لَو تَغيَّرت الحالة بَين
          // هَذا الفَحص وَلَحظة الإرسال الفِعلية).
          const windowOpen = conv.lastInboundAt != null && Date.now() - conv.lastInboundAt.getTime() < 24 * 3600 * 1000;
          if (!windowOpen) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "نافذة المحادثة مغلقة (٢٤ ساعة) — الإرسال متاح بقالب معتمد فقط، تفعيلها في شريحة القوالب.",
            });
          }
          const dedupeKey = `CHAT:${input.conversationId}:${input.clientRequestId?.trim() || nanoid()}`;
          // channelHandle لِـWHATSAPP = wa_id خام (بِلا "+"، نَمط webhookProcessor/contactResolver).
          const toPhoneE164 = conv.channelHandle.startsWith("+") ? conv.channelHandle : `+${conv.channelHandle}`;
          const { id: outboxId } = await enqueueAndDispatch({
            dedupeKey,
            branchId: conv.branchId,
            conversationId: input.conversationId,
            toPhoneE164,
            kind: "SESSION_TEXT",
            payloadJson: { text: input.body.trim() },
            createdBy: Number(ctx.user.id),
          });
          return { queued: true as const, outboxId };
        }
      }

      return addMessage({
        conversationId: input.conversationId,
        direction: input.direction,
        body: input.body ?? null,
        mediaUrl: input.mediaUrl ?? null,
        mediaType: input.mediaType ?? null,
        authorUserId: input.direction === "IN" ? null : Number(ctx.user.id),
      });
    }),

  /** رَبط مُحادثة بِعَميل مَوجود نَشِط (شَريحة الوارِد — الكاشير يَتعرَّف عَلى الزَبون أَثناء المُحادثة). */
  linkCustomer: channelsWrite
    .input(z.object({
      conversationId: z.number().int().positive(),
      customerId: z.number().int().positive(),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertConversationBranch(input.conversationId, deriveScopedBranchId(ctx.user));
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البَيانات غَير مُتاحة" });
      const customer = (
        await db
          .select({ id: customers.id, isActive: customers.isActive })
          .from(customers)
          .where(eq(customers.id, input.customerId))
          .limit(1)
      )[0];
      if (!customer || !customer.isActive) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "العَميل غَير مَوجود أو غَير نَشِط" });
      }
      await db.update(conversations).set({ customerId: input.customerId }).where(eq(conversations.id, input.conversationId));
      await logAudit(ctx, {
        action: "conversation.linkCustomer",
        entityType: "conversation",
        entityId: input.conversationId,
        newValue: { customerId: input.customerId },
      });
      return { conversationId: input.conversationId, customerId: input.customerId };
    }),

  /** إعادة مُحاولة إرسال صَفّ صَندوق صادِر فاشِل (زِرّ «أَعِد المُحاولة» في الوارِد). */
  retrySend: channelsWrite
    .input(z.object({ outboxId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البَيانات غَير مُتاحة" });
      const row = (
        await db
          .select({
            id: waOutbox.id,
            status: waOutbox.status,
            kind: waOutbox.kind,
            conversationId: waOutbox.conversationId,
          })
          .from(waOutbox)
          .where(eq(waOutbox.id, input.outboxId))
          .limit(1)
      )[0];
      if (!row || row.kind !== "SESSION_TEXT" || row.conversationId == null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "لا يوجَد صَفّ إرسال بِهَذا المُعَرّف" });
      }
      // عَزل الفُروع: صَفّ الصَندوق الصادِر يُنسَب لِفَرع مُحادثته — نَفس نَمط الرَسائل.
      await assertConversationBranch(Number(row.conversationId), deriveScopedBranchId(ctx.user));
      if (row.status !== "FAILED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يُمكن إعادة مُحاولة إرسالٍ لَيس بِحالة فَشل" });
      }
      await db
        .update(waOutbox)
        .set({ status: "QUEUED", attempts: 0, nextAttemptAt: sql`NOW()`, lastError: null })
        .where(eq(waOutbox.id, input.outboxId));
      // مُحاولة فَورية غَير مُتزامِنة — نَفس نَمط enqueueAndDispatch (outboxService.ts): لا نَنتظر
      // النَتيجة، الكَنّاس يَلتَقط أَي فَشل خِلال دَقيقة عَلى أَي حال.
      setImmediate(() => {
        void dispatchOutboxRow(input.outboxId).catch((e) => {
          logger.error({ err: e, outboxId: input.outboxId }, "wa-outbox: retrySend immediate dispatch attempt failed");
        });
      });
      return { outboxId: input.outboxId, ok: true as const };
    }),

  /** تَصفير عَدّاد غَير المَقروء. */
  markRead: channelsWrite
    .input(z.object({ conversationId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const scopedBranchId = deriveScopedBranchId(ctx.user);
      await assertConversationBranch(input.conversationId, scopedBranchId);
      return markConversationRead(input.conversationId, { userId: Number(ctx.user.id), branchId: scopedBranchId ?? 0 });
    }),

  /** رَبط/فَصل مُحادثة بأَمر شَغل. */
  linkWorkOrder: channelsWrite
    .input(z.object({
      conversationId: z.number().int().positive(),
      workOrderId: z.number().int().positive().nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertConversationBranch(input.conversationId, deriveScopedBranchId(ctx.user));
      return linkConversationToWorkOrder(input.conversationId, input.workOrderId);
    }),

  /** تَأرشيف/إغلاق مُحادثة. */
  setStatus: channelsWrite
    .input(z.object({
      conversationId: z.number().int().positive(),
      status: z.enum(["OPEN", "ARCHIVED", "CLOSED"]),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertConversationBranch(input.conversationId, deriveScopedBranchId(ctx.user));
      return setConversationStatus(input.conversationId, input.status);
    }),
});
