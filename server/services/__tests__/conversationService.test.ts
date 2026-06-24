import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import {
  addMessage,
  getConversationMessages,
  listConversations,
  markConversationRead,
  setConversationStatus,
  upsertConversation,
} from "../conversationService";

/**
 * شَريحة #5 — صَندوق الوارد المُوحَّد.
 * المحاور: upsert ذَرّي بَلا dup، addMessage يَحسب unread لِـIN فَقط،
 * webhook dedup بـexternalId، عَزل الفُروع في list، markRead يُصَفّر.
 */

const TABLES = [
  "conversationMessages", "conversations",
  "accountingEntries", "receipts", "inventoryMovements",
  "invoiceItems", "invoices", "idempotencyKeys",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderMaterials", "workOrderItems", "workOrderImages", "workOrders",
  "customers", "users", "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function seed() {
  await db().insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: 1, openId: "u1", name: "admin", role: "admin", loginMethod: "local" },
    { id: 2, openId: "u2", name: "cashier", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await db().insert(s.customers).values({ id: 10, name: "زَبون", currentBalance: "0", defaultPriceTier: "RETAIL" });
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("صَندوق الوارد — conversationService", () => {
  it("upsert: إنشاء جَديدة، تَكرار يُعيد القائمة (لا dup)", async () => {
    const r1 = await upsertConversation({
      branchId: 1, channel: "WHATSAPP", channelHandle: "+9647701234567", customerId: 10, displayName: "زَبون",
    });
    expect(r1.isNew).toBe(true);
    const r2 = await upsertConversation({
      branchId: 1, channel: "WHATSAPP", channelHandle: "+9647701234567",
    });
    expect(r2.isNew).toBe(false);
    expect(r2.id).toBe(r1.id);
    // عَدد المُحادثات = ١ بَلا dup.
    const all = await db().select().from(s.conversations);
    expect(all).toHaveLength(1);
  });

  it("upsert: نَفس handle في فَرعَين مُختلفَين ⇒ مُحادثتان مُنفصلتان", async () => {
    const a = await upsertConversation({ branchId: 1, channel: "WHATSAPP", channelHandle: "+9647700000001" });
    const b = await upsertConversation({ branchId: 2, channel: "WHATSAPP", channelHandle: "+9647700000001" });
    expect(a.id).not.toBe(b.id);
    expect(await db().select().from(s.conversations).then((r) => r.length)).toBe(2);
  });

  it("addMessage IN: يَزيد unreadCount + يُحدّث preview", async () => {
    const { id } = await upsertConversation({ branchId: 1, channel: "PHONE", channelHandle: "07811111111" });
    await addMessage({ conversationId: id, direction: "IN", body: "أَريد طِباعة كَرت دَعوة" });
    const c = (await db().select().from(s.conversations).where(eq(s.conversations.id, id)))[0];
    expect(c.unreadCount).toBe(1);
    expect(c.lastMessagePreview).toBe("أَريد طِباعة كَرت دَعوة");
    expect(c.lastMessageAt).not.toBeNull();
  });

  it("addMessage OUT: لا يَزيد unread (نَحن أَرسلنا)", async () => {
    const { id } = await upsertConversation({ branchId: 1, channel: "WHATSAPP", channelHandle: "+1" });
    await addMessage({ conversationId: id, direction: "IN", body: "مَرحبا" });
    await addMessage({ conversationId: id, direction: "OUT", body: "أَهلاً، كَيف نُساعدك؟", authorUserId: 2 });
    const c = (await db().select().from(s.conversations).where(eq(s.conversations.id, id)))[0];
    expect(c.unreadCount).toBe(1); // IN واحدة فَقط زادت العَدّاد.
  });

  it("addMessage NOTE: لا يَلمس preview ولا unread", async () => {
    const { id } = await upsertConversation({ branchId: 1, channel: "WHATSAPP", channelHandle: "+1" });
    await addMessage({ conversationId: id, direction: "IN", body: "رِسالة زَبون" });
    await addMessage({ conversationId: id, direction: "NOTE", body: "ملاحظة سرّية", authorUserId: 2 });
    const c = (await db().select().from(s.conversations).where(eq(s.conversations.id, id)))[0];
    expect(c.lastMessagePreview).toBe("رِسالة زَبون"); // preview = آخر IN/OUT لا NOTE.
    expect(c.unreadCount).toBe(1);
  });

  it("addMessage dedup بـexternalId: webhook retry لا يُكرّر", async () => {
    const { id } = await upsertConversation({ branchId: 1, channel: "WHATSAPP", channelHandle: "+1" });
    const a = await addMessage({ conversationId: id, direction: "IN", body: "أوّل", externalId: "wamid.XXX" });
    const b = await addMessage({ conversationId: id, direction: "IN", body: "ثانية", externalId: "wamid.XXX" });
    expect(b.deduped).toBe(true);
    expect(b.messageId).toBe(a.messageId);
    expect(await db().select().from(s.conversationMessages).then((r) => r.length)).toBe(1);
  });

  it("markRead: يُصَفّر العَدّاد", async () => {
    const { id } = await upsertConversation({ branchId: 1, channel: "PHONE", channelHandle: "07811111112" });
    await addMessage({ conversationId: id, direction: "IN", body: "١" });
    await addMessage({ conversationId: id, direction: "IN", body: "٢" });
    let c = (await db().select().from(s.conversations).where(eq(s.conversations.id, id)))[0];
    expect(c.unreadCount).toBe(2);
    await markConversationRead(id, { userId: 2, branchId: 1 });
    c = (await db().select().from(s.conversations).where(eq(s.conversations.id, id)))[0];
    expect(c.unreadCount).toBe(0);
  });

  it("list: يُعيد المفتوحة فَقط افتراضياً، فَلتر unread يَفلتر العَدّاد>0", async () => {
    const a = await upsertConversation({ branchId: 1, channel: "WHATSAPP", channelHandle: "+1" });
    const b = await upsertConversation({ branchId: 1, channel: "WHATSAPP", channelHandle: "+2" });
    await addMessage({ conversationId: a.id, direction: "IN", body: "ل" });
    // a مَقروءة، b بَلا رَسائل بَعد.
    await markConversationRead(a.id, { userId: 1, branchId: 1 });
    await addMessage({ conversationId: b.id, direction: "IN", body: "م" });

    const all = await listConversations({ branchId: 1, filter: "all" });
    expect(all.length).toBe(2);
    const unread = await listConversations({ branchId: 1, filter: "unread" });
    expect(unread.length).toBe(1);
    expect(Number(unread[0].id)).toBe(b.id);
  });

  it("list: عَزل الفُروع — لا يَتسَرَّب مُحادثات فَرع آخر", async () => {
    await upsertConversation({ branchId: 1, channel: "WHATSAPP", channelHandle: "+10" });
    await upsertConversation({ branchId: 2, channel: "WHATSAPP", channelHandle: "+20" });
    const f1 = await listConversations({ branchId: 1, filter: "all" });
    const f2 = await listConversations({ branchId: 2, filter: "all" });
    expect(f1.length).toBe(1);
    expect(f2.length).toBe(1);
    expect(Number(f1[0].branchId)).toBe(1);
    expect(Number(f2[0].branchId)).toBe(2);
  });

  it("setStatus: ARCHIVED يُخفي مِن all (الذي يَعرض OPEN فَقط)", async () => {
    const { id } = await upsertConversation({ branchId: 1, channel: "WHATSAPP", channelHandle: "+1" });
    await setConversationStatus(id, "ARCHIVED");
    const open = await listConversations({ branchId: 1, filter: "all" });
    expect(open.length).toBe(0);
    const arch = await listConversations({ branchId: 1, filter: "archived" });
    expect(arch.length).toBe(1);
  });
});
