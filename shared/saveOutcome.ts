/**
 * نتيجةُ الحفظ المُهيكَلة — العقدُ بين `RecordForm`/`SaveBar` وأيّ عمليةٍ محكومة (م٦ ق٤).
 *
 * **العلّة (Codex FP-04):** شريط الحفظ كان يعرف «نجح/فشل» فقط. وفي نظامٍ حوكميّ كثيرٌ من
 * «الحفظ» لا يُطبِّق شيئاً بل **يُنشئ طلباً معلّقاً** (تعديل شراء ⇒ `APPROVE_REVISION`، إلغاءٌ ⇒
 * طلبُ اعتماد…). عرضُ «تم الحفظ» الأخضر عندها كذبٌ يُنتج شكوى المالك المتكرّرة: «الشاشة قالت
 * حُفظ، والقيمة لم تتغيّر». فالنتيجة أربعُ حالاتٍ مُسمّاة، لا اثنتان:
 *   • SAVED     — طُبِّق التغيير فعلاً.
 *   • REQUESTED — أُنشئ طلبٌ بانتظار قرار — **لم يُطبَّق** بعد.
 *   • CONFLICT  — تغيّر السجلّ في مكانٍ آخر (رمز `CONFLICT` من الخادم) — أعد التحميل ثمّ كرّر.
 *   • FAILED    — رُفض أو تعطّل، والرسالة تقول لماذا وماذا تفعل (عقد `appErrorMessage`).
 *
 * الملفّ **نقيّ** (بلا React ولا شبكة) كي يُختبر في `test:unit` ويُعاد استعماله من أيّ شاشة.
 * موقعُه `shared/` لأنّ قاموس العبارات (`SAVE_OUTCOME_LABELS`) مصطلحٌ موحَّد لا قاموسٌ محلّيّ في شاشة
 * (مقياس الاحتكاك D6)، وليصلح للخادم إن أراد أن يُعيد نتيجةً مُهيكَلة بالنوع نفسه.
 */
import { ACTION_LABELS } from "./actionLabels";

export type SaveOutcomeStatus = "SAVED" | "REQUESTED" | "CONFLICT" | "FAILED";

export type SaveOutcome = {
  status: SaveOutcomeStatus;
  /** نصٌّ يُعرض بجوار الزرّ — للنجاح عبارةُ `ACTION_LABELS`، وللرفض رسالةُ الخادم كما هي. */
  message: string;
  /** لحظةُ النتيجة (ms) — تُميّز نتيجتَين متتاليتَين بنفس النصّ. */
  at: number;
};

/** العبارات الثابتة — مصدرٌ واحد كي لا تنجرف بين الشاشات. */
export const SAVE_OUTCOME_LABELS: Record<SaveOutcomeStatus, string> = {
  SAVED: ACTION_LABELS.saved,
  REQUESTED: "أُنشئ طلب بانتظار الاعتماد — لم يُطبَّق التغيير بعد",
  CONFLICT: "تعارض: تغيّر السجل في مكان آخر — أعد تحميل الشاشة ثم كرّر الحفظ",
  FAILED: "تعذّر الحفظ",
};

/**
 * هل نتيجةُ الخادم «طلبٌ معلّق» لا تطبيقٌ؟ — البروتوكول صريح لا تخمين:
 *   `{ outcome: "REQUESTED" }` أو `{ requested: true }` أو `{ controlRequestId }` أو `{ requestId }`.
 * أيُّ شكلٍ آخر = تطبيقٌ فعليّ. (البروتوكول موثَّق هنا كي تلتزم به الخدمات التي تُنشئ طلبات.)
 */
export function isRequestedResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  if (r.outcome === "REQUESTED" || r.status === "REQUESTED") return true;
  if (r.requested === true) return true;
  if (typeof r.controlRequestId === "number" && r.controlRequestId > 0) return true;
  if (typeof r.requestId === "number" && r.requestId > 0) return true;
  return false;
}

/** رمزُ خطأ tRPC من `TRPCClientError` (أو أيّ كائنٍ يحمل `data.code`) — بلا استيراد @trpc/client. */
export function errorCodeOf(error: unknown): string | null {
  const code = (error as { data?: { code?: unknown } } | null | undefined)?.data?.code;
  return typeof code === "string" ? code : null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return SAVE_OUTCOME_LABELS.FAILED;
}

export type DeriveSaveOutcomeInput = {
  /** قيمةُ الـPromise عند النجاح. */
  result?: unknown;
  /** الخطأ عند الفشل — وجودُه يغلب `result`. */
  error?: unknown;
  /** عبارةُ النجاح المخصَّصة (مثل «تم حفظ المنتج»). الافتراض `ACTION_LABELS.saved`. */
  savedMessage?: string;
  now?: number;
};

/** يشتقّ النتيجةَ المُهيكَلة من مآل الحفظ. */
export function deriveSaveOutcome(input: DeriveSaveOutcomeInput): SaveOutcome {
  const at = input.now ?? Date.now();
  if (input.error !== undefined && input.error !== null) {
    const code = errorCodeOf(input.error);
    if (code === "CONFLICT") {
      return { status: "CONFLICT", message: `${messageOf(input.error)} — ${SAVE_OUTCOME_LABELS.CONFLICT}`, at };
    }
    return { status: "FAILED", message: messageOf(input.error), at };
  }
  if (isRequestedResult(input.result)) {
    return { status: "REQUESTED", message: SAVE_OUTCOME_LABELS.REQUESTED, at };
  }
  return { status: "SAVED", message: input.savedMessage?.trim() || SAVE_OUTCOME_LABELS.SAVED, at };
}
