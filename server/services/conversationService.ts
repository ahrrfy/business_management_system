import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { conversationMessages, conversations, customers, users, workOrders } from "../../drizzle/schema";
import { getDb } from "../db";
import { withTx, type Actor } from "./tx";

/**
 * صَندوق الوارد المُوحَّد — شَريحة #5.
 *
 * المَنطق:
 *   - upsertConversation: webhook أو إدخال يَدوي ⇒ نُحدّث المحادثة القائمة (channel + handle + branch)
 *     أو نُنشئ جَديدة. ذَرّي عبر UNIQUE قَيد يَمنع التَكَرار حَتى مع طَلَبات مُتزامنة.
 *   - addMessage: تَزيد unreadCount لِـIN فَقط (مُوظَّفنا لا يَزيد عَدّاد عَلى نَفسه).
 *     تُحدّث lastMessageAt/lastMessagePreview ⇒ الـinbox يَفرز بَلا scan.
 *   - markRead: تُصَفّر العَدّاد. مُوظَّف فَتح المحادثة ⇒ قَرَأ.
 *
 * عَزل الفُروع: كل العَمليات تَتطلَّب branchId. الـbranchScopedProcedure يَفرضه على tRPC.
 */

export type ChannelKind = "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "STORE" | "PHONE" | "WALK_IN" | "OTHER";
export type Direction = "IN" | "OUT" | "NOTE";

export interface UpsertConversationInput {
  branchId: number;
  channel: ChannelKind;
  channelHandle: string;
  customerId?: number | null;
  displayName?: string | null;
}

export interface AddMessageInput {
  conversationId: number;
  direction: Direction;
  body?: string | null;
  mediaUrl?: string | null;
  mediaType?: string | null;
  externalId?: string | null;
  authorUserId?: number | null;
  deliveryStatus?: "PENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED" | null;
}

/** preview نَصّ مَختصَر للـlist — قَطع آمن على مَنتصف كَلمة. */
function previewOf(body: string | null | undefined, mediaType: string | null | undefined): string {
  if (body && body.trim()) {
    const t = body.trim().replace(/\s+/g, " ");
    return t.length > 280 ? t.slice(0, 277) + "…" : t;
  }
  if (mediaType?.startsWith("image/")) return "🖼 صورة";
  if (mediaType?.startsWith("audio/")) return "🎤 صوت";
  if (mediaType === "application/pdf") return "📄 ملف PDF";
  if (mediaType) return "📎 مَلف وَسائط";
  return "(رِسالة فارِغة)";
}

/** يُنشئ مُحادثة جَديدة أو يُعيد القائمة (channel + handle + branch) بَلا duplicate.
 *  الذَرّية: INSERT ... ON DUPLICATE KEY UPDATE id=id لا تَعمل على MySQL مع AUTO_INCREMENT id
 *  (يُهدر id-pool). نَستعمل SELECT ثم INSERT داخل TX، والـUNIQUE قَيد يَحمي السُباق:
 *  لو فاز INSERT آخر بَيننا ⇒ يَفشل INSERT الثاني بـER_DUP_ENTRY ⇒ نُعيد SELECT. */
export async function upsertConversation(input: UpsertConversationInput): Promise<{ id: number; isNew: boolean }> {
  if (!input.channelHandle.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "channelHandle مَطلوب" });
  }
  const handle = input.channelHandle.trim().slice(0, 120);
  return withTx(async (tx) => {
    const existing = (
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(
          eq(conversations.channel, input.channel),
          eq(conversations.channelHandle, handle),
          eq(conversations.branchId, input.branchId),
        ))
        .limit(1)
    )[0];
    if (existing) {
      // حَدّث customerId/displayName لو كانت فارِغة (تَعرّفنا على الزَبون لاحقاً).
      if (input.customerId != null || input.displayName != null) {
        const updates: Record<string, unknown> = {};
        if (input.customerId != null) updates.customerId = input.customerId;
        if (input.displayName != null) updates.displayName = input.displayName.slice(0, 200);
        if (Object.keys(updates).length > 0) {
          await tx.update(conversations).set(updates).where(eq(conversations.id, Number(existing.id)));
        }
      }
      return { id: Number(existing.id), isNew: false };
    }
    try {
      const res = await tx.insert(conversations).values({
        branchId: input.branchId,
        channel: input.channel,
        channelHandle: handle,
        customerId: input.customerId ?? null,
        displayName: input.displayName?.slice(0, 200) ?? null,
      });
      const id = Number((res as any)?.[0]?.insertId ?? (res as any)?.insertId);
      return { id, isNew: true };
    } catch (e: any) {
      // سُباق مع كاتب آخر فاز بـINSERT ⇒ اِسترجع السجلّ الفائز.
      if (String(e?.code ?? "").includes("DUP")) {
        const r = (
          await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(and(
              eq(conversations.channel, input.channel),
              eq(conversations.channelHandle, handle),
              eq(conversations.branchId, input.branchId),
            ))
            .limit(1)
        )[0];
        if (r) return { id: Number(r.id), isNew: false };
      }
      throw e;
    }
  });
}

/** يُضيف رِسالة، يُحدّث lastMessage*، يَزيد unread لِـIN فَقط. */
export async function addMessage(input: AddMessageInput): Promise<{ messageId: number; deduped: boolean }> {
  return withTx(async (tx) => {
    // dedup webhook retries بِـexternalId UNIQUE.
    if (input.externalId) {
      const dup = (
        await tx
          .select({ id: conversationMessages.id })
          .from(conversationMessages)
          .where(eq(conversationMessages.externalId, input.externalId))
          .limit(1)
      )[0];
      if (dup) return { messageId: Number(dup.id), deduped: true };
    }
    // تَحقَّق أن المحادثة مَوجودة (FK سَيَفشل تِلقائياً، لكن نُرسل رِسالة أَوضح).
    const conv = (
      await tx
        .select({ id: conversations.id, branchId: conversations.branchId })
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .limit(1)
    )[0];
    if (!conv) throw new TRPCError({ code: "NOT_FOUND", message: "المحادثة غَير مَوجودة" });

    const insRes = await tx.insert(conversationMessages).values({
      conversationId: input.conversationId,
      direction: input.direction,
      body: input.body?.slice(0, 65500) ?? null,
      mediaUrl: input.mediaUrl ?? null,
      mediaType: input.mediaType?.slice(0, 40) ?? null,
      externalId: input.externalId ?? null,
      authorUserId: input.authorUserId ?? null,
      deliveryStatus: input.deliveryStatus ?? (input.direction === "OUT" ? "PENDING" : null),
    });
    const messageId = Number((insRes as any)?.[0]?.insertId ?? (insRes as any)?.insertId);

    // تَحديث المحادثة: lastMessageAt = NOW()، preview = خَلاصة، وunread + 1 لِـIN فَقط.
    // NOTE = مُلاحظة داخِلية لا تَلمس preview/unread (يَختار المُوظَّف ذلك).
    const preview = previewOf(input.body, input.mediaType);
    if (input.direction === "IN") {
      await tx
        .update(conversations)
        .set({
          lastMessageAt: sql`NOW()`,
          lastMessagePreview: preview,
          unreadCount: sql`${conversations.unreadCount} + 1`,
          // إعادة فَتح مُحادثة مُؤرشَفة لو وَصَل رَدّ جَديد.
          status: sql`CASE WHEN ${conversations.status} = 'CLOSED' THEN 'CLOSED' ELSE 'OPEN' END`,
        })
        .where(eq(conversations.id, input.conversationId));
    } else if (input.direction === "OUT") {
      await tx
        .update(conversations)
        .set({ lastMessageAt: sql`NOW()`, lastMessagePreview: preview })
        .where(eq(conversations.id, input.conversationId));
    }
    return { messageId, deduped: false };
  });
}

/** يُصَفّر العَدّاد — مُوظَّف فَتح المحادثة. */
export async function markConversationRead(conversationId: number, _actor: Actor) {
  return withTx(async (tx) => {
    await tx.update(conversations).set({ unreadCount: 0 }).where(eq(conversations.id, conversationId));
    return { conversationId, ok: true };
  });
}

/** يَربط محادثة بأَمر شَغل (الكاشير اختار «أمر شَغل» مِن الـinbox drawer). */
export async function linkConversationToWorkOrder(conversationId: number, workOrderId: number | null) {
  return withTx(async (tx) => {
    if (workOrderId != null) {
      // تَحقَّق أن أَمر الشَغل مَوجود.
      const wo = (
        await tx.select({ id: workOrders.id }).from(workOrders).where(eq(workOrders.id, workOrderId)).limit(1)
      )[0];
      if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "أَمر الشَغل غَير مَوجود" });
    }
    await tx.update(conversations).set({ linkedWorkOrderId: workOrderId }).where(eq(conversations.id, conversationId));
    return { conversationId, linkedWorkOrderId: workOrderId };
  });
}

/** قائمة الـinbox — مَفروزة بـlastMessageAt تَنازُلياً، غَير مُؤرشَفة افتراضياً. */
export interface ListConversationsInput {
  branchId: number;
  /** فَلتر العَدّاد: 'unread' = فَقط ما لِم يُقرَأ بَعد. */
  filter?: "all" | "unread" | "archived" | "closed";
  /** فَلتر قَناة (اختياري). */
  channel?: ChannelKind | null;
  limit?: number;
}

export async function listConversations(input: ListConversationsInput) {
  const db = getDb();
  if (!db) return [];
  const filter = input.filter ?? "all";
  // فَلتر الحالة: archived/closed صَريحَين، unread يَضيف unreadCount>0، all يَستثني archived/closed.
  const baseWhere = [eq(conversations.branchId, input.branchId)];
  if (filter === "archived") baseWhere.push(eq(conversations.status, "ARCHIVED"));
  else if (filter === "closed") baseWhere.push(eq(conversations.status, "CLOSED"));
  else baseWhere.push(eq(conversations.status, "OPEN"));
  if (filter === "unread") baseWhere.push(sql`${conversations.unreadCount} > 0`);
  if (input.channel) baseWhere.push(eq(conversations.channel, input.channel));

  return db
    .select({
      id: conversations.id,
      branchId: conversations.branchId,
      channel: conversations.channel,
      channelHandle: conversations.channelHandle,
      customerId: conversations.customerId,
      customerName: customers.name,
      displayName: conversations.displayName,
      linkedWorkOrderId: conversations.linkedWorkOrderId,
      unreadCount: conversations.unreadCount,
      lastMessageAt: conversations.lastMessageAt,
      lastMessagePreview: conversations.lastMessagePreview,
      status: conversations.status,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .leftJoin(customers, eq(conversations.customerId, customers.id))
    .where(and(...baseWhere))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(input.limit ?? 100);
}

/** رَسائل مُحادثة — مَفروزة زَمنياً. */
export async function getConversationMessages(conversationId: number) {
  const db = getDb();
  if (!db) return [];
  return db
    .select({
      id: conversationMessages.id,
      direction: conversationMessages.direction,
      body: conversationMessages.body,
      mediaUrl: conversationMessages.mediaUrl,
      mediaType: conversationMessages.mediaType,
      authorUserId: conversationMessages.authorUserId,
      authorName: users.name,
      deliveryStatus: conversationMessages.deliveryStatus,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .leftJoin(users, eq(conversationMessages.authorUserId, users.id))
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(conversationMessages.createdAt);
}

/** تَأرشيف/فَتح/إغلاق مُحادثة. */
export async function setConversationStatus(conversationId: number, status: "OPEN" | "ARCHIVED" | "CLOSED") {
  return withTx(async (tx) => {
    await tx.update(conversations).set({ status }).where(eq(conversations.id, conversationId));
    return { conversationId, status };
  });
}
