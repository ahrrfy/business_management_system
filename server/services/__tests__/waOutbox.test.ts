/**
 * اختبارات waOutbox (DB حقيقية) — الصندوق الصادر لواتساب: idempotency الإدراج، دورة الإرسال
 * الناجحة (outbox + صفّ conversationMessages OUT معاً)، تصنيف الفشل (retryable/permanent) وأثره
 * على attempts/nextAttemptAt/status، فحص نافذة الردّ الحرّ ٢٤ ساعة، والتقاط دفعة الكنّاس (يستبعد
 * scheduledAt مستقبلياً).
 *
 * fetch مزيف يُحقن عبر vi.spyOn(globalThis, "fetch") (نمط imageStudioSettingsService.test.ts) —
 * dispatchOutboxRow/sweepWaOutboxOnce لا تقبلان fetchImpl (تفصيل داخلي)، فالحقن على المستوى العام.
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { __resetKeyCacheForTests, encryptSecret } from "../cryptoService";
import { dispatchOutboxRow, enqueueOutbox } from "../whatsapp/outboxService";
import { sweepWaOutboxOnce } from "../whatsapp/outboxSweeper";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const ORIGINAL_KEY = process.env.INTEGRATIONS_ENCRYPTION_KEY;
const TEST_KEY_HEX = crypto.randomBytes(32).toString("hex");

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

let convSeq = 5000;
/** يُنشئ محادثة WHATSAPP بـlastInboundAt منذ hoursAgo ساعة (أو null لو null صراحةً). */
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

/** رد Graph API ناجح بـwamid مُعطى — نسخة جديدة من Response في كل استدعاء (تجنّب استهلاك body مرّتين). */
function successResponder(wamid: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ messages: [{ id: wamid }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

/** رد فشل بحالة/جسم مُعطى — نسخة جديدة في كل استدعاء. */
function failureResponder(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

beforeEach(async () => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = TEST_KEY_HEX;
  __resetKeyCacheForTests();
  await db().insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await db().insert(s.users).values([{ id: 1, openId: "u1", name: "المدير", role: "manager", loginMethod: "local", branchId: 1 }]);
});

afterAll(() => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = ORIGINAL_KEY;
  __resetKeyCacheForTests();
});

describe("enqueueOutbox — idempotency", () => {
  it("enqueue بنفس dedupeKey مرتين ⇒ صفّ واحد، والثانية تعيد القائم بلا رمي", async () => {
    const first = await enqueueOutbox({
      dedupeKey: "dedupe-idem-1",
      branchId: 1,
      kind: "SESSION_TEXT",
      toPhoneE164: "+9647701234567",
      payloadJson: { text: "مرحباً" },
    });
    const second = await enqueueOutbox({
      dedupeKey: "dedupe-idem-1",
      branchId: 1,
      kind: "SESSION_TEXT",
      toPhoneE164: "+9647701234567",
      payloadJson: { text: "نص مختلف تماماً" },
    });
    expect(second.id).toBe(first.id);
    expect(second.isNew).toBe(false);
    const rows = await db().select().from(s.waOutbox);
    expect(rows).toHaveLength(1);
  });
});

describe("dispatchOutboxRow — دورة الإرسال", () => {
  it("نجاح (fetch مزيف يعيد wamid) ⇒ outbox SENT+wamid وصفّ conversationMessages OUT بexternalId=wamid وorigin=API", async () => {
    await seedActiveIntegration(1);
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1 });
    const { id } = await enqueueOutbox({
      dedupeKey: "dedupe-success-1",
      branchId: 1,
      kind: "SESSION_TEXT",
      conversationId: convId,
      toPhoneE164: "+9647701234567",
      payloadJson: { text: "رسالة اختبار" },
    });

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(successResponder("wamid.SUCCESS_1"));
    try {
      await dispatchOutboxRow(id);
    } finally {
      spy.mockRestore();
    }

    const row = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, id)))[0];
    expect(row.status).toBe("SENT");
    expect(row.wamid).toBe("wamid.SUCCESS_1");

    const msgs = await db().select().from(s.conversationMessages).where(eq(s.conversationMessages.conversationId, convId));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].externalId).toBe("wamid.SUCCESS_1");
    expect(msgs[0].direction).toBe("OUT");
    expect(msgs[0].origin).toBe("API");
  });

  it("فشل 500 ⇒ QUEUED وattempts=1 وnextAttemptAt مستقبلي؛ وبعد بلوغ attempts=6 ⇒ FAILED", async () => {
    await seedActiveIntegration(1);
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1 });
    const { id } = await enqueueOutbox({
      dedupeKey: "dedupe-retry-1",
      branchId: 1,
      kind: "SESSION_TEXT",
      conversationId: convId,
      toPhoneE164: "+9647701234567",
      payloadJson: { text: "سيفشل" },
    });

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(failureResponder(500, { error: { message: "Internal error" } }));
    try {
      await dispatchOutboxRow(id);
      let row = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, id)))[0];
      expect(row.status).toBe("QUEUED");
      expect(row.attempts).toBe(1);
      expect(row.nextAttemptAt).not.toBeNull();
      expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

      // نُسرِّع الوصول لعتبة ٦ محاولات بتقديم nextAttemptAt للماضي بدل انتظار الباكوف الحقيقي فعلياً.
      for (let i = 2; i <= 6; i++) {
        await db()
          .update(s.waOutbox)
          .set({ nextAttemptAt: new Date(Date.now() - 1000) })
          .where(eq(s.waOutbox.id, id));
        await dispatchOutboxRow(id);
      }
      row = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, id)))[0];
      expect(row.status).toBe("FAILED");
      expect(row.attempts).toBe(6);
    } finally {
      spy.mockRestore();
    }
  });

  it("فشل 400 بكود 131047 ⇒ FAILED فوراً برسالة عربية تحوي «قالب»، ولا صفّ رسالة OUT", async () => {
    await seedActiveIntegration(1);
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1 });
    const { id } = await enqueueOutbox({
      dedupeKey: "dedupe-permanent-1",
      branchId: 1,
      kind: "SESSION_TEXT",
      conversationId: convId,
      toPhoneE164: "+9647701234567",
      payloadJson: { text: "خارج النافذة" },
    });

    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(failureResponder(400, { error: { message: "Re-engagement message", code: 131047 } }));
    try {
      await dispatchOutboxRow(id);
    } finally {
      spy.mockRestore();
    }

    const row = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, id)))[0];
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toContain("قالب");
    const msgs = await db().select().from(s.conversationMessages).where(eq(s.conversationMessages.conversationId, convId));
    expect(msgs).toHaveLength(0);
  });

  it("SESSION_TEXT لمحادثة lastInboundAt قبل ٢٥ ساعة ⇒ FAILED بالنافذة (بلا ضرب fetch حتى)؛ وقبل ٢٣ ساعة ⇒ يُرسَل", async () => {
    await seedActiveIntegration(1);
    const oldConv = await seedConversation({ branchId: 1, hoursAgo: 25, channelHandle: "9647700000001" });
    const freshConv = await seedConversation({ branchId: 1, hoursAgo: 23, channelHandle: "9647700000002" });

    const { id: idOld } = await enqueueOutbox({
      dedupeKey: "dedupe-window-old",
      branchId: 1,
      kind: "SESSION_TEXT",
      conversationId: oldConv,
      toPhoneE164: "+9647700000001",
      payloadJson: { text: "متأخّر جداً" },
    });
    const { id: idFresh } = await enqueueOutbox({
      dedupeKey: "dedupe-window-fresh",
      branchId: 1,
      kind: "SESSION_TEXT",
      conversationId: freshConv,
      toPhoneE164: "+9647700000002",
      payloadJson: { text: "ضمن النافذة" },
    });

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(successResponder("wamid.FRESH"));
    try {
      await dispatchOutboxRow(idOld);
      expect(spy).not.toHaveBeenCalled(); // النافذة تُفحَص قبل أي محاولة إرسال فعلية.
      await dispatchOutboxRow(idFresh);
    } finally {
      spy.mockRestore();
    }

    const rowOld = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, idOld)))[0];
    expect(rowOld.status).toBe("FAILED");
    expect(rowOld.lastError).toContain("قالب");

    const rowFresh = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, idFresh)))[0];
    expect(rowFresh.status).toBe("SENT");
    expect(rowFresh.wamid).toBe("wamid.FRESH");
  });
});

describe("sweepWaOutboxOnce — التقاط الدفعة", () => {
  it("صفّ scheduledAt مستقبلي لا يلتقطه استعلام الدفعة؛ والمستحقّ يُلتقط ويُرسَل", async () => {
    await seedActiveIntegration(1);
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1 });
    const future = new Date(Date.now() + 3600_000);

    const { id: futureId } = await enqueueOutbox({
      dedupeKey: "dedupe-sweep-future",
      branchId: 1,
      kind: "SESSION_TEXT",
      conversationId: convId,
      toPhoneE164: "+9647701234567",
      payloadJson: { text: "لاحقاً" },
      scheduledAt: future,
    });
    const { id: dueId } = await enqueueOutbox({
      dedupeKey: "dedupe-sweep-due",
      branchId: 1,
      kind: "SESSION_TEXT",
      conversationId: convId,
      toPhoneE164: "+9647701234567",
      payloadJson: { text: "الآن" },
    });

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(successResponder("wamid.SWEEP"));
    let result: Awaited<ReturnType<typeof sweepWaOutboxOnce>>;
    try {
      result = await sweepWaOutboxOnce();
    } finally {
      spy.mockRestore();
    }

    expect(result.claimed).toBe(1);

    const rowFuture = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, futureId)))[0];
    expect(rowFuture.status).toBe("QUEUED"); // لم يُلتقَط — لم يُلمَس.

    const rowDue = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, dueId)))[0];
    expect(rowDue.status).toBe("SENT");
    expect(rowDue.wamid).toBe("wamid.SWEEP");
  });

  it("لا تكامل واتساب نشط ⇒ خروج فوري (claimed=0)، بلا لمس أي صفّ", async () => {
    // بلا seedActiveIntegration — لا تكامل ACTIVE على الإطلاق.
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1 });
    const { id } = await enqueueOutbox({
      dedupeKey: "dedupe-no-integration",
      branchId: 1,
      kind: "SESSION_TEXT",
      conversationId: convId,
      toPhoneE164: "+9647701234567",
      payloadJson: { text: "x" },
    });
    const result = await sweepWaOutboxOnce();
    expect(result.claimed).toBe(0);
    const row = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, id)))[0];
    expect(row.status).toBe("QUEUED");
  });
});
