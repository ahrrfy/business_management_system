/**
 * اختبارات waOutbox (DB حقيقية) — الصندوق الصادر لواتساب: idempotency الإدراج، دورة الإرسال
 * الناجحة (outbox + صفّ conversationMessages OUT معاً)، تصنيف الفشل (retryable/permanent) وأثره
 * على attempts/nextAttemptAt/status، فحص نافذة الردّ الحرّ ٢٤ ساعة، والتقاط دفعة الكنّاس (يستبعد
 * scheduledAt مستقبلياً)، وKill Switch يوقف الكنّاس عن الالتقاط فوراً (ثم يستأنف تلقائياً عند إطفائه).
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
  it("يلغي الصف المؤجّل إذا حُذف سجل العميل بعد الجدولة", async () => {
    await seedActiveIntegration(1);
    const inserted = await db().insert(s.customers).values({
      name: "عميل سيُحذف",
      phone: "+9647701234566",
    });
    const customerId = Number((inserted as any)?.[0]?.insertId ?? (inserted as any)?.insertId);
    const { id } = await enqueueOutbox({
      dedupeKey: "dedupe-deleted-customer-before-dispatch",
      branchId: 1,
      kind: "TEMPLATE",
      customerId,
      toPhoneE164: "+9647701234566",
      templateName: "reservation_near_expiry",
      templateLang: "ar",
      payloadJson: { bodyParams: ["RES-0", "عميل", "صنف", "15:00"] },
    });
    await db().delete(s.customers).where(eq(s.customers.id, customerId));

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(successResponder("wamid.MUST_NOT_SEND"));
    try {
      await dispatchOutboxRow(id);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }

    const row = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, id)))[0];
    expect(row.status).toBe("CANCELLED");
    expect(row.lastError).toContain("لم يعد موجوداً");
  });

  it("يلغي تنبيه الحجز المؤجّل إذا تغيّر موعد الانتهاء بعد الجدولة", async () => {
    await seedActiveIntegration(1);
    const originalExpiry = new Date(Date.now() + 60 * 60 * 1000);
    const inserted = await db().insert(s.reservations).values({
      reservationNumber: "RSV-OUTBOX-GUARD",
      branchId: 1,
      contactPhone: "+9647701234567",
      channel: "PHONE",
      status: "ACTIVE",
      expiresAt: originalExpiry,
      createdBy: 1,
    });
    const reservationId = Number((inserted as any)?.[0]?.insertId ?? (inserted as any)?.insertId);
    const { id } = await enqueueOutbox({
      dedupeKey: "dedupe-reservation-guard",
      branchId: 1,
      kind: "TEMPLATE",
      toPhoneE164: "+9647701234567",
      templateName: "reservation_near_expiry",
      templateLang: "ar",
      payloadJson: {
        bodyParams: ["RSV-OUTBOX-GUARD", "عميل", "صنف", "15:00"],
        deliveryGuard: {
          type: "RESERVATION_NEAR_EXPIRY",
          reservationId,
          expiresAt: originalExpiry.toISOString(),
        },
      },
    });
    await db()
      .update(s.reservations)
      .set({ expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000) })
      .where(eq(s.reservations.id, reservationId));

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(successResponder("wamid.MUST_NOT_SEND"));
    try {
      await dispatchOutboxRow(id);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }

    const row = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, id)))[0];
    expect(row.status).toBe("CANCELLED");
    expect(row.lastError).toContain("تغيّر موعده");
  });

  it("يلغي تنبيه الحجز المؤجّل إذا عُطّل مفتاح التدفق بعد الجدولة", async () => {
    await seedActiveIntegration(1);
    await db().insert(s.waHubSettings).values({ id: 1, flowReservationNearExpiry: true });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const inserted = await db().insert(s.reservations).values({
      reservationNumber: "RSV-FLOW-GUARD",
      branchId: 1,
      contactPhone: "+9647701234567",
      channel: "PHONE",
      status: "ACTIVE",
      expiresAt,
      createdBy: 1,
    });
    const reservationId = Number((inserted as any)?.[0]?.insertId ?? (inserted as any)?.insertId);
    const storedExpiry = (await db()
      .select({ expiresAt: s.reservations.expiresAt })
      .from(s.reservations)
      .where(eq(s.reservations.id, reservationId))
      .limit(1))[0].expiresAt;
    const { id } = await enqueueOutbox({
      dedupeKey: "dedupe-reservation-flow-guard",
      branchId: 1,
      kind: "TEMPLATE",
      toPhoneE164: "+9647701234567",
      templateName: "reservation_near_expiry",
      templateLang: "ar",
      payloadJson: {
        bodyParams: ["RSV-FLOW-GUARD", "عميل", "صنف", "15:00"],
        deliveryGuard: {
          type: "RESERVATION_NEAR_EXPIRY",
          reservationId,
          expiresAt: storedExpiry.toISOString(),
        },
      },
    });
    await db().update(s.waHubSettings).set({ flowReservationNearExpiry: false }).where(eq(s.waHubSettings.id, 1));

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(successResponder("wamid.MUST_NOT_SEND"));
    try {
      await dispatchOutboxRow(id);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }

    const row = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, id)))[0];
    expect(row.status).toBe("CANCELLED");
    expect(row.lastError).toContain("معطّل");
  });

  it("يلغي الصف المؤجّل قبل Graph إذا ألغى العميل موافقته بعد الجدولة", async () => {
    await seedActiveIntegration(1);
    const inserted = await db().insert(s.customers).values({
      name: "عميل ألغى الموافقة",
      phone: "+9647701234567",
      waConsent: "UNKNOWN",
    });
    const customerId = Number((inserted as any)?.[0]?.insertId ?? (inserted as any)?.insertId);
    const { id } = await enqueueOutbox({
      dedupeKey: "dedupe-optout-before-dispatch",
      branchId: 1,
      kind: "TEMPLATE",
      customerId,
      toPhoneE164: "+9647701234567",
      templateName: "reservation_near_expiry",
      templateLang: "ar",
      payloadJson: { bodyParams: ["RES-1", "عميل", "صنف", "15:00"] },
    });
    await db()
      .update(s.customers)
      .set({ waConsent: "OPTED_OUT" })
      .where(eq(s.customers.id, customerId));

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(successResponder("wamid.MUST_NOT_SEND"));
    try {
      await dispatchOutboxRow(id);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }

    const row = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, id)))[0];
    expect(row.status).toBe("CANCELLED");
    expect(row.lastError).toContain("ألغى موافقة");
  });

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
  it("يحترم throttlePerMinute في صفوف outbox العامة ولا يرسل الدفعة كلها دفعةً واحدة", async () => {
    await seedActiveIntegration(1);
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1 });
    await db().insert(s.waHubSettings).values({ id: 1, throttlePerMinute: 2 });
    for (let index = 0; index < 3; index++) {
      await enqueueOutbox({
        dedupeKey: `dedupe-throttle-${index}`,
        branchId: 1,
        kind: "SESSION_TEXT",
        conversationId: convId,
        toPhoneE164: "+9647701234567",
        payloadJson: { text: `رسالة ${index}` },
      });
    }

    let wamidSeq = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ messages: [{ id: `wamid.THROTTLED.${++wamidSeq}` }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    try {
      expect(await sweepWaOutboxOnce()).toEqual({ claimed: 2 });
    } finally {
      spy.mockRestore();
    }
    const rows = await db().select().from(s.waOutbox);
    expect(rows.filter((row) => row.status === "SENT")).toHaveLength(2);
    expect(rows.filter((row) => row.status === "QUEUED")).toHaveLength(1);
  });

  it("يعالج MEDIA_FETCH الوارد قبل تراكم الصادر وخارج throttle مع بقاء سقف الدورة الكلي", async () => {
    await seedActiveIntegration(1);
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1 });
    await db().insert(s.waHubSettings).values({ id: 1, throttlePerMinute: 1 });
    for (let index = 0; index < 3; index++) {
      await enqueueOutbox({
        dedupeKey: `dedupe-media-lane-outbound-${index}`,
        branchId: 1,
        kind: "SESSION_TEXT",
        conversationId: convId,
        toPhoneE164: "+9647701234567",
        payloadJson: { text: `رسالة ${index}` },
      });
    }
    const { id: mediaId } = await enqueueOutbox({
      dedupeKey: "dedupe-media-lane-inbound",
      branchId: 1,
      kind: "MEDIA_FETCH",
      payloadJson: {},
    });

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(successResponder("wamid.MEDIA.LANE"));
    try {
      expect(await sweepWaOutboxOnce()).toEqual({ claimed: 2 });
    } finally {
      spy.mockRestore();
    }

    const rows = await db().select().from(s.waOutbox);
    expect(rows.find((row) => row.id === mediaId)?.status).toBe("FAILED");
    expect(rows.filter((row) => row.kind !== "MEDIA_FETCH" && row.status === "SENT")).toHaveLength(1);
    expect(rows.filter((row) => row.kind !== "MEDIA_FETCH" && row.status === "QUEUED")).toHaveLength(2);
  });

  it("يحجز خمس خانات للصادر فلا يحتكره سيل MEDIA_FETCH مستمر", async () => {
    await seedActiveIntegration(1);
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1 });
    await db().insert(s.waHubSettings).values({ id: 1, throttlePerMinute: 5 });
    for (let index = 0; index < 25; index++) {
      await enqueueOutbox({
        dedupeKey: `dedupe-media-flood-${index}`,
        branchId: 1,
        kind: "MEDIA_FETCH",
        payloadJson: {},
      });
    }
    const { id: outboundId } = await enqueueOutbox({
      dedupeKey: "dedupe-media-flood-outbound",
      branchId: 1,
      kind: "SESSION_TEXT",
      conversationId: convId,
      toPhoneE164: "+9647701234567",
      payloadJson: { text: "رسالة لا تجوع" },
    });

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(successResponder("wamid.MEDIA.FLOOD"));
    try {
      expect(await sweepWaOutboxOnce()).toEqual({ claimed: 21 });
    } finally {
      spy.mockRestore();
    }

    const rows = await db().select().from(s.waOutbox);
    expect(rows.find((row) => row.id === outboundId)?.status).toBe("SENT");
    expect(rows.filter((row) => row.kind === "MEDIA_FETCH" && row.status === "QUEUED")).toHaveLength(5);
  });

  it("ينظف الصفوف الملغاة بلا احتسابها من throttle حتى يصل إلى إرسال صالح", async () => {
    await seedActiveIntegration(1);
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1 });
    await db().insert(s.waHubSettings).values({ id: 1, throttlePerMinute: 1, flowReservationNearExpiry: true });
    for (let index = 0; index < 3; index++) {
      await enqueueOutbox({
        dedupeKey: `dedupe-stale-before-valid-${index}`,
        branchId: 1,
        kind: "TEMPLATE",
        toPhoneE164: "+9647701234567",
        templateName: "reservation_near_expiry",
        templateLang: "ar",
        payloadJson: {
          bodyParams: ["RES-STALE", "عميل", "صنف", "15:00"],
          deliveryGuard: {
            type: "RESERVATION_NEAR_EXPIRY",
            reservationId: 900000 + index,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        },
      });
    }
    const { id: validId } = await enqueueOutbox({
      dedupeKey: "dedupe-valid-after-stale",
      branchId: 1,
      kind: "SESSION_TEXT",
      conversationId: convId,
      toPhoneE164: "+9647701234567",
      payloadJson: { text: "يجب أن تصل في الدورة نفسها" },
    });

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(successResponder("wamid.AFTER.STALE"));
    try {
      expect(await sweepWaOutboxOnce()).toEqual({ claimed: 4 });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }

    const rows = await db().select().from(s.waOutbox);
    expect(rows.filter((row) => row.status === "CANCELLED")).toHaveLength(3);
    expect(rows.find((row) => row.id === validId)?.status).toBe("SENT");
  });

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

  it("Kill Switch مفعّل ⇒ الكنّاس لا يلتقط أي صفّ QUEUED مستحقّ (claimed=0، يبقى QUEUED بلا إرسال)؛ وبعد إطفائه يُلتقط ويُرسَل فوراً", async () => {
    await seedActiveIntegration(1);
    const convId = await seedConversation({ branchId: 1, hoursAgo: 1 });
    const { id } = await enqueueOutbox({
      dedupeKey: "dedupe-killswitch",
      branchId: 1,
      kind: "SESSION_TEXT",
      conversationId: convId,
      toPhoneE164: "+9647701234567",
      payloadJson: { text: "يجب ألّا يُرسَل أثناء الإيقاف" },
    });

    await db().insert(s.waHubSettings).values({ id: 1, campaignApprovalThreshold: 500, killSwitch: true });

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(successResponder("wamid.SHOULD_NOT_SEND"));
    try {
      const resultBlocked = await sweepWaOutboxOnce();
      expect(resultBlocked.claimed).toBe(0);
      expect(spy).not.toHaveBeenCalled(); // لا محاولة إرسال فعلية أثناء الإيقاف.

      const rowBlocked = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, id)))[0];
      expect(rowBlocked.status).toBe("QUEUED"); // لم يُلتقَط — لم يُلمَس.

      // رفع Kill Switch ⇒ الكنّاس يستأنف تلقائياً التقاط نفس الصفّ الباقي QUEUED.
      await db().update(s.waHubSettings).set({ killSwitch: false }).where(eq(s.waHubSettings.id, 1));
      const resultResumed = await sweepWaOutboxOnce();
      expect(resultResumed.claimed).toBe(1);
    } finally {
      spy.mockRestore();
    }

    const rowSent = (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, id)))[0];
    expect(rowSent.status).toBe("SENT");
    expect(rowSent.wamid).toBe("wamid.SHOULD_NOT_SEND");
  });
});
