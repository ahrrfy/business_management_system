import crypto from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import pino from "pino";
import { addMessage, upsertConversation } from "../services/conversationService";

/**
 * Webhook routes لِلقَنوات الخارِجية — شَريحة #5.
 *
 * الحالة الحالية: scaffolding. الـtokens والـverify-tokens مَطلوبة مِن المالك:
 *   - WHATSAPP_VERIFY_TOKEN — الكلمة السِرّية التي تُعطيها لِـMeta عند تَسجيل webhook.
 *   - WHATSAPP_APP_SECRET — لِـHMAC verify signature (X-Hub-Signature-256).
 *   - INSTAGRAM_VERIFY_TOKEN / INSTAGRAM_APP_SECRET — مَشابِه.
 *   - STORE_WEBHOOK_SECRET — مَنصّة المتجر (Salla/Zid/WooCommerce…).
 *
 * بَدون هذه المُتَغيّرات ⇒ الـroutes تَعمل لكنها تَرفض أَي طَلب (لا تَكتب رَسائل وَهمية).
 * المالك يَضيف الـsecrets في .env على VPS ثم يُسَجّل الـwebhooks عند المُزوّدين.
 *
 * الأَمان:
 *   - HMAC verify إلزامي قَبل أَي كَتابة (لا يَتم أَي إدخال DB بَلا تَوقيع صَحيح).
 *   - dedup بـexternalId (مُعَرّف المُزوّد لِكل رِسالة) ⇒ retries لا تُكَرّر.
 *   - فَرع الكَتابة: webhooks لا تَحمل branchId فطرياً ⇒ نَستعمل DEFAULT_INBOX_BRANCH_ID
 *     (أوّل فَرع نَشط = MAIN) أو نَحدّده per channel handle لاحقاً.
 */

const log = pino({ name: "channel-webhooks" });

/** الفَرع الافتراضي لِـwebhooks (المالك يَضبطه في .env، أو نَختار MAIN). */
const DEFAULT_BRANCH_ID = Number(process.env.DEFAULT_INBOX_BRANCH_ID ?? 1);

/** HMAC verify عام لِـwebhooks مِن Meta (WhatsApp/Instagram). */
function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;
  const sig = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : signatureHeader;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  // timing-safe compare لِمَنع timing attacks.
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export function channelWebhooksRouter(): Router {
  const r = express.Router();

  // Meta يَتطلَّب raw body لِـHMAC verify ⇒ نَستعمل express.raw بَدل json (يَنطبق فَقط هُنا،
  // الـmount نَفسه يَختار raw قبل json العام).
  const rawJson = express.raw({ type: "application/json", limit: "1mb" });

  /**
   * WhatsApp Business Cloud API — verify (GET) + receive (POST).
   * Meta تَفعل GET أَوّلاً لِلتَحقّق مِن مِلكية الـendpoint بِـhub.verify_token.
   */
  r.get("/whatsapp", (req: Request, res: Response) => {
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!verifyToken) {
      log.warn("WhatsApp webhook: WHATSAPP_VERIFY_TOKEN غَير مَضبوط — حُذِفَت طَلَبات");
      return res.status(503).send("not configured");
    }
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === verifyToken) {
      return res.status(200).send(String(challenge ?? ""));
    }
    return res.status(403).send("forbidden");
  });

  r.post("/whatsapp", rawJson, async (req: Request, res: Response) => {
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (!secret) {
      log.warn("WhatsApp webhook: WHATSAPP_APP_SECRET غَير مَضبوط — حُذِفَت طَلَبات");
      return res.status(503).send("not configured");
    }
    const raw = req.body as Buffer;
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifyMetaSignature(raw, sig, secret)) {
      log.warn({ ip: req.ip }, "WhatsApp webhook: HMAC غَير صَحيح");
      return res.status(401).send("invalid signature");
    }
    try {
      const payload = JSON.parse(raw.toString("utf8"));
      // WhatsApp Cloud API: entry[].changes[].value.messages[]
      const entries = payload?.entry ?? [];
      for (const entry of entries) {
        for (const change of entry?.changes ?? []) {
          const value = change?.value;
          const messages = value?.messages ?? [];
          for (const msg of messages) {
            // مُتَلَقّى يَتَضمَّن: from (رَقم), id (wamid), text.body, type.
            const from = String(msg?.from ?? "");
            const externalId = String(msg?.id ?? "");
            const body = msg?.text?.body ?? null;
            const mediaType = msg?.image ? "image/jpeg" : msg?.audio ? "audio/ogg" : msg?.document ? "application/pdf" : null;
            if (!from || !externalId) continue;
            const conv = await upsertConversation({
              branchId: DEFAULT_BRANCH_ID,
              channel: "WHATSAPP",
              channelHandle: from,
              displayName: value?.contacts?.[0]?.profile?.name ?? null,
            });
            await addMessage({
              conversationId: conv.id,
              direction: "IN",
              body,
              mediaType,
              externalId,
            });
          }
        }
      }
      return res.status(200).send("ok");
    } catch (e: any) {
      log.error({ err: e?.message }, "WhatsApp webhook: فَشل المُعالجة");
      // 200 حَتى Meta لا تُعيد المُحاولة بِشكل مُفرط (نَحن سَجَّلنا الخَطأ).
      return res.status(200).send("error logged");
    }
  });

  /**
   * Instagram Graph webhook — verify + receive (نَفس بَنية Meta).
   * الـmount نَفسه؛ الـpayload يَختلف (entry[].messaging[]).
   */
  r.get("/instagram", (req: Request, res: Response) => {
    const verifyToken = process.env.INSTAGRAM_VERIFY_TOKEN;
    if (!verifyToken) return res.status(503).send("not configured");
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === verifyToken) {
      return res.status(200).send(String(req.query["hub.challenge"] ?? ""));
    }
    return res.status(403).send("forbidden");
  });

  r.post("/instagram", rawJson, async (req: Request, res: Response) => {
    const secret = process.env.INSTAGRAM_APP_SECRET;
    if (!secret) return res.status(503).send("not configured");
    const raw = req.body as Buffer;
    if (!verifyMetaSignature(raw, req.headers["x-hub-signature-256"] as string | undefined, secret)) {
      return res.status(401).send("invalid signature");
    }
    try {
      const payload = JSON.parse(raw.toString("utf8"));
      for (const entry of payload?.entry ?? []) {
        for (const m of entry?.messaging ?? []) {
          const senderId = String(m?.sender?.id ?? "");
          const externalId = String(m?.message?.mid ?? "");
          const body = m?.message?.text ?? null;
          if (!senderId || !externalId) continue;
          const conv = await upsertConversation({
            branchId: DEFAULT_BRANCH_ID, channel: "INSTAGRAM", channelHandle: senderId,
          });
          await addMessage({ conversationId: conv.id, direction: "IN", body, externalId });
        }
      }
      return res.status(200).send("ok");
    } catch (e: any) {
      log.error({ err: e?.message }, "Instagram webhook: فَشل");
      return res.status(200).send("error logged");
    }
  });

  /**
   * Store webhook (generic) — Salla/Zid/WooCommerce/Shopify…
   * المُزوّد يُرسل رِسالة عَميل أو طَلب جَديد ⇒ نُسجّله كـIN.
   * الـpayload صَيغته تَختلف per platform؛ نَدعم الحالة العامة بَين الحقول الشائعة.
   */
  r.post("/store", rawJson, async (req: Request, res: Response) => {
    const secret = process.env.STORE_WEBHOOK_SECRET;
    if (!secret) return res.status(503).send("not configured");
    const raw = req.body as Buffer;
    // كثيرٌ مِن مَنصّات المَتاجر تَستعمل X-Webhook-Signature (HMAC SHA256 hex).
    const sig = (req.headers["x-webhook-signature"] ?? req.headers["x-store-signature"]) as string | undefined;
    if (!sig) return res.status(401).send("missing signature");
    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.status(401).send("invalid signature");
    }
    try {
      const payload = JSON.parse(raw.toString("utf8"));
      const customerHandle = String(payload?.customer?.id ?? payload?.customer?.email ?? payload?.customer_id ?? "");
      const externalId = String(payload?.id ?? payload?.event_id ?? "");
      const body = payload?.note ?? payload?.message ?? `طَلب جَديد #${payload?.order_number ?? payload?.id}`;
      if (!customerHandle || !externalId) return res.status(400).send("missing fields");
      const conv = await upsertConversation({
        branchId: DEFAULT_BRANCH_ID,
        channel: "STORE",
        channelHandle: customerHandle,
        displayName: payload?.customer?.name ?? null,
      });
      await addMessage({ conversationId: conv.id, direction: "IN", body, externalId });
      return res.status(200).send("ok");
    } catch (e: any) {
      log.error({ err: e?.message }, "Store webhook: فَشل");
      return res.status(200).send("error logged");
    }
  });

  return r;
}
