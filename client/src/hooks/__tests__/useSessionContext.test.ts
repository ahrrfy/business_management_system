/**
 * useSessionContext — اختبارُ مسند «إعادة المحاولة» (تدقيق Codex، م٤).
 *
 * العطبُ المُثبَّت: زرّ «إعادة المحاولة» كان يُعيد جلبَ `sessionContext.get` وحده. لكنّ ذلك
 * الاستعلام مُعطَّلٌ (`enabled: signedIn`) ما لم تُقرأ الهويّة؛ فحين يفشل `auth.me` ابتدائياً يبقى
 * `meError`/`signedIn===false` وتظلّ الشاشاتُ الثلاث محجوبةً ولو نجحت إعادةُ جلب السياق.
 * `retryTarget` يقرّر — بلا React — أيَّ استعلامٍ يُعاد جلبه: الهويّة إن كانت هي الساقطة، وإلّا السياق.
 *
 * البيئة `node` (بلا jsdom) ⇒ نختبر المسند النقيّ المُعرَّض مباشرةً، لا الهوك عبر renderHook.
 */
import { describe, expect, it } from "vitest";
import { retryTarget } from "../useSessionContext";

describe("retryTarget — إعادةُ جلب الاستعلام الساقط فعلاً", () => {
  it("فشلُ auth.me ⇒ يُعيد جلبَ me (لا السياقَ المُعطَّل الذي لا يُجلَب أصلاً)", () => {
    // العطب الأصليّ: هنا كان يُعاد جلبُ السياق وحده فتبقى الشاشةُ محجوبةً.
    expect(retryTarget({ meError: true, signedIn: false })).toBe("me");
  });

  it("لم تُقرأ الهويّةُ بعد (signedIn=false بلا خطأ) ⇒ يُعيد جلبَ me", () => {
    expect(retryTarget({ meError: false, signedIn: false })).toBe("me");
  });

  it("الهويّةُ حاضرةٌ والسياقُ هو الساقط ⇒ يُعيد جلبَ السياق", () => {
    expect(retryTarget({ meError: false, signedIn: true })).toBe("context");
  });

  it("حافّةٌ: خطأُ me مع بقاء هويّةٍ سابقة (signedIn=true) ⇒ يُقدَّم إعادةُ جلب me", () => {
    // إن كان `auth.me` في حالة خطأ، فإعادةُ جلبه أَولى — قد تُصلح الهويّةَ فيُفعَّل السياق تلقائياً.
    expect(retryTarget({ meError: true, signedIn: true })).toBe("me");
  });
});
