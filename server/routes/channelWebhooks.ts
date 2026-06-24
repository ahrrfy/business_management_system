import crypto from "node:crypto";
import { and, eq, not } from "drizzle-orm";
import express, { type Request, type Response, type Router } from "express";
import pino from "pino";
import { channelIntegrations } from "../../drizzle/schema";
import { getDb } from "../db";
import { decryptSecret } from "../services/cryptoService";
import { addMessage, upsertConversation } from "../services/conversationService";
import { findIntegrationByVerifyToken } from "../services/integrationService";

/**
 * Webhook routes لِلقَنوات الخارِجية — شَريحة #5، مُحَدَّثة لِشَريحة #6.
 *
 * مَصدر الـsecrets: DB (مُشَفَّر بـAES-256-GCM) بَدل `.env`. الإدارة عبر:
 *   /settings/integrations (شاشة في النِظام، adminProcedure).
 *
 * الـenv vars القَديمة (WHATSAPP_VERIFY_TOKEN، WHATSAPP_APP_SECRET، ...) لم تَعد مَطلوبة.
 * المُتَطَلَّب الوَحيد في .env: `INTEGRATIONS_ENCRYPTION_KEY` لِفَكّ الـsecrets.
 *
 * تَدفّق webhook:
 *   1. Meta يَضرب GET ?hub.verify_token=... ⇒ نَبحث في DB عَن مُطابِق + نَردّ challenge.
 *   2. Meta يَضرب POST مع X-Hub-Signature-256 ⇒ نَجلب appSecret مِن DB حَسب
 *      branchId الذي طابَق verify_token (مُمَيَّز في URL أو نَجرّب كل الفُروع).
 *   3. HMAC verify timing-safe ⇒ نُضيف رِسالة IN.
 *
 * الأَمان كَما كان: HMAC إلزامي قَبل أَي كَتابة، dedup بـexternalId UNIQUE.
 */

const log = pino({ name: "channel-webhooks" });

/** HMAC verify عام لِـwebhooks مِن Meta (WhatsApp/Instagram). */
function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;
  const sig = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : signatureHeader;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

/** decrypt آمن (لا يَرمي عَلى ciphertext مُتَلاعَب به). */
function safeDecrypt(s: string | null): string | null {
  if (!s) return null;
  try { return decryptSecret(s); } catch { return null; }
}

/** يَجلب appSecret لكل تَكامل في قَناة مُحَدَّدة (نَشِط فَقط)، مُفَكّاً، مَع branchId.
 *  مَشترَك بَين Meta (sha256=) و Store (hex خام) — الفَرق في كَيفية التَوقيع. */
async function decryptedAppSecretsFor(channel: "WHATSAPP" | "INSTAGRAM" | "STORE"): Promise<Array<{ branchId: number; appSecret: string }>> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      branchId: channelIntegrations.branchId,
      enc: channelIntegrations.encryptedAppSecret,
    })
    .from(channelIntegrations)
    .where(and(
      eq(channelIntegrations.channel, channel),
      not(eq(channelIntegrations.status, "DISABLED")),
    ));
  // فَكّ secret واحد فَقط لكل سطر (بَدل 3 في getDecryptedIntegration) ⇒ أَسرع.
  const out: Array<{ branchId: number; appSecret: string }> = [];
  for (const r of rows) {
    const dec = safeDecrypt(r.enc);
    if (dec) out.push({ branchId: Number(r.branchId), appSecret: dec });
  }
  return out;
}

/** يَجد الفَرع الذي وقَّع HMAC على الـrawBody. مَشترَك بَين كل القَنوات. */
async function findBranchByHmac(
  channel: "WHATSAPP" | "INSTAGRAM" | "STORE",
  rawBody: Buffer,
  signatureHeader: string | undefined,
  verifierFn: (rawBody: Buffer, sig: string, secret: string) => boolean,
): Promise<{ branchId: number } | null> {
  if (!signatureHeader) return null;
  const secrets = await decryptedAppSecretsFor(channel);
  for (const s of secrets) {
    if (verifierFn(rawBody, signatureHeader, s.appSecret)) {
      return { branchId: s.branchId };
    }
  }
  return null;
}

/** HMAC verifier لِـStore (hex خام بَلا sha256= prefix). */
function verifyStoreSignature(rawBody: Buffer, sig: string, secret: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export function channelWebhooksRouter(): Router {
  const r = express.Router();
  const rawJson = express.raw({ type: "application/json", limit: "1mb" });

  /**
   * WhatsApp Business Cloud API — verify (GET) + receive (POST).
   * verify_token يُطابِق integration مَوجود في DB ⇒ نَردّ challenge.
   * بَلا integration ⇒ 503.
   */
  r.get("/whatsapp", async (req: Request, res: Response) => {
    const mode = req.query["hub.mode"];
    const token = String(req.query["hub.verify_token"] ?? "");
    const challenge = req.query["hub.challenge"];
    if (mode !== "subscribe" || !token) {
      return res.status(403).send("forbidden");
    }
    const match = await findIntegrationByVerifyToken("WHATSAPP", token);
    if (!match) {
      log.warn({ ip: req.ip }, "WhatsApp webhook GET: verify_token لا يُطابِق");
      return res.status(403).send("forbidden");
    }
    log.info({ branchId: match.branchId }, "WhatsApp webhook: verified");
    return res.status(200).send(String(challenge ?? ""));
  });

  r.post("/whatsapp", rawJson, async (req: Request, res: Response) => {
    const raw = req.body as Buffer;
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    const match = await findBranchByHmac("WHATSAPP", raw, sig, verifyMetaSignature);
    if (!match) {
      log.warn({ ip: req.ip }, "WhatsApp webhook POST: HMAC غَير صَحيح أو لا تَكامل");
      return res.status(401).send("invalid signature");
    }
    try {
      const payload = JSON.parse(raw.toString("utf8"));
      // WhatsApp Cloud API: entry[].changes[].value.messages[]
      for (const entry of payload?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
          const value = change?.value;
          for (const msg of value?.messages ?? []) {
            const from = String(msg?.from ?? "");
            const externalId = String(msg?.id ?? "");
            const body = msg?.text?.body ?? null;
            const mediaType = msg?.image ? "image/jpeg" : msg?.audio ? "audio/ogg" : msg?.document ? "application/pdf" : null;
            if (!from || !externalId) continue;
            const conv = await upsertConversation({
              branchId: match.branchId,
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
      log.error({ err: e?.message, branchId: match.branchId }, "WhatsApp webhook: فَشل المُعالجة");
      return res.status(200).send("error logged");
    }
  });

  /**
   * Instagram Graph webhook — نَفس النَمط، payload = entry[].messaging[].
   */
  r.get("/instagram", async (req: Request, res: Response) => {
    const token = String(req.query["hub.verify_token"] ?? "");
    if (req.query["hub.mode"] !== "subscribe" || !token) return res.status(403).send("forbidden");
    const match = await findIntegrationByVerifyToken("INSTAGRAM", token);
    if (!match) return res.status(403).send("forbidden");
    return res.status(200).send(String(req.query["hub.challenge"] ?? ""));
  });

  r.post("/instagram", rawJson, async (req: Request, res: Response) => {
    const raw = req.body as Buffer;
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    const match = await findBranchByHmac("INSTAGRAM", raw, sig, verifyMetaSignature);
    if (!match) return res.status(401).send("invalid signature");
    try {
      const payload = JSON.parse(raw.toString("utf8"));
      for (const entry of payload?.entry ?? []) {
        for (const m of entry?.messaging ?? []) {
          const senderId = String(m?.sender?.id ?? "");
          const externalId = String(m?.message?.mid ?? "");
          const body = m?.message?.text ?? null;
          if (!senderId || !externalId) continue;
          const conv = await upsertConversation({
            branchId: match.branchId, channel: "INSTAGRAM", channelHandle: senderId,
          });
          await addMessage({ conversationId: conv.id, direction: "IN", body, externalId });
        }
      }
      return res.status(200).send("ok");
    } catch (e: any) {
      log.error({ err: e?.message, branchId: match.branchId }, "Instagram webhook: فَشل");
      return res.status(200).send("error logged");
    }
  });

  /**
   * Store webhook — Salla/Zid/WooCommerce/Shopify.
   * يَجَرّب كل الفُروع لِيَجد الـsecret المُطابِق (مَشابِه لِـMeta).
   */
  r.post("/store", rawJson, async (req: Request, res: Response) => {
    const raw = req.body as Buffer;
    const sig = (req.headers["x-webhook-signature"] ?? req.headers["x-store-signature"]) as string | undefined;
    const match = await findBranchByHmac("STORE", raw, sig, verifyStoreSignature);
    if (!match) return res.status(401).send("invalid signature");
    const matchedBranchId = match.branchId;
    try {
      const payload = JSON.parse(raw.toString("utf8"));
      const customerHandle = String(payload?.customer?.id ?? payload?.customer?.email ?? payload?.customer_id ?? "");
      const externalId = String(payload?.id ?? payload?.event_id ?? "");
      const body = payload?.note ?? payload?.message ?? `طَلب جَديد #${payload?.order_number ?? payload?.id}`;
      if (!customerHandle || !externalId) return res.status(400).send("missing fields");
      const conv = await upsertConversation({
        branchId: matchedBranchId,
        channel: "STORE",
        channelHandle: customerHandle,
        displayName: payload?.customer?.name ?? null,
      });
      await addMessage({ conversationId: conv.id, direction: "IN", body, externalId });
      return res.status(200).send("ok");
    } catch (e: any) {
      log.error({ err: e?.message, branchId: matchedBranchId }, "Store webhook: فَشل");
      return res.status(200).send("error logged");
    }
  });

  return r;
}
