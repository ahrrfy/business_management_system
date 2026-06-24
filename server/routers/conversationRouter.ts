import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { conversations } from "../../drizzle/schema";
import { getDb } from "../db";
import { branchScopedProcedure, cashierProcedure, router } from "../trpc";
import {
  addMessage,
  getConversationMessages,
  linkConversationToWorkOrder,
  listConversations,
  markConversationRead,
  setConversationStatus,
  upsertConversation,
} from "../services/conversationService";

const channelEnum = z.enum(["WHATSAPP", "INSTAGRAM", "TIKTOK", "STORE", "PHONE", "WALK_IN", "OTHER"]);

/**
 * صَندوق الوارد المُوحَّد — tRPC.
 *
 * الصَلاحيات:
 *   - list/get/messages: branchScopedProcedure (عَزل فُروع تِلقائي عبر ctx.scopedBranchId).
 *   - create/send/mark/link/setStatus: cashierProcedure (الكاشير يَتعامل مع الزَبائن مُباشرة).
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

async function assertConversationBranch(conversationId: number, scopedBranchId: number | null) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البَيانات غَير مُتاحة" });
  const row = (
    await db
      .select({ id: conversations.id, branchId: conversations.branchId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
  )[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "المحادثة غَير مَوجودة" });
  if (scopedBranchId != null && Number(row.branchId) !== scopedBranchId) {
    // لا نَكشف وجود مُحادثة فَرع آخَر ⇒ NOT_FOUND بَدل FORBIDDEN.
    throw new TRPCError({ code: "NOT_FOUND", message: "المحادثة غَير مَوجودة" });
  }
  return Number(row.branchId);
}

export const conversationRouter = router({
  /** قائمة الـinbox للفَرع الحالي. */
  list: branchScopedProcedure
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
      return listConversations(
        { branchId: effectiveBranchId, filter: input?.filter, channel: input?.channel, limit: input?.limit },
      );
    }),

  /** رَسائل مُحادثة مُحدَّدة (بَعد التَحقّق من عَزل الفُروع). */
  messages: branchScopedProcedure
    .input(z.object({ conversationId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      await assertConversationBranch(input.conversationId, ctx.scopedBranchId);
      return getConversationMessages(input.conversationId);
    }),

  /** إنشاء/upsert مُحادثة (إدخال يَدوي مِن الكاشير: اتصال هاتفي، حُضوري، ...). */
  upsert: cashierProcedure
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

  /** إرسال رِسالة OUT أو تَسجيل IN يَدوياً (لاتصال هاتفي). */
  sendMessage: cashierProcedure
    .input(z.object({
      conversationId: z.number().int().positive(),
      direction: z.enum(["IN", "OUT", "NOTE"]),
      body: z.string().max(65500).nullable().optional(),
      mediaUrl: z.string().url().nullable().optional(),
      mediaType: z.string().max(40).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertConversationBranch(input.conversationId, deriveScopedBranchId(ctx.user));
      if (!input.body?.trim() && !input.mediaUrl) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "رِسالة فارِغة — أَدخل نَصّاً أو مَرفقاً" });
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

  /** تَصفير عَدّاد غَير المَقروء. */
  markRead: cashierProcedure
    .input(z.object({ conversationId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const scopedBranchId = deriveScopedBranchId(ctx.user);
      await assertConversationBranch(input.conversationId, scopedBranchId);
      return markConversationRead(input.conversationId, { userId: Number(ctx.user.id), branchId: scopedBranchId ?? 0 });
    }),

  /** رَبط/فَصل مُحادثة بأَمر شَغل. */
  linkWorkOrder: cashierProcedure
    .input(z.object({
      conversationId: z.number().int().positive(),
      workOrderId: z.number().int().positive().nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertConversationBranch(input.conversationId, deriveScopedBranchId(ctx.user));
      return linkConversationToWorkOrder(input.conversationId, input.workOrderId);
    }),

  /** تَأرشيف/إغلاق مُحادثة. */
  setStatus: cashierProcedure
    .input(z.object({
      conversationId: z.number().int().positive(),
      status: z.enum(["OPEN", "ARCHIVED", "CLOSED"]),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertConversationBranch(input.conversationId, deriveScopedBranchId(ctx.user));
      return setConversationStatus(input.conversationId, input.status);
    }),
});
