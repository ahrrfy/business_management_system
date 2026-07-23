/**
 * بنك جهات الاتصال — أساس T3.1: تطبيع E.164 خادمي مشترك (server/lib/phone.ts) + مساري
 * إنشاء/تعديل العميل والمورّد (customerService/supplierService) + التقاط إلغاء الاشتراك التلقائي
 * من الوارد (webhookProcessor.processWaEvent). DB حقيقية على قاعدة الاختبار (نمط
 * webhookProcessor.test.ts لسيناريو الـwebhook — يحتاج تكاملاً نشطاً + مفتاح تشفير للاختبار).
 *
 * صفر تغيير سلوكي لمسار المتجر عند استخراج normalizeStorePhone يُحرَس بـ onlineOrderPhone.test.ts
 * القائم (يستورد normalizeStorePhone من onlineOrderService — يبقى أخضر بلا تعديل هنا).
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { normalizeIraqPhoneE164 } from "../../lib/phone";
import { createCustomer, updateCustomer } from "../customerService";
import { __resetKeyCacheForTests, encryptSecret } from "../cryptoService";
import { createSupplier, updateSupplier } from "../supplierService";
import { persistWaEvent, processWaEvent } from "../whatsapp/webhookProcessor";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const actor = { userId: 1, branchId: 1 };

const ORIGINAL_KEY = process.env.INTEGRATIONS_ENCRYPTION_KEY;
const TEST_KEY_HEX = crypto.randomBytes(32).toString("hex");

async function seedIntegration(phoneNumberId: string): Promise<void> {
  await db().insert(s.channelIntegrations).values({
    branchId: 1,
    channel: "WHATSAPP",
    phoneNumberId,
    encryptedAccessToken: encryptSecret("fake-access-token"),
    status: "ACTIVE",
  });
}

/** حمولة webhook مبسّطة برسالة نصّية واردة واحدة (نمط waPayload في webhookProcessor.test.ts). */
function waTextPayload(from: string, body: string, msgId: string) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "15550001111", display_phone_number: "15550001111" },
              messages: [{ from, id: msgId, type: "text", text: { body } }],
            },
          },
        ],
      },
    ],
  };
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

describe("normalizeIraqPhoneE164 — التطبيع النقي (بلا DB)", () => {
  it("كل الصيغ الشائعة لنفس الرقم تتلاقى على +9647701234567", () => {
    expect(normalizeIraqPhoneE164("07701234567")).toBe("+9647701234567");
    expect(normalizeIraqPhoneE164("+9647701234567")).toBe("+9647701234567");
    expect(normalizeIraqPhoneE164("009647701234567")).toBe("+9647701234567");
    expect(normalizeIraqPhoneE164("7701234567")).toBe("+9647701234567");
  });
});

describe("customerService — تطبيع E.164 خادمي عند الإنشاء/التعديل", () => {
  it("create بهاتف محلي «07701234567» ⇒ يُخزَّن +9647701234567", async () => {
    const { customerId } = await createCustomer({ name: "عميل هاتف محلي", phone: "07701234567" }, actor);
    const c = (await db().select().from(s.customers).where(eq(s.customers.id, customerId)).limit(1))[0];
    expect(c.phone).toBe("+9647701234567");
  });

  it("update بهاتف محلي ⇒ يُخزَّن +964… (فارغ يبقى فارغاً)", async () => {
    const { customerId } = await createCustomer({ name: "عميل بلا هاتف" }, actor);
    let c = (await db().select().from(s.customers).where(eq(s.customers.id, customerId)).limit(1))[0];
    expect(c.phone).toBeNull();

    await updateCustomer({ customerId, phone: "07709876543" }, actor);
    c = (await db().select().from(s.customers).where(eq(s.customers.id, customerId)).limit(1))[0];
    expect(c.phone).toBe("+9647709876543");
  });
});

describe("supplierService — تطبيع E.164 خادمي عند الإنشاء/التعديل", () => {
  it("create بهاتف محلي «07701234567» ⇒ يُخزَّن +9647701234567", async () => {
    const { supplierId } = await createSupplier({ name: "مورّد هاتف محلي", phone: "07701234567" }, actor);
    const r = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId)).limit(1))[0];
    expect(r.phone).toBe("+9647701234567");
  });

  it("update بهاتف محلي ⇒ يُخزَّن +964… (فارغ يبقى فارغاً)", async () => {
    const { supplierId } = await createSupplier({ name: "مورّد بلا هاتف" }, actor);
    let r = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId)).limit(1))[0];
    expect(r.phone).toBeNull();

    await updateSupplier({ supplierId, phone: "07709876543" }, actor);
    r = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId)).limit(1))[0];
    expect(r.phone).toBe("+9647709876543");
  });
});

describe("webhookProcessor — التقاط إلغاء الاشتراك التلقائي من الوارد", () => {
  it("محادثة مربوطة بعميل + رسالة «ايقاف» ⇒ waConsent='OPTED_OUT' وsource='AUTO_KEYWORD'", async () => {
    await seedIntegration("15550001111");
    await db().insert(s.customers).values({ id: 1, name: "عميل يريد الإيقاف", phone: "+9647701112222", isActive: true });

    const { id } = await persistWaEvent(waTextPayload("9647701112222", "ايقاف", "wamid.OPT1"), null);
    await processWaEvent(id);

    const c = (await db().select().from(s.customers).where(eq(s.customers.id, 1)).limit(1))[0];
    expect(c.waConsent).toBe("OPTED_OUT");
    expect(c.waConsentSource).toBe("AUTO_KEYWORD");
    expect(c.waConsentAt).toBeTruthy();

    const ev = (await db().select().from(s.waWebhookEvents).where(eq(s.waWebhookEvents.id, id)))[0];
    expect(ev.status).toBe("PROCESSED");
  });

  it("رسالة عادية لا تغيّر waConsent (يبقى UNKNOWN)", async () => {
    await seedIntegration("15550001111");
    await db().insert(s.customers).values({ id: 1, name: "عميل عادي", phone: "+9647701113333", isActive: true });

    const { id } = await persistWaEvent(waTextPayload("9647701113333", "مرحباً، أريد الاستفسار عن سعر ورق A4", "wamid.OPT2"), null);
    await processWaEvent(id);

    const c = (await db().select().from(s.customers).where(eq(s.customers.id, 1)).limit(1))[0];
    expect(c.waConsent).toBe("UNKNOWN");
    expect(c.waConsentSource).toBeNull();
    expect(c.waConsentAt).toBeNull();
  });

  it("محادثة بلا عميل مربوط + «ايقاف» ⇒ لا خطأ ولا تغيير (لا نعرف صاحب الموافقة)", async () => {
    await seedIntegration("15550001111");
    // لا عميل مُسجَّل بهذا الرقم إطلاقاً ⇒ maybeLinkCustomer لا يربط شيئاً ⇒ customerId يبقى null.
    const { id } = await persistWaEvent(waTextPayload("9647709998888", "ايقاف", "wamid.OPT3"), null);
    await processWaEvent(id);

    const ev = (await db().select().from(s.waWebhookEvents).where(eq(s.waWebhookEvents.id, id)))[0];
    expect(ev.status).toBe("PROCESSED"); // لا رمي — التقاط الإيقاف محميّ بذاته.

    const conv = (await db().select().from(s.conversations).where(eq(s.conversations.channelHandle, "9647709998888")))[0];
    expect(conv.customerId).toBeNull();
    expect(await db().select().from(s.customers)).toHaveLength(0); // لا عميل أُنشئ أو تغيّر.
  });
});
