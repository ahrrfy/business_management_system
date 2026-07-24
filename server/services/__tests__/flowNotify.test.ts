/**
 * اختبارات T4.2 — الأتمتة الخلفية: `flowNotify` (الحارس المشترك، §أ) + ربط التدفّقات (§ب: تذكيرات
 * AR/AP عبر Cloud API، order_ready، purchase_thanks، consignment_withdraw) + الردّ الآلي (§ج: بعد
 * الدوام/الترحيب). القاعدة الذهبية المُتحقَّق منها في كل سيناريو حَقَنَ فشلاً: الأتمتة لا تُفشِل
 * عملية أعمال حقيقية أبداً (خصوصاً مسار البيع الذرّي في createSale).
 *
 * `vi.mock("../whatsapp", ...)` يلفّ `flowNotify` بمُموِّه (`vi.fn`) يُفوِّض للتنفيذ الحقيقي
 * افتراضياً — يتيح حَقن فشل مُتعمَّد لاختبار واحد بـ`mockRejectedValueOnce` بلا المساس ببقية
 * الاختبارات. اختبارات `flowNotify` نفسه تستورده مباشرةً من `../whatsapp/flowNotify` (بلا تمويه).
 *
 * fetch عالمي مُموَّه دائماً (نجاح فوري) لأنّ `enqueueAndDispatch` يُطلق محاولة إرسال خلفية غير
 * منتظرة (`setImmediate`) — بلا تمويه ستضرب الاختبارات شبكة حقيقية بتوكن وهمي.
 */
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { __resetKeyCacheForTests, encryptSecret } from "../cryptoService";
import { createProduct } from "../catalogService";
import { createSupplier } from "../supplierService";
import { createSale } from "../sale/create";
import { createConsignmentNote } from "../consignment/noteService";
import { markWorkOrderReady } from "../workOrder/lifecycle";
import { sendViaApi as sendArViaApi } from "../arRemindersService";
import { sendViaApi as sendApViaApi } from "../apRemindersService";
import { flowNotify as flowNotifyReal, isOutsideBusinessHours } from "../whatsapp/flowNotify";
import { persistWaEvent, processWaEvent } from "../whatsapp/webhookProcessor";

vi.mock("../whatsapp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../whatsapp")>();
  return { ...actual, flowNotify: vi.fn(actual.flowNotify) };
});
// eslint-disable-next-line import/order -- يجب أن يأتي بعد vi.mock (مرفوع تلقائياً فوقه على أي حال).
import { flowNotify as flowNotifyMocked } from "../whatsapp";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
const insertId = (r: unknown): number => Number((r as any)?.[0]?.insertId ?? (r as any)?.insertId);
const actor = { userId: 1, branchId: 1 };

const ORIGINAL_KEY = process.env.INTEGRATIONS_ENCRYPTION_KEY;
const TEST_KEY_HEX = crypto.randomBytes(32).toString("hex");

async function seedBranchAndUser() {
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "t42_user", name: "مدير اختبار", role: "manager", loginMethod: "local", branchId: 1 });
}

async function seedActiveIntegration(branchId = 1, phoneNumberId = "15550009999") {
  await db().insert(s.channelIntegrations).values({
    branchId,
    channel: "WHATSAPP",
    phoneNumberId,
    encryptedAccessToken: encryptSecret("fake-access-token"),
    status: "ACTIVE",
  });
}

/** يستبدل صفّ الإعدادات singleton (id=1) — حذف ثم إدراج (نمط tasksAutoCreate.test.ts). */
async function setWaHubSettings(partial: Partial<typeof s.waHubSettings.$inferInsert> = {}) {
  await db().delete(s.waHubSettings);
  await db().insert(s.waHubSettings).values({ id: 1, ...partial });
}

async function seedTemplate(name: string, status: "APPROVED" | "PENDING" = "APPROVED") {
  await db().insert(s.waTemplates).values({ name, language: "ar", category: "UTILITY", templateStatus: status, bodyText: "نص تجريبي {{1}} {{2}}" });
}

async function seedCustomer(overrides: Partial<typeof s.customers.$inferInsert> = {}): Promise<number> {
  const res = await db().insert(s.customers).values({ name: "عميل تجريبي", phone: "+9647701112233", ...overrides });
  return insertId(res);
}

async function seedSupplier(overrides: Partial<typeof s.suppliers.$inferInsert> = {}): Promise<number> {
  const res = await db().insert(s.suppliers).values({ name: "مورّد تجريبي", phone: "+9647709998877", ...overrides });
  return insertId(res);
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
  // يُصرِّف أي محاولة إرسال خلفية معلَّقة (enqueueAndDispatch يُشغّل dispatchOutboxRow عبر
  // setImmediate بلا انتظار) **قبل** أن يُفرِّغ __setup__.ts العالمي كل الجداول — وقاية من سباق
  // تحديث/إدراج خلفيّ متأخّر يضرب صفوفاً حُذفت للتوّ، ومن استعمال fetch بعد استرجاعه.
  await new Promise((resolve) => setImmediate(resolve));
  fetchSpy?.mockRestore();
});

afterAll(() => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = ORIGINAL_KEY;
  __resetKeyCacheForTests();
});

// ── flowNotify — الحارس المشترك (§أ) ────────────────────────────────────────────────────────────

describe("flowNotify — الحارس المشترك", () => {
  beforeEach(async () => {
    await seedBranchAndUser();
  });

  it("killSwitch=true ⇒ skip kill_switch (حتى بلا تكامل/قالب)", async () => {
    await setWaHubSettings({ killSwitch: true, flowOrderReady: true });
    const res = await flowNotifyReal({
      flowKey: "flowOrderReady",
      branchId: 1,
      toPhoneE164: "+9647701234567",
      templateName: "order_ready",
      bodyParams: ["أحمد", "WO-1"],
      dedupeKey: "T42-1",
    });
    expect(res).toEqual({ skipped: "kill_switch" });
    expect(await db().select().from(s.waOutbox)).toHaveLength(0);
  });

  it("مفتاح التدفّق غير مفعّل (افتراضي OFF) ⇒ skip disabled", async () => {
    await setWaHubSettings({}); // كل مفاتيح الأتمتة OFF افتراضياً.
    const res = await flowNotifyReal({
      flowKey: "flowOrderReady",
      branchId: 1,
      toPhoneE164: "+9647701234567",
      templateName: "order_ready",
      bodyParams: ["أحمد", "WO-1"],
      dedupeKey: "T42-2",
    });
    expect(res).toEqual({ skipped: "disabled" });
  });

  it("لا تكامل واتساب ACTIVE على الفرع ⇒ skip no_integration", async () => {
    await setWaHubSettings({ flowOrderReady: true });
    const res = await flowNotifyReal({
      flowKey: "flowOrderReady",
      branchId: 1,
      toPhoneE164: "+9647701234567",
      templateName: "order_ready",
      bodyParams: ["أحمد", "WO-1"],
      dedupeKey: "T42-3",
    });
    expect(res).toEqual({ skipped: "no_integration" });
  });

  it("customerId مُمرَّر وwaConsent='OPTED_OUT' ⇒ skip opted_out دائماً", async () => {
    await setWaHubSettings({ flowOrderReady: true });
    await seedActiveIntegration();
    const custId = await seedCustomer({ waConsent: "OPTED_OUT" });
    const res = await flowNotifyReal({
      flowKey: "flowOrderReady",
      branchId: 1,
      toPhoneE164: "+9647701234567",
      customerId: custId,
      templateName: "order_ready",
      bodyParams: ["أحمد", "WO-1"],
      dedupeKey: "T42-4",
    });
    expect(res).toEqual({ skipped: "opted_out" });
  });

  it("القالب غير APPROVED عند Meta (غائب من waTemplates) ⇒ skip template_unavailable بلا رمي", async () => {
    await setWaHubSettings({ flowOrderReady: true });
    await seedActiveIntegration();
    const res = await flowNotifyReal({
      flowKey: "flowOrderReady",
      branchId: 1,
      toPhoneE164: "+9647701234567",
      templateName: "order_ready",
      bodyParams: ["أحمد", "WO-1"],
      dedupeKey: "T42-5",
    });
    expect(res).toEqual({ skipped: "template_unavailable" });
  });

  it("كل الشروط متحقّقة ⇒ صفّ outbox TEMPLATE بdedupeKey صحيح؛ استدعاء مكرّر بنفس dedupeKey ⇒ صفّ واحد فقط", async () => {
    await setWaHubSettings({ flowOrderReady: true });
    await seedActiveIntegration();
    await seedTemplate("order_ready");
    const input = {
      flowKey: "flowOrderReady" as const,
      branchId: 1,
      toPhoneE164: "+9647701234567",
      templateName: "order_ready",
      bodyParams: ["أحمد", "WO-1"],
      dedupeKey: "T42-6",
    };
    const first = await flowNotifyReal(input);
    expect(first).toMatchObject({ queued: true, isNew: true });
    const second = await flowNotifyReal(input);
    expect(second).toMatchObject({ queued: true, isNew: false });
    if ("outboxId" in first && "outboxId" in second) expect(second.outboxId).toBe(first.outboxId);

    const rows = await db().select().from(s.waOutbox).where(eq(s.waOutbox.dedupeKey, "T42-6"));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("TEMPLATE");
    expect(rows[0].templateName).toBe("order_ready");
  });
});

// ── isOutsideBusinessHours — دالة نقيّة (§ج) ─────────────────────────────────────────────────────

describe("isOutsideBusinessHours — دالة نقيّة", () => {
  it("بلا إعداد صالح (null/فارغ/حقل ناقص) ⇒ false تحفّظياً (داخل الدوام)", () => {
    expect(isOutsideBusinessHours(null)).toBe(false);
    expect(isOutsideBusinessHours({})).toBe(false);
    expect(isOutsideBusinessHours({ days: [1], from: "09:00" })).toBe(false); // to مفقود.
  });

  it("يوم غير مدرَج في days ⇒ خارج الدوام دائماً بغضّ النظر عن الوقت", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    expect(isOutsideBusinessHours({ days: [], from: "09:00", to: "18:00" } as any, now)).toBe(false); // days فارغة = غير صالح.
    const weekdayNow = new Date(now.getTime() + 3 * 3600_000).getUTCDay();
    const otherDay = (weekdayNow + 1) % 7;
    expect(isOutsideBusinessHours({ days: [otherDay], from: "09:00", to: "18:00" }, now)).toBe(true);
  });

  it("داخل يوم الدوام: قبل/بعد الساعات ⇒ خارج الدوام؛ ضمنها ⇒ داخل الدوام", () => {
    const base = new Date("2026-07-21T05:00:00.000Z"); // ٠٨:٠٠ بغداد (UTC+3).
    const weekday = new Date(base.getTime() + 3 * 3600_000).getUTCDay();
    const cfg = { days: [weekday], from: "09:00", to: "18:00" };
    expect(isOutsideBusinessHours(cfg, base)).toBe(true); // ٠٨:٠٠ قبل الدوام.
    expect(isOutsideBusinessHours(cfg, new Date(base.getTime() + 4 * 3600_000))).toBe(false); // ١٢:٠٠.
    expect(isOutsideBusinessHours(cfg, new Date(base.getTime() + 11 * 3600_000))).toBe(true); // ١٩:٠٠ بعد الدوام.
  });

  it("نطاق مقلوب/متساوٍ (from>=to) ⇒ إعداد غير صالح، تحفّظياً false", () => {
    expect(isOutsideBusinessHours({ days: [0, 1, 2, 3, 4, 5, 6], from: "18:00", to: "09:00" }, new Date())).toBe(false);
  });
});

// ── الردّ الآلي — بعد الدوام والترحيب (webhookProcessor، §ج) ─────────────────────────────────────

describe("الردّ الآلي — بعد الدوام والترحيب (webhookProcessor)", () => {
  beforeEach(async () => {
    await seedBranchAndUser();
    await seedActiveIntegration(1, "15559990000");
  });

  function inboundPayload(from: string, body: string, msgId: string) {
    return {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "15559990000", display_phone_number: "9647700000000" },
                contacts: [{ profile: { name: "عميل واتساب" } }],
                messages: [{ from, id: msgId, type: "text", text: { body } }],
              },
            },
          ],
        },
      ],
    };
  }

  /** يوم بغداد الحاليّ (getUTCDay بعد إزاحة UTC+3) — حتمي بلا تخمين تقويميّ يدويّ. */
  function baghdadWeekdayToday(): number {
    return new Date(Date.now() + 3 * 3600_000).getUTCDay();
  }

  it("داخل الدوام (اليوم والوقت الحاليّان ضمن الإعداد) ⇒ لا ردّ آلي بعد الدوام رغم تفعيل المفتاح", async () => {
    await setWaHubSettings({
      autoReplyAfterHours: true,
      afterHoursReply: "نعتذر، نحن خارج أوقات الدوام حالياً",
      businessHoursJson: { days: [baghdadWeekdayToday()], from: "00:00", to: "23:59" }, // اليوم كاملاً = داخل الدوام دائماً.
    });
    const { id } = await persistWaEvent(inboundPayload("9647709998801", "مرحباً", "wamid.AH.1"), null);
    await processWaEvent(id);
    const rows = await db().select().from(s.waOutbox);
    expect(rows.filter((r) => r.dedupeKey.startsWith("AH:"))).toHaveLength(0);
  });

  it("خارج الدوام (اليوم الحاليّ مُستبعَد من أيام الدوام) + المفتاح ON ⇒ ردّ واحد فقط — throttle مرّة/يوم", async () => {
    const today = baghdadWeekdayToday();
    const daysExcludingToday = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== today);
    await setWaHubSettings({
      autoReplyAfterHours: true,
      afterHoursReply: "نعتذر، نحن خارج أوقات الدوام حالياً",
      businessHoursJson: { days: daysExcludingToday, from: "00:00", to: "23:59" }, // اليوم عطلة دائماً.
    });
    const { id: id1 } = await persistWaEvent(inboundPayload("9647709998802", "مرحباً", "wamid.AH.2"), null);
    await processWaEvent(id1);
    const { id: id2 } = await persistWaEvent(inboundPayload("9647709998802", "رسالة ثانية من نفس العميل", "wamid.AH.3"), null);
    await processWaEvent(id2);

    const rows = await db().select().from(s.waOutbox);
    const ahRows = rows.filter((r) => r.dedupeKey.startsWith("AH:"));
    expect(ahRows).toHaveLength(1); // throttle مرّة واحدة/محادثة/يوم رغم رسالتين واردتين.
    expect(ahRows[0].kind).toBe("SESSION_TEXT");
  });

  it("خارج الدوام + المفتاح OFF ⇒ لا ردّ آلي إطلاقاً", async () => {
    const today = baghdadWeekdayToday();
    const daysExcludingToday = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== today);
    await setWaHubSettings({
      autoReplyAfterHours: false,
      afterHoursReply: "نعتذر، نحن خارج أوقات الدوام حالياً",
      businessHoursJson: { days: daysExcludingToday, from: "00:00", to: "23:59" },
    });
    const { id } = await persistWaEvent(inboundPayload("9647709998803", "مرحباً", "wamid.AH.4"), null);
    await processWaEvent(id);
    expect(await db().select().from(s.waOutbox)).toHaveLength(0);
  });

  it("محادثة جديدة تماماً + autoReplyWelcome ON ⇒ ترحيب مرّة واحدة فقط (dedupeKey WELCOME:{convId})", async () => {
    await setWaHubSettings({ autoReplyWelcome: true, welcomeReply: "أهلاً بكم في مكتبتنا" });
    const { id: id1 } = await persistWaEvent(inboundPayload("9647701112204", "مرحباً", "wamid.W.1"), null);
    await processWaEvent(id1);
    const { id: id2 } = await persistWaEvent(inboundPayload("9647701112204", "رسالة ثانية من نفس العميل", "wamid.W.2"), null);
    await processWaEvent(id2);

    const conv = (await db().select().from(s.conversations).where(eq(s.conversations.channelHandle, "9647701112204")))[0];
    const welcomeRows = await db().select().from(s.waOutbox).where(eq(s.waOutbox.dedupeKey, `WELCOME:${conv.id}`));
    expect(welcomeRows).toHaveLength(1); // مرّة واحدة رغم رسالتين — الثانية ليست من محادثة جديدة.
    expect(welcomeRows[0].kind).toBe("SESSION_TEXT");
  });

  it("autoReplyWelcome OFF ⇒ لا ترحيب رغم أن المحادثة جديدة", async () => {
    await setWaHubSettings({ autoReplyWelcome: false, welcomeReply: "أهلاً بكم في مكتبتنا" });
    const { id } = await persistWaEvent(inboundPayload("9647701112205", "مرحباً", "wamid.W.3"), null);
    await processWaEvent(id);
    expect(await db().select().from(s.waOutbox)).toHaveLength(0);
  });
});

// ── sendViaApi — تذكيرات AR/AP عبر Cloud API (§ب-١) ─────────────────────────────────────────────

describe("sendViaApi — تذكيرات AR/AP عبر Cloud API", () => {
  beforeEach(async () => {
    await seedBranchAndUser();
    await setWaHubSettings({ flowArReminder: true });
    await seedActiveIntegration();
    await seedTemplate("payment_reminder");
  });

  it("AR: عميل مؤهَّل بهاتف ⇒ sent:true + سجلّ arReminders بـsentVia='API'", async () => {
    const custId = await seedCustomer({ name: "زبون آجل" });
    // assertCustomerHasBranchInvoice (حماية IDOR في logReminderSent) يتطلّب فاتورة فعلية للعميل
    // في هذا الفرع — إدراج مباشر أبسط من مرور دورة بيع كاملة (لسنا نختبر منطق الفوترة هنا).
    await db().insert(s.invoices).values({
      invoiceNumber: `INV-T42-${Math.random().toString(36).slice(2, 8)}`,
      sourceType: "POS",
      branchId: 1,
      customerId: custId,
      subtotal: "50000.00",
      total: "50000.00",
      status: "PENDING",
    });
    const r = await sendArViaApi({ customerId: custId, totalUnpaidSnapshot: "50000", oldestInvoiceDate: "2026-07-01", daysOverdue: 10 }, actor);
    expect(r.sent).toBe(true);
    const rows = await db().select().from(s.arReminders).where(eq(s.arReminders.customerId, custId));
    expect(rows).toHaveLength(1);
    expect(rows[0].sentVia).toBe("API");
    expect(rows[0].status).toBe("SENT");
  });

  it("AR: عميل بلا هاتف مسجَّل ⇒ sent:false بلا أي تسجيل تذكير", async () => {
    const custId = await seedCustomer({ name: "بلا هاتف", phone: null });
    const r = await sendArViaApi({ customerId: custId, totalUnpaidSnapshot: "50000", oldestInvoiceDate: "2026-07-01", daysOverdue: 10 }, actor);
    expect(r.sent).toBe(false);
    expect(await db().select().from(s.arReminders)).toHaveLength(0);
  });

  it("AR: مفتاح flowArReminder OFF ⇒ sent:false بلا تسجيل (المسار اليدوي wa.me/logSent يبقى متاحاً كما هو)", async () => {
    await setWaHubSettings({ flowArReminder: false });
    const custId = await seedCustomer();
    const r = await sendArViaApi({ customerId: custId, totalUnpaidSnapshot: "50000", oldestInvoiceDate: "2026-07-01", daysOverdue: 10 }, actor);
    expect(r.sent).toBe(false);
    if (!r.sent) expect(r.reason).toBe("disabled");
    expect(await db().select().from(s.arReminders)).toHaveLength(0);
  });

  it("AP: مورّد مؤهَّل بهاتف ⇒ sent:true + سجلّ apReminders بـsentVia='API'", async () => {
    const supId = await seedSupplier({ name: "مورّد آجل" });
    // assertSupplierHasBranchPO (حماية IDOR) يتطلّب أمر شراء ملتزَم فعلياً في هذا الفرع.
    await db().insert(s.purchaseOrders).values({
      poNumber: `PO-T42-${Math.random().toString(36).slice(2, 8)}`,
      supplierId: supId,
      branchId: 1,
      subtotal: "30000.00",
      total: "30000.00",
      status: "CONFIRMED",
    });
    const r = await sendApViaApi({ supplierId: supId, totalUnpaidSnapshot: "30000", oldestPoDate: "2026-07-01", daysOverdue: 10 }, actor);
    expect(r.sent).toBe(true);
    const rows = await db().select().from(s.apReminders).where(eq(s.apReminders.supplierId, supId));
    expect(rows).toHaveLength(1);
    expect(rows[0].sentVia).toBe("API");
  });

  it("AP: مورّد OPTED_OUT ⇒ sent:false بلا تسجيل (suppliers.waConsent يُحترَم رغم أن flowNotify.customerId خاصّ بالعملاء)", async () => {
    const supId = await seedSupplier({ waConsent: "OPTED_OUT" });
    const r = await sendApViaApi({ supplierId: supId, totalUnpaidSnapshot: "30000", oldestPoDate: "2026-07-01", daysOverdue: 10 }, actor);
    expect(r.sent).toBe(false);
    expect(await db().select().from(s.apReminders)).toHaveLength(0);
  });
});

// ── order_ready — markWorkOrderReady (§ب-٢) ─────────────────────────────────────────────────────

describe("order_ready — markWorkOrderReady", () => {
  beforeEach(async () => {
    await seedBranchAndUser();
  });

  async function seedInProgressWorkOrder(customerId: number | null): Promise<number> {
    const res = await db().insert(s.workOrders).values({
      orderNumber: `WO-T42-${Math.random().toString(36).slice(2, 8)}`,
      branchId: 1,
      customerId,
      title: "أمر اختبار",
      status: "IN_PROGRESS",
    });
    return insertId(res);
  }

  it("flowOrderReady OFF ⇒ لا outbox والانتقال إلى READY ينجح كالمعتاد", async () => {
    await setWaHubSettings({ flowOrderReady: false });
    const custId = await seedCustomer();
    const woId = await seedInProgressWorkOrder(custId);
    const res = await markWorkOrderReady(woId);
    expect(res.status).toBe("READY");
    expect(await db().select().from(s.waOutbox)).toHaveLength(0);
    const row = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)))[0];
    expect(row.status).toBe("READY");
  });

  it("flowOrderReady ON + تكامل نشط + قالب معتمَد ⇒ outbox TEMPLATE بdedupeKey WO_READY + الانتقال ينجح", async () => {
    await setWaHubSettings({ flowOrderReady: true });
    await seedActiveIntegration();
    await seedTemplate("order_ready");
    const custId = await seedCustomer({ name: "عميل الأمر" });
    const woId = await seedInProgressWorkOrder(custId);
    const res = await markWorkOrderReady(woId);
    expect(res.status).toBe("READY");
    const rows = await db().select().from(s.waOutbox).where(eq(s.waOutbox.dedupeKey, `WO_READY:${woId}`));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("TEMPLATE");
    expect(rows[0].templateName).toBe("order_ready");
  });

  it("markWorkOrderReady لا يفشل أبداً حتى لو رمى flowNotify (حقن فشل متعمّد)", async () => {
    await setWaHubSettings({ flowOrderReady: true });
    await seedActiveIntegration();
    await seedTemplate("order_ready");
    const custId = await seedCustomer();
    const woId = await seedInProgressWorkOrder(custId);

    vi.mocked(flowNotifyMocked).mockRejectedValueOnce(new Error("محقون: فشل متعمّد للاختبار"));

    const res = await markWorkOrderReady(woId);
    expect(res.status).toBe("READY");
    const row = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)))[0];
    expect(row.status).toBe("READY");
  });
});

// ── purchase_thanks — createSale (§ب-٣، أخطر جزء: لا مسّ لذرّية البيع) ──────────────────────────

describe("purchase_thanks — createSale", () => {
  beforeEach(async () => {
    await seedBranchAndUser();
  });

  async function seedSimpleProduct(sell = "1000", cost = "500") {
    const sku = `T42P-${Math.random().toString(36).slice(2, 8)}`;
    await createProduct(
      {
        name: "دفتر اختبار T4.2",
        variants: [{ sku, costPrice: cost, openingStock: 100, units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL" as const, price: sell }] }] }],
      },
      actor,
    );
    const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, sku)))[0];
    const u = (await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(v.id))))[0];
    return { variantId: Number(v.id), productUnitId: Number(u.id) };
  }

  /** البيع النقدي الكامل يلزمه وردية مفتوحة (حارس مستقلّ في createSale — لا صلة بـT4.2). */
  async function openShift(): Promise<number> {
    return insertId(await db().insert(s.shifts).values({ branchId: 1, userId: actor.userId, openingBalance: "0", status: "OPEN" }));
  }

  it("بيع ناجح مع flowPurchaseThanks ON ⇒ القيد سليم والمخزون صحيح + outbox TEMPLATE بdedupeKey SALE_THANKS", async () => {
    await setWaHubSettings({ flowPurchaseThanks: true });
    await seedActiveIntegration();
    await seedTemplate("purchase_thanks");
    const custId = await seedCustomer({ name: "زبون البيع" });
    const { variantId, productUnitId } = await seedSimpleProduct("1000", "500");
    const shiftId = await openShift();

    const sale = await createSale(
      { branchId: 1, shiftId, customerId: custId, priceTier: "RETAIL", sourceType: "POS", lines: [{ variantId, productUnitId, quantity: "2" }], payment: { amount: "2000", method: "CASH" } },
      actor,
    );
    expect(sale.status).toBe("PAID");

    const entry = (
      await db().select().from(s.accountingEntries).where(and(eq(s.accountingEntries.entryType, "SALE"), eq(s.accountingEntries.invoiceId, sale.invoiceId)))
    )[0];
    expect(entry.revenue).toBe("2000.00");
    expect(entry.profit).toBe("1000.00"); // (1000-500) × 2.

    const rows = await db().select().from(s.waOutbox).where(eq(s.waOutbox.dedupeKey, `SALE_THANKS:${sale.invoiceId}`));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("TEMPLATE");
    expect(rows[0].templateName).toBe("purchase_thanks");
  });

  it("بيع مع فشل flowNotify (حقن فشل متعمّد) يبقى ناجحاً تماماً — الثبات المالي/المخزوني غير متأثر إطلاقاً", async () => {
    await setWaHubSettings({ flowPurchaseThanks: true });
    await seedActiveIntegration();
    await seedTemplate("purchase_thanks");
    const custId = await seedCustomer();
    const { variantId, productUnitId } = await seedSimpleProduct("1500", "600");
    const shiftId = await openShift();

    vi.mocked(flowNotifyMocked).mockRejectedValueOnce(new Error("محقون: فشل متعمّد للاختبار"));

    const sale = await createSale(
      { branchId: 1, shiftId, customerId: custId, priceTier: "RETAIL", sourceType: "POS", lines: [{ variantId, productUnitId, quantity: "1" }], payment: { amount: "1500", method: "CASH" } },
      actor,
    );
    expect(sale.status).toBe("PAID");

    const entry = (
      await db().select().from(s.accountingEntries).where(and(eq(s.accountingEntries.entryType, "SALE"), eq(s.accountingEntries.invoiceId, sale.invoiceId)))
    )[0];
    expect(entry.revenue).toBe("1500.00");
    expect(entry.profit).toBe("900.00"); // 1500 - 600.

    const stockRow = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, variantId)))[0];
    expect(stockRow.quantity).toBe(99); // ١٠٠ افتتاحي − ١ مباع.
  });

  it("بيع بلا عميل (customerId مفقود) ⇒ لا محاولة إشعار، والبيع ينجح كالمعتاد", async () => {
    await setWaHubSettings({ flowPurchaseThanks: true });
    await seedActiveIntegration();
    await seedTemplate("purchase_thanks");
    const { variantId, productUnitId } = await seedSimpleProduct("800", "300");
    const shiftId = await openShift();
    const sale = await createSale(
      { branchId: 1, shiftId, priceTier: "RETAIL", sourceType: "POS", lines: [{ variantId, productUnitId, quantity: "1" }], payment: { amount: "800", method: "CASH" } },
      actor,
    );
    expect(sale.status).toBe("PAID");
    expect(await db().select().from(s.waOutbox)).toHaveLength(0);
  });
});

// ── consignment_withdraw — سند WITHDRAW/EXCHANGE (§ب-٤) ─────────────────────────────────────────

describe("consignment_withdraw — سند WITHDRAW", () => {
  beforeEach(async () => {
    await seedBranchAndUser();
  });

  async function mkConsignProduct(consignorId: number) {
    const sku = `T42CN-${Math.random().toString(36).slice(2, 7)}`;
    await createProduct(
      {
        name: "دفتر أمانة T4.2",
        isConsignment: true,
        consignorId,
        variants: [{ sku, costPrice: "1000", units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL" as const, price: "1500" }] }] }],
      },
      actor,
    );
    const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, sku)))[0];
    const u = (await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(v.id))))[0];
    return { variantId: Number(v.id), productUnitId: Number(u.id) };
  }

  it("سند WITHDRAW ينجح دوماً بغضّ النظر عن اعتماد القالب: تخطٍّ آمن قبل الاعتماد، ثمّ outbox فعلي بعده", async () => {
    await setWaHubSettings({ flowConsignmentWithdraw: true });
    await seedActiveIntegration();

    const { supplierId: consignorId } = await createSupplier({ name: "مودِع اختبار T4.2", supplierKind: "CONSIGNOR", phone: "+9647705554433" }, actor);
    const { variantId, productUnitId } = await mkConsignProduct(consignorId);
    await createConsignmentNote({ noteType: "DEPOSIT", consignorId, branchId: 1, lines: [{ lineDirection: "IN", variantId, productUnitId, quantity: "10" }] }, actor);

    // القالب consignment_withdraw غير مُعتمَد بعد (لم نبذره) ⇒ flowNotify يتخطّى بأمان — السند ينجح.
    const w1 = await createConsignmentNote(
      { noteType: "WITHDRAW", consignorId, branchId: 1, attachmentUrl: "data:image/png;base64,x", lines: [{ lineDirection: "OUT", variantId, productUnitId, quantity: "3" }] },
      actor,
    );
    expect(w1.idempotentReplay).toBe(false);
    expect(await db().select().from(s.waOutbox)).toHaveLength(0);

    // بعد اعتماد القالب (محاكاة مزامنة Graph لاحقة) — سند سحب جديد يُصدر إشعاراً فعلياً.
    await seedTemplate("consignment_withdraw");
    const w2 = await createConsignmentNote(
      { noteType: "WITHDRAW", consignorId, branchId: 1, attachmentUrl: "data:image/png;base64,y", lines: [{ lineDirection: "OUT", variantId, productUnitId, quantity: "2" }] },
      actor,
    );
    const rows = await db().select().from(s.waOutbox);
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupeKey).toBe(`CONSIG_WD:${w2.noteId}`);
    expect(rows[0].kind).toBe("TEMPLATE");
  });

  it("سند DEPOSIT لا يُطلق إشعار سحب الأمانة أبداً (المفتاح مخصَّص لِـWITHDRAW/EXCHANGE فقط)", async () => {
    await setWaHubSettings({ flowConsignmentWithdraw: true });
    await seedActiveIntegration();
    await seedTemplate("consignment_withdraw");
    const { supplierId: consignorId } = await createSupplier({ name: "مودِع آخر", supplierKind: "CONSIGNOR", phone: "+9647705554400" }, actor);
    const { variantId, productUnitId } = await mkConsignProduct(consignorId);
    await createConsignmentNote({ noteType: "DEPOSIT", consignorId, branchId: 1, lines: [{ lineDirection: "IN", variantId, productUnitId, quantity: "5" }] }, actor);
    expect(await db().select().from(s.waOutbox)).toHaveLength(0);
  });
});
