/**
 * مِسبارٌ نصّيّ على `RecordForm.tsx` و`SaveBar.tsx` (م٦ ق٤) — يفحص العقودَ التي لو انحرفت لأعادت
 * العللَ التي صُمّم الغلافُ لإغلاقها. لا مكتبةَ تصيير في `test:unit` (env=node)، فالحراسة نصّية
 * على المصدر + محاكاةٌ نقيّة لتصنيف المآل.
 *
 *  · الغلافُ يربط `useUnsavedGuard` بحالة الاتّساخ **في وضعَي الإنشاء والتعديل** (لا في العرض).
 *  · **لا `<form onSubmit`**: ماسحُ الباركود يرسل Enter — `<form>` كان سيحفظ مع كلّ مسح.
 *  · النتيجةُ مُهيكَلة عبر `deriveSaveOutcome` وتُمرَّر إلى `SaveBar` (لا `notify.ok` أعمى).
 *  · `SaveBar` يعرض `outcome` عبر `SaveOutcomeNotice`، ويدمج `disabledReason` في الأسباب الظاهرة،
 *    ويمرّر `onCancel` إلى `useSaveShortcuts` (Esc).
 *  · وضعُ العرض يُصيّر الحقول داخل `fieldset disabled` بلا شريط حفظ.
 *  · لا `toLocaleString("ar-…")` — الأرقام لاتينية.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveSaveOutcome, type SaveOutcome } from "../saveOutcome";

const RECORD_FORM = readFileSync(new URL("../RecordForm.tsx", import.meta.url), "utf8");
const SAVE_BAR = readFileSync(new URL("../SaveBar.tsx", import.meta.url), "utf8");

/** الشيفرة بلا تعليقات — التوثيقُ يذكر `<form onSubmit>` نصّاً، والمِسبار يقيس الـJSX لا النثر. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const RECORD_FORM_CODE = stripComments(RECORD_FORM);

describe("RecordForm — عقودُ الغلاف الواحد", () => {
  it("يربط حارس فقد البيانات بالاتّساخ في الأوضاع القابلة للتعديل فقط", () => {
    expect(RECORD_FORM).toContain('const editable = mode !== "view";');
    expect(RECORD_FORM).toContain("useUnsavedGuard(editable && isDirty)");
  });

  it("لا <form onSubmit> — الحفظُ زرٌّ صريح أو Ctrl+S (ماسح الباركود يرسل Enter)", () => {
    expect(RECORD_FORM_CODE).not.toMatch(/<form\b/);
    expect(RECORD_FORM_CODE).not.toMatch(/onSubmit/);
    expect(RECORD_FORM_CODE).toContain("<SaveBar");
  });

  it("النتيجةُ مُهيكَلة وتُمرَّر إلى الشريط", () => {
    expect(RECORD_FORM).toContain("deriveSaveOutcome({ result, savedMessage })");
    expect(RECORD_FORM).toContain("deriveSaveOutcome({ error })");
    expect(RECORD_FORM).toContain("outcome={shown}");
    expect(RECORD_FORM).toContain("onOutcome?.(next)");
  });

  it("وضعُ العرض: الحقول معطَّلة داخل fieldset ولا شريط حفظ", () => {
    expect(RECORD_FORM).toContain("<fieldset disabled");
    expect(RECORD_FORM).toContain("{editable && (");
  });

  it("الأرقام لاتينية — لا توطين عربيّ للأرقام", () => {
    for (const src of [RECORD_FORM, SAVE_BAR]) {
      expect(src).not.toMatch(/toLocaleString\(["']ar-/);
      expect(src).not.toMatch(/Intl\.NumberFormat\(["']ar-(?!.*-nu-latn)/);
    }
  });
});

describe("SaveBar — النتيجة وسبب المنع وEsc", () => {
  it("يعرض النتيجة المُهيكَلة عبر SaveOutcomeNotice", () => {
    expect(SAVE_BAR).toContain("<SaveOutcomeNotice outcome={outcome} />");
    expect(SAVE_BAR).toContain("outcome?: SaveOutcome | null;");
  });

  it("سببُ المنع الخادميّ يُدمج في الأسباب الظاهرة (لا tooltip على زرٍّ معطَّل)", () => {
    expect(SAVE_BAR).toContain("for (const raw of [...(blockedBy ?? []), disabledReason])");
    expect(SAVE_BAR).toContain('"الحفظ متوقّف الآن"');
  });

  it("Esc يمرّ إلى useSaveShortcuts بلا مستمعٍ ثانٍ", () => {
    expect(SAVE_BAR).toMatch(/useSaveShortcuts\(\{\s*onSave: \(\) => run\("save", onSave\),\s*onCancel,\s*\}\)/);
  });
});

describe("تصنيفُ المآل داخل الغلاف — محاكاةٌ نقيّة لـclassify", () => {
  async function classify(handler: () => Promise<unknown>): Promise<SaveOutcome> {
    try {
      return deriveSaveOutcome({ result: await handler(), savedMessage: "تم حفظ المنتج", now: 1 });
    } catch (error) {
      return deriveSaveOutcome({ error, now: 1 });
    }
  }

  it("نجاحٌ ⇒ SAVED، طلبٌ معلّق ⇒ REQUESTED، رميٌ ⇒ FAILED — بلا أن يتسرّب الرمي إلى الشريط", async () => {
    expect((await classify(async () => ({ productId: 1 }))).status).toBe("SAVED");
    expect((await classify(async () => ({ controlRequestId: 9 }))).status).toBe("REQUESTED");
    const failed = await classify(async () => {
      throw new Error("تعذّر الحفظ — السبب. افعل كذا");
    });
    expect(failed).toEqual({ status: "FAILED", message: "تعذّر الحفظ — السبب. افعل كذا", at: 1 });
  });
});
