/**
 * تقديم وسائط واتساب الواردة عبر REST — `GET /api/wa/media/:messageId` (خارج tRPC، بايتات خام
 * لا JSON — نفس فلسفة `imageRoute.ts`). شريحة #١ (نواة Cloud API).
 *
 * المصادقة: **نفس آلية `/api/backups` و`/api/print`** — كوكي الجلسة عبر `getUserFromRequest`
 * (لا فحص دور إضافي؛ أي مستخدم نظام مصادَق يكفي، الوسائط تخصّ محادثات مركز واتساب المشترك بين
 * الفروع وسطحها أضيق أصلاً من صور المنتج العلنية في imageRoute.ts). GET فقط — لا قوائم ولا حذف
 * (YAGNI، كما تنصّ المواصفة).
 */
import { Router, type Request, type Response } from "express";
import { getUserFromRequest } from "../auth/session";
import { logger } from "../logger";
import { getMediaForServing } from "../services/whatsapp/mediaService";

/**
 * أنواع الوسائط المسموح عرضها inline — قائمة بيضاء صريحة (نمط `ALLOWED_MIME` في
 * `imageRoute.ts`). `media.mimeType` مصدره **مرفقٌ أرسله طرفٌ خارجي عبر واتساب** (غير مصادَق
 * على النظام) ⇒ لا نثق به كـ`Content-Type` خام: نوعٌ خطر مثل `text/html`/`image/svg+xml`
 * يُعرَض على أصل التطبيق لمستخدمٍ مصادَق = ناقل XSS مخزَّن. القائمة تقتصر على أنواع وسائط
 * واتساب المعروفة الآمنة عرضاً؛ أيّ شيءٍ آخر يُخدَم كتنزيلٍ (`application/octet-stream` +
 * `Content-Disposition: attachment`) لا يفسّره المتصفّح أبداً.
 */
const INLINE_ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "video/mp4",
  "video/3gpp",
]);

/** دالة نقية: تقرّر ترويستي الاستجابة من نوع الوسائط الخام — مُصدَّرة للاختبار المباشر. */
export function resolveMediaHeaders(mimeType: string): { contentType: string; disposition: "inline" | "attachment" } {
  if (INLINE_ALLOWED_MIME.has(mimeType)) return { contentType: mimeType, disposition: "inline" };
  return { contentType: "application/octet-stream", disposition: "attachment" };
}

export function waMediaRouter(): Router {
  const r = Router();

  r.get("/:messageId", async (req: Request, res: Response) => {
    let user;
    try {
      user = await getUserFromRequest(req);
    } catch {
      user = null; // جلسة تالفة/منتهية ⇒ يسقط للرفض أدناه (نفس نمط printRoute.ts/requireAuth).
    }
    if (!user) return res.status(401).json({ error: "يلزم تسجيل الدخول." });

    const messageId = Number(req.params.messageId);
    if (!Number.isInteger(messageId) || messageId <= 0) return res.status(404).end();

    try {
      const media = await getMediaForServing(messageId);
      if (!media) return res.status(404).end();
      const bytes = Buffer.from(media.bytesBase64, "base64");
      const { contentType, disposition } = resolveMediaHeaders(media.mimeType);
      res.setHeader("Content-Type", contentType);
      // الوسائط ليست مستنداً موثوقاً: نمنع أيّ محاولة تفسيرٍ كـHTML مهما كان المحتوى (نمط imageRoute.ts).
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (disposition === "attachment") {
        // اسمٌ ثابتٌ آمن — لا مدخلات خارجية (اسم ملف واتساب الأصلي) داخل الترويسة.
        res.setHeader("Content-Disposition", `attachment; filename="media-${messageId}"`);
      }
      // خاص لكل مستخدم مصادَق (يعتمد على الجلسة) — لا كاش مشترك؛ ٢٤ ساعة كافية لصورة محادثة
      // لا تتغيّر بعد وصولها (نمط أبسط من immutable+ETag في imageRoute.ts — لا رابط بصمة محتوى هنا).
      res.setHeader("Cache-Control", "private, max-age=86400");
      return res.end(bytes);
    } catch (e) {
      logger.error({ err: e, messageId }, "wa-media: فشل تقديم الوسائط");
      return res.status(500).end();
    }
  });

  return r;
}
