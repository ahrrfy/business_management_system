/**
 * اختبار الانحدار الجوهري — سبب حملة T1.3 كاملة: `server/index.ts` كان يُسجّل `express.json()`
 * العام **قبل** تركيب `/api/webhooks`، فيَستهلك التدفّق أوّلاً؛ `express.raw()` الخاص بمسارات
 * webhook في `channelWebhooks.ts` كان يستلم عندها كائناً محلولاً لا Buffer خاماً ⇒ تحقّق HMAC
 * كان **مستحيل النجاح** مع Meta الحقيقية أبداً (اختبار channelWebhooks.test.ts القائم كان يمرّ
 * فقط لأنه يُركّب الراوتر معزولاً بلا الوسيط العام — لا يعكس ترتيب الإنتاج الحقيقي).
 *
 * نبني هنا تطبيق Express حقيقياً بنفس ترتيب `server/index.ts`: `applyBodyParsers(app)` الحقيقية
 * ثم تركيب `channelWebhooksRouter()` على `/api/webhooks` — ونُشغّله على منفذٍ عابر بـ`node:http`
 * (نمط `productImageEndpoint.test.ts` — صفر اعتمادية supertest جديدة، سلوك HTTP حقيقي لا محاكاة).
 */
import crypto from "node:crypto";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { applyBodyParsers } from "../../middleware/bodyParsers";
import { __resetKeyCacheForTests } from "../../services/cryptoService";
import { setIntegrationStatus, upsertIntegration } from "../../services/integrationService";
import { channelWebhooksRouter } from "../channelWebhooks";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const ORIGINAL_KEY = process.env.INTEGRATIONS_ENCRYPTION_KEY;
const TEST_KEY_HEX = crypto.randomBytes(32).toString("hex");
const APP_SECRET = "test-app-secret-for-hmac-1234";

/** يرفع تطبيقاً بنفس ترتيب server/index.ts (مُحلِّلات الجسم العامة ثم /api/webhooks) على منفذ
 *  عابر، ينفّذ الفحص، ثم يُغلق حتماً (finally) كي لا تتسرّب المنافذ. */
async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  applyBodyParsers(app);
  app.use("/api/webhooks", channelWebhooksRouter());
  // مسار مستقلّ يُحاكي بقية النظام (tRPC وغيره) — يُثبت أنّ json العام لم ينكسر لبقية المسارات.
  app.post("/api/fake-json-route", (req, res) => {
    res.json({ received: req.body });
  });
  const srv = createServer(app);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

function signPayload(raw: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

async function seedActiveWaIntegration(phoneNumberId = "15550001111"): Promise<void> {
  const created = await upsertIntegration({
    branchId: 1,
    channel: "WHATSAPP",
    phoneNumberId,
    appSecret: APP_SECRET,
    accessToken: "fake-access-token",
    updatedBy: 1,
  });
  await setIntegrationStatus(created.id, "ACTIVE");
}

beforeEach(async () => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = TEST_KEY_HEX;
  __resetKeyCacheForTests();
  await db().insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await db().insert(s.users).values([{ id: 1, openId: "u1", name: "المدير", role: "admin", loginMethod: "local" }]);
});

afterAll(() => {
  if (ORIGINAL_KEY) process.env.INTEGRATIONS_ENCRYPTION_KEY = ORIGINAL_KEY;
  else delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
  __resetKeyCacheForTests();
});

describe("POST /api/webhooks/whatsapp — الانحدار الجوهري (سبب حملة T1.3)", () => {
  it("توقيع HMAC صحيح + Content-Type: application/json ⇒ 200 وحدث محفوظ ورسالة مدرجة (كان 401 مستحيل النجاح قبل الإصلاح)", async () => {
    await seedActiveWaIntegration();
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "15550001111", display_phone_number: "15550001111" },
                messages: [{ from: "9647709990000", id: "wamid.COMPOSED1", type: "text", text: { body: "اختبار التركيب" } }],
              },
            },
          ],
        },
      ],
    };
    const raw = JSON.stringify(payload);
    const sig = signPayload(raw, APP_SECRET);

    await withServer(async (base) => {
      const res = await fetch(`${base}/api/webhooks/whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig },
        body: raw,
      });
      expect(res.status).toBe(200);
    });

    const events = await db().select().from(s.waWebhookEvents);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("PROCESSED");

    const msgs = await db().select().from(s.conversationMessages).where(eq(s.conversationMessages.externalId, "wamid.COMPOSED1"));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe("اختبار التركيب");
  });

  it("توقيع خاطئ ⇒ 401 وصفر أحداث محفوظة", async () => {
    await seedActiveWaIntegration();
    const raw = JSON.stringify({ entry: [] });

    await withServer(async (base) => {
      const res = await fetch(`${base}/api/webhooks/whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + "0".repeat(64) },
        body: raw,
      });
      expect(res.status).toBe(401);
    });

    const events = await db().select().from(s.waWebhookEvents);
    expect(events).toHaveLength(0);
  });

  it("مسار آخر عبر نفس الـapp ما زال يُحلَّل json عادياً — الإصلاح لم يكسر بقية النظام", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/fake-json-route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { received: unknown };
      expect(body.received).toEqual({ hello: "world" });
    });
  });

  it("HMAC صحيح لكن معالجة الحدث تفشل (سباق ترتيب: status لwamid غير موجود) ⇒ الردّ يبقى 200 والحدث يُعلَّم FAILED للإعادة", async () => {
    // مواءمة السلوك الجديد المطلوبة على channelWebhooks.test.ts (بند ز في تكليف T1.3): ذاك الملف
    // لا يحوي فعلياً أي اختبار لسلوك مسار whatsapp POST (يقتصر على webhookTenancyGuard، غير
    // ممسوس هنا) — التغطية الحقيقية لعقد «فشل المعالجة لا يغيّر الردّ» تعيش هنا حيث الخادم مركَّب
    // فعلياً بنفس ترتيب الإنتاج.
    await seedActiveWaIntegration();
    const payload = { entry: [{ changes: [{ value: {
      messaging_product: "whatsapp",
      metadata: { phone_number_id: "15550001111", display_phone_number: "15550001111" },
      statuses: [{ id: "wamid.NEVER_SENT", status: "delivered", timestamp: "1690000000" }],
    } }] }] };
    const raw = JSON.stringify(payload);
    const sig = signPayload(raw, APP_SECRET);

    await withServer(async (base) => {
      const res = await fetch(`${base}/api/webhooks/whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig },
        body: raw,
      });
      expect(res.status).toBe(200); // فشل المعالجة الداخلي لا يُسرَّب إلى الردّ.
    });

    const events = await db().select().from(s.waWebhookEvents);
    expect(events).toHaveLength(1); // الحدث محفوظ رغم فشل المعالجة (persistWaEvent سبق processWaEvent).
    expect(events[0].status).toBe("FAILED");
    expect(events[0].attempts).toBe(1);
  });
});
