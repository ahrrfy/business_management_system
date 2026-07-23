/**
 * اختبارات إعادة توصيل conversations.sendMessage عبر الصندوق الصادر لواتساب + linkCustomer/retrySend
 * الجديدتان — تكليف T1.4 (نواة Cloud API، شريحة #١).
 *
 * نمط الاختبار: appRouter.createCaller (نفس rbacHardening.test.ts) + DB حقيقية مبذورة يدوياً (نفس
 * waOutbox.test.ts/integration.test.ts). fetch مزيَّف عبر vi.spyOn(globalThis, "fetch") — يمنع أي
 * ضربة شبكة حقيقية أثناء المحاولة الفورية غير المتزامنة (enqueueAndDispatch/dispatchOutboxRow
 * تُجدوَل عبر setImmediate ولا تُنتظَر من الراوتر) وتُبقي حالة waOutbox متوقَّعة (500 دائماً ⇒
 * retryable ⇒ الصفّ يبقى QUEUED لو التقطه الكنّاس الفوري قبل تأكيدنا، لا SENT أبداً ⇒ لا صفّ رسالة
 * حقيقي يظهر خلسة). كل اختبار يلمس outbox ينتظر مهلة قصيرة في نهايته ليستقرّ أي إرسال فوري خلفي
 * قبل انتقال afterEach (`__setup__.ts`) لتفريغ الجداول — يمنع تسرّب استعلام معلَّق لملف الاختبار
 * التالي.
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { appRouter } from "../../routers";
import { __resetKeyCacheForTests, encryptSecret } from "../cryptoService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const ORIGINAL_KEY = process.env.INTEGRATIONS_ENCRYPTION_KEY;
const TEST_KEY_HEX = crypto.randomBytes(32).toString("hex");

function ctxWith(role: string, branchId: number | null, userId = 2): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: userId, role, branchId, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  };
}
const caller = (role: string, branchId: number | null, userId = 2) => appRouter.createCaller(ctxWith(role, branchId, userId));

/** يُنشئ تكاملاً نشطاً WHATSAPP على الفرع المُعطى (accessToken مشفَّر فعلياً — نفس مسار الإنتاج). */
async function seedActiveIntegration(branchId: number, phoneNumberId = "15550001111"): Promise<void> {
  await db().insert(s.channelIntegrations).values({
    branchId,
    channel: "WHATSAPP",
    phoneNumberId,
    encryptedAccessToken: encryptSecret("fake-access-token"),
    status: "ACTIVE",
  });
}

let convSeq = 9000;
/** يُنشئ محادثة WHATSAPP بـlastInboundAt منذ hoursAgo ساعة (أو null صراحةً). */
async function seedConversation(opts: { branchId: number; hoursAgo: number | null; channelHandle?: string }): Promise<number> {
  const id = convSeq++;
  await db().insert(s.conversations).values({
    id,
    branchId: opts.branchId,
    channel: "WHATSAPP",
    channelHandle: opts.channelHandle ?? `96470${id}`,
    lastInboundAt: opts.hoursAgo == null ? null : new Date(Date.now() - opts.hoursAgo * 3600_000),
  });
  return id;
}

/** رد Graph API فاشل (500 — retryable) بلا اعتماد على الشبكة الحقيقية. */
function failureResponder(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ error: { message: "Internal error" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

/** يمنح أي محاولة إرسال فورية خلفية (setImmediate) فرصةً للاستقرار قبل نهاية الاختبار. */
async function settleBackgroundDispatch(): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
}

beforeEach(async () => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = TEST_KEY_HEX;
  __resetKeyCacheForTests();
  await db().insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: 1, openId: "u1", name: "المدير", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "u2", name: "كاشير الفرع ١", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "u3", name: "كاشير الفرع ٢", role: "cashier", loginMethod: "local", branchId: 2 },
  ]);
  await db().insert(s.customers).values([
    { id: 10, name: "زَبون نَشِط", currentBalance: "0", defaultPriceTier: "RETAIL", isActive: true },
    { id: 11, name: "زَبون مُعطَّل", currentBalance: "0", defaultPriceTier: "RETAIL", isActive: false },
  ]);
});

afterAll(() => {
  if (ORIGINAL_KEY) process.env.INTEGRATIONS_ENCRYPTION_KEY = ORIGINAL_KEY;
  else delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
  __resetKeyCacheForTests();
});

describe("sendMessage — إعادة توصيل عبر الصندوق الصادر", () => {
  it("١) بلا تكامل ⇒ المسار القديم حرفياً (صفّ OUT مباشر، لا outbox)", async () => {
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1 });

    const result = await caller("cashier", 1, 2).conversations.sendMessage({
      conversationId: convId,
      direction: "OUT",
      body: "مرحباً بلا تكامل",
    });

    expect(result).toMatchObject({ deduped: false });
    expect((result as { messageId: number }).messageId).toEqual(expect.any(Number));
    expect((result as Record<string, unknown>).queued).toBeUndefined();

    const msgs = await db().select().from(s.conversationMessages).where(eq(s.conversationMessages.conversationId, convId));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].direction).toBe("OUT");
    expect(msgs[0].body).toBe("مرحباً بلا تكامل");

    const outboxRows = await db().select().from(s.waOutbox);
    expect(outboxRows).toHaveLength(0);
  });

  it("٢) تكامل ACTIVE + نافذة مفتوحة (قبل ساعة) ⇒ {queued:true} + صفّ waOutbox QUEUED بdedupeKey صحيح، ولا صفّ رسالة فوري", async () => {
    await seedActiveIntegration(1);
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1, channelHandle: "9647701234567" });

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(failureResponder());
    try {
      const result = await caller("cashier", 1, 2).conversations.sendMessage({
        conversationId: convId,
        direction: "OUT",
        body: "رسالة عبر الصندوق الصادر",
        clientRequestId: "click-2",
      });

      expect(result).toMatchObject({ queued: true });
      const outboxId = (result as { outboxId: number }).outboxId;
      expect(outboxId).toEqual(expect.any(Number));

      const row = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, outboxId)))[0];
      expect(row).toBeDefined();
      expect(row.kind).toBe("SESSION_TEXT");
      expect(row.status).toBe("QUEUED");
      expect(row.dedupeKey).toBe(`CHAT:${convId}:click-2`);
      expect(row.conversationId).toBe(convId);
      expect(row.toPhoneE164).toBe("+9647701234567");

      const msgs = await db().select().from(s.conversationMessages).where(eq(s.conversationMessages.conversationId, convId));
      expect(msgs).toHaveLength(0); // لا إدراج فوري — يُدرَج فقط عند نجاح الإرسال الفعلي.
    } finally {
      spy.mockRestore();
    }
    await settleBackgroundDispatch();
  });

  it("٣) تكامل ACTIVE + نافذة مغلقة ⇒ TRPCError برسالة تحوي «قالب»، بلا outbox ولا رسالة", async () => {
    await seedActiveIntegration(1);
    const convId = await seedConversation({ branchId: 1, hoursAgo: 25, channelHandle: "9647700000099" });

    await expect(
      caller("cashier", 1, 2).conversations.sendMessage({
        conversationId: convId,
        direction: "OUT",
        body: "خارج النافذة",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("قالب") });

    const outboxRows = await db().select().from(s.waOutbox).where(eq(s.waOutbox.conversationId, convId));
    expect(outboxRows).toHaveLength(0);
    const msgs = await db().select().from(s.conversationMessages).where(eq(s.conversationMessages.conversationId, convId));
    expect(msgs).toHaveLength(0);
  });

  it("٤) نفس clientRequestId مرّتين ⇒ صفّ outbox واحد (idempotency)", async () => {
    await seedActiveIntegration(1);
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1, channelHandle: "9647700000088" });

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(failureResponder());
    try {
      const first = await caller("cashier", 1, 2).conversations.sendMessage({
        conversationId: convId,
        direction: "OUT",
        body: "أولى",
        clientRequestId: "dup-click",
      });
      const second = await caller("cashier", 1, 2).conversations.sendMessage({
        conversationId: convId,
        direction: "OUT",
        body: "أولى مكرَّرة (نفس المفتاح)",
        clientRequestId: "dup-click",
      });

      expect((first as { outboxId: number }).outboxId).toBe((second as { outboxId: number }).outboxId);

      const rows = await db().select().from(s.waOutbox).where(eq(s.waOutbox.conversationId, convId));
      expect(rows).toHaveLength(1);
      expect(rows[0].dedupeKey).toBe(`CHAT:${convId}:dup-click`);
    } finally {
      spy.mockRestore();
    }
    await settleBackgroundDispatch();
  });
});

describe("linkCustomer", () => {
  it("يحدّث customerId لمحادثة في نطاق فرع المستخدم", async () => {
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1 });
    const result = await caller("cashier", 1, 2).conversations.linkCustomer({ conversationId: convId, customerId: 10 });
    expect(result).toMatchObject({ conversationId: convId, customerId: 10 });
    const conv = (await db().select().from(s.conversations).where(eq(s.conversations.id, convId)))[0];
    expect(Number(conv.customerId)).toBe(10);
  });

  it("مُحادثة فَرع آخر ⇒ يُرفَض (عزل الفروع، IDOR)", async () => {
    const convBranch1 = await seedConversation({ branchId: 1, hoursAgo: 1 });
    await expect(
      caller("cashier", 2, 3).conversations.linkCustomer({ conversationId: convBranch1, customerId: 10 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const conv = (await db().select().from(s.conversations).where(eq(s.conversations.id, convBranch1)))[0];
    expect(conv.customerId).toBeNull();
  });

  it("عميل معطَّل ⇒ يُرفَض", async () => {
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1 });
    await expect(
      caller("cashier", 1, 2).conversations.linkCustomer({ conversationId: convId, customerId: 11 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const conv = (await db().select().from(s.conversations).where(eq(s.conversations.id, convId)))[0];
    expect(conv.customerId).toBeNull();
  });
});

describe("retrySend", () => {
  async function seedOutboxRow(status: "FAILED" | "SENT", conversationId: number, branchId: number): Promise<number> {
    const res = await db().insert(s.waOutbox).values({
      branchId,
      dedupeKey: `CHAT:${conversationId}:retry-${crypto.randomUUID()}`,
      conversationId,
      toPhoneE164: "+9647700000077",
      kind: "SESSION_TEXT",
      payloadJson: { text: "نص إعادة المحاولة" },
      status,
      attempts: status === "FAILED" ? 3 : 0,
      lastError: status === "FAILED" ? "فشل سابق (اختبار)" : null,
      wamid: status === "SENT" ? "wamid.TEST_SENT" : null,
    });
    return extractInsertId(res);
  }

  it("على FAILED ⇒ يُعيده QUEUED (attempts=0، lastError=null)", async () => {
    await seedActiveIntegration(1);
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1 });
    const outboxId = await seedOutboxRow("FAILED", convId, 1);

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(failureResponder());
    try {
      const result = await caller("cashier", 1, 2).conversations.retrySend({ outboxId });
      expect(result).toMatchObject({ outboxId, ok: true });

      const row = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, outboxId)))[0];
      expect(row.status).toBe("QUEUED");
      expect(row.attempts).toBe(0);
      expect(row.lastError).toBeNull();
    } finally {
      spy.mockRestore();
    }
    await settleBackgroundDispatch();
  });

  it("على SENT ⇒ يُرفَض", async () => {
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1 });
    const outboxId = await seedOutboxRow("SENT", convId, 1);

    await expect(caller("cashier", 1, 2).conversations.retrySend({ outboxId })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const row = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, outboxId)))[0];
    expect(row.status).toBe("SENT"); // لم يتغيَّر.
  });
});
