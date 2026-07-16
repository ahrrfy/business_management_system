// تسجيل التدقيق (auditLogs) — يكتب «من فعل ماذا، متى، من أين» لكل عملية حسّاسة.
// السبب (مراجعة ٧/٦): الجدول معرَّف في المخطّط ولا يُكتب فيه سطر ⇒ صفر مساءلة.
//
// التصميم: best-effort على مستوى الراوتر (لا يُلَفّ في tx العملية لتجنّب تمرير ctx
// عبر كل الخدمات). فشل التسجيل لا يكسر العملية إطلاقاً (يُسجَّل تحذيراً فقط).
import { auditLogs } from "../../drizzle/schema";
import type { TrpcContext } from "../context";
import { getDb } from "../db";
import { logger } from "../logger";

export type AuditData = {
  action: string; // مثل "sale.create" / "product.update" / "inventory.transfer"
  entityType: string; // مثل "invoice" / "product" / "stock"
  entityId?: string | number | null;
  oldValue?: unknown;
  newValue?: unknown;
};

/**
 * ═══ تعقيم قيم التدقيق — حارسٌ مركزيّ، لا تجميل ═══
 *
 * **العطل الحقيقيّ الذي أوجده (١٤–١٦/٧، مُشخَّصٌ من سجلّ الإنتاج):** `store.banner.update` كان
 * يمرّر مدخله كاملاً (`newValue: rest`) وفيه `imageUrl` (سقف ٣ م.ب) و`mobileImageUrl` (٣ م.ب)
 * و`images` (٢٠ × ٢ م.ب) **data-URL بـbase64** ⇒ صفُّ تدقيقٍ واحدٍ بميغابايتات.
 *
 * ثم يقتل ذلك الصفُّ **الشاشة كلّها** لا نفسه: `ORDER BY id DESC` يُجبر MySQL على `filesort`،
 * وحقلُ الفرز يجب أن يتّسع لأعرض صفّ ⇒ `Out of sort memory` (بنرُ إنتاجٍ حقيقيّ = ١٫٣ م.ب =
 * **٥٫٣× `sort_buffer_size`** الافتراضي ٢٥٦ ك.ب). أُعيد إنتاجه محلّياً: صفٌّ واحد ⇒ الجدول كلّه يسقط.
 *
 * **لماذا مركزيّ في `logAudit` لا في الراوتر:** ٣٧ راوتراً تكتب هنا، وأيّ واحدٍ منها قد يمرّر
 * حقلاً يحمل data URL اليوم أو غداً (مرفقات السندات، صور المنتجات، صور الموظّفين…). إصلاح
 * النداء وحده يُصلح حالةً؛ الحارس المركزيّ يجعل تسميم الجدول **مستحيلاً بنيوياً**.
 *
 * القاعدتان: ① data URL ⇒ علامةٌ تصف الحجم (لا بايتاتها). ② سقفٌ نهائيّ للحمولة كلّها —
 * شبكة أمانٍ لأيّ حقلٍ ضخمٍ غير متوقَّع (نصّ طويل، مصفوفة كبيرة) لا نعرفه بعد.
 */
const MAX_AUDIT_VALUE_BYTES = 8 * 1024;
const MAX_AUDIT_STRING_CHARS = 1024;
/**
 * حاجزٌ أخير ضدّ تداخلٍ مَرَضيّ فقط — **ليس** أداة تحديد الحجم (ذاك عمل `MAX_AUDIT_VALUE_BYTES`).
 *
 * ⚠️ درسٌ من انحدارٍ أمسكه اختبار H6 القائم: كان الحدّ ٦ فبتر بياناتٍ **مشروعة**
 * (`product.update` يسجّل `variants→units→prices` فتتجاوز ٦ بسهولة) وحوّل `[{priceTier:"RETAIL"}]`
 * إلى `["<عميق>"]` ⇒ التعقيم يأكل التدقيق الذي جاء ليحميه. حمولات التدقيق الحقيقية أعمق ممّا يبدو.
 */
const MAX_AUDIT_DEPTH = 32;
const DATA_URL_RE = /^data:[a-z0-9.+/-]+;base64,/i;

/**
 * `ancestors` = مسار الأجداد الحاليّ لا «كل ما زُرِف»: الدورة وحدها تُوقف الغوص. مجموعةُ
 * «كل ما زُرِف» كانت ستُعلِّم كائناً مشتركاً بين فرعين (DAG، لا دورة فيه) كأنّه دائريّ فتحذفه ظلماً.
 */
function redactDeep(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (typeof value === "string") {
    if (DATA_URL_RE.test(value.trimStart())) {
      return `<صورة ${Math.round(value.length / 1024)} ك.ب — محجوبة عن سجلّ التدقيق>`;
    }
    return value.length > MAX_AUDIT_STRING_CHARS
      ? `${value.slice(0, MAX_AUDIT_STRING_CHARS)}…<اقتُطع ${value.length - MAX_AUDIT_STRING_CHARS} حرفاً>`
      : value;
  }
  if (value === null || typeof value !== "object") return value;

  // مرجعٌ دائريّ ⇒ توقّف (وإلّا غاصت الدالّة بلا نهاية). JSON.stringify يرمي على الدورات،
  // لكنّه يأتي **بعد** هذا الغوص ⇒ لا يحمينا منه.
  if (ancestors.has(value)) return "<مرجعٌ دائريّ>";
  if (depth >= MAX_AUDIT_DEPTH) return "<تداخلٌ مفرط>";

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1, ancestors));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, depth + 1, ancestors);
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/** يُعقّم قيمة تدقيق قبل تخزينها. مُصدَّرة للاختبار ولسكربت تطهير الصفوف القائمة. */
export function redactAuditValue(value: unknown): unknown {
  if (value == null) return null;
  const redacted = redactDeep(value, 0, new Set<object>());
  // السقف النهائيّ: لا نثق بأنّ القاعدتين أعلاه غطّتا كل شكلٍ ممكن.
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(redacted);
  } catch {
    return { _unserializable: true };
  }
  if (serialized && serialized.length > MAX_AUDIT_VALUE_BYTES) {
    return { _truncated: true, _originalBytes: serialized.length, _preview: serialized.slice(0, 512) };
  }
  return redacted;
}

/** يكتب سطر تدقيق. لا يرمي أبداً — السجلّ لا يجب أن يُسقط عمليةً ناجحة. */
export async function logAudit(ctx: Pick<TrpcContext, "user" | "req">, data: AuditData): Promise<void> {
  try {
    const db = getDb();
    if (!db) return;
    const ip =
      (ctx.req?.headers?.["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
      ctx.req?.ip ??
      null;
    await db.insert(auditLogs).values({
      userId: ctx.user?.id ?? null,
      branchId: ctx.user?.branchId ?? null,
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId != null ? String(data.entityId) : null,
      oldValue: redactAuditValue(data.oldValue),
      newValue: redactAuditValue(data.newValue),
      ipAddress: ip,
    });
  } catch (e) {
    logger.warn({ err: e, action: data.action }, "تعذّر كتابة سجلّ التدقيق");
  }
}
