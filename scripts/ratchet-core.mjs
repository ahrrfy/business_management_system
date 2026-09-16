/**
 * المِسنَنة التنازلية — النواة المشتركة لحرّاس خطوط الأساس.
 *
 * ⭐ المشكلة التي تغلقها (تشخيص ١/٩/٢٦):
 * كل حرّاس §٣.١ من نوع «خطّ أساسٍ **مجمَّد**»: يمنعون الانتهاك الجديد ولا يفرضون تخفيض
 * القائم. النتيجة الملموسة: `check:raw-tables` **أخضرُ** اليوم بينما ١١٢ ملفاً على جداول
 * خامّة، وسيبقى أخضرَ بعد سنة. الحارس يمنع التراجع ولا يُنتج تقدّماً — ولذلك ظلّت خمسة
 * مكوّنات موحّدة (FilterPanel · form/Field · SubmitButton · OperationActionCell ·
 * TableTotalsRow) **بصفر تبنٍّ** رغم وجود الحرّاس.
 *
 * ما تضيفه هذه النواة: الأساس **لا يجوز أن يرتفع عن `origin/main`**. أي:
 *   • فرعٌ يضيف انتهاكاً ⇒ يفشل (كما قبل).
 *   • فرعٌ يرفع خطّ الأساس ليمرّر انتهاكاً ⇒ **يفشل أيضاً** (كان يمرّ صامتاً).
 *   • فرعٌ يُرحّل ملفاً ⇒ يُطالَب بتنزيل الأساس فعلياً، ويُبلَّغ بالمقدار.
 * ⇒ الرقم يسير في اتّجاهٍ واحد: نزولاً. المنع والترحيل في آليةٍ واحدة.
 *
 * ⚠️ يلزم `git fetch origin main` أوّلاً وإلّا كانت الأرضية قديمة — وعندها تتخطّى المقارنةُ
 * بصمتٍ (تفشل مفتوحةً) بدل إنذارٍ كاذب، على نمط `check:migrations` القائم.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** يقرأ نسخة `origin/main` من ملفّ خطّ الأساس؛ `null` حين لا يكون المرجع محلياً. */
export function readBaselineFromMain(relativePath) {
  try {
    const raw = execFileSync("git", ["show", `origin/main:${relativePath}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(raw);
  } catch {
    return null; // لا origin/main محلياً، أو الملفّ جديدٌ لم يُدمج بعد.
  }
}

/**
 * يستخرج عدداً من قيمة أساسٍ خامّة. يدعم صيغتَين:
 *   • رقم (السائد) — يُعاد كما هو.
 *   • `{ onlyNew: string[], onlyEdit: string[] }` — لخطّ أساس تناظر النموذج (#958)،
 *     يُجمَع طولا المصفوفتَين. كان `Number({...}) || 0` = `NaN || 0` = 0 ⇒ ratchet يُبلغ
 *     زوراً بأنّ أساس main = 0 ويرفض أيّ فرع (مسك أثناء دمج #954 مع main بعد #958).
 */
function coerceCount(v) {
  if (typeof v === "number") return v;
  if (v && typeof v === "object") {
    const n = (Array.isArray(v.onlyNew) ? v.onlyNew.length : 0);
    const e = (Array.isArray(v.onlyEdit) ? v.onlyEdit.length : 0);
    return n + e;
  }
  return Number(v) || 0;
}

/** مجموع القيم في خريطة خطّ أساس `{ file: count }` (أو `{ file: {onlyNew,onlyEdit} }`). */
export function baselineTotal(baseline) {
  return Object.values(baseline ?? {}).reduce((sum, n) => sum + coerceCount(n), 0);
}

/**
 * يفرض أنّ خطّ الأساس المُلتزَم لم يرتفع عن `origin/main`.
 *
 * `renames`: خريطةٌ اختيارية `{ oldPath: newPath }` لملفّاتٍ نُقلت في هذا الفرع.
 * المقارنة بالمفتاح تعمى عن التسمية: ملفٌّ نُقل يبدو للحارس كـ«ملفٍّ جديدٍ برصيدٍ ٢٤»
 * وكـ«ملفٍّ اختفى» — فيبلّغ عن ارتفاعٍ زائفٍ لأنّ نظيرَه في `origin/main` تحت الاسم القديم.
 * تُنقَل قيمةُ `mainBaseline[oldPath]` إلى `mainBaseline[newPath]` قبل المقارنة، فيتّبعُ
 * تاريخُ الملفّ اسمَه الجديد. النقلُ الميكانيكيّ يمرّ؛ رفعُ الانتهاك الحقيقيّ يبقى ممنوعاً.
 *
 * @returns {{ ok: boolean, skipped: boolean, message: string, delta: number }}
 */
export function assertMonotonicDescent({ baselinePath, baseline, label, renames }) {
  const mainBaseline = readBaselineFromMain(baselinePath);
  if (!mainBaseline) {
    return {
      ok: true,
      skipped: true,
      delta: 0,
      message: `ℹ️  ${label}: تُخطّيت مقارنة المِسنَنة (لا origin/main محلياً). شغّل: git fetch origin main`,
    };
  }

  if (renames && typeof renames === "object") {
    for (const [oldPath, newPath] of Object.entries(renames)) {
      if (
        typeof newPath === "string" &&
        Object.prototype.hasOwnProperty.call(mainBaseline, oldPath) &&
        !Object.prototype.hasOwnProperty.call(mainBaseline, newPath)
      ) {
        mainBaseline[newPath] = mainBaseline[oldPath];
        delete mainBaseline[oldPath];
      }
    }
  }

  const before = baselineTotal(mainBaseline);
  const after = baselineTotal(baseline);
  const delta = after - before;

  /*
   * المقارنة **لكل ملفّ** لا للمجموع وحده (مراجعة Codex على PR #931، P2):
   * المجموع يسمح بنقل السماح بين الملفّات — تنظيفُ ملفٍّ بواحد ورفعُ آخر بواحد يُبقي
   * `delta === 0`، فيقبل الحارسُ الفرديّ الانتهاكَ الجديد لأنّه يطابق السماح المرفوع،
   * وتُلتَفّ المِسنَنة بينما هذه الدالّة تُبلّغ بالنجاح. المِسنَنة **لكل مفتاح**.
   */
  const risen = Object.keys(baseline).filter(
    (f) => coerceCount(baseline[f]) > coerceCount(mainBaseline[f]),
  );

  if (risen.length > 0) {
    const detail = risen
      .slice(0, 10)
      .map((f) => `   - ${f}: ${coerceCount(mainBaseline[f])} ← ${coerceCount(baseline[f])}`);
    return {
      ok: false,
      skipped: false,
      delta,
      message:
        `✗ ${label}: **ارتفع** خطّ الأساس في ${risen.length} ملفّ عن origin/main ` +
        `(المجموع ${before} ← ${after}).\n` +
        `  المِسنَنة تنازلية **لكل ملفّ**: لا يُرفَع سماحُ ملفٍّ ولو قابله تنظيفُ آخر.\n` +
        `${detail.join("\n")}\n` +
        (risen.length > 10 ? `   … و${risen.length - 10} غيرها\n` : "") +
        `  إن كان الانتهاك مقصوداً وضرورياً: رحّل الملفّ إلى المكوّن الموحّد بدل رفع الأساس.`,
    };
  }

  return {
    ok: true,
    skipped: false,
    delta,
    message:
      delta < 0
        ? `✓ ${label}: المِسنَنة نزلت ${Math.abs(delta)} عن origin/main (${before} ← ${after}). أحسنت.`
        : `✓ ${label}: المِسنَنة ثابتة عند ${after} (لا ارتفاع).`,
  };
}

/**
 * يبلّغ عن «التراخي» — فجوة بين الأساس المُلتزَم والقياس الفعليّ.
 * الملفّ الذي نظُف ولم يُحذف من الأساس يترك مساحةً لانتهاكٍ مستقبليّ يمرّ صامتاً.
 */
export function reportSlack({ baseline, actual, label, updateHint }) {
  const slack = [];
  for (const [file, allowed] of Object.entries(baseline ?? {})) {
    const now = Number(actual.get?.(file) ?? actual[file] ?? 0) || 0;
    const cap = Number(allowed) || 0;
    if (now < cap) slack.push({ file, cap, now });
  }
  if (!slack.length) return { total: 0, message: `✓ ${label}: لا تراخٍ — الأساس يطابق الواقع.` };
  const total = slack.reduce((sum, s) => sum + (s.cap - s.now), 0);
  return {
    total,
    message:
      `ℹ️  ${label}: تراخٍ ${total} في ${slack.length} ملف (الأساس أعلى من الواقع) — أنزِله:\n` +
      slack.slice(0, 12).map((s) => `   - ${s.file}: ${s.cap} ← ${s.now}`).join("\n") +
      (updateHint ? `\n   ${updateHint}` : ""),
  };
}

/** يقرأ خطّ أساسٍ من ملفّ JSON؛ كائنٌ فارغ حين لا يوجد. */
export function readBaselineFile(absolutePath) {
  return existsSync(absolutePath) ? JSON.parse(readFileSync(absolutePath, "utf8")) : {};
}
