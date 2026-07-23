/**
 * اختبارات webhookProcessor (DB حقيقية على erp_watest) — قلب معالجة أحداث الـwebhook الخام:
 * إدراج رسائل واردة + تحديث lastInboundAt، الربط التلقائي بالعميل عبر contactResolver، رتابة
 * حالات التسليم + سباق الترتيب (status يسبق الرسالة)، تسامح صدى تعايش تطبيق الهاتف، توجيه
 * phone_number_id بين فروع متعددة، وتكامل جلب الوسائط المؤجَّل (MEDIA_FETCH) مع dispatchOutboxRow
 * القائمة من T1.2 (يسدّ فجوة تغطية mediaService من مراجعة T1.2).
 *
 * fetch مزيف يُحقن عبر vi.spyOn(globalThis, "fetch") (نمط waOutbox.test.ts) — dispatchOutboxRow
 * لا تقبل fetchImpl (تفصيل داخلي)، فالحقن على المستوى العام.
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { __resetKeyCacheForTests, encryptSecret } from "../cryptoService";
import { dispatchOutboxRow } from "../whatsapp/outboxService";
import { persistWaEvent, processWaEvent, retryFailedWaEvents } from "../whatsapp/webhookProcessor";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const ORIGINAL_KEY = process.env.INTEGRATIONS_ENCRYPTION_KEY;
const TEST_KEY_HEX = crypto.randomBytes(32).toString("hex");

async function seedIntegration(opts: {
  branchId: number;
  phoneNumberId: string;
  status?: "ACTIVE" | "PENDING" | "FAILED" | "DISABLED";
}): Promise<number> {
  const res = await db().insert(s.channelIntegrations).values({
    branchId: opts.branchId,
    channel: "WHATSAPP",
    phoneNumberId: opts.phoneNumberId,
    encryptedAccessToken: encryptSecret("fake-access-token"),
    status: opts.status ?? "ACTIVE",
  });
  return extractInsertId(res);
}

interface WaPayloadOpts {
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  messages?: unknown[];
  statuses?: unknown[];
  messageEchoes?: unknown[];
  contacts?: unknown[];
}

function waPayload(opts: WaPayloadOpts) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                phone_number_id: opts.phoneNumberId ?? "15550001111",
                display_phone_number: opts.displayPhoneNumber ?? "15550001111",
              },
              contacts: opts.contacts,
              messages: opts.messages,
              statuses: opts.statuses,
              message_echoes: opts.messageEchoes,
            },
          },
        ],
      },
    ],
  };
}

async function insertConversation(branchId: number, channelHandle: string): Promise<number> {
  const res = await db().insert(s.conversations).values({ branchId, channel: "WHATSAPP", channelHandle });
  return extractInsertId(res);
}

async function insertOutMessage(conversationId: number, externalId: string): Promise<number> {
  const res = await db().insert(s.conversationMessages).values({
    conversationId,
    direction: "OUT",
    body: "رسالة صادرة",
    externalId,
    deliveryStatus: "PENDING",
    origin: "API",
  });
  return extractInsertId(res);
}

async function insertOutboxRow(branchId: number, dedupeKey: string, wamid: string, status: "SENT" | "QUEUED" | "SENDING" | "FAILED"): Promise<void> {
  await db().insert(s.waOutbox).values({ branchId, dedupeKey, kind: "SESSION_TEXT", payloadJson: { text: "x" }, status, wamid });
}

async function messageByExternalId(externalId: string) {
  const row = (await db().select().from(s.conversationMessages).where(eq(s.conversationMessages.externalId, externalId)))[0];
  if (!row) throw new Error(`no message with externalId=${externalId}`);
  return row;
}

async function runStatusEvent(wamid: string, status: string, errors?: Array<{ code: number; title: string }>): Promise<void> {
  const payload = waPayload({ statuses: [{ id: wamid, status, timestamp: "1690000000", errors }] });
  const { id } = await persistWaEvent(payload, null);
  await processWaEvent(id);
}

beforeEach(async () => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = TEST_KEY_HEX;
  __resetKeyCacheForTests();
  await db().insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await db().insert(s.users).values([{ id: 1, openId: "u1", name: "المدير", role: "manager", loginMethod: "local", branchId: 1 }]);
});

afterAll(() => {
  if (ORIGINAL_KEY) process.env.INTEGRATIONS_ENCRYPTION_KEY = ORIGINAL_KEY;
  else delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
  __resetKeyCacheForTests();
});

describe("processWaEvent — رسالة واردة جديدة", () => {
  it("رسالة IN جديدة ⇒ محادثة+رسالة+lastInboundAt محدث؛ تكرار نفس الحمولة ⇒ صف واحد وevent ثانٍ PROCESSED", async () => {
    await seedIntegration({ branchId: 1, phoneNumberId: "15550001111" });
    const payload = waPayload({
      messages: [{ from: "9647709999999", id: "wamid.IN1", type: "text", text: { body: "مرحباً" } }],
    });

    const { id: event1 } = await persistWaEvent(payload, null);
    await processWaEvent(event1);

    const conv = (await db().select().from(s.conversations))[0];
    expect(conv).toBeTruthy();
    expect(conv.lastInboundAt).toBeTruthy();
    const msgs1 = await db().select().from(s.conversationMessages);
    expect(msgs1).toHaveLength(1);
    expect(msgs1[0].body).toBe("مرحباً");
    expect((await db().select().from(s.waWebhookEvents).where(eq(s.waWebhookEvents.id, event1)))[0].status).toBe("PROCESSED");

    const { id: event2 } = await persistWaEvent(payload, null);
    await processWaEvent(event2);

    const msgs2 = await db().select().from(s.conversationMessages);
    expect(msgs2).toHaveLength(1); // dedup بexternalId — لا صفّ ثانٍ.

    const ev2Row = (await db().select().from(s.waWebhookEvents).where(eq(s.waWebhookEvents.id, event2)))[0];
    expect(ev2Row.status).toBe("PROCESSED");
  });
});

describe("processWaEvent — الربط التلقائي بالعميل", () => {
  it("عميل وحيد بنفس لاحقة الهاتف ⇒ customerId مربوط", async () => {
    await seedIntegration({ branchId: 1, phoneNumberId: "15550001111" });
    await db().insert(s.customers).values({ id: 1, name: "عميل واحد", phone: "+9647701234567", isActive: true });

    const payload = waPayload({ messages: [{ from: "9647701234567", id: "wamid.LINK1", type: "text", text: { body: "أهلاً" } }] });
    const { id } = await persistWaEvent(payload, null);
    await processWaEvent(id);

    const conv = (await db().select().from(s.conversations).where(eq(s.conversations.channelHandle, "9647701234567")))[0];
    expect(conv.customerId).toBe(1);
  });

  it("عميلان بنفس اللاحقة ⇒ لا ربط (تسامح الخطر ٤)", async () => {
    await seedIntegration({ branchId: 1, phoneNumberId: "15550001111" });
    await db()
      .insert(s.customers)
      .values([
        { id: 1, name: "عميل أ", phone: "+9647702222222", isActive: true },
        { id: 2, name: "عميل ب", phone: "+9647702222222", isActive: true },
      ]);
    const payload = waPayload({ messages: [{ from: "9647702222222", id: "wamid.LINK2", type: "text", text: { body: "أهلاً" } }] });
    const { id } = await persistWaEvent(payload, null);
    await processWaEvent(id);
    const conv = (await db().select().from(s.conversations).where(eq(s.conversations.channelHandle, "9647702222222")))[0];
    expect(conv.customerId).toBeNull();
  });
});

describe("processWaEvent — حالات التسليم (رتابة صارمة)", () => {
  it("sent→delivered→read ترفع الرتبة؛ delivered بعد read لا تخفضها", async () => {
    await seedIntegration({ branchId: 1, phoneNumberId: "15550001111" });
    const convId = await insertConversation(1, "9647703333333");
    await insertOutMessage(convId, "wamid.PROG1");
    await insertOutboxRow(1, "dedupe-prog-1", "wamid.PROG1", "SENT");

    await runStatusEvent("wamid.PROG1", "sent");
    expect((await messageByExternalId("wamid.PROG1")).deliveryStatus).toBe("SENT");

    await runStatusEvent("wamid.PROG1", "delivered");
    expect((await messageByExternalId("wamid.PROG1")).deliveryStatus).toBe("DELIVERED");

    await runStatusEvent("wamid.PROG1", "read");
    expect((await messageByExternalId("wamid.PROG1")).deliveryStatus).toBe("READ");

    await runStatusEvent("wamid.PROG1", "delivered"); // لا تراجع.
    expect((await messageByExternalId("wamid.PROG1")).deliveryStatus).toBe("READ");
  });

  it("failed تكتب errorCode وstatusUpdatedAt وتعلم outbox FAILED", async () => {
    await seedIntegration({ branchId: 1, phoneNumberId: "15550001111" });
    const convId = await insertConversation(1, "9647704444444");
    await insertOutMessage(convId, "wamid.FAIL1");
    await insertOutboxRow(1, "dedupe-fail-1", "wamid.FAIL1", "SENT");

    await runStatusEvent("wamid.FAIL1", "failed", [{ code: 131047, title: "نافذة مغلقة" }]);

    const msg = await messageByExternalId("wamid.FAIL1");
    expect(msg.deliveryStatus).toBe("FAILED");
    expect(msg.errorCode).toBe("131047");
    expect(msg.statusUpdatedAt).toBeTruthy();

    const outboxRow = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.wamid, "wamid.FAIL1")))[0];
    expect(outboxRow.status).toBe("FAILED");
    expect(outboxRow.lastError).toBeTruthy();
  });
});

describe("processWaEvent — سباق الترتيب (status يسبق الرسالة)", () => {
  it("status لwamid غير موجود ⇒ الحدث FAILED؛ بعد إدراج الرسالة، retryFailedWaEvents ⇒ PROCESSED والحالة مطبقة", async () => {
    await seedIntegration({ branchId: 1, phoneNumberId: "15550001111" });
    const payload = waPayload({ statuses: [{ id: "wamid.RACE1", status: "delivered", timestamp: "1690000000" }] });
    const { id: eventId } = await persistWaEvent(payload, null);
    await processWaEvent(eventId);

    let ev = (await db().select().from(s.waWebhookEvents).where(eq(s.waWebhookEvents.id, eventId)))[0];
    expect(ev.status).toBe("FAILED");
    expect(ev.attempts).toBe(1);

    // الرسالة تصل الآن (محاكاة finalizeSendSuccess في outboxService.ts).
    const convId = await insertConversation(1, "9647705555555");
    await insertOutMessage(convId, "wamid.RACE1");

    const { retried } = await retryFailedWaEvents();
    expect(retried).toBe(1);

    ev = (await db().select().from(s.waWebhookEvents).where(eq(s.waWebhookEvents.id, eventId)))[0];
    expect(ev.status).toBe("PROCESSED");
    const msg = await messageByExternalId("wamid.RACE1");
    expect(msg.deliveryStatus).toBe("DELIVERED");
  });
});

describe("processWaEvent — صدى تعايش تطبيق الهاتف", () => {
  it("from == رقم العمل ⇒ رسالة OUT بorigin PHONE_APP، ولا تُحدَّث lastInboundAt", async () => {
    await seedIntegration({ branchId: 1, phoneNumberId: "15550001111" });
    const payload = waPayload({
      displayPhoneNumber: "15550001111",
      messages: [{ from: "15550001111", to: "9647707777777", id: "wamid.ECHO1", type: "text", text: { body: "ردّ من التطبيق مباشرة" } }],
    });
    const { id } = await persistWaEvent(payload, null);
    await processWaEvent(id);

    const conv = (await db().select().from(s.conversations).where(eq(s.conversations.channelHandle, "9647707777777")))[0];
    expect(conv).toBeTruthy();
    expect(conv.lastInboundAt).toBeNull();

    const msg = await messageByExternalId("wamid.ECHO1");
    expect(msg.direction).toBe("OUT");
    expect(msg.origin).toBe("PHONE_APP");
  });
});

describe("processWaEvent — توجيه phone_number_id بين فروع متعددة", () => {
  it("تكاملان لفرعين مختلفين وphone_number_id الثاني في الحمولة ⇒ المحادثة تُنشأ على الفرع الثاني", async () => {
    await db().insert(s.branches).values({ id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" });
    await seedIntegration({ branchId: 1, phoneNumberId: "15550001111" });
    await seedIntegration({ branchId: 2, phoneNumberId: "15550002222" });

    const payload = waPayload({
      phoneNumberId: "15550002222",
      displayPhoneNumber: "15550002222",
      messages: [{ from: "9647708888888", id: "wamid.ROUTE1", type: "text", text: { body: "لفرع المبيعات" } }],
    });
    const { id } = await persistWaEvent(payload, null);
    await processWaEvent(id);

    const conv = (await db().select().from(s.conversations).where(eq(s.conversations.channelHandle, "9647708888888")))[0];
    expect(conv.branchId).toBe(2);
  });
});

describe("processWaEvent — وسائط واردة (جلب مؤجَّل) عبر MEDIA_FETCH", () => {
  it("رسالة image ⇒ MEDIA_FETCH في waOutbox؛ dispatch ⇒ waMedia مدرج وmediaUrl مضبوط (Authorization في التنزيل)", async () => {
    await seedIntegration({ branchId: 1, phoneNumberId: "15550001111" });
    const payload = waPayload({
      messages: [{ from: "9647706666666", id: "wamid.MEDIA1", type: "image", image: { id: "media-abc", mime_type: "image/jpeg" } }],
    });
    const { id } = await persistWaEvent(payload, null);
    await processWaEvent(id);

    const outboxRow = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.dedupeKey, "MF:wamid.MEDIA1")))[0];
    expect(outboxRow).toBeTruthy();
    expect(outboxRow.kind).toBe("MEDIA_FETCH");
    const msg = await messageByExternalId("wamid.MEDIA1");
    expect((outboxRow.payloadJson as { messageId?: number }).messageId).toBe(Number(msg.id));

    let authHeaderOnDownload: string | null = null;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/media-abc")) {
        return new Response(JSON.stringify({ url: "https://lookaside.example/file", mime_type: "image/jpeg", file_size: 4 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      authHeaderOnDownload = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200 });
    }) as typeof fetch;

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
    try {
      await dispatchOutboxRow(Number(outboxRow.id));
    } finally {
      spy.mockRestore();
    }

    const media = (await db().select().from(s.waMedia).where(eq(s.waMedia.messageId, Number(msg.id))))[0];
    expect(media).toBeTruthy();
    expect(authHeaderOnDownload).toMatch(/^Bearer /);

    const updatedMsg = await messageByExternalId("wamid.MEDIA1");
    expect(updatedMsg.mediaUrl).toBe(`/api/wa/media/${msg.id}`);
  });

  it("وسائط أكبر من 5MB ⇒ FAILED دائم والرسالة الأصلية سليمة", async () => {
    await seedIntegration({ branchId: 1, phoneNumberId: "15550001111" });
    const payload = waPayload({
      messages: [{ from: "9647706666667", id: "wamid.MEDIA2", type: "image", image: { id: "media-big", mime_type: "image/jpeg" } }],
    });
    const { id } = await persistWaEvent(payload, null);
    await processWaEvent(id);

    const outboxRow = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.dedupeKey, "MF:wamid.MEDIA2")))[0];
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ url: "https://lookaside.example/big", mime_type: "image/jpeg", file_size: 6 * 1024 * 1024 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
    try {
      await dispatchOutboxRow(Number(outboxRow.id));
    } finally {
      spy.mockRestore();
    }

    const finalRow = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, outboxRow.id)))[0];
    expect(finalRow.status).toBe("FAILED");

    const msg = await messageByExternalId("wamid.MEDIA2");
    expect(msg).toBeTruthy();
    expect(msg.body).toBe("[صورة]");
  });

  it("تكرار نفس حدث الوسائط ⇒ idempotent (لا صفّ MEDIA_FETCH ثانٍ)", async () => {
    await seedIntegration({ branchId: 1, phoneNumberId: "15550001111" });
    const payload = waPayload({
      messages: [{ from: "9647706666668", id: "wamid.MEDIA3", type: "image", image: { id: "media-dup", mime_type: "image/jpeg" } }],
    });
    const { id: event1 } = await persistWaEvent(payload, null);
    await processWaEvent(event1);
    const { id: event2 } = await persistWaEvent(payload, null);
    await processWaEvent(event2);

    const rows = await db().select().from(s.waOutbox).where(eq(s.waOutbox.dedupeKey, "MF:wamid.MEDIA3"));
    expect(rows).toHaveLength(1);
  });
});
