import { describe, expect, it } from "vitest";
import {
  ROLLOUT_FLAGS,
  ROLLOUT_FLAG_KEYS,
  ROLLOUT_MODES,
  isRolloutMode,
  resolveRolloutMode,
  rolloutReasonLabel,
  type RolloutFlagKey,
} from "./rolloutFlags";

/**
 * الثابت الحاكم لهذا الملفّ: **العلَم يفشل مغلقاً في كل حالةٍ ملتبسة.**
 * كل اختبارٍ هنا يحرس بابَ خطأٍ محتملاً في النشر — لا يحرس صياغةً.
 */
describe("أعلام الطرح — تفشل مغلقةً دائماً", () => {
  it("علَمٌ غير مضبوط ⇒ OFF بسبب «الافتراض»", () => {
    const r = resolveRolloutMode("courierLedgerDerived", undefined);
    expect(r).toEqual({ mode: "OFF", reason: "default" });
  });

  it("قيمةٌ فارغة أو فراغات ⇒ OFF (لا تُعامَل قيمةً)", () => {
    expect(resolveRolloutMode("courierLedgerDerived", "").mode).toBe("OFF");
    expect(resolveRolloutMode("courierLedgerDerived", "   ").mode).toBe("OFF");
    expect(resolveRolloutMode("courierLedgerDerived", null).mode).toBe("OFF");
  });

  it("قيمةٌ غير مفهومة ⇒ OFF بسبب «غير صالحة» — لا تخمينَ لنيّة الكاتب", () => {
    for (const bad of ["yes", "true", "1", "ENABLED", "on-ish", "OF"]) {
      const r = resolveRolloutMode("courierLedgerDerived", bad);
      expect(r.mode, `القيمة «${bad}» كان يجب أن تُطفئ العلَم`).toBe("OFF");
      expect(r.reason).toBe("invalid");
    }
  });

  it("يقبل الأوضاع الصالحة ويطبّع حالة الأحرف والفراغات", () => {
    expect(resolveRolloutMode("courierLedgerDerived", "on")).toEqual({ mode: "ON", reason: "explicit" });
    expect(resolveRolloutMode("courierLedgerDerived", " Shadow ")).toEqual({
      mode: "SHADOW",
      reason: "explicit",
    });
    expect(resolveRolloutMode("courierLedgerDerived", "OFF")).toEqual({ mode: "OFF", reason: "explicit" });
  });

  it("وضعٌ صالحٌ لكنّ العلَم لا يدعمه ⇒ OFF لا ON", () => {
    // `posDeliveryMode` لا معنى للظلّ فيه: الوضع الثاني إمّا يظهر أو لا.
    expect(ROLLOUT_FLAGS.posDeliveryMode.supports).not.toContain("SHADOW");
    const r = resolveRolloutMode("posDeliveryMode", "SHADOW");
    expect(r).toEqual({ mode: "OFF", reason: "unsupported" });
  });

  it("كلُّ علَمٍ يدعم OFF — وإلّا لَما أمكن إطفاؤه", () => {
    for (const key of ROLLOUT_FLAG_KEYS) {
      expect(ROLLOUT_FLAGS[key].supports, `العلَم ${key}`).toContain("OFF");
    }
  });

  it("كلُّ علَمٍ يدعم ON — وإلّا لَما أمكن طرحُه", () => {
    for (const key of ROLLOUT_FLAG_KEYS) {
      expect(ROLLOUT_FLAGS[key].supports, `العلَم ${key}`).toContain("ON");
    }
  });
});

describe("سجلّ الأعلام — عقدُ التسمية والوصف", () => {
  it("مفتاحُ البيئة يبدأ بـROLLOUT_ ولا يتكرّر بين علمين", () => {
    const seen = new Set<string>();
    for (const key of ROLLOUT_FLAG_KEYS) {
      const env = ROLLOUT_FLAGS[key].env;
      expect(env, `العلَم ${key}`).toMatch(/^ROLLOUT_[A-Z0-9_]+$/);
      expect(seen.has(env), `مفتاحُ البيئة ${env} مكرّر`).toBe(false);
      seen.add(env);
    }
  });

  it("كلُّ علَمٍ يُصرّح بموجته وبما يعنيه إطفاؤه", () => {
    for (const key of ROLLOUT_FLAG_KEYS) {
      const spec = ROLLOUT_FLAGS[key];
      expect(spec.wave, `العلَم ${key}`).toMatch(/^م\d+$/);
      // «ماذا يحدث حين يكون مطفأً» ليس زينةً: هو ما يُقرأ في مراجعة النشر لتقدير أثر الإطفاء.
      expect(spec.offMeans.length, `العلَم ${key}`).toBeGreaterThan(20);
      expect(spec.label.length, `العلَم ${key}`).toBeGreaterThan(3);
    }
  });

  it("سببُ الإطفاء يُشرَح بالعربية ويذكر مفتاح البيئة", () => {
    const key: RolloutFlagKey = "reversalEngine";
    expect(rolloutReasonLabel(key, "default")).toContain(ROLLOUT_FLAGS[key].env);
    expect(rolloutReasonLabel(key, "invalid")).toContain(ROLLOUT_FLAGS[key].env);
    expect(rolloutReasonLabel(key, "unsupported")).toContain("المدعوم");
  });

  it("isRolloutMode يقبل الأوضاع الثلاثة وحدها", () => {
    for (const m of ROLLOUT_MODES) expect(isRolloutMode(m)).toBe(true);
    for (const bad of ["on", "", null, undefined, 1, {}]) expect(isRolloutMode(bad)).toBe(false);
  });
});
