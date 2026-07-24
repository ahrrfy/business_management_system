/**
 * اختبارات T4.2 — CSAT: الإطلاق (resolveTask، §د-١) + الالتقاط (webhookProcessor، ردّ الزرّ
 * التفاعليّ، §د-٢). القاعدة الذهبية: CSAT لا يُفشِل resolveTask أبداً حتى لو رمى الاستدعاء الداخلي.
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { __resetKeyCacheForTests, encryptSecret } from "../cryptoService";
import { createTask } from "../tasks/create";
import { claimTask, resolveTask } from "../tasks/lifecycle";
import { persistWaEvent, processWaEvent } from "../whatsapp/webhookProcessor";

vi.mock("../whatsapp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../whatsapp")>();
  return { ...actual, checkAutomationGate: vi.fn(actual.checkAutomationGate) };
});
// eslint-disable-next-line import/order -- يجب أن يأتي بعد vi.mock (مرفوع تلقائياً فوقه على أي حال).
import { checkAutomationGate as checkAutomationGateMocked } from "../whatsapp";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
const insertId = (r: unknown): number => Number((r as any)?.[0]?.insertId ?? (r as any)?.insertId);
const actor = { userId: 3, branchId: 1, role: "cashier" as const };

const ORIGINAL_KEY = process.env.INTEGRATIONS_ENCRYPTION_KEY;
const TEST_KEY_HEX = crypto.randomBytes(32).toString("hex");

async function seedBase() {
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 3, openId: "csat_cashier", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 });
}

async function seedActiveIntegration(phoneNumberId = "15559990000") {
  await db().insert(s.channelIntegrations).values({
    branchId: 1,
    channel: "WHATSAPP",
    phoneNumberId,
    encryptedAccessToken: encryptSecret("fake-access-token"),
    status: "ACTIVE",
  });
}

async function setWaHubSettings(partial: Partial<typeof s.waHubSettings.$inferInsert> = {}) {
  await db().delete(s.waHubSettings);
  await db().insert(s.waHubSettings).values({ id: 1, ...partial });
}

/** محادثة WHATSAPP بـlastInboundAt منذ hoursAgo ساعة (أو null صراحةً = لا رسالة واردة قط). */
async function seedConversation(hoursAgo: number | null, channelHandle = "9647701112233"): Promise<number> {
  const res = await db().insert(s.conversations).values({
    branchId: 1,
    channel: "WHATSAPP",
    channelHandle,
    lastInboundAt: hoursAgo == null ? null : new Date(Date.now() - hoursAgo * 3600_000),
  });
  return insertId(res);
}

async function seedSupportTask(conversationId: number | null): Promise<number> {
  const { taskId } = await createTask({ branchId: 1, kind: "SUPPORT", title: "شكوى عميل", conversationId }, { userId: 3, branchId: 1 });
  await claimTask(taskId, actor);
  return taskId;
}

let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = TEST_KEY_HEX;
  __resetKeyCacheForTests();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ messages: [{ id: "wamid.TEST" }] }), { status: 200, headers: { "content-type": "application/json" } }),
  );
});

afterEach(async () => {
  // يُصرِّف أي إرسال خلفيّ معلَّق (enqueueAndDispatch/setImmediate) قبل تفريغ __setup__.ts العالمي
  // لكل الجداول — وقاية من سباق تنظيف (راجع نفس التعليق في flowNotify.test.ts).
  await new Promise((resolve) => setImmediate(resolve));
  fetchSpy?.mockRestore();
});

afterAll(() => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = ORIGINAL_KEY;
  __resetKeyCacheForTests();
});

// ── CSAT — الإطلاق (resolveTask) ─────────────────────────────────────────────────────────────

describe("CSAT — الإطلاق (resolveTask)", () => {
  beforeEach(async () => {
    await seedBase();
    await seedActiveIntegration();
  });

  it("resolve مهمة SUPPORT بcsatOnResolve ON ونافذة مفتوحة ⇒ outbox تفاعلي بdedupeKey CSAT:{taskId} + csatRequestedAt", async () => {
    await setWaHubSettings({ csatOnResolve: true });
    const convId = await seedConversation(2);
    const taskId = await seedSupportTask(convId);

    const res = await resolveTask(taskId, actor, "تمّ الحلّ مع العميل");
    expect(res.status).toBe("RESOLVED");

    const rows = await db().select().from(s.waOutbox).where(eq(s.waOutbox.dedupeKey, `CSAT:${taskId}`));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("SESSION_TEXT");
    const payload = rows[0].payloadJson as { text?: string; buttons?: Array<{ id: string; title: string }> };
    expect(Array.isArray(payload.buttons)).toBe(true);
    expect(payload.buttons!.length).toBeLessThanOrEqual(3); // حدّ Cloud API الصارم لأزرار الردّ السريع.
    expect(payload.buttons!.some((b) => b.id === `csat:${taskId}:5`)).toBe(true);

    const task = (await db().select().from(s.tasks).where(eq(s.tasks.id, taskId)))[0];
    expect(task.csatRequestedAt).not.toBeNull();
  });

  it("csatOnResolve OFF ⇒ لا CSAT رغم نافذة مفتوحة، وresolve ينجح كالمعتاد", async () => {
    await setWaHubSettings({ csatOnResolve: false });
    const convId = await seedConversation(2);
    const taskId = await seedSupportTask(convId);
    const res = await resolveTask(taskId, actor, "تمّ الحلّ");
    expect(res.status).toBe("RESOLVED");
    expect(await db().select().from(s.waOutbox)).toHaveLength(0);
    const task = (await db().select().from(s.tasks).where(eq(s.tasks.id, taskId)))[0];
    expect(task.csatRequestedAt).toBeNull();
  });

  it("مهمّة غير SUPPORT (مثلاً INQUIRY) ⇒ لا CSAT حتى مع المفتاح ON", async () => {
    await setWaHubSettings({ csatOnResolve: true });
    const convId = await seedConversation(2);
    const { taskId } = await createTask({ branchId: 1, kind: "INQUIRY", title: "استفسار", conversationId: convId }, { userId: 3, branchId: 1 });
    await claimTask(taskId, actor);
    await resolveTask(taskId, actor);
    expect(await db().select().from(s.waOutbox)).toHaveLength(0);
  });

  it("نافذة الردّ الحرّ مغلقة (آخر رسالة منذ >٢٤ ساعة) ⇒ لا CSAT", async () => {
    await setWaHubSettings({ csatOnResolve: true });
    const convId = await seedConversation(30);
    const taskId = await seedSupportTask(convId);
    await resolveTask(taskId, actor, "تمّ الحلّ");
    expect(await db().select().from(s.waOutbox)).toHaveLength(0);
  });

  it("مهمّة SUPPORT بلا conversationId (بلا قناة واتساب) ⇒ لا CSAT بلا أي خطأ", async () => {
    await setWaHubSettings({ csatOnResolve: true });
    const taskId = await seedSupportTask(null);
    const res = await resolveTask(taskId, actor, "تمّ الحلّ");
    expect(res.status).toBe("RESOLVED");
    expect(await db().select().from(s.waOutbox)).toHaveLength(0);
  });

  it("resolveTask لا يفشل أبداً حتى لو رمى الاستدعاء الداخلي لبوّابة الأتمتة (حقن فشل متعمّد)", async () => {
    await setWaHubSettings({ csatOnResolve: true });
    const convId = await seedConversation(2);
    const taskId = await seedSupportTask(convId);

    vi.mocked(checkAutomationGateMocked).mockRejectedValueOnce(new Error("محقون: فشل متعمّد للاختبار"));

    const res = await resolveTask(taskId, actor, "تمّ الحلّ");
    expect(res.status).toBe("RESOLVED");
    const task = (await db().select().from(s.tasks).where(eq(s.tasks.id, taskId)))[0];
    expect(task.taskStatus).toBe("RESOLVED");
  });
});

// ── CSAT — الالتقاط (webhookProcessor، ردّ الزرّ التفاعليّ) ─────────────────────────────────────

describe("CSAT — الالتقاط (webhookProcessor)", () => {
  beforeEach(async () => {
    await seedBase();
    await seedActiveIntegration();
  });

  function buttonPayload(from: string, buttonId: string, title: string, msgId: string) {
    return {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "15559990000" },
                messages: [{ from, id: msgId, type: "interactive", interactive: { button_reply: { id: buttonId, title } } }],
              },
            },
          ],
        },
      ],
    };
  }

  it("button_reply بمعرّف csat:{taskId}:4 ⇒ tasks.csatScore=4 + حدث CSAT في taskEvents", async () => {
    const { taskId } = await createTask({ branchId: 1, kind: "SUPPORT", title: "مهمّة CSAT-1" }, { userId: 3, branchId: 1 });
    const { id } = await persistWaEvent(buttonPayload("9647701112233", `csat:${taskId}:4`, "جيد", "wamid.CSAT.1"), null);
    await processWaEvent(id);

    const task = (await db().select().from(s.tasks).where(eq(s.tasks.id, taskId)))[0];
    expect(task.csatScore).toBe(4);
    const events = await db().select().from(s.taskEvents).where(eq(s.taskEvents.taskId, taskId));
    expect(events.some((e) => e.eventType === "CSAT")).toBe(true);
  });

  it("ضغطة ثانية على مهمّة مُقيَّمة مسبقاً ⇒ idempotent — لا يُكتَب فوق التقييم القائم", async () => {
    const { taskId } = await createTask({ branchId: 1, kind: "SUPPORT", title: "مهمّة CSAT-2" }, { userId: 3, branchId: 1 });
    await db().update(s.tasks).set({ csatScore: 5 }).where(eq(s.tasks.id, taskId));
    const { id } = await persistWaEvent(buttonPayload("9647701112233", `csat:${taskId}:1`, "سيّئ", "wamid.CSAT.2"), null);
    await processWaEvent(id);
    const task = (await db().select().from(s.tasks).where(eq(s.tasks.id, taskId)))[0];
    expect(task.csatScore).toBe(5); // لم يتغيّر.
  });

  it("معرّف زرّ لا يطابق نمط csat: ⇒ يُتجاهَل بأمان بلا رمي — الرسالة العادية تُدرَج كالمعتاد", async () => {
    const { id } = await persistWaEvent(buttonPayload("9647701112233", "some_other_button_id", "غير ذلك", "wamid.CSAT.3"), null);
    await expect(processWaEvent(id)).resolves.toBeUndefined();
    const event = (await db().select().from(s.waWebhookEvents).where(eq(s.waWebhookEvents.id, id)))[0];
    expect(event.status).toBe("PROCESSED");
  });

  it("معرّف بtaskId غير موجود ⇒ يُتجاهَل بأمان بلا رمي", async () => {
    const { id } = await persistWaEvent(buttonPayload("9647701112233", "csat:999999:3", "عادي", "wamid.CSAT.4"), null);
    await expect(processWaEvent(id)).resolves.toBeUndefined();
    const event = (await db().select().from(s.waWebhookEvents).where(eq(s.waWebhookEvents.id, id)))[0];
    expect(event.status).toBe("PROCESSED");
  });
});
