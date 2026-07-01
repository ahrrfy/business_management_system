import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { branches, channelIntegrations } from "../../drizzle/schema";
import { getDb } from "../db";
import { getCurrentCompanyId } from "../tenancy/context";
import { resolveCompanyById } from "../tenancy/registry";
import { decryptSecret, encryptSecret, isCryptoReady, maskSecret } from "./cryptoService";
import { withTx } from "./tx";

/**
 * إدارة tokens التَكاملات الخارِجية — شَريحة #6.
 *
 * المَنطق:
 *   - upsert: يُشَفّر الـsecrets ثم يَكتب/يُحدّث (UNIQUE branchId+channel).
 *     الـtokens القَديمة لا تُمَسَّ إن لَم تُرسَل (Partial update — تَغيير phoneNumberId
 *     بَلا إعادة كَتابة الـtoken).
 *   - verifyConnection: يَضرب Meta/Store API فِعلياً ⇒ يَكتب status + lastVerifiedAt + lastError.
 *   - getDecryptedForBranch: يُستَعمَل مِن channelWebhooks لِفَكّ secrets لَحظة الاستعمال
 *     (لا cache طَويل الأَجل: مُحَدَّث فَوراً عند تَغيير الواجهة).
 *
 * RBAC: الـrouter يَفرض adminProcedure. الـservice لا يَفترض actor (مَدعو مِن adminProcedure
 * أو مِن webhook receiver الذي لا يَملك actor).
 */

export type IntegrationChannel = "WHATSAPP" | "INSTAGRAM" | "STORE";

export interface UpsertIntegrationInput {
  branchId: number;
  channel: IntegrationChannel;
  displayName?: string | null;
  phoneNumberId?: string | null;
  /** undefined = لا تُغَيّر؛ null = اِمسح؛ string = اِكتب جَديد. */
  verifyToken?: string | null;
  appSecret?: string | null;
  accessToken?: string | null;
  updatedBy: number;
}

export interface IntegrationDisplay {
  id: number;
  branchId: number;
  branchName: string | null;
  channel: IntegrationChannel;
  displayName: string | null;
  phoneNumberId: string | null;
  /** قِناع آمن لِلعَرض ('•••abcd' أو null). أَبداً نَصّاً عادياً. */
  verifyTokenMasked: string | null;
  appSecretMasked: string | null;
  accessTokenMasked: string | null;
  status: "PENDING" | "ACTIVE" | "FAILED" | "DISABLED";
  lastVerifiedAt: Date | null;
  lastError: string | null;
  /** URL لِنَسخه في إدارة المُزوّد (Meta/Store). يُبنى مِن channel + APP_URL. */
  webhookUrl: string;
}

/**
 * يَحسب webhook URL لِكل قَناة بَناءً على APP_URL أو request origin.
 *
 * تَعدّد الشركات: المَسار غَير المُقيَّد (`/api/webhooks/<channel>`) لا سِياق شَركة لَه إطلاقاً
 * (لا كوكي جَلسة يَصِل مِن مُزوّد خارِجي) — إن كُنّا داخِل سِياق شَركة حالياً (`getCurrentCompanyId`،
 * أَي وَضع تَعدّد الشركات مُفَعَّل) نَبني المَسار المُقيَّد بِرَمز الشركة تَحديداً
 * (`/api/webhooks/company/<code>/<channel>`) — هو الوَحيد الذي يَعمَل فِعلياً لِهذه الشركة (راجِع
 * `companyChannelWebhooksRouter` في server/routes/channelWebhooks.ts). بلا سِياق شَركة (نَشر
 * أُحادي): المَسار القَديم تَماماً كَما كان، بَلا أَي تَغيير.
 */
async function webhookUrlFor(channel: IntegrationChannel): Promise<string> {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const channelSegment = channel === "WHATSAPP" ? "whatsapp" : channel === "INSTAGRAM" ? "instagram" : "store";
  const companyId = getCurrentCompanyId();
  if (companyId != null) {
    const company = await resolveCompanyById(companyId);
    if (company) {
      return `${base}/api/webhooks/company/${company.code}/${channelSegment}`;
    }
  }
  return `${base}/api/webhooks/${channelSegment}`;
}

/** يَجلب التَكاملات للعَرض في الواجهة (مُقَنَّعة secrets). branchId=undefined = كل الفُروع. */
export async function listIntegrations(branchId?: number): Promise<IntegrationDisplay[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: channelIntegrations.id,
      branchId: channelIntegrations.branchId,
      branchName: branches.name,
      channel: channelIntegrations.channel,
      displayName: channelIntegrations.displayName,
      phoneNumberId: channelIntegrations.phoneNumberId,
      encryptedVerifyToken: channelIntegrations.encryptedVerifyToken,
      encryptedAppSecret: channelIntegrations.encryptedAppSecret,
      encryptedAccessToken: channelIntegrations.encryptedAccessToken,
      status: channelIntegrations.status,
      lastVerifiedAt: channelIntegrations.lastVerifiedAt,
      lastError: channelIntegrations.lastError,
    })
    .from(channelIntegrations)
    .leftJoin(branches, eq(channelIntegrations.branchId, branches.id))
    .where(branchId != null ? eq(channelIntegrations.branchId, branchId) : undefined)
    .orderBy(channelIntegrations.branchId, channelIntegrations.channel);
  return Promise.all(rows.map(async (r): Promise<IntegrationDisplay> => ({
    id: Number(r.id),
    branchId: Number(r.branchId),
    branchName: r.branchName,
    channel: r.channel as IntegrationChannel,
    displayName: r.displayName,
    phoneNumberId: r.phoneNumberId,
    // تَفُكّ-ثُمَّ-تُقَنّع: لا تُسَرّب النَصّ الكامل لِلواجهة أَبداً.
    verifyTokenMasked: maskSecret(safeDecrypt(r.encryptedVerifyToken)),
    appSecretMasked: maskSecret(safeDecrypt(r.encryptedAppSecret)),
    accessTokenMasked: maskSecret(safeDecrypt(r.encryptedAccessToken)),
    status: r.status as IntegrationDisplay["status"],
    lastVerifiedAt: r.lastVerifiedAt,
    lastError: r.lastError,
    webhookUrl: await webhookUrlFor(r.channel as IntegrationChannel),
  })));
}

/** decrypt آمن: تُعيد null لو ciphertext مُتَلاعَب به (لا throw يَكسر العَرض). */
function safeDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decryptSecret(ciphertext);
  } catch {
    return null;
  }
}

/** يَكتب/يُحدّث تَكاملاً. undefined لِحُقول secret = لا تُغَيّر؛ null = اِمسح؛ string = اِكتب. */
export async function upsertIntegration(input: UpsertIntegrationInput): Promise<{ id: number; isNew: boolean }> {
  if (!isCryptoReady()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "INTEGRATIONS_ENCRYPTION_KEY غَير مَضبوط في .env. أَضفه قَبل حِفظ tokens.",
    });
  }
  return withTx(async (tx) => {
    const existing = (
      await tx
        .select({ id: channelIntegrations.id })
        .from(channelIntegrations)
        .where(and(
          eq(channelIntegrations.branchId, input.branchId),
          eq(channelIntegrations.channel, input.channel),
        ))
        .limit(1)
    )[0];

    // تَكوين الـpatch: فَقط الحُقول المُعَطاة + تَشفير الـsecrets الجَديدة.
    const patch: Record<string, unknown> = {
      updatedBy: input.updatedBy,
    };
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.phoneNumberId !== undefined) patch.phoneNumberId = input.phoneNumberId;
    if (input.verifyToken !== undefined) patch.encryptedVerifyToken = encryptSecret(input.verifyToken);
    if (input.appSecret !== undefined) patch.encryptedAppSecret = encryptSecret(input.appSecret);
    if (input.accessToken !== undefined) patch.encryptedAccessToken = encryptSecret(input.accessToken);
    // إعادة status إلى PENDING بَعد تَعديل secret — يَجب verify جَديد لِلتَأكد.
    if (input.verifyToken !== undefined || input.appSecret !== undefined || input.accessToken !== undefined) {
      patch.status = "PENDING";
      patch.lastError = null;
    }

    if (existing) {
      await tx.update(channelIntegrations).set(patch).where(eq(channelIntegrations.id, Number(existing.id)));
      return { id: Number(existing.id), isNew: false };
    }
    const res = await tx.insert(channelIntegrations).values({
      branchId: input.branchId,
      channel: input.channel,
      displayName: input.displayName ?? null,
      phoneNumberId: input.phoneNumberId ?? null,
      encryptedVerifyToken: encryptSecret(input.verifyToken),
      encryptedAppSecret: encryptSecret(input.appSecret),
      encryptedAccessToken: encryptSecret(input.accessToken),
      status: "PENDING",
      updatedBy: input.updatedBy,
    });
    const id = Number((res as any)?.[0]?.insertId ?? (res as any)?.insertId);
    return { id, isNew: true };
  });
}

/** يَحذف تَكاملاً (يُعَطّل القَناة لِفَرع). */
export async function deleteIntegration(integrationId: number): Promise<void> {
  return withTx(async (tx) => {
    await tx.delete(channelIntegrations).where(eq(channelIntegrations.id, integrationId));
  });
}

/** يَجلب secret مفكوك لِكَتب الـwebhooks — يَستَعمَل في channelWebhooks.ts فَقط. */
export async function getDecryptedIntegration(branchId: number, channel: IntegrationChannel): Promise<{
  verifyToken: string | null;
  appSecret: string | null;
  accessToken: string | null;
  phoneNumberId: string | null;
} | null> {
  const db = getDb();
  if (!db) return null;
  const row = (
    await db
      .select({
        verifyToken: channelIntegrations.encryptedVerifyToken,
        appSecret: channelIntegrations.encryptedAppSecret,
        accessToken: channelIntegrations.encryptedAccessToken,
        phoneNumberId: channelIntegrations.phoneNumberId,
        status: channelIntegrations.status,
      })
      .from(channelIntegrations)
      .where(and(
        eq(channelIntegrations.branchId, branchId),
        eq(channelIntegrations.channel, channel),
      ))
      .limit(1)
  )[0];
  if (!row) return null;
  if (row.status === "DISABLED") return null; // DISABLED = لا تَستَقبل/تُرسل.
  return {
    verifyToken: safeDecrypt(row.verifyToken),
    appSecret: safeDecrypt(row.appSecret),
    accessToken: safeDecrypt(row.accessToken),
    phoneNumberId: row.phoneNumberId,
  };
}

/** يَجلب أَوّل تَكامل بـverifyToken مُطابق — لِـwebhook handshake (GET).
 *  لِـMeta: الـverify_token مَن المُعَرّف الذي يُرسله Meta للتَأكد مِن مِلكية الـendpoint. */
export async function findIntegrationByVerifyToken(channel: IntegrationChannel, verifyToken: string): Promise<{ branchId: number } | null> {
  const db = getDb();
  if (!db) return null;
  // نَفُكّ كل صُفوف القَناة ثم نُطابق (لا يَدعم MySQL البَحث على encrypted column مُباشَرة).
  // الجَدول صَغير (قَناة واحدة لكل فَرع) ⇒ O(branches) لكل handshake = مَقبول جداً.
  const rows = await db
    .select({
      branchId: channelIntegrations.branchId,
      enc: channelIntegrations.encryptedVerifyToken,
      status: channelIntegrations.status,
    })
    .from(channelIntegrations)
    .where(eq(channelIntegrations.channel, channel));
  for (const r of rows) {
    if (r.status === "DISABLED") continue;
    const dec = safeDecrypt(r.enc);
    if (dec === verifyToken) return { branchId: Number(r.branchId) };
  }
  return null;
}

/** نَتيجة verifyConnection — مَلائمة لِحَفظ status. */
export interface VerifyResult {
  ok: boolean;
  message: string;
  /** تَفاصيل إضافية مِن API لِلعَرض (اسم الـbusiness account لِـWhatsApp مَثلاً). */
  details?: Record<string, unknown>;
}

/** يَختبر اتصال الـintegration بِضَرب Meta/Store API فِعلياً.
 *  WhatsApp: يَضرب /v18.0/{phoneNumberId} مع Bearer token ⇒ يُتحَقّق phone meta-data.
 *  Instagram: يَضرب /me?access_token=... ⇒ يُتحَقّق صلاحية الـtoken.
 *  Store: لا API بديل — يَكفي وجود secret + URL مَنسوخ في الإعداد. */
export async function verifyIntegration(integrationId: number): Promise<VerifyResult> {
  const db = getDb();
  if (!db) return { ok: false, message: "قاعدة البَيانات غَير مُتاحة" };
  const row = (
    await db
      .select({
        channel: channelIntegrations.channel,
        phoneNumberId: channelIntegrations.phoneNumberId,
        encAccess: channelIntegrations.encryptedAccessToken,
        encAppSecret: channelIntegrations.encryptedAppSecret,
      })
      .from(channelIntegrations)
      .where(eq(channelIntegrations.id, integrationId))
      .limit(1)
  )[0];
  if (!row) return { ok: false, message: "التَكامل غَير مَوجود" };

  let result: VerifyResult;
  try {
    if (row.channel === "WHATSAPP") {
      result = await verifyWhatsAppConnection(row.phoneNumberId, safeDecrypt(row.encAccess));
    } else if (row.channel === "INSTAGRAM") {
      result = await verifyInstagramConnection(safeDecrypt(row.encAccess));
    } else {
      // STORE: لا API بديل عام. نَكتفي بِفَحص أن الـsecret مَوجود + قَد لُصق.
      const sec = safeDecrypt(row.encAppSecret);
      result = sec && sec.length >= 16
        ? { ok: true, message: "secret مَلصوق وَطوله مَعقول. سَيُتَحَقَّق فِعلياً عند أَوّل webhook." }
        : { ok: false, message: "STORE_WEBHOOK_SECRET مَفقود أو قَصير (< 16 char)" };
    }
  } catch (e: any) {
    result = { ok: false, message: `خَطأ في الاتصال: ${e?.message ?? "غَير مَعروف"}` };
  }

  // اِكتب النَتيجة على السَجلّ.
  await db
    .update(channelIntegrations)
    .set({
      status: result.ok ? "ACTIVE" : "FAILED",
      lastVerifiedAt: new Date(),
      lastError: result.ok ? null : result.message.slice(0, 500),
    })
    .where(eq(channelIntegrations.id, integrationId));

  return result;
}

/** يَضرب WhatsApp Cloud API بـtoken لِلتَأكّد أنه فِعّال + يَملك صلاحية على phoneNumberId. */
async function verifyWhatsAppConnection(phoneNumberId: string | null, accessToken: string | null): Promise<VerifyResult> {
  if (!phoneNumberId) return { ok: false, message: "phoneNumberId مَطلوب" };
  if (!accessToken) return { ok: false, message: "accessToken مَطلوب" };
  // Meta Graph API v18 — مَوارد phone number.
  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.ok) {
    const data = await res.json() as { display_phone_number?: string; verified_name?: string };
    return {
      ok: true,
      message: `مُتَّصِل بـ${data.verified_name ?? "WhatsApp Business"} (${data.display_phone_number ?? phoneNumberId})`,
      details: data,
    };
  }
  const errorBody = await res.text().catch(() => "");
  return {
    ok: false,
    message: `Meta API ${res.status}: ${errorBody.slice(0, 200)}`,
  };
}

/** يَضرب Instagram Graph API بـtoken لِلتَأكّد. */
async function verifyInstagramConnection(accessToken: string | null): Promise<VerifyResult> {
  if (!accessToken) return { ok: false, message: "accessToken مَطلوب" };
  const url = `https://graph.facebook.com/v18.0/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url, { method: "GET" });
  if (res.ok) {
    const data = await res.json() as { id?: string; name?: string };
    return {
      ok: true,
      message: `مُتَّصِل بـ${data.name ?? data.id ?? "Instagram"}`,
      details: data,
    };
  }
  const errorBody = await res.text().catch(() => "");
  return {
    ok: false,
    message: `Instagram API ${res.status}: ${errorBody.slice(0, 200)}`,
  };
}

/** تَعطيل/تَفعيل تَكامل بَلا حَذف. */
export async function setIntegrationStatus(integrationId: number, status: "ACTIVE" | "DISABLED"): Promise<void> {
  return withTx(async (tx) => {
    await tx.update(channelIntegrations).set({ status }).where(eq(channelIntegrations.id, integrationId));
  });
}
