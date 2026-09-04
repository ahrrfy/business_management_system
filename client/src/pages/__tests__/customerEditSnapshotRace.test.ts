import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editSource = readFileSync(new URL("../CustomerEdit.tsx", import.meta.url), "utf8");

/**
 * ⚠️ لا مكتبةَ تصيير (`@testing-library/react`) في هذا المستودع (`vitest.unit.config.ts` بـenv=node)،
 * فالحراسة على شقّين:
 *
 *   ١) **محاكاةٌ نقيّة للسباق** — نمذجةُ الحلقة (لقطة → mutate → تعديلٌ إضافيّ → onSuccess) بدون React،
 *      تُثبت أنّ اللقطة المُلتقَطة **قبل** الاستدعاء تُحبَط بها التعديلاتُ اللاحقة (baseline ≠ current).
 *      قبل الإصلاح: قراءةُ اللقطة وقت الاستجابة تجعل baseline يبتلع التعديلات ⇒ isDirty=false زوراً.
 *
 *   ٢) **حرَسٌ نصّيٌّ على المصدر** — يمنع الرجوع البنيويّ إلى النمط الخطر:
 *      • لا `initialSnapshotRef.current = dirtySnapshot()` (يقرأ الحاليّ وقت الاستجابة).
 *      • `submit()` يلتقط `submittedSnapshot` **قبل** `update.mutate`، ويمرّره في `onSuccess` الخاصّ
 *        بذلك النداء (per-call options) لا في options المستوى.
 *
 * السببُ الجذريّ لبلاغ Codex #978 P2: TanStack Query يستبدل callbacks الطلبِ الجاري بأحدثِ ما يرَه
 * render، فقراءةُ `dirtySnapshot()` وقت وصول الاستجابة تلتقط تعديلاتٍ أُضيفت **بعد** إرسال الطلب.
 * السيناريو: عدِّل «الملاحظات» ⇒ اضغط حفظ ⇒ عدِّل «الهاتف» بينما الحفظ معلَّق ⇒ الاستجابة تصل ⇒
 * baseline يُصبح «ملاحظات+هاتف» بينما الخادم حفظ «ملاحظات» فقط ⇒ isDirty=false ⇒ يُغادر المستخدم
 * بلا تحذير ⇒ يُفقد تعديل «الهاتف» بصمت.
 */
describe("سباق baseline بين mutate و onSuccess (Codex #978 P2)", () => {
  // ═══════════════════════════════════════════════════════════════════════
  // (١) محاكاة السباق بلا React
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * نموذجٌ صغيرٌ لدورة الحفظ: لقطة → mutate → onSuccess.
   *
   * `captureAt`:
   *   - "submit"  ⇒ السلوك الصحيح (بعد الإصلاح): يلتقط اللقطة عند استدعاء mutate ويثبّتها بالإغلاق.
   *   - "success" ⇒ السلوك المعطوب (قبل الإصلاح): يقرأ اللقطة الحالية وقت وصول الاستجابة، فيبتلع
   *                 كلَّ تعديلٍ أُضيف بين الإرسال والاستجابة.
   */
  async function runSaveRace(captureAt: "submit" | "success"): Promise<{
    baselineAfterSave: string;
    currentAfterSave: string;
    isDirtyAfterSave: boolean;
  }> {
    let currentSnapshot = "A"; // الحالة الأولية بعد التحميل.
    let baseline = "A"; // baseline بعد التحميل الأوّليّ.

    // مؤجَّلٌ يمثّل mutation لم يُحسم بعد.
    let resolveMutation!: () => void;
    const mutationPromise = new Promise<void>((res) => {
      resolveMutation = res;
    });

    // === submit ===
    // اللقطةُ المُلتقَطة **الآن** — تُثبَّت بالإغلاق للـper-call onSuccess (السلوك الصحيح).
    const submittedSnapshot = currentSnapshot; // = "A"

    const onSuccess = () => {
      // captureAt=="submit"  ⇒ نقرأ الإغلاق (اللقطة وقت الإرسال) — لا يتأثّر بأيّ تعديلٍ لاحق.
      // captureAt=="success" ⇒ نقرأ `currentSnapshot` وقت وصول الاستجابة — يبتلع التعديلات.
      baseline = captureAt === "submit" ? submittedSnapshot : currentSnapshot;
    };

    // === بعد الإرسال وقبل الاستجابة: تعديلٌ إضافيّ يُضاف على النموذج ===
    currentSnapshot = "AB"; // المستخدم عدّل حقلاً آخر (B) والمكوّن أُعيد render.

    // === وصول الاستجابة ===
    resolveMutation();
    await mutationPromise;
    onSuccess();

    return {
      baselineAfterSave: baseline,
      currentAfterSave: currentSnapshot,
      isDirtyAfterSave: baseline !== currentSnapshot,
    };
  }

  it("قبل الإصلاح: قراءةُ اللقطة وقت الاستجابة تبتلع التعديل الإضافيّ (isDirty=false زوراً)", async () => {
    const result = await runSaveRace("success");
    expect(result.currentAfterSave).toBe("AB"); // المستخدم يرى «A+B»…
    expect(result.baselineAfterSave).toBe("AB"); // …لكنّ baseline يبتلعها…
    expect(result.isDirtyAfterSave).toBe(false); // …فيصير حارس فقد البيانات صامتاً ⇒ يُفقد B.
  });

  it("بعد الإصلاح: اللقطةُ المُلتقَطة قبل mutate تحمي التعديلَ اللاحق (isDirty=true)", async () => {
    const result = await runSaveRace("submit");
    expect(result.baselineAfterSave).toBe("A"); // baseline = ما أُرسل فعلاً.
    expect(result.currentAfterSave).toBe("AB"); // النموذج يحمل تعديلاً غير محفوظ.
    expect(result.isDirtyAfterSave).toBe(true); // ⇒ حارس فقد البيانات يشتغل ويحذّر عند المغادرة.
  });

  // ═══════════════════════════════════════════════════════════════════════
  // (٢) حراسة المصدر — تمنع رجوعاً بنيوياً للنمط الخطر
  // ═══════════════════════════════════════════════════════════════════════

  it("⛔ لا يقرأ `dirtySnapshot()` وقت الاستجابة (يبتلع تعديلاتٍ لم تُرسَل)", () => {
    // النمطُ الخطر: `initialSnapshotRef.current = dirtySnapshot();` **داخل** onSuccess (مستوى
    // useMutation أو per-call) ⇒ يقرأ الحالة الحاليّة (بعد التعديل الإضافيّ) لا ما أُرسل.
    // (الاستعمالُ في التأثير الأوّليّ عند التحميل — `useEffect` قبل الـmutation — مشروع.)
    const onSuccessBlocks = [...editSource.matchAll(/onSuccess:\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{([\s\S]*?)\n(?:\s{2,}|\t+)\}/g)];
    for (const [, body] of onSuccessBlocks) {
      expect(body).not.toMatch(/initialSnapshotRef\.current\s*=\s*dirtySnapshot\(\)/);
    }
    // ولا يمرُّ النمطُ نصّياً في أيّ قربٍ من `notify.ok("تمّ حفظ التعديلات")` (بصمة onSuccess القديم).
    const saveOkIdx = editSource.indexOf('notify.ok("تمّ حفظ التعديلات")');
    expect(saveOkIdx).toBeGreaterThan(-1);
    const windowAround = editSource.slice(Math.max(0, saveOkIdx - 200), saveOkIdx + 600);
    expect(windowAround).not.toMatch(/initialSnapshotRef\.current\s*=\s*dirtySnapshot\(\)/);
  });

  it("⭐ يلتقط `submittedSnapshot` قبل استدعاء `update.mutate`", () => {
    // اللقطةُ متغيّرٌ محلّيٌّ في `submit`، مُلتقَطٌ بالإغلاق ⇒ لا يتغيّر عند render لاحق.
    expect(editSource).toContain("const submittedSnapshot = dirtySnapshot();");
    // الترتيبُ إلزاميّ: اللقطةُ قبل النداء (وإلّا لا فرقَ عن قراءتها في onSuccess).
    const snapshotIdx = editSource.indexOf("const submittedSnapshot = dirtySnapshot();");
    const mutateIdx = editSource.indexOf("update.mutate(", snapshotIdx);
    expect(snapshotIdx).toBeGreaterThan(-1);
    expect(mutateIdx).toBeGreaterThan(snapshotIdx);
  });

  it("⭐ يمرّر onSuccess **في options النداء** ويعيّن baseline إلى اللقطة المُلتقَطة", () => {
    // per-call onSuccess: أرغُمنتٌ ثانٍ لـ`mutate` (لا options المستوى الذي يُستبدَل بأحدث render).
    expect(editSource).toMatch(/update\.mutate\(\s*\{[\s\S]*?\},\s*\{[\s\S]*?onSuccess:/);
    // baseline = `submittedSnapshot` (اللقطة المُلتقَطة) لا `dirtySnapshot()` (الحاليّ).
    expect(editSource).toContain("initialSnapshotRef.current = submittedSnapshot;");
  });

  it("⛔ يبقي `onError` على options المستوى بلا مسّ baseline (فشلُ الحفظ ⇒ الحقول تبقى dirty)", () => {
    // الفشل يجب ألّا يمسّ baseline: الحقول تبقى dirty ويظهر الحوار عند المغادرة.
    expect(editSource).toMatch(/useMutation\(\{\s*onError:/);
    // لا onSuccess على options المستوى (يُستبدَل بأحدث render — العلّة الأصليّة).
    const mutationBlockMatch = editSource.match(
      /trpc\.customers\.update\.useMutation\(\{[\s\S]*?\}\);/,
    );
    expect(mutationBlockMatch).toBeTruthy();
    expect(mutationBlockMatch![0]).not.toMatch(/onSuccess\s*:/);
  });
});
