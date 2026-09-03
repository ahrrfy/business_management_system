/**
 * حارسُ سجلّ القرارات — يمنع انحدارَه إلى فهرسٍ شكليّ.
 *
 * السجلّ بلا هذه الاختبارات يتحوّل خلال أشهر إلى ما كان يُفترَض أن يعالجه: مداخلُ بـ`why`
 * فارغٍ («للحوكمة») و`decidesOn` فيه معرّفٌ قاعديّ — أي وصفٌ لطابورٍ مخفيّ بدل علاجه.
 *
 * ⚠️ **ولا يقيس هذا الملفّ جودة النصّ** — لا يستطيعه اختبار. يقيس ثلاثةً يقيناً: أنّ الشكل
 * صحيح، وأنّ الحقول المحظورة غائبة، وأنّ **الحارس D3 سيعترف بكلّ مدخل**. وادّعاءُ أكثرَ من
 * ذلك يُنذر كذباً فيُتجاوَز (CLAUDE.md §٣.١).
 */
import { describe, expect, it } from "vitest";
import {
  DECISION_REGISTRY,
  allDecisions,
  decisionSpec,
  decisionsForApprover,
  type DecisionSpec,
} from "./decisionRegistry";

const entries = Object.entries(DECISION_REGISTRY);

/** التشكيل العربيّ — ممنوعٌ في نصٍّ يُعرَض في رأس جدولٍ أو شارة (`check:tashkeel`). */
const TASHKEEL = /[ً-ْٰٓ-ٟ]/;
/** الأرقام الهندية — قرار مالكٍ مطلق: كلُّ رقمٍ يعرضه النظام لاتينيّ. */
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/;
/** الإيموجي — ممنوعةٌ في نصّ واجهةٍ (البديل أيقونة `lucide-react`). */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

/**
 * صيغةُ اسم الإجراء التي يلتقطها [`check-friction.mjs`](../scripts/check-friction.mjs)
 * في `detectDecisionProcedures` و`loadRegisteredDecisions` معاً. اسمٌ خارجها = مدخلٌ لا
 * يُسقِط شيئاً من المحور D3، أي سجلٌّ لا يعترف به الحارس.
 */
const GUARD_PROCEDURE_SHAPE = /^(approve|reject|decide)([A-Z]\w*)?$/;

/** حشوٌ لا يُقبَل في `why` — كلٌّ منها يعني «لا أعرف لماذا هذا الضابط موجود». */
const BANNED_WHY = [
  "للحوكمة",
  "لدواعي الحوكمة",
  "اجراء حساس",
  "إجراء حساس",
  "لدواعي الرقابة",
  "احتياطا",
  "احتياطاً",
  "حسب السياسة",
  "كما هو معتاد",
];

/** حقولٌ لا تُغيّر قراراً: معرّفاتٌ داخلية وأرقامُ نسخٍ تفاؤلية. */
const OPAQUE_FIELD = /معرف|رقم النسخة|نسخة السجل|رقم الصف|مفتاح الطلب|\bid\b/i;

/** الحقلُ العدديّ المجرّد — مسموحٌ به مرافقاً، ممنوعٌ أن يكون كلَّ ما يراه المعتمِد. */
const isBareCount = (field: string) => /^عدد\s/.test(field);

const allText = (s: DecisionSpec) => [s.title, s.why, ...s.decidesOn].join(" | ");

describe("سجل القرارات — الشكل", () => {
  it("يحمل مداخل فعلية", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(allDecisions()).toHaveLength(entries.length);
  });

  it("مفتاح الخريطة يطابق kind في كل مدخل", () => {
    for (const [key, s] of entries) expect(s.kind).toBe(key);
  });

  it("kind منقط بمقاطع لاتينية — مفتاح مستقر يصلح للروابط", () => {
    for (const [key] of entries) {
      expect(key, key).toMatch(/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/);
    }
  });

  it("لا تكرار في kind ولا في العنوان", () => {
    const kinds = entries.map(([k]) => k);
    expect(new Set(kinds).size).toBe(kinds.length);
    const titles = allDecisions().map((s) => s.title);
    const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
    expect(dupes, `عناوين مكررة: ${dupes.join(" · ")}`).toHaveLength(0);
  });

  it("decisionSpec يرجع المدخل، وundefined لمفتاح غير مسجل", () => {
    const [firstKey, firstSpec] = entries[0]!;
    expect(decisionSpec(firstKey)).toBe(firstSpec);
    expect(decisionSpec("لا.وجود.له")).toBeUndefined();
  });
});

describe("سجل القرارات — النص العربي المعروض", () => {
  it("العناوين عربية بلا تشكيل ولا ايموجي ولا ارقام هندية", () => {
    for (const s of allDecisions()) {
      expect(s.title.trim().length, s.kind).toBeGreaterThan(4);
      expect(TASHKEEL.test(s.title), `${s.kind}: تشكيل في العنوان`).toBe(false);
      expect(EMOJI.test(s.title), `${s.kind}: ايموجي في العنوان`).toBe(false);
    }
  });

  it("لا ارقام هندية ولا ايموجي في اي نص معروض", () => {
    for (const s of allDecisions()) {
      const text = allText(s);
      expect(ARABIC_INDIC_DIGITS.test(text), `${s.kind}: رقم هندي`).toBe(false);
      expect(EMOJI.test(text), `${s.kind}: ايموجي`).toBe(false);
    }
  });

  it("حقول decidesOn بلا تشكيل — تعرض في رؤوس جداول صغيرة", () => {
    for (const s of allDecisions()) {
      for (const field of s.decidesOn) {
        expect(TASHKEEL.test(field), `${s.kind}: تشكيل في «${field}»`).toBe(false);
      }
    }
  });
});

describe("سجل القرارات — why يفسر ولا يحشو", () => {
  it("لكل قرار سبب مكتوب لا شعار", () => {
    for (const s of allDecisions()) {
      expect(s.why.trim().length, `${s.kind}: سبب قصير`).toBeGreaterThanOrEqual(60);
      for (const banned of BANNED_WHY) {
        expect(s.why.includes(banned), `${s.kind}: حشو «${banned}»`).toBe(false);
      }
    }
  });

  it("لا سببين متطابقين — النسخ واللصق يفرغ السجل من معناه", () => {
    const whys = allDecisions().map((s) => s.why);
    const dupes = whys.filter((w, i) => whys.indexOf(w) !== i);
    expect(dupes).toHaveLength(0);
  });
});

describe("سجل القرارات — decidesOn هو ما يغير القرار", () => {
  it("لا يقل عن ثلاثة حقول", () => {
    for (const s of allDecisions()) {
      expect(s.decidesOn.length, s.kind).toBeGreaterThanOrEqual(3);
    }
  });

  it("لا حقل مكرر ولا حقل فارغ", () => {
    for (const s of allDecisions()) {
      expect(new Set(s.decidesOn).size, s.kind).toBe(s.decidesOn.length);
      for (const field of s.decidesOn) expect(field.trim().length, s.kind).toBeGreaterThan(2);
    }
  });

  /**
   * ⭐ الحارسُ الجوهريّ. العلّةُ المقيسة أنّ شاشة اعتماد أوامر الشراء تُرجع `purchaseOrderId`
   * و«عدد النسخة» بلا مورّدٍ ولا إجماليّ ولا صنف — فيضغط المعتمِد على معرّفٍ لا معنى له.
   */
  it("لا معرف داخلي ولا رقم نسخة في ما يراه المعتمد", () => {
    for (const s of allDecisions()) {
      for (const field of s.decidesOn) {
        expect(OPAQUE_FIELD.test(field), `${s.kind}: حقل معتم «${field}»`).toBe(false);
      }
    }
  });

  it("لا يكتفي باعداد مجردة — لكل قرار حقلان جوهريان على الاقل", () => {
    for (const s of allDecisions()) {
      const substantive = s.decidesOn.filter((f) => !isBareCount(f));
      expect(substantive.length, `${s.kind}: ${s.decidesOn.join(" · ")}`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("سجل القرارات — الاجراء المنفذ والرابط", () => {
  /**
   * ⭐ العقدُ مع حارس الاحتكاك. اسمٌ خارج هذه الصيغة يجعل المدخل غيرَ مرئيٍّ للحارس، فيبقى
   * الموضعُ محسوباً في D3 بينما يظنّ كاتبُه أنّه عالجه.
   */
  it("اسم كل اجراء بالصيغة التي يلتقطها حارس D3", () => {
    for (const s of allDecisions()) {
      expect(s.procedure.name, s.kind).toMatch(GUARD_PROCEDURE_SHAPE);
      expect(s.procedure.router.trim().length, s.kind).toBeGreaterThan(2);
    }
  });

  it("لا تكرار في الزوج (راوتر · اجراء)", () => {
    const pairs = allDecisions().map((s) => `${s.procedure.router}.${s.procedure.name}`);
    const dupes = pairs.filter((p, i) => pairs.indexOf(p) !== i);
    expect(dupes, `ازواج مكررة: ${dupes.join(" · ")}`).toHaveLength(0);
  });

  it("href مسار داخلي يبدا بشرطة مائلة", () => {
    for (const s of allDecisions()) {
      const href = s.href(7);
      expect(href, s.kind).toMatch(/^\/[^\s]*$/);
      expect(href.includes("undefined"), s.kind).toBe(false);
      expect(href.includes("null"), s.kind).toBe(false);
    }
  });

  it("href الذي يستهلك المعرف يحمله فعلا — بالرقم وبالنص", () => {
    for (const s of allDecisions()) {
      const withNumber = s.href(1234);
      const withText = s.href("ABC");
      if (withNumber !== withText) {
        expect(withNumber, s.kind).toContain("1234");
        expect(withText, s.kind).toContain("ABC");
      }
    }
  });
});

describe("سجل القرارات — من يعتمد", () => {
  it("كل قرار مصنف بواحد من ثلاثة", () => {
    const known = new Set(["OWNER_ONLY", "MANAGER", "INDEPENDENT_REVIEWER"]);
    for (const s of allDecisions()) expect(known.has(s.approver), s.kind).toBe(true);
  });

  it("decisionsForApprover تقسم السجل بلا فقد ولا تكرار", () => {
    const total =
      decisionsForApprover("OWNER_ONLY").length +
      decisionsForApprover("MANAGER").length +
      decisionsForApprover("INDEPENDENT_REVIEWER").length;
    expect(total).toBe(allDecisions().length);
  });

  /**
   * السحبُ مخرجٌ نادرٌ لا افتراض: بحثٌ في الراوترات أعطى ثلاثةَ مسارات سحبٍ حيّة فقط
   * (`salesControl.withdraw` · `superApp.withdrawLeave` · `gifts.cancelGift`). فوسمُ مدخلٍ
   * بـ`withdrawable: true` بلا مسارٍ يترك الطالب في طريقٍ مسدود يظنّ أنّ له مخرجاً.
   */
  it("القابل للسحب يبقى استثناء لا قاعدة", () => {
    const withdrawable = allDecisions().filter((s) => s.withdrawable);
    expect(withdrawable.length).toBeGreaterThan(0);
    expect(withdrawable.length).toBeLessThan(allDecisions().length / 2);
  });
});
