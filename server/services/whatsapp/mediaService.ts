/**
 * جلب وسائط واتساب الواردة — شريحة #١ (نواة Cloud API).
 *
 * روابط Graph لتنزيل الوسائط (lookaside URLs) تنتهي صلاحيتها خلال ~٥ دقائق ⇒ الجلب كله (GET بيانات
 * الوصول + تنزيل البايتات) يتم في محاولة واحدة متتابعة — لا فصل بين الخطوتين عبر محاولات كنّاس
 * منفصلة (المحاولة الثانية ستصل لرابط منتهي الصلاحية).
 *
 * قرار تصميمي (موثَّق كما يطلب التكليف): `fetchInboundMedia` تستقبل `integration` جاهزاً بدل تحميله
 * من DB بنفسها — outboxService يُحمِّله مرّة واحدة في processClaimedRow (لفحص التكامل النشط أصلاً
 * قبل تفريع kind) ويُمرِّره، فتُوفَّر استعلامات DB مكرَّرة. المواصفة لم تُحدّد هذه النقطة صراحةً
 * (وصفت التوقيع بمعامل واحد فقط)؛ إضافة `integration` كمعامل ثانٍ قرار تنفيذي داخلي لا يغيّر السلوك
 * الملحوظ من الخارج (الدالة تبقى غير مصدَّرة إلا عبر البرميل، ولا مستهلك خارجي بعد في هذه المهمة).
 */
import { eq } from "drizzle-orm";
import { isDupEntry } from "@shared/errorMap.ar";
import { conversationMessages, conversations, waMedia, type WaOutbox } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { graphFetch, type GraphIntegration } from "./graph";
import { classifyGraphError } from "./sendService";

/** حدّ حجم الوسائط الوارد — يتّفق مع سقوف رفع الصور الأخرى في النظام (نمط productImages). */
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

/** مضيفات وسائط Meta الموثوقة (لاحقة) — يُرسَل لها توكن الوصول عند التنزيل. */
const TRUSTED_MEDIA_HOST_SUFFIXES = [
  ".fbcdn.net",
  ".fbsbx.com",
  ".whatsapp.net",
  ".facebook.com",
  ".cdninstagram.com",
];

/** مضيف داخليّ/خاص (منع SSRF) — عناوين حرفية loopback/خاصة/link-local. */
function isPrivateHost(host: string): boolean {
  // URL.hostname يُبقي أقواس IPv6 (`[::1]`) — نجرّدها للمطابقة.
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  // IPv4 حرفيّ في نطاقات خاصة/loopback/link-local/محجوزة.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    if (a === 127 || a === 10 || a === 0 || (a === 169 && b === 254)) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  // IPv6 loopback/ULA/link-local.
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}

/**
 * تدقيق ٣/٨ (SSRF + تسريب Bearer): يتحقّق من رابط تنزيل الوسائط القادم **من استجابة Graph** قبل
 * جلبه بترويسة توكن الوصول. `meta.url` غير موثوق (لو كان apiBaseUrl خبيثاً أو Graph مُخترَقاً قد
 * يوجّه الخادم لمضيف داخليّ أو يسرّب التوكن لمضيف عشوائي). القاعدة: (١) https حصراً، (٢) رفض مضيف
 * داخليّ/خاص (SSRF)، (٣) إرسال التوكن فقط لمضيف Meta موثوق أو مضيف apiBaseUrl المُهيّأ (منع التسريب).
 */
export function guardMediaUrl(
  rawUrl: string,
  apiBaseUrl?: string | null
): { ok: true; sendAuth: boolean } | { ok: false; detail: string } {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, detail: "رابط تنزيل الوسائط غير صالح." };
  }
  if (u.protocol !== "https:") return { ok: false, detail: "رابط تنزيل الوسائط غير آمن (ليس https)." };
  const host = u.hostname.toLowerCase();
  if (isPrivateHost(host)) return { ok: false, detail: "مضيف تنزيل الوسائط غير مسموح." };
  let apiHost = "";
  try {
    if (apiBaseUrl) apiHost = new URL(apiBaseUrl).hostname.toLowerCase();
  } catch {
    apiHost = "";
  }
  // موثوق ⇒ يُرسَل التوكن: مضيف Meta معروف، أو مضيف apiBaseUrl المُهيّأ نفسه/مضيف فرعيّ منه
  // (مطابقة فرعيّة صارمة لا «أصل مشترك» — أضيق سطحاً؛ مضيف BSP بأصلٍ مشترك مختلف يُنزَّل بلا توكن).
  const trusted =
    TRUSTED_MEDIA_HOST_SUFFIXES.some((s) => host.endsWith(s)) ||
    (apiHost !== "" && (host === apiHost || host.endsWith(`.${apiHost}`)));
  return { ok: true, sendAuth: trusted };
}

export type MediaFetchResult =
  | { ok: true }
  | { ok: false; permanent: boolean; detail: string };

interface MediaFetchPayload {
  mediaId?: string;
  messageId?: number;
  mimeTypeHint?: string;
}

interface GraphMediaMeta {
  url?: string;
  mime_type?: string;
  file_size?: number;
}

/**
 * يجلب وسائط رسالة واردة: بيانات الوصول (`GET /{mediaId}`) ثم تنزيل البايتات، فحفظها في waMedia
 * وتحديث `conversationMessages.mediaUrl`. idempotent: ازدواج `uq_wa_media_message` ⇒ نجاح صامت
 * (وسائط هذه الرسالة محفوظة مسبقاً — لا حاجة لإعادة الجلب).
 */
export async function fetchInboundMedia(
  outboxRow: Pick<WaOutbox, "payloadJson">,
  integration: GraphIntegration,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<MediaFetchResult> {
  const payload = (outboxRow.payloadJson ?? {}) as MediaFetchPayload;
  const { mediaId, messageId } = payload;
  if (!mediaId || !messageId) {
    return { ok: false, permanent: true, detail: "حمولة جلب الوسائط ناقصة (mediaId/messageId مفقودان)." };
  }

  // ١) بيانات الوصول — رابط مؤقّت + نوع/حجم.
  const metaRes = await graphFetch(integration, `/${mediaId}`, { method: "GET" }, fetchImpl);
  if (!metaRes.ok) {
    const cls = classifyGraphError(metaRes.status, metaRes.body);
    return { ok: false, permanent: cls.classification !== "retryable", detail: cls.detail };
  }
  const meta = metaRes.body as GraphMediaMeta;
  if (!meta.url) {
    return { ok: false, permanent: true, detail: "استجابة واتساب لا تحوي رابط تنزيل الوسائط." };
  }
  if (typeof meta.file_size === "number" && meta.file_size > MAX_MEDIA_BYTES) {
    return { ok: false, permanent: true, detail: "الوسائط أكبر من الحد 5MB." };
  }

  // ٢) تنزيل البايتات — بعد التحقّق من الرابط (SSRF + منع تسريب Bearer، تدقيق ٣/٨). التوكن يُرسَل
  // فقط لمضيف Meta موثوق أو مضيف apiBaseUrl المُهيّأ (روابط lookaside تتطلّبه)؛ مضيف غير موثوق يُنزَّل
  // بلا توكن (لا تسريب)، ومضيف داخليّ/غير https يُرفَض تماماً.
  const urlGuard = guardMediaUrl(meta.url, integration.apiBaseUrl);
  if (!urlGuard.ok) {
    return { ok: false, permanent: true, detail: urlGuard.detail };
  }
  let downloadRes: Response;
  try {
    downloadRes = await fetchImpl(
      meta.url,
      urlGuard.sendAuth ? { headers: { Authorization: `Bearer ${integration.accessToken}` } } : {}
    );
  } catch (e: any) {
    return { ok: false, permanent: false, detail: `تعذّر تنزيل الوسائط: ${e?.message ?? "خطأ شبكة"}` };
  }
  if (!downloadRes.ok) {
    // ٥xx أو 429 ⇒ قابل لإعادة المحاولة نظرياً؛ لكن الرابط ينتهي خلال دقائق فالمحاولة التالية
    // ستحصل على رابط جديد من الكنّاس على أي حال (kind=MEDIA_FETCH يُعاد جلب بياناته بالكامل).
    const retryable = downloadRes.status >= 500 || downloadRes.status === 429;
    return { ok: false, permanent: !retryable, detail: `فشل تنزيل الوسائط (رمز الحالة ${downloadRes.status}).` };
  }
  const buf = Buffer.from(await downloadRes.arrayBuffer());
  if (buf.length === 0) {
    return { ok: false, permanent: true, detail: "الوسائط المُنزَّلة فارغة." };
  }
  if (buf.length > MAX_MEDIA_BYTES) {
    return { ok: false, permanent: true, detail: "الوسائط أكبر من الحد 5MB." };
  }
  const mimeType = (meta.mime_type ?? payload.mimeTypeHint ?? "application/octet-stream").slice(0, 80);
  const bytesBase64 = buf.toString("base64");

  await withTx(async (tx) => {
    try {
      await tx.insert(waMedia).values({ messageId, mimeType, bytesBase64, sizeBytes: buf.length });
    } catch (e) {
      if (!isDupEntry(e)) throw e; // uq_wa_media_message: وسائط هذه الرسالة محفوظة مسبقاً ⇒ نجاح صامت.
    }
    await tx.update(conversationMessages).set({ mediaUrl: `/api/wa/media/${messageId}` }).where(eq(conversationMessages.id, messageId));
  });

  return { ok: true };
}

/** يجلب وسائط رسالة محفوظة للتقديم عبر مسار REST (مسار `/api/wa/media/:id`). null لو غير موجودة.
 *  يُرجِع `branchId` المحادثة (عبر conversationMessages → conversations) كي يفرض المسار عزل الفرع
 *  (تدقيق ٣/٨: كان أي مستخدم مصادَق يعدّد messageId تسلسلياً فيسحب وسائط كل الفروع — IDOR أفقي). */
export async function getMediaForServing(
  messageId: number
): Promise<{ mimeType: string; bytesBase64: string; branchId: number | null } | null> {
  const db = getDb();
  if (!db) return null;
  const row = (
    await db
      .select({
        mimeType: waMedia.mimeType,
        bytesBase64: waMedia.bytesBase64,
        branchId: conversations.branchId,
      })
      .from(waMedia)
      .innerJoin(conversationMessages, eq(conversationMessages.id, waMedia.messageId))
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .where(eq(waMedia.messageId, messageId))
      .limit(1)
  )[0];
  return row
    ? { mimeType: row.mimeType, bytesBase64: row.bytesBase64, branchId: row.branchId == null ? null : Number(row.branchId) }
    : null;
}
