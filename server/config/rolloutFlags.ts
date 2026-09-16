/**
 * حلُّ أعلام الطرح على الخادم — القراءة الوحيدة من البيئة.
 *
 * كلُّ ما يخصّ المعنى والأوضاع في `shared/rolloutFlags.ts`؛ هذا الملفّ **وصلٌ بالبيئة فقط**،
 * كي يبقى المنطق نقيّاً قابلاً للاختبار بلا `process.env`.
 *
 * ⚠️ **القراءة كسولةٌ لا مجمَّدة عند الاستيراد.** التجميد وقت الاستيراد يجعل أيّ اختبارٍ
 * يضبط البيئة بعد `import` يقرأ قيمةً قديمة — وهو صنفُ الأخطاء التي تمرّ خضراءَ ثمّ تسقط
 * على الإنتاج. والكلفة معدومة: قراءةُ حقلٍ من كائن.
 */
import {
  ROLLOUT_FLAGS,
  ROLLOUT_FLAG_KEYS,
  resolveRolloutMode,
  rolloutReasonLabel,
  type RolloutFlagKey,
  type RolloutMode,
} from "@shared/rolloutFlags";

/** وضعُ علَمٍ الآن. يفشل مغلقاً (`OFF`) عند أيّ التباس — انظر `resolveRolloutMode`. */
export function rolloutMode(key: RolloutFlagKey): RolloutMode {
  return resolveRolloutMode(key, process.env[ROLLOUT_FLAGS[key].env]).mode;
}

/** هل السلوك الجديد هو المرجع؟ */
export function isRolloutOn(key: RolloutFlagKey): boolean {
  return rolloutMode(key) === "ON";
}

/**
 * هل نحسب الجديد **بلا أن نعتمده**؟ صحيحةٌ في `SHADOW` وحدها.
 *
 * ⛔ لا تستعملها لتقرير سلوك: `SHADOW` تعني «احسب وسجّل الفرق»، فإن فرّعتَ عليها سلوكاً
 * ماليّاً صار الظلّ مؤثّراً — وهو نقضُ الغرض كلّه.
 */
export function isRolloutShadow(key: RolloutFlagKey): boolean {
  return rolloutMode(key) === "SHADOW";
}

/**
 * هل يجب حسابُ المسار الجديد أصلاً؟ (`SHADOW` أو `ON`).
 * تُستعمل لتفادي حسابٍ ثقيلٍ بلا داعٍ حين يكون العلَم مطفأً.
 */
export function shouldComputeNext(key: RolloutFlagKey): boolean {
  const mode = rolloutMode(key);
  return mode === "SHADOW" || mode === "ON";
}

export interface RolloutStatusRow {
  key: RolloutFlagKey;
  env: string;
  label: string;
  wave: string;
  mode: RolloutMode;
  reason: string;
  offMeans: string;
}

/**
 * لقطةُ حالة كل الأعلام — للتشخيص ومراجعة النشر.
 *
 * تُقرأ بعد كل نشرٍ للتحقّق من أنّ ما ضُبط في `ecosystem` وصل فعلاً إلى العملية: فخُّ PM2
 * المسجَّل في رأس `shared/rolloutFlags.ts` يجعل «الملفّ صحيح» غيرَ كافٍ كإثبات.
 */
export function rolloutStatus(): RolloutStatusRow[] {
  return ROLLOUT_FLAG_KEYS.map((key) => {
    const spec = ROLLOUT_FLAGS[key];
    const { mode, reason } = resolveRolloutMode(key, process.env[spec.env]);
    return {
      key,
      env: spec.env,
      label: spec.label,
      wave: spec.wave,
      mode,
      reason: rolloutReasonLabel(key, reason),
      offMeans: spec.offMeans,
    };
  });
}
