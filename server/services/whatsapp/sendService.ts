/**
 * إرسال رسائل WhatsApp Cloud API — شريحة #١ (نواة Cloud API).
 *
 * كل دالة إرسال تبني حمولة Cloud API الرسمية (`messaging_product:"whatsapp"`...) وتضربها عبر
 * graphFetch، ثم تُعيد إمّا نجاحاً بمعرّف الرسالة (wamid) أو فشلاً مُصنَّفاً (retryable/permanent/
 * pauseworthy) — التصنيف يقود قرار outboxService (إعادة محاولة بتراجع أسّي أو إنهاء دائم).
 *
 * حياديّة عن مصدر التكامل: تستقبل accessToken/phoneNumberId/apiBaseUrl جاهزة (لا تقرأ DB) ⇒ قابلة
 * للاختبار الخالص بـfetch مُموَّه بلا قاعدة بيانات (sendService.test.ts).
 *
 * sendMediaByLink غير مبنيّة عمداً (YAGNI — غير مطلوبة في هذه الشريحة).
 */
import { graphFetch, type GraphIntegration } from "./graph";

export type GraphErrorClassification = "retryable" | "permanent" | "pauseworthy";

export interface GraphErrorInfo {
  classification: GraphErrorClassification;
  /** رمز خطأ Meta الرقمي (error.code) إن وُجد — null لو فشل شبكة أو جسم غير متوقَّع. */
  code: number | null;
  /** رسالة عربية جاهزة للعرض/lastError. */
  detail: string;
}

export interface SendSuccess {
  ok: true;
  wamid: string;
}
export interface SendFailure {
  ok: false;
  classification: GraphErrorClassification;
  code: number | null;
  detail: string;
}
export type SendResult = SendSuccess | SendFailure;

// ── تصنيف الأخطاء + خريطة الرسائل العربية ───────────────────────────────────

const TEMPLATE_ERROR_DETAIL_AR =
  "خطأ في القالب المُرسَل — تحقّق من اسمه ولغته ومطابقة معطياته للقالب المعتمَد في إدارة واتساب للأعمال.";
const templateErrorEntries: Record<number, string> = {};
for (let code = 132000; code <= 132015; code++) templateErrorEntries[code] = TEMPLATE_ERROR_DETAIL_AR;

/** رسائل عربية جاهزة لأكواد أخطاء Meta الشائعة — تُعرض كما هي في lastError/الواجهة. */
export const GRAPH_ERROR_AR: Record<number, string> = {
  131047: "نافذة المحادثة مغلقة — استخدم قالباً معتمداً.",
  131026: "تعذّر تسليم الرسالة لهذا الرقم — تحقّق من صحته أو أنه مسجَّل فعلاً على واتساب.",
  131056: "تكرار إرسال سريع جداً لنفس المستلم — أعد المحاولة بعد قليل.",
  100: "معامل غير صالح في طلب الإرسال (خطأ داخلي في تركيب الرسالة إلى واتساب).",
  131048: "تنبيه معدّل الرسائل من واتساب — يُستحسَن إيقاف الحملة مؤقّتاً حتى يهدأ المعدّل.",
  ...templateErrorEntries,
};

/** أكواد تُصنَّف قابلة لإعادة المحاولة رغم أنها تصل بحالة HTTP غير 429/5xx صراحةً. */
const RETRYABLE_CODES = new Set([130429]);
/** أكواد «يستحقّ الإيقاف» (pauseworthy) — للحملات لاحقاً؛ تُصنَّف الآن فقط، بلا معالجة خاصة بعد. */
const PAUSEWORTHY_CODES = new Set([131048]);

function extractGraphErrorCode(body: unknown): number | null {
  const raw = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

function extractGraphErrorMessage(body: unknown): string | null {
  const err = (body as { error?: { message?: unknown; error_data?: { details?: unknown } } } | null)?.error;
  if (typeof err?.message === "string" && err.message) return err.message;
  if (typeof err?.error_data?.details === "string" && err.error_data.details) return err.error_data.details;
  return null;
}

/**
 * يصنّف فشل استجابة Graph API — يقرّر الكنّاس على أساسه إعادة المحاولة أم الإنهاء الدائم.
 * status=0 (من graphFetch) يعني فشل شبكة (استثناء fetch) ⇒ retryable دائماً.
 */
export function classifyGraphError(status: number, body: unknown): GraphErrorInfo {
  const code = extractGraphErrorCode(body);
  const arDetail = code != null ? GRAPH_ERROR_AR[code] : undefined;
  const detail = arDetail ?? extractGraphErrorMessage(body) ?? `فشل الاتصال بواتساب (رمز الحالة ${status}).`;

  if (status === 0 || status >= 500 || status === 429 || (code != null && RETRYABLE_CODES.has(code))) {
    return { classification: "retryable", code, detail };
  }
  if (code != null && PAUSEWORTHY_CODES.has(code)) {
    return { classification: "pauseworthy", code, detail };
  }
  // أي 4xx آخر (يشمل 131047/131026/131056/132000-132015/100 المصنَّفة صراحةً برسالة أعلاه).
  return { classification: "permanent", code, detail };
}

/** ينزع بادئة «+» ليصبح الرقم بصيغة wa_id (المتوقَّعة من Cloud API — دولية بلا +). */
export function toWaId(phoneE164: string): string {
  return phoneE164.replace(/^\+/, "");
}

async function postMessage(
  integration: GraphIntegration,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<SendResult> {
  const res = await graphFetch(integration, `/${integration.phoneNumberId}/messages`, { method: "POST", body: payload }, fetchImpl);
  if (res.ok) {
    const wamid = (res.body as { messages?: Array<{ id?: unknown }> } | null)?.messages?.[0]?.id;
    if (typeof wamid !== "string" || !wamid) {
      return {
        ok: false,
        classification: "permanent",
        code: null,
        detail: "استجابة واتساب لا تحوي معرّف رسالة (wamid) رغم نجاح الطلب ظاهرياً.",
      };
    }
    return { ok: true, wamid };
  }
  const info = classifyGraphError(res.status, res.body);
  return { ok: false, classification: info.classification, code: info.code, detail: info.detail };
}

/** ردّ حرّ ضمن نافذة ٢٤ ساعة (نصّ عادي) — فحص النافذة مسؤولية المستدعي (outboxService). */
export async function sendSessionText(
  integration: GraphIntegration,
  toE164digits: string,
  bodyText: string,
  fetchImpl?: typeof fetch,
): Promise<SendResult> {
  const payload = {
    messaging_product: "whatsapp",
    to: toWaId(toE164digits),
    type: "text",
    text: { body: bodyText },
  };
  return postMessage(integration, payload, fetchImpl);
}

/** قالب مُعتمَد — يعمل خارج/داخل نافذة الردّ الحرّ. bodyParams بترتيب متغيّرات القالب {{1}} {{2}} ... */
export async function sendTemplate(
  integration: GraphIntegration,
  to: string,
  templateName: string,
  langCode: string,
  bodyParams: string[],
  fetchImpl?: typeof fetch,
): Promise<SendResult> {
  const template: Record<string, unknown> = {
    name: templateName,
    language: { code: langCode },
  };
  if (bodyParams.length > 0) {
    template.components = [{ type: "body", parameters: bodyParams.map((p) => ({ type: "text", text: p })) }];
  }
  const payload = {
    messaging_product: "whatsapp",
    to: toWaId(to),
    type: "template",
    template,
  };
  return postMessage(integration, payload, fetchImpl);
}

/** رسالة تفاعلية بأزرار ردّ سريع (حتى ٣ — حدّ Cloud API) — لـCSAT/الأتمتة لاحقاً. */
export async function sendInteractiveButtons(
  integration: GraphIntegration,
  to: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
  fetchImpl?: typeof fetch,
): Promise<SendResult> {
  const payload = {
    messaging_product: "whatsapp",
    to: toWaId(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })),
      },
    },
  };
  return postMessage(integration, payload, fetchImpl);
}
