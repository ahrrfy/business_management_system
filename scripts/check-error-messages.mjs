#!/usr/bin/env node
/**
 * حارس «الرسالة تقول ماذا تفعل» — عدّادُ رسائل `TRPCError` التي **لا تمرّ بعقد** `appErrorMessage`.
 *
 * السبب: `shared/errors.ts` ثبّت عقداً رباعياً (ماذا حدث · لماذا · **ماذا تفعل الآن** · زرّ)،
 * وجذرُه المكتوب هناك أنّ «أغلب رسائل النظام اليوم تقول ① و② وتقف، فيقف الموظّف معها».
 * لكنّ العقد بلا مقياس يبقى **نيّةً**: لا أحد يعرف كم رسالةً تحوّلت ولا أيّ ملفّ أثقلُ ديناً،
 * فيصير كلّ ادّعاء «حسّنّا الرسائل» غيرَ قابلٍ للتكذيب. هذا الملفّ يجعله رقماً ينزل.
 *
 * ══════════════════════════ ما يقيسه — وما لا يقيسه ══════════════════════════
 *
 * ⚠️ **يقيس المرور بالعقد من عدمه. لا شيءَ غير ذلك.**
 *
 * هو **لا يستطيع** — ولا يدّعي — الحكم على جودة نصٍّ عربيّ: لا يعرف أنّ «ماذا تفعل» مخرجٌ
 * عمليّ حقيقيّ لا إعادةَ صياغةٍ للسبب، ولا أنّ الأرقام في مكانها، ولا أنّ العبارة يفهمها
 * كاشيرٌ في الساعة الثامنة صباحاً. الذي يحرس ذلك هو `appError` نفسها في وقت التشغيل
 * (ترفض الجزء الفارغ، وترفض `doThis` المطابق لـ`why`)، لا هذا السكربت.
 *
 * ⇒ ولذلك **سيُعَدّ نصٌّ عربيٌّ ممتازٌ لم يُحوَّل بعد**، وهذا مقصود لا عطب: العدد يقيس
 *   الترحيل، لا الأسلوب. ومن يقرأ الرقم على أنّه «عددُ الرسائل السيّئة» يقرأ ما لا يقوله.
 *   لهذا يعمل بوضع التقرير أوّلاً (`--report`) ولا يحجب حتى يُشدَّد عمداً — حارسٌ يُنذر
 *   كذباً يُتجاوَز فيصير مسرحياً (CLAUDE.md §٤-ج).
 *
 * وشيئان خارج العدّ صراحةً، يُطبَعان في اللوحة بسطرَيهما كي يبقيا مرئيَّين لا مطموسَين:
 *   • **غير مقيس** — رسالةٌ من متغيّرٍ أو مساعد (`message: toArabicMessage(e)`، `message: err.message`،
 *     واختصارُ الخاصّية `{ code, message }`). لا يعرف السكربت ما بداخلها، فلا يعدّها ولا يبرّئها.
 *   • **خارج التعريف** — موضعٌ بلا `message` أصلاً (`{ code: "FORBIDDEN" }`)، فيصل الموظّفَ اسمُ
 *     الرمز لاتينياً. هذا **أسوأُ** من رسالةٍ صمّاء لا أهون، لكنّه ليس «نصّاً حرفيّاً» فلا يدخل
 *     مقياساً عرّفناه بالنصّ الحرفيّ. يُعرَض برقمه ليُعالَج بشريحته، ولا يُخبَّأ في الإجمالي.
 *
 * ══════════════════════════ المستثنيات وأدلّتها ══════════════════════════
 *
 * ① **`code: "INTERNAL_SERVER_ERROR"`** — خطأُ برمجةٍ أو بنيةٍ لا قرارَ للموظّف فيه.
 *    الدليل من الشيفرة نفسها: «تصنيف استثناء صرف الخزينة غير معروف»
 *    (`cash/cashAvailability.ts`) و«سجل حالة فرق النقد غير مكتمل» (`cashVarianceService.ts`)
 *    و«تعذّر تحديد متغيّر البكج بعد الإنشاء» (`catalog/productCreate.ts`) — ثوابتُ منطقٍ
 *    مكسورة، لا شيءَ يفعله الكاشير حيالها. وفرضُ `doThis` عليها يُنتج «اتصل بالدعم» مكرّرةً
 *    في ١٥١ موضعاً: طقسٌ بلا قيمة يُعلّم الناس أنّ العقد شكليّ.
 *    ⚠️ **وثمنُ هذا الاستثناء مذكورٌ صراحةً:** رسالةٌ تخصّ المستخدم رُمِزت خطأً بهذا الرمز
 *    تختبئ فيه (مثالٌ حيّ: «قاعدة البيانات غير متاحة»). ولو صار الرمزُ مهرباً — بتحويل
 *    `BAD_REQUEST` إليه هرباً من العدّ — فذاك تغييرٌ في دلالة HTTP يراه أيُّ مراجع.
 *
 * ② **الاختبارات** — مستبعَدةٌ آلياً: المشّاء يتخطّى مجلّدات `__tests__` وكلَّ `*.test.ts`
 *    (ومنها `server/logger.test.ts` و`server/sentry.test.ts` خارج تلك المجلّدات).
 *
 * ③ **سكربتات الصيانة والبذر** — لا قاعدةَ لها لأنّها **قيست بصفر**: `server/seed.ts`
 *    و`server/seedPrintPos.ts` لا يحويان `new TRPCError` إطلاقاً (لا سياق tRPC فيهما أصلاً)،
 *    و`scripts/**` خارج نطاق المسح كلّه. ولم تُكتب قاعدةٌ لِما لا يقع: استثناءٌ لا يُطابق
 *    شيئاً شيفرةٌ ميتةٌ تُوحي بتغطيةٍ غير موجودة.
 *
 * ══════════════════════════ كيف يقرّر ══════════════════════════
 *
 * يُقنَّع المصدر أوّلاً (`maskSource`): التعليقات تصير فراغاً، ومحتوى النصوص والتعابير
 * النمطية يصير حشواً مع **إبقاء محدّداتها**. فيصير الفرزُ بنيوياً لا نصّياً:
 *   • `new TRPCError` داخل تعليقٍ أو نصّ لا يُعَدّ (اختُبر ذاتياً).
 *   • قيمة `message` تُقرأ من العمق الصحيح داخل الكائن، لا بمطابقةٍ عمياء.
 * ثمّ تُصنَّف قيمةُ `message` بأربعة فروعٍ لكلٍّ منها سبب:
 *   ١) تحوي `appErrorMessage(` أو `appError(`      ⇒ **مارّةٌ بالعقد**.
 *   ٢) فيها محدّدُ نصٍّ على **عمقها هي**            ⇒ **صمّاء** (يشمل `شرط ? "أ" : "ب"` والوصل).
 *   ٣) اسمٌ مجرَّد يُحلّ في الملفّ نفسه إلى نصٍّ حرفيّ ⇒ **صمّاء** (يسدّ مهرب رفع النصّ إلى ثابت).
 *   ٤) ما عدا ذلك                                   ⇒ **غير مقيس** (لا يُعَدّ ولا يُدَّعى).
 * والمحدّدُ داخل قوسَي نداءٍ (`helper("x")`) **ليس** على العمق صفر ⇒ لا يُعَدّ صمّاء: قد يكون
 * المساعد نفسه هو من يستدعي العقد، فعدُّه إنذارٌ كاذبٌ لا يستطيع مؤلّفُه إسكاته.
 *
 * المِسنَنة **تنازلية** (scripts/ratchet-core.mjs): الأساس يُخفَّض أو يبقى، ولا يُرفَع أبداً.
 * التحديث بعد الترحيل: node scripts/check-error-messages.mjs --update-baseline
 * التقرير وحده (بلا حجب):  node scripts/check-error-messages.mjs --report
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMonotonicDescent, readBaselineFile } from "./ratchet-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BASELINE_PATH = path.join(__dirname, "error-messages-baseline.json");
const BASELINE_REL = "scripts/error-messages-baseline.json";

const UPDATE = process.argv.includes("--update-baseline");
const SELFTEST_ONLY = process.argv.includes("--selftest");
/** وضعُ التقرير: يطبع اللوحة ويخرج بـ0 دائماً. يُستعمل قبل التشديد. */
const REPORT_ONLY = process.argv.includes("--report");

/** نطاق المسح: الخادم وحده — العقد خادميّ، والشاشة تعرض ما يصلها. */
const SCAN_ROOT = "server";
/** رمزٌ لا قرارَ للموظّف فيه (انظر «المستثنيات» في الرأس). */
const EXCLUDED_CODE = "INTERNAL_SERVER_ERROR";
/** بوّابةُ العقد — المرور بها هو كلُّ ما يقيسه هذا الحارس. */
const CONTRACT_CALLS = ["appErrorMessage(", "appError("];

// ───────────────────────────── التقنيع ─────────────────────────────

/** محرفُ الحشو: يملأ محتوى النصوص فلا يُربك موازنةَ الأقواس ولا يُقرأ نصّاً. */
const FILL = "\u0001";

/** محارفُ تسبق «/» فتجعلها بدايةَ تعبيرٍ نمطيّ لا قسمة. */
const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%~^<>".split(""));
/** كلماتٌ مفتاحية بعدها «/» بدايةُ تعبيرٍ نمطيّ. */
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "case", "in", "of", "delete", "void",
  "instanceof", "new", "do", "else", "yield", "await",
]);

/**
 * يُقنّع المصدر مع **حفظ الأطوال وأرقام الأسطر**: التعليقات فراغاً، ومحتوى النصوص
 * والتعابير النمطية حشواً، مع إبقاء المحدّدات (`"` `'` `` ` `` `/`) و`${ }` ظاهرةً.
 *
 * ⚠️ حفظُ الطول شرطٌ لا زينة: كلُّ الإزاحات تُقرأ من المُقنَّع وتُقتطع من الأصل.
 * ⚠️ والتعابير النمطية تُقنَّع لأنّ `/["']/` بغير ذلك يقلب الماسح إلى وضع نصٍّ فيبتلع
 *    بقيّة الملفّ صامتاً — عطبٌ لا يُنتج خطأً بل رقماً خاطئاً، وهو أسوأ.
 */
export function maskSource(source) {
  const out = source.split("");
  const n = source.length;
  let mode = "code";
  let braceDepth = 0;
  /** أعماقُ القوالب المتداخلة: نعود إلى `tpl` عند `}` المقابلة لـ`${`. */
  const templateStack = [];
  let i = 0;

  /** آخرُ محرفٍ ذي معنى قبل `at` (لتمييز التعبير النمطيّ عن القسمة). */
  const previousSignificant = (at) => {
    let j = at - 1;
    while (j >= 0 && /\s/.test(source[j])) j -= 1;
    return j >= 0 ? { char: source[j], at: j } : null;
  };

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];

    if (mode === "code") {
      if (c === "/" && d === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        mode = "line";
        i += 2;
        continue;
      }
      if (c === "/" && d === "*") {
        out[i] = " ";
        out[i + 1] = " ";
        mode = "block";
        i += 2;
        continue;
      }
      if (c === "/") {
        const prev = previousSignificant(i);
        let isRegex = prev === null || REGEX_PRECEDERS.has(prev.char);
        if (!isRegex && /\w/.test(prev.char)) {
          const word = /[A-Za-z_$][\w$]*$/.exec(source.slice(0, prev.at + 1));
          isRegex = word !== null && REGEX_KEYWORDS.has(word[0]);
        }
        if (isRegex) {
          i = maskRegexLiteral(source, out, i);
          continue;
        }
        i += 1;
        continue;
      }
      if (c === "'" || c === '"') {
        mode = c === "'" ? "sq" : "dq";
        i += 1;
        continue;
      }
      if (c === "`") {
        mode = "tpl";
        i += 1;
        continue;
      }
      if (c === "{") braceDepth += 1;
      else if (c === "}") {
        if (braceDepth === 0 && templateStack.length > 0) {
          braceDepth = templateStack.pop();
          mode = "tpl";
          i += 1;
          continue;
        }
        braceDepth -= 1;
      }
      i += 1;
      continue;
    }

    if (mode === "line") {
      if (c === "\n") mode = "code";
      else out[i] = " ";
      i += 1;
      continue;
    }

    if (mode === "block") {
      if (c === "*" && d === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        mode = "code";
        i += 2;
        continue;
      }
      if (c !== "\n") out[i] = " ";
      i += 1;
      continue;
    }

    if (mode === "sq" || mode === "dq") {
      const quote = mode === "sq" ? "'" : '"';
      if (c === "\\") {
        out[i] = FILL;
        if (i + 1 < n && source[i + 1] !== "\n") out[i + 1] = FILL;
        i += 2;
        continue;
      }
      if (c === quote) {
        mode = "code";
        i += 1;
        continue;
      }
      if (c !== "\n") out[i] = FILL;
      i += 1;
      continue;
    }

    // mode === "tpl"
    if (c === "\\") {
      out[i] = FILL;
      if (i + 1 < n && source[i + 1] !== "\n") out[i + 1] = FILL;
      i += 2;
      continue;
    }
    if (c === "`") {
      mode = "code";
      i += 1;
      continue;
    }
    if (c === "$" && d === "{") {
      templateStack.push(braceDepth);
      braceDepth = 0;
      mode = "code";
      i += 2; // `${` تبقى ظاهرةً كي تتوازن الأقواس
      continue;
    }
    if (c !== "\n") out[i] = FILL;
    i += 1;
  }

  return out.join("");
}

/** يُقنّع جسم تعبيرٍ نمطيّ يبدأ عند `start` («/»)، ويُعيد الإزاحة بعده. */
function maskRegexLiteral(source, out, start) {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const c = source[i];
    if (c === "\n") break; // تعبيرٌ نمطيّ لا يعبر السطر ⇒ كانت قسمةً؛ نتوقّف بأمان
    if (c === "\\") {
      out[i] = FILL;
      if (i + 1 < source.length) out[i + 1] = FILL;
      i += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1;
    out[i] = FILL;
    i += 1;
  }
  return i;
}

// ───────────────────────── أدواتُ قراءة المُقنَّع ─────────────────────────

const OPENERS = "({[";
const CLOSERS = ")}]";

/** خريطةُ العمق لكلّ إزاحة (العمق **قبل** المحرف). */
function depthMap(masked) {
  const depths = new Int32Array(masked.length);
  let depth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    depths[i] = depth;
    const c = masked[i];
    if (OPENERS.includes(c)) depth += 1;
    else if (CLOSERS.includes(c)) depth -= 1;
  }
  return depths;
}

/** إزاحةُ القوس المقابل لِـ`open`، أو `-1`. */
function matchDelimiter(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i];
    if (OPENERS.includes(c)) depth += 1;
    else if (CLOSERS.includes(c)) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** رقمُ السطر (1-based) عند إزاحةٍ ما. */
function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

/**
 * قيمةُ خاصّيةٍ على العمق المطلوب داخل نصٍّ مُقنَّع.
 * @returns {{ start: number, end: number } | null} إزاحاتٌ نسبيّةٌ إلى `masked`.
 */
function findPropertyValue(masked, depths, name, wantedDepth) {
  const re = new RegExp(`(^|[^\\w$.])${name}\\s*:`, "g");
  let m;
  while ((m = re.exec(masked)) !== null) {
    const keyAt = m.index + m[1].length;
    if (depths[keyAt] !== wantedDepth) continue;
    let start = m.index + m[0].length;
    while (start < masked.length && /\s/.test(masked[start])) start += 1;
    let end = start;
    while (end < masked.length) {
      const c = masked[end];
      // ⚠️ `depths[i]` هو العمق **قبل** المحرف: عند `}` الخاتمة يكون العمق ما زال 1، فشرطُ
      // «العمق أقلّ» لا يقف عندها فتُبتلع `});` داخل القيمة — وهو ما جعل الاسم المجرَّد
      // (`message: FORBIDDEN_MSG`) يفشل في المطابقة فيُصنَّف «غير مقيس» بدل «صمّاء».
      if (CLOSERS.includes(c) && depths[end] <= wantedDepth) break;
      if (c === "," && depths[end] === wantedDepth) break;
      end += 1;
    }
    return { start, end };
  }
  return null;
}

/**
 * هل الخاصّية مكتوبةٌ باختصارها (`{ code, message }`)؟
 * قيمتُها متغيّرٌ دائماً ⇒ **غير مقيسة** لا «بلا message»: الخلط بينهما يجعل اللوحة تدّعي
 * أنّ الموضع يُرمى بالرمز وحده، وهو يحمل رسالةً لا نعرف مصدرها.
 */
function hasShorthandProperty(masked, depths, name, wantedDepth) {
  const re = new RegExp(`(^|[{,])\\s*${name}\\s*(?=[,}])`, "g");
  let m;
  while ((m = re.exec(masked)) !== null) {
    const keyAt = m.index + m[0].length - name.length;
    if (depths[keyAt] === wantedDepth) return true;
  }
  return false;
}

/** هل في التعبير محدّدُ نصٍّ على **عمقه هو** (لا داخل قوسَي نداء)؟ */
export function hasTopLevelLiteral(expressionMasked) {
  let depth = 0;
  for (const c of expressionMasked) {
    if (OPENERS.includes(c)) depth += 1;
    else if (CLOSERS.includes(c)) depth -= 1;
    else if (depth === 0 && (c === '"' || c === "'" || c === "`")) return true;
  }
  return false;
}

/**
 * ثوابتُ الملفّ التي قيمتها نصٌّ حرفيّ — تسدّ مهرب «ارفع النصّ إلى ثابتٍ ينجو من العدّ».
 * قفزةٌ واحدة وفي الملفّ نفسه عمداً: تتبّعُ الاستيرادات يحتاج محلّل وحداتٍ كاملاً، وحارسٌ
 * نصفُ محلّلٍ يُخطئ في الاتّجاهين.
 */
export function localLiteralConstants(masked) {
  const found = new Set();
  const re = /(^|[^\w$.])const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(["'`])/g;
  let m;
  while ((m = re.exec(masked)) !== null) found.add(m[2]);
  return found;
}

// ───────────────────────── الفرز (دالّةٌ نقيّة) ─────────────────────────

/** الأصناف الأربعة. `LITERAL` وحدها تُعَدّ (بعد استبعاد الرمز الداخليّ). */
export const KIND = {
  CONTRACT: "CONTRACT",
  LITERAL: "LITERAL",
  INDIRECT: "INDIRECT",
  NONE: "NONE",
};

/**
 * يفرز كلّ مواضع `new TRPCError` في مصدرٍ واحد.
 * @returns {{ line: number, code: string | null, kind: string, excluded: boolean }[]}
 */
export function classifyTrpcErrorSites(source) {
  const masked = maskSource(source);
  const constants = localLiteralConstants(masked);
  const sites = [];
  const token = "new TRPCError";
  let from = 0;

  for (;;) {
    const at = masked.indexOf(token, from);
    if (at < 0) break;
    from = at + token.length;
    // حدودُ الرمز: `newTRPCErrorX` أو `x.new TRPCError` ليسا نداءً لهذا الصنف.
    if (at > 0 && /[\w$.]/.test(masked[at - 1])) continue;
    if (/[\w$]/.test(masked[from] ?? "")) continue;

    const open = masked.indexOf("(", from);
    if (open < 0) break;
    if (masked.slice(from, open).trim() !== "") continue;
    const close = matchDelimiter(masked, open);
    if (close < 0) continue;

    const argsMasked = masked.slice(open + 1, close);
    const argsRaw = source.slice(open + 1, close);
    const depths = depthMap(argsMasked);

    const codeSlot = findPropertyValue(argsMasked, depths, "code", 1);
    let code = null;
    if (codeSlot) {
      const rawCode = argsRaw.slice(codeSlot.start, codeSlot.end).trim();
      const quoted = /^(["'`])([A-Z_]+)\1$/.exec(rawCode);
      if (quoted) code = quoted[2];
    }

    const messageSlot = findPropertyValue(argsMasked, depths, "message", 1);
    let kind = KIND.NONE;
    if (messageSlot) {
      const valueMasked = argsMasked.slice(messageSlot.start, messageSlot.end).trim();
      const valueRaw = argsRaw.slice(messageSlot.start, messageSlot.end).trim();
      if (CONTRACT_CALLS.some((call) => valueRaw.includes(call))) kind = KIND.CONTRACT;
      else if (hasTopLevelLiteral(valueMasked)) kind = KIND.LITERAL;
      else if (/^[A-Za-z_$][\w$]*$/.test(valueMasked) && constants.has(valueMasked)) {
        kind = KIND.LITERAL;
      } else kind = KIND.INDIRECT;
    } else if (hasShorthandProperty(argsMasked, depths, "message", 1)) {
      kind = KIND.INDIRECT;
    }

    sites.push({ line: lineAt(source, at), code, kind, excluded: code === EXCLUDED_CODE });
  }

  return sites;
}

/** ملخّصُ ملفٍّ واحد: `deaf` هو الرقم الذي يدخل خطّ الأساس. */
export function analyzeSource(source) {
  const sites = classifyTrpcErrorSites(source);
  const summary = { total: sites.length, deaf: 0, contract: 0, indirect: 0, none: 0, excluded: 0 };
  for (const site of sites) {
    if (site.excluded) {
      summary.excluded += 1;
      continue;
    }
    if (site.kind === KIND.LITERAL) summary.deaf += 1;
    else if (site.kind === KIND.CONTRACT) summary.contract += 1;
    else if (site.kind === KIND.INDIRECT) summary.indirect += 1;
    else summary.none += 1;
  }
  return { sites, summary };
}

// ───────────────────────────── جمع القياس ─────────────────────────────

const SKIP_DIRS = new Set(["__tests__", "node_modules", "_legacy", "dist", ".git", "coverage"]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile() && /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      yield full;
    }
  }
}

const relOf = (full) => path.relative(REPO_ROOT, full).replace(/\\/g, "/");

function collect() {
  /** @type {Map<string, number>} مسارُ الملفّ ⇒ عددُ الرسائل الصمّاء. */
  const current = new Map();
  const totals = { files: 0, sites: 0, deaf: 0, contract: 0, indirect: 0, none: 0, excluded: 0 };

  for (const file of walk(path.join(REPO_ROOT, SCAN_ROOT))) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("new TRPCError")) continue;
    const { summary } = analyzeSource(source);
    if (summary.total === 0) continue;
    totals.files += 1;
    totals.sites += summary.total;
    totals.deaf += summary.deaf;
    totals.contract += summary.contract;
    totals.indirect += summary.indirect;
    totals.none += summary.none;
    totals.excluded += summary.excluded;
    if (summary.deaf > 0) current.set(relOf(file), summary.deaf);
  }

  return { current, totals };
}

function printDashboard(totals, current) {
  const pass = totals.contract + totals.deaf;
  const share = pass > 0 ? Math.round((totals.contract / pass) * 100) : 0;
  console.log("\n  رسائلُ TRPCError في server/** (بلا اختبارات)");
  console.log("  " + "─".repeat(66));
  console.log(`  المواضع كلّها                     ${String(totals.sites).padStart(6)}  في ${totals.files} ملفّاً`);
  console.log(`  مارّةٌ بعقد appErrorMessage        ${String(totals.contract).padStart(6)}`);
  console.log(`  ✗ صمّاء (نصٌّ حرفيّ بلا عقد)        ${String(totals.deaf).padStart(6)}  في ${current.size} ملفّاً ← المقياس`);
  console.log("  " + "─".repeat(66));
  console.log(`  مستثنى: ${EXCLUDED_CODE}    ${String(totals.excluded).padStart(6)}  خطأُ برمجةٍ لا قرارَ للموظّف فيه`);
  console.log(`  غير مقيس: رسالةٌ من متغيّرٍ أو مساعد ${String(totals.indirect).padStart(6)}  لا يعرف السكربت ما بداخلها`);
  console.log(`  خارج التعريف: رمزٌ عارٍ بلا message ${String(totals.none).padStart(6)}  يصل الموظّفَ اسمُ الرمز لاتينياً`);
  console.log("  " + "─".repeat(66));
  console.log(`  نسبةُ المرور بالعقد: ${share}%  (${totals.contract} من ${pass})\n`);
}

function printWorst(current, limit = 10) {
  const worst = [...current.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (worst.length === 0) return;
  console.log(`  أثقلُ ${worst.length} ملفّاتٍ ديناً:`);
  for (const [file, count] of worst) console.log(`   ${String(count).padStart(4)}  ${file}`);
  console.log("");
}

// ───────────────────────────── الاختبار الذاتيّ ─────────────────────────────

function runSelfTest({ quiet }) {
  const fails = [];
  const eq = (name, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fails.push(`${name}: توقّعنا ${JSON.stringify(want)} فجاء ${JSON.stringify(got)}`);
    }
  };
  const kinds = (src) => classifyTrpcErrorSites(src).map((s) => s.kind);
  const deaf = (src) => analyzeSource(src).summary.deaf;

  // ── التقنيع
  eq("التقنيع يُبقي الطول", maskSource('const a = "xy"; // z').length, 'const a = "xy"; // z'.length);
  eq(
    "التقنيع يُبقي أرقام الأسطر",
    maskSource("/* أ\nب */\nx").split("\n").length,
    3,
  );
  eq(
    "التقنيع لا ينكسر على تعبيرٍ نمطيّ فيه علامةُ اقتباس",
    hasTopLevelLiteral(maskSource('const re = /["\']/g; const v = x;').slice(19)),
    false,
  );
  eq(
    "التقنيع يُبقي شيفرة ${} ظاهرةً",
    maskSource("`أ ${obj.name} ب`").includes("obj.name"),
    true,
  );

  // ── ما لا يُعَدّ أصلاً
  eq(
    "موضعٌ داخل تعليقٍ لا يُعَدّ",
    kinds('// throw new TRPCError({ code: "BAD_REQUEST", message: "س" });'),
    [],
  );
  eq(
    "موضعٌ داخل نصٍّ لا يُعَدّ",
    kinds('const doc = "new TRPCError({ message: \'س\' })";'),
    [],
  );

  // ── الأصناف الأربعة
  eq(
    "النصّ الحرفيّ صمّاء",
    kinds('throw new TRPCError({ code: "BAD_REQUEST", message: "لا فرع مُسنَد" });'),
    [KIND.LITERAL],
  );
  eq(
    "القالب النصّيّ صمّاء",
    kinds("throw new TRPCError({ code: \"CONFLICT\", message: `الكمية ${n} غير كافية` });"),
    [KIND.LITERAL],
  );
  eq(
    "الشرطيّ بين نصّين صمّاء",
    kinds('throw new TRPCError({ code: "FORBIDDEN", message: isX ? "أ" : "ب" });'),
    [KIND.LITERAL],
  );
  eq(
    "الوصل بنصٍّ صمّاء",
    kinds('throw new TRPCError({ code: "FORBIDDEN", message: "أ " + reason });'),
    [KIND.LITERAL],
  );
  eq(
    "المارّة بالعقد ليست صمّاء",
    kinds(
      'throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "أ", why: "ب", doThis: "ج" }) });',
    ),
    [KIND.CONTRACT],
  );
  eq(
    "نداءُ مساعدٍ غيرُ مقيس لا صمّاء",
    kinds('throw new TRPCError({ code: "CONFLICT", message: toArabicMessage(e, "أ") });'),
    [KIND.INDIRECT],
  );
  eq(
    "قيمةٌ غيرُ حرفيّةٍ غيرُ مقيسة",
    kinds('throw new TRPCError({ code: "CONFLICT", message: error.message });'),
    [KIND.INDIRECT],
  );
  eq(
    "موضعٌ بلا message",
    kinds('throw new TRPCError({ code: "FORBIDDEN" });'),
    [KIND.NONE],
  );
  eq(
    "اختصارُ الخاصّية غيرُ مقيس لا «بلا message»",
    kinds('throw new TRPCError({ code: "FORBIDDEN", message });'),
    [KIND.INDIRECT],
  );
  eq(
    "اختصارُ الرمز والرسالة معاً",
    kinds("throw new TRPCError({ code, message });"),
    [KIND.INDIRECT],
  );

  // ── سدُّ مهرب رفع النصّ إلى ثابت
  eq(
    "الثابتُ المحلّيُّ النصّيّ يُعَدّ صمّاء",
    deaf('const FORBIDDEN_MSG = "ممنوع";\nthrow new TRPCError({ code: "FORBIDDEN", message: FORBIDDEN_MSG });'),
    1,
  );
  eq(
    "الثابتُ المستورَد لا يُدَّعى",
    deaf('import { M } from "./m";\nthrow new TRPCError({ code: "FORBIDDEN", message: M });'),
    0,
  );
  // انحدارٌ حقيقيّ: قصُّ القيمة كان يبتلع `});` فيفشل تطابقُ الاسم المجرَّد.
  eq(
    "القيمةُ تُقصّ عند خاصّيةٍ تالية لا عند نهاية الكائن",
    deaf('const M = "ممنوع";\nthrow new TRPCError({ code: "FORBIDDEN", message: M, cause: err });'),
    1,
  );

  // ── الاستثناء
  eq(
    "الرمزُ الداخليّ مستثنى",
    deaf('throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر اشتقاق المرجع" });'),
    0,
  );
  eq(
    "الاستثناء لا يبتلع رمزاً آخر",
    deaf('throw new TRPCError({ code: "BAD_REQUEST", message: "تعذّر" });'),
    1,
  );

  // ── قراءة `message` من العمق الصحيح لا بمطابقةٍ عمياء
  eq(
    "message داخل cause لا يُقرأ بدل الأصل",
    kinds(
      'throw new TRPCError({ code: "CONFLICT", cause: { message: "داخليّ" }, message: appErrorMessage({ what: "أ", why: "ب", doThis: "ج" }) });',
    ),
    [KIND.CONTRACT],
  );

  // ── موضعان في ملفٍّ واحد
  eq(
    "العدّ يجمع مواضع الملفّ",
    deaf(
      'throw new TRPCError({ code: "BAD_REQUEST", message: "أ" });\nthrow new TRPCError({ code: "NOT_FOUND", message: "ب" });',
    ),
    2,
  );

  if (fails.length > 0) {
    console.error("✗ الاختبار الذاتيّ لحارس رسائل الخطأ فشل:\n");
    for (const f of fails) console.error(`  ${f}`);
    process.exit(1);
  }
  if (!quiet) console.log("✓ الاختبار الذاتيّ لحارس رسائل الخطأ: كلّ الفرز سليم.");
}

// ───────────────────────────── التنفيذ ─────────────────────────────

runSelfTest({ quiet: !SELFTEST_ONLY });
if (SELFTEST_ONLY) process.exit(0);

const { current, totals } = collect();

if (UPDATE) {
  const asObj = Object.fromEntries([...current.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(asObj, null, 2) + "\n", "utf8");
  console.log(`✓ حُدِّث خطّ أساس رسائل الخطأ: ${current.size} ملفّاً · ${totals.deaf} رسالةً صمّاء.`);
  printDashboard(totals, current);
  printWorst(current);
  process.exit(0);
}

const BASELINE = readBaselineFile(BASELINE_PATH);

const findings = [];
for (const [file, count] of current) {
  const allowed = BASELINE[file] ?? 0;
  if (count > allowed) {
    findings.push(
      allowed === 0
        ? `${file}: ${count} رسالةً صمّاء (الأساس ٠)`
        : `${file}: ${count} (الأساس ${allowed}، +${count - allowed})`,
    );
  }
}

/*
 * ملفّات نُقلت مكانياً بلا تغييرٍ في نصوصها — `origin/main` يحتفظ برصيدها تحت الاسم القديم،
 * وهذا الفرع يحتفظ به تحت الاسم الجديد. بلا هذه الخريطة يبلّغ المِسنَنة عن ارتفاعٍ زائف على
 * الاسم الجديد وعن اختفاءٍ على القديم. المدخل صحيحٌ ما دام الرقمُ لم يتغيّر — نقلٌ ميكانيكيّ.
 * يُشطَب بعد الدمج ودورةِ التنقية التالية.
 */
const RENAMES = {
  // م٣ من برنامج v2 «السهل الممتنع»: تجميع خدمة السلف تحت مجلّدٍ مستقلّ.
  "server/services/advancesService.ts":
    "server/services/advances/advancesService.ts",
  "server/services/voucher/employeeAdvanceCancellation.ts":
    "server/services/advances/employeeAdvanceCancellation.ts",
};

const descent = assertMonotonicDescent({
  baselinePath: BASELINE_REL,
  baseline: BASELINE,
  label: "حارس رسائل الخطأ",
  renames: RENAMES,
});

/** ملفٌّ نظُف كلّياً ولم يُحذف من الأساس — يترك مساحةً لانتهاكٍ يمرّ صامتاً. */
const stale = Object.keys(BASELINE).filter((k) => !current.has(k));

if (REPORT_ONLY) {
  console.log("حارس رسائل الخطأ — تقريرٌ (لا يحجب):");
  printDashboard(totals, current);
  printWorst(current);
  if (findings.length > 0) {
    console.log(`ℹ️  ${findings.length} ملفّاً فوق خطّ الأساس:`);
    for (const f of findings.slice(0, 20)) console.log(`   ${f}`);
    if (findings.length > 20) console.log(`   … و${findings.length - 20} غيرها`);
  } else {
    console.log("✓ لا ملفَّ فوق خطّ الأساس.");
  }
  process.exit(0);
}

if (!descent.ok) {
  console.error(descent.message);
  process.exit(1);
}

if (findings.length === 0) {
  console.log(`✓ رسائل الخطأ ضمن خطّ الأساس — ${totals.deaf} رسالةً صمّاء في ${current.size} ملفّاً.`);
  printDashboard(totals, current);
  if (!descent.skipped) console.log(descent.message);
  if (stale.length > 0) {
    console.log(`ℹ️  ${stale.length} ملفّاً نظُف ويمكن حذفه من ${BASELINE_REL}:`);
    for (const k of stale.slice(0, 20)) console.log(`   - ${k}`);
    if (stale.length > 20) console.log(`   … و${stale.length - 20} غيرها`);
  }
  process.exit(0);
}

console.error(`✗ رسائلُ الخطأ الصمّاء ارتفعت — ${findings.length} ملفّاً فوق خطّ الأساس:\n`);
for (const f of findings.slice(0, 30)) console.error(`  ${f}`);
if (findings.length > 30) console.error(`  … و${findings.length - 30} غيرها`);
printDashboard(totals, current);
console.error(`
القاعدة: هذا الرقم ينزل ولا يصعد. والعلاج موضعٌ واحد لا نقاش فيه:

  import { appErrorMessage } from "@shared/errors";

  throw new TRPCError({
    code: "…",
    message: appErrorMessage({
      what:   "ماذا حدث كما يراه الموظّف",
      why:    "لماذا — وفيه الأرقام إن كان الرفض رقمياً",
      doThis: "ماذا يفعل الآن — مخرجٌ عمليّ لا إعادةُ صياغةٍ للسبب",
    }),
  });

⚠️ وما يقيسه هذا الحارس هو **المرور بالعقد** لا جودةَ النصّ: جودةُ «ماذا تفعل» يحرسها
   \`appError\` في وقت التشغيل (ترفض الفارغ، وترفض تكرار «لماذا»). فلا تُرضِ العدّاد
   بـ«حاول مجدّداً» — ذاك يُنقص الرقم ولا يُحرّك الموظّف الواقف.

خطّ الأساس (تنازليّ — لا يُرفَع): ${BASELINE_REL}
التحديث بعد الترحيل: node scripts/check-error-messages.mjs --update-baseline
`);
process.exit(1);
