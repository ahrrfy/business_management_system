import { describe, it, expect } from "vitest";
import { appError, appErrorMessage, type AppErrorParts } from "./errors";

/**
 * الأجزاء الأربعة عقدٌ لا اصطلاح تحرير: هذه الاختبارات تُثبت أنّ الجزء الثالث («ماذا تفعل الآن»)
 * **لا يمكن نسيانه**، وأنّ الرسالة المركَّبة تحمل الثلاثة النصّية معاً في سطرٍ واحد.
 */

/** أجزاء صالحة مأخوذةٌ من حارسٍ حقيقيّ (وردية الكاشير المغلقة) — أساسٌ للاختبارات الجزئية. */
const VALID: AppErrorParts = {
  what: "تعذّر تسجيل الدفعة على الفاتورة",
  why: "الوردية المرتبطة بها مغلقة، والمغلقة لا تقبل حركة نقدٍ جديدة",
  doThis: "افتح وردية جديدة على درجك ثمّ أعد التحصيل",
};

describe("عقد رسالة الخطأ (appError)", () => {
  it("الرسالة المبنيّة تحوي الأجزاء الثلاثة النصّية", () => {
    const err = appError(VALID);
    expect(err.message).toContain(VALID.what);
    expect(err.message).toContain(VALID.why);
    expect(err.message).toContain(VALID.doThis);
    // والأجزاء تبقى مُتاحةً مُهيكَلةً للشاشة التي تعرض كلَّ جزءٍ في موضعه.
    expect(err.what).toBe(VALID.what);
    expect(err.why).toBe(VALID.why);
    expect(err.doThis).toBe(VALID.doThis);
  });

  it("ترتيب الأجزاء ثابت: ماذا حدث ثمّ لماذا ثمّ ماذا تفعل", () => {
    const { message } = appError(VALID);
    expect(message.indexOf(VALID.what)).toBeLessThan(message.indexOf(VALID.why));
    expect(message.indexOf(VALID.why)).toBeLessThan(message.indexOf(VALID.doThis));
  });

  // ═══ الجزء الذي يُنسى دائماً ═════════════════════════════════════════════════════════
  // النوع يمنع نسيانه عند التأليف (`doThis` حقلٌ إلزاميّ في `AppErrorParts`)، وهذه الحالات
  // تُثبت النصف الآخر: مستدعٍ غير مُنمَّط (استيراد/بذرة/جافاسكربت) لا يمرّ بلا مخرجٍ عمليّ.
  it.each([
    ["غائب", undefined],
    ["فارغ", ""],
    ["فراغاتٌ فقط", "   \n  "],
  ])("لا تُبنى رسالةٌ و«ماذا تفعل الآن» %s", (_label, doThis) => {
    expect(() =>
      appError({ ...VALID, doThis: doThis as unknown as string }),
    ).toThrow(/ماذا تفعل الآن/);
  });

  it("«ماذا حدث» و«لماذا» إلزاميّان كذلك — الرسالة عقدٌ كامل لا جزءان", () => {
    expect(() => appError({ ...VALID, what: "  " })).toThrow(/ماذا حدث/);
    expect(() => appError({ ...VALID, why: "" })).toThrow(/لماذا/);
  });

  it("«ماذا تفعل الآن» لا يصحّ أن يكون إعادةَ صياغةٍ لـ«لماذا»", () => {
    // كانت هذه أشيعَ صورةٍ للامتثال الشكليّ: يُملأ الحقل بنسخةٍ من السبب فتبقى الرسالة بلا مخرج.
    expect(() => appError({ ...VALID, doThis: VALID.why })).toThrow(/يكرّر/);
    // والنقطة الختامية لا تُنجيه — المقارنة بعد إسقاط علامات الفصل.
    expect(() => appError({ ...VALID, doThis: `${VALID.why}.` })).toThrow(/يكرّر/);
  });

  // ═══ قرار المالك: كلّ رقمٍ يعرضه النظام لاتينيّ ══════════════════════════════════════
  it("الأرقام الهندية تُصحَّح إلى لاتينية — ولا تُسقِط الرسالة", () => {
    expect(appError({ ...VALID, why: "المتاح ٣ والمطلوب ٥" }).why).toBe("المتاح 3 والمطلوب 5");
    expect(appError({ ...VALID, doThis: "راجع الفرع ٢" }).doThis).toBe("راجع الفرع 2");
  });

  it("⭐ رقمٌ هنديّ في بياناتِ مستخدمٍ لا يقلب الرفض إلى خطأ خادم", () => {
    // العطبُ الذي أمسكته المراجعة العدائية: الرمي هنا يقع **داخل مسار بناء رسالة الرفض**،
    // وأجزاؤها تُستوفى من بيانات المستخدم. فمورّدٌ اسمه «مكتبة ١٢٣» كان يحوّل رفضاً
    // عملياً نظيفاً إلى 500 **ويُضيّع سببَ الرفض الأصليّ** — نقيضُ غرض هذا الملفّ.
    const err = appError({
      what: "تعذّر الصرف",
      why: "المورّد «مكتبة ١٢٣» بلا رصيد كافٍ",
      doThis: "أضِف رصيداً للمورّد ثمّ أعد المحاولة",
    });
    expect(err.why).toContain("مكتبة 123");
    expect(err.message).toContain("تعذّر الصرف");
  });

  it("الأرقام اللاتينية تمرّ — وهي الصيغة المطلوبة", () => {
    const err = appError({ ...VALID, why: "المتاح 3 والمطلوب 5" });
    expect(err.message).toContain("المتاح 3 والمطلوب 5");
  });

  // ═══ الجزء الرابع: زرٌّ يفعلها ═══════════════════════════════════════════════════════
  it("الزرّ يحمل تسميةً ووجهةً داخل النظام", () => {
    const err = appError({
      ...VALID,
      action: { label: "افتح وردية", href: "/shifts/new" },
    });
    expect(err.action).toEqual({ label: "افتح وردية", href: "/shifts/new" });
  });

  it("زرٌّ بلا وجهة مقبول — ينفّذه المستدعي (مودال) بدل التنقّل", () => {
    const err = appError({ ...VALID, action: { label: "افتح وردية" } });
    expect(err.action).toEqual({ label: "افتح وردية" });
    expect(err.action?.href).toBeUndefined();
  });

  it("وجهةٌ خارج النظام مرفوضة — زرّ الخطأ ينقل داخل التطبيق لا إلى الإنترنت", () => {
    expect(() =>
      appError({ ...VALID, action: { label: "افتح", href: "https://example.com" } }),
    ).toThrow(/مسار/);
    expect(() =>
      appError({ ...VALID, action: { label: "افتح", href: "shifts/new" } }),
    ).toThrow(/مسار/);
  });

  it("⭐ وجهةٌ بروتوكول-نسبيّة مرفوضة — «//» و«/\\» يقودان خارج النظام", () => {
    // `startsWith("/")` وحدها تمرّرهما، وكان الاختبار السابق يجرّب `https://` فقط ⇒ يمرّ
    // لسببٍ ناقص. هذه هي الحالة التي تُفلت من حارسٍ يبدو صحيحاً.
    for (const href of ["//evil.com", "/\\evil.com"]) {
      expect(() =>
        appError({ ...VALID, action: { label: "افتح", href } }),
      ).toThrow(/داخل النظام/);
    }
  });

  it("⭐ جزءٌ يصير فارغاً بعد قصّ الفواصل مرفوض — لا يمرّ «— . افعل»", () => {
    // الترتيب المعكوس (افحص ثمّ اقصّ) كان يُمرّر `why: "."` فتُبنى رسالةٌ بسببٍ فارغ.
    expect(() => appError({ ...VALID, why: "." })).toThrow(/مطلوب/);
    expect(() => appError({ ...VALID, what: "،" })).toThrow(/مطلوب/);
  });

  it("زرٌّ بلا تسمية مرفوض — زرٌّ صامت ليس إجراءً", () => {
    expect(() => appError({ ...VALID, action: { label: "  " } })).toThrow(/تسمية/);
  });

  it("الزرّ اختياريّ: الرسالة تقف على «ماذا تفعل الآن» وحده حين لا ناقلَ للبنية", () => {
    const err = appError(VALID);
    expect(err.action).toBeUndefined();
    expect(err.message).toContain(VALID.doThis);
  });

  // ═══ شكل الرسالة ════════════════════════════════════════════════════════════════════
  it("الرسالة سطرٌ واحد مهما تعدّدت أسطر القالب", () => {
    const err = appError({
      what: "تعذّر استلام البضاعة",
      why: `أمر الشراء يحمل ضريبة،
            والاستلام الحالي يدعم سياسة الضريبة الصفرية فقط`,
      doThis: "صفِّر الضريبة في أمر الشراء ثمّ أعد الاستلام",
    });
    expect(err.message).not.toContain("\n");
    expect(err.message).toContain("ضريبة، والاستلام الحالي");
  });

  it("لا تتضاعف علامة النهاية حين ينتهي «ماذا تفعل الآن» بها أصلاً", () => {
    expect(appError({ ...VALID, doThis: "افتح وردية جديدة." }).message).not.toContain("..");
    expect(appError({ ...VALID, doThis: "أيّ وردية؟" }).message).toContain("؟");
    // وتُضاف حين تغيب، كي لا تلتصق الرسالة بما يليها في التوست.
    expect(appError(VALID).message.endsWith(".")).toBe(true);
  });

  it("appErrorMessage هو نصّ appError نفسه — مسارٌ واحد لا صيغتان", () => {
    expect(appErrorMessage(VALID)).toBe(appError(VALID).message);
  });

  // ═══ المعيار: أفضل رسالةٍ في المستودع تُعبَّر بالعقد بلا خسارة ═══════════════════════
  it("رسالة مطابقة فاتورة المورّد تُبنى بالعقد كاملةً — الرقمان والفرق والسبب والمخرج", () => {
    const err = appError({
      what: "قيمة فاتورة المورّد (41.48 $) لا تطابق مجموع البنود (38.00 $)",
      why: "الفرق 3.48 $ ناقصٌ من البنود؛ السبب المعتاد بندٌ لم يُدخَل أو سعر وحدةٍ أقلّ مما في الفاتورة",
      doThis: "صحّح البند الناقص، أو وزّع الفرق على أسعار البنود من زرّ التوزيع",
      action: { label: "وزّع الفرق", href: "/purchases/new" },
    });
    // الأجزاء الثلاثة التي كانت الرسالةُ القديمة («لا يطابق مجموع البنود») تفتقدها:
    expect(err.message).toContain("41.48");
    expect(err.message).toContain("38.00");
    expect(err.message).toContain("3.48");
    expect(err.message).toContain("وزّع الفرق على أسعار البنود");
    expect(err.action?.label).toBe("وزّع الفرق");
  });

  it("رسالة GRNI — أسوأ رسالةٍ في المستودع — تكتسب مخرجاً بالعقد", () => {
    // الأصل: «GRNI الحالي يدعم سياسة الضريبة العراقية الصفرية فقط» — صحيحةٌ تماماً، والبضاعة
    // على الرصيف والسائق ينتظر، ولا سبيلَ فيها إلى معرفة الخطوة التالية.
    const err = appError({
      what: "تعذّر استلام بضاعة أمر الشراء",
      why: "الأمر يحمل ضريبة، ومسار الاستلام يدعم سياسة الضريبة العراقية الصفرية فقط",
      doThis: "صفِّر نسبة الضريبة في أمر الشراء وأعِد اعتماده ثمّ استلم البضاعة",
      action: { label: "افتح أمر الشراء", href: "/purchases" },
    });
    expect(err.doThis).toMatch(/صفِّر/);
    expect(err.message).toContain(err.doThis);
    expect(err.action?.href).toBe("/purchases");
  });
});
