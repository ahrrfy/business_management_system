#!/usr/bin/env node
/**
 * حارِسُ **انجراف الرسائل المتعاقَد عليها** (برنامج v2، ق٦ — ٢/٩/٢٦).
 *
 * ## العلّة التي وُجد لها
 * اختباراتٌ كثيرة في هذا المستودع تطابق **نصَّ** رسالة الخطأ (`toThrow(/إرسالية مفتوحة/)`)
 * لا رمزَها. فحين يُعاد صوغُ الرسالة — وهو ما تفعله حملةُ ق٦ في آلاف المواضع — **يسقط
 * التعاقد بلا خطأ نوعٍ ولا تحذيرٍ ولا شيءٍ يظهر قبل تشغيل الحزمة الكاملة** (٢٠-٤٥ دقيقة).
 * وقع هذا **ثلاث مرّات في يومٍ واحد**: `/إرسالية مفتوحة/` و`/استُهلكت/` و`/الحجوزات النشطة/`.
 *
 * وأخطرُ منه أنّ النصّ قد يكون تعاقداً **بين خدمتين** لا بين خدمةٍ واختبار:
 * `sale/create.ts` و`workOrder/lifecycle.ts` و`Reception.tsx` تفحص ثلاثتُها
 * `message.includes("المخزون غير كافٍ")` — وإسقاطُها يُعطّل ثلاثة مسارات بصمتٍ تامّ.
 *
 * ## ما يقيسه — وما لا يقيسه (بصراحة)
 * يقارن كلّ ملفٍّ **متغيّرٍ** بنسخته في المرجع، ويبحث عن نصٍّ عربيٍّ **كان يطابقه** مستهلِكٌ
 * ذو صلة **ولم يعد**. المستهلِكان نوعان: تأكيدُ اختبارٍ (`toThrow(/…/)`/`toContain("…")`)،
 * وفحصٌ نصّيٌّ في شيفرةٍ أخرى (`message.includes("…")`).
 *
 * ⛔ **ولا يدّعي أكثر من ذلك:** لا يحكم على جودة الرسالة، ولا يمسك تعاقداً بنصٍّ مبنيٍّ
 * ديناميكياً، ولا مطابقةً بمتغيّر. حارسٌ يدّعي ما لا يفعله يُنذر كذباً فيُتجاوَز فيصير مسرحياً.
 *
 * ⭐ **وقيدُ الصلة هو جوهرُ صحّته:** بلا اشتراطِ أن يستورد المستهلِكُ الملفَّ فعلاً، كانت أوّلُ
 * نسخةٍ تقارن كلَّ اختبارٍ بكلّ ملفّ فتُخرج **١٣٨ إنذاراً أغلبُها كاذب** («السابق» من
 * `TablePager.test.ts` مقابل إلغاء أمر شغل). القيدُ خفّضها إلى **٥ — كلُّها حقيقية**.
 *
 * الاستعمال:
 *   node scripts/check-message-contract-drift.mjs              # شجرةُ العمل مقابل HEAD
 *   node scripts/check-message-contract-drift.mjs --base origin/main
 *   node scripts/check-message-contract-drift.mjs --selftest
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const SELFTEST_ONLY = args.includes("--selftest");
const baseIdx = args.indexOf("--base");
const BASE = baseIdx >= 0 ? args[baseIdx + 1] : "HEAD";

const ARABIC = /[\u0600-\u06FF]/;

/** أنماطُ التعاقد النصّيّ في مستهلِكٍ: تأكيدُ اختبار، أو فحصٌ نصّيّ في شيفرة. */
const CONTRACT_PATTERNS = [
  /toThrowError[(][/]([^/\n]{4,140})[/][a-z]*[)]/g,
  /toThrow[(][/]([^/\n]{4,140})[/][a-z]*[)]/g,
  /toContain[(]"([^"\n]{6,140})"[)]/g,
  /[.]includes[(]"([^"\n]{6,140})"[)]/g,
];

/** يستخرج كلّ نصٍّ عربيٍّ يتعاقد عليه هذا المستهلِك. */
export function extractContractTexts(source) {
  const out = [];
  for (const re of CONTRACT_PATTERNS) {
    for (const m of source.matchAll(new RegExp(re.source, re.flags))) {
      const text = m[1];
      if (text && ARABIC.test(text)) out.push(text);
    }
  }
  return out;
}

/** هل يشير هذا المستهلِك إلى الوحدة `stem` (استيرادٌ أو مسار)؟ قيدُ الصلة. */
export function referencesModule(source, stem) {
  return source.includes(`/${stem}"`) || source.includes(`/${stem}'`);
}

/** محدّداتُ الاستيراد في مستهلِك — نسبيّةً أو باسمٍ مختصر. */
export function importSpecifiers(source) {
  const out = [];
  for (const m of source.matchAll(/from\s+["']([^"'\n]+)["']/g)) out.push(m[1]);
  return out;
}

/**
 * ⭐ **قيدُ الصلة وحدَه لا يكفي — والسببُ أمسكه CI علينا (٣/٩/٢٦).**
 *
 * `saleCancel.test.ts` يستورد `returnService` **و**`sale/cancel` معاً. فحين نُقلت
 * «الفاتورة لا تخصّ فرعك» من الأوّل — وهي ما تزال حيّةً في الثاني الذي يُنفّذه التأكيد فعلاً —
 * أنذر الحارسُ على **ثلاثة** تأكيداتٍ سليمة. أربعةٌ من خمسة إنذاراتٍ كاذبة، وحارسٌ بهذه
 * النسبة يُتجاوَز فيصير مسرحياً (وهو أسوأ من غيابه: يمنح ثقةً ويأخذ انتباهاً).
 *
 * العلاج: التعاقدُ يُقاس على **كلّ ما يستورده المستهلِك**، لا على الملفّ المتغيّر وحده.
 * فإن بقي النصُّ مُنتَجاً في أيّ وحدةٍ يستوردها، فالتأكيدُ ما زال يُصيب ⇒ لا انجراف.
 * ⛔ ولا يُوسَّع الفحص إلى المستودع كلّه: عبارةٌ في شاشةٍ لا يستوردها الاختبار كانت
 * ستُخفي انجرافاً حقيقياً (جرّبناه: «الطلبات النشطة» موجودةٌ في `ReceptionOrderQueue.tsx`).
 */
export function satisfiedByAnotherImport(
  text,
  consumerPath,
  source,
  changedFile,
  readFile,
) {
  let re = null;
  try {
    re = new RegExp(text);
  } catch {
    re = null;
  }
  const hit = (body) => (re ? re.test(body) : body.includes(text));
  const pending = [{ file: consumerPath.replace(/\\/g, "/"), body: source }];
  const visited = new Set(pending.map((entry) => entry.file));
  while (pending.length) {
    const entry = pending.shift();
    const dir = path.posix.dirname(entry.file);
    for (const spec of runtimeImportSpecifiers(entry.body)) {
      if (
        !spec.startsWith(".") &&
        !spec.startsWith("@/") &&
        !spec.startsWith("@shared/")
      )
        continue;
      const base = spec.startsWith("@/")
        ? path.posix.join("client/src", spec.slice(2))
        : spec.startsWith("@shared/")
          ? path.posix.join("shared", spec.slice(8))
          : path.posix.normalize(path.posix.join(dir, spec));
      if (base.startsWith("../")) continue;
      for (const cand of [
        base + ".ts",
        base + ".tsx",
        base + "/index.ts",
        base + "/index.tsx",
        base,
      ]) {
        const body = readFile(cand);
        if (body === null) continue;
        // A cycle back to the consumer must not count its own assertion as a producer.
        if (visited.has(cand)) break;
        visited.add(cand);
        if (cand !== changedFile && hit(stripComments(body))) return true;
        // A decomposed component still produces its imported hook/view's message.
        pending.push({ file: cand, body });
        break;
      }
    }
  }
  return false;
}

const runtimeImportCache = new Map();
function runtimeImportSpecifiers(source) {
  if (runtimeImportCache.has(source)) return runtimeImportCache.get(source);
  const file = ts.createSourceFile(
    "module.tsx",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX,
  );
  const out = [];
  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
      continue;
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier))
      continue;
    const clause = ts.isImportDeclaration(node) ? node.importClause : node;
    if (clause?.isTypeOnly) continue;
    const bindings = ts.isImportDeclaration(node)
      ? clause?.namedBindings
      : node.exportClause;
    if (
      !clause?.name &&
      bindings &&
      "elements" in bindings &&
      bindings.elements.length &&
      bindings.elements.every((item) => item.isTypeOnly)
    )
      continue;
    out.push(node.moduleSpecifier.text);
  }
  runtimeImportCache.set(source, out);
  return out;
}

/**
 * يحذف التعليقات ويُبقي السلاسل. ⭐ **بلا هذا كان الحارس أعمى عن أخطر حالةٍ يوجد لها**:
 * أسقطتُ «الطلبات النشطة» من رسالةٍ في `onlineOrderService.ts` بينما بقيت العبارةُ في
 * **تعليقٍ** بالملفّ نفسه — فرأى الحارسُ النصَّ حاضراً وأعلن سلامة التعاقد، وسقطت الحزمةُ
 * على CI وحدها. والمقارنةُ النصّيّة الخامّة تجعل أيَّ تعليقٍ يذكر العبارة **قناعاً** يحجب
 * حذفَها من الشيفرة الحيّة — وكلّما شرحتَ تعاقداً في تعليقٍ (وهو ما نطلبه!) عمي عنه أكثر.
 *
 * ⛔ ولا يصلح `replace(/\/\/.*$/gm, "")`: يقصّ داخل السلاسل عند أوّل `//` (أيّ عنوان
 * `"https://…"` أو مسارٍ فيه `//`) فيحذف نصَّ رسالةٍ حقيقيّ ويُنتج إنذاراً كاذباً.
 * لذلك ماسحٌ يتتبّع الحالة: سلسلة `'`/`"`/`` ` `` مع الإفلات، وتعليقٌ سطريّ وكتليّ.
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue; // نُبقي "\n" ليبقى ترقيمُ الأسطر وحدودُ الأنماط سليمة.
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * هل انكسر التعاقد؟ كان يطابق النصَّ القديم ولم يعد يطابق الجديد.
 * الطرفان يُجرَّدان من التعليقات أوّلاً (انظر `stripComments`).
 */
export function contractBroken(text, before, after) {
  const b = stripComments(before);
  const a = stripComments(after);
  let re;
  try {
    re = new RegExp(text);
  } catch {
    // نصٌّ حرفيّ لا نمط (من `toContain`/`includes`).
    return b.includes(text) && !a.includes(text);
  }
  return re.test(b) && !re.test(a);
}

function runSelfTest({ quiet }) {
  const fails = [];
  const eq = (name, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fails.push(
        `${name}: توقّعنا ${JSON.stringify(want)} فجاء ${JSON.stringify(got)}`,
      );
    }
  };

  eq(
    "يلتقط تأكيد toThrow العربيّ",
    extractContractTexts("rejects.toThrowError(/إرسالية مفتوحة/);"),
    ["إرسالية مفتوحة"],
  );
  eq(
    "ويلتقط فحص includes بين خدمتين",
    extractContractTexts('e.message.includes("المخزون غير كافٍ")'),
    ["المخزون غير كافٍ"],
  );
  eq(
    "ولا يلتقط نمطاً لاتينياً — ليس رسالةَ مستخدم",
    extractContractTexts("toThrow(/ER_DUP_ENTRY/)"),
    [],
  );

  eq(
    "قيدُ الصلة يقبل الاستيراد الفعليّ",
    referencesModule('from "../returnService"', "returnService"),
    true,
  );
  eq(
    "ويرفض اسماً عابراً في نصّ",
    referencesModule("// returnService مذكورٌ تعليقاً", "returnService"),
    false,
  );

  eq(
    "الكسرُ يُكتشف",
    contractBroken(
      "إرسالية مفتوحة",
      "x إرسالية مفتوحة y",
      "x إرسالية التوصيل y",
    ),
    true,
  );
  eq(
    "والباقي لا يُنذَر عليه",
    contractBroken("إرسالية", "x إرسالية y", "x إرسالية التوصيل y"),
    false,
  );
  // البديلُ يبقى محقَّقاً ما دام أحدُ شقّيه باقياً — وإلّا أنذر الحارس على صياغةٍ سليمة.
  eq(
    "والبديل يُقاس كنمطٍ لا كنصّ",
    contractBroken("أ|ب", "فيه أ", "فيه ب"),
    false,
  );

  // ⭐ الحالةُ التي أسقطت CI فعلاً (٣/٩/٢٦): العبارةُ تُحذف من الرسالة وتبقى في **تعليق**
  // بالملفّ نفسه. بلا تجريد التعليقات كان الحارس يُعلن السلامة — وهذا أخطر من غيابه،
  // لأنّه يمنح ثقةً لا يستحقّها. الاختبارُ يُثبّت السلوك فلا ينطفئ الإصلاح بعدنا.
  eq(
    "⭐ تعليقٌ يذكر العبارة لا يُخفي حذفَها من الرسالة",
    contractBroken(
      "الطلبات النشطة",
      'const m = "بعد احتساب الطلبات النشطة";',
      '// قبل فحص الطلبات النشطة.\nconst m = "بعد احتساب طلبات زبائن آخرين";',
    ),
    true,
  );
  eq(
    "والتعليقُ الكتليّ كذلك",
    contractBroken(
      "إرسالية مفتوحة",
      'x = "إرسالية مفتوحة";',
      '/* إرسالية مفتوحة */ x = "إرسالية التوصيل";',
    ),
    true,
  );
  // ⛔ والعكسُ محروسٌ أيضاً: التجريد لا يقصّ داخل السلاسل عند `//` — وإلّا حُذف نصُّ
  // رسالةٍ حقيقيّ بعد أيّ عنوانٍ في الملفّ فصار الإنذارُ كاذباً والحارسُ يُتجاوَز.
  eq(
    "ولا يقصّ `//` داخل سلسلة",
    stripComments('const u = "https://x.test/a"; const m = "إرسالية مفتوحة";'),
    'const u = "https://x.test/a"; const m = "إرسالية مفتوحة";',
  );
  eq(
    "ويحترم الإفلات داخل السلسلة",
    stripComments('const m = "قال \\"نعم\\" // ليس تعليقاً"; // هذا تعليق'),
    'const m = "قال \\"نعم\\" // ليس تعليقاً"; ',
  );

  // ⭐ الإنذارُ الكاذب الذي أنتجه الحارسُ فعلاً: النصُّ انتقل إلى وحدةٍ أخرى **يستوردها
  // المستهلِك نفسه** ⇒ التأكيدُ ما زال يُصيب ⇒ لا انجراف.
  {
    const consumerSrc =
      'import { returnSale } from "../returnService";\nimport { cancelSale } from "../sale/cancel";\ntoThrow(/لا تخصّ فرعك/)';
    const files = {
      "server/services/sale/cancel.ts": 'message: "الفاتورة لا تخصّ فرعك"',
      "server/services/returnService.ts": "// «الفاتورة لا تخصّ فرعك» كانت هنا",
    };
    eq(
      "⭐ نصٌّ باقٍ في وحدةٍ أخرى يستوردها المستهلِك ⇒ لا إنذار",
      satisfiedByAnotherImport(
        "لا تخصّ فرعك",
        "server/services/__tests__/saleCancel.test.ts",
        consumerSrc,
        "server/services/returnService.ts",
        (f) => files[f] ?? null,
      ),
      true,
    );
    eq(
      "⛔ ولا يُقمَع حين تكون الوحدةُ الأخرى غيرَ مستورَدة",
      satisfiedByAnotherImport(
        "لا تخصّ فرعك",
        "server/services/__tests__/x.test.ts",
        'import { returnSale } from "../returnService";\ntoThrow(/لا تخصّ فرعك/)',
        "server/services/returnService.ts",
        (f) =>
          f === "server/services/sale/cancel.ts"
            ? 'message: "الفاتورة لا تخصّ فرعك"'
            : null,
      ),
      false,
    );
    eq(
      "⛔ ولا يُقمَع بوجودِ النصّ في تعليقٍ بوحدةٍ مستورَدة",
      satisfiedByAnotherImport(
        "لا تخصّ فرعك",
        "server/services/__tests__/y.test.ts",
        'import { cancelSale } from "../sale/cancel";\ntoThrow(/لا تخصّ فرعك/)',
        "server/services/returnService.ts",
        (f) =>
          f === "server/services/sale/cancel.ts"
            ? "// لا تخصّ فرعك — أُزيلت"
            : null,
      ),
      false,
    );
  }

  {
    const files = {
      "client/src/Portal.tsx":
        'import { usePortal } from "./usePortal"; export const Portal = usePortal;',
      "client/src/usePortal.ts":
        'import { message } from "@/messages"; import { Portal } from "./Portal"; export { message };',
      "client/src/messages.ts":
        'export const message = "تغيّرت بنود الفاتورة";',
      "client/src/unrelated.ts": 'export const message = "نص غير مستورد";',
    };
    const read = (file) => files[file] ?? null;
    const consumer = 'import { Portal } from "../Portal";';
    eq(
      "رسالة باقية في اعتماد حي مستخرج مع دورة استيراد",
      satisfiedByAnotherImport(
        "تغيّرت بنود الفاتورة",
        "client/src/__tests__/portal.test.tsx",
        consumer,
        "client/src/Portal.tsx",
        read,
      ),
      true,
    );
    eq(
      "لا يبحث خارج اعتمادات المستهلك",
      satisfiedByAnotherImport(
        "نص غير مستورد",
        "client/src/__tests__/portal.test.tsx",
        consumer,
        "client/src/Portal.tsx",
        read,
      ),
      false,
    );
    eq(
      "استيراد النوع ليس منتجاً لرسالة تشغيلية",
      satisfiedByAnotherImport(
        "تغيّرت بنود الفاتورة",
        "client/src/__tests__/portal.test.tsx",
        'import type { Portal } from "../Portal";',
        "client/src/Portal.tsx",
        read,
      ),
      false,
    );
    eq(
      "ولا الاستيراد المسمى لنوع فقط",
      satisfiedByAnotherImport(
        "تغيّرت بنود الفاتورة",
        "client/src/__tests__/portal.test.tsx",
        'import { type Portal } from "../Portal";',
        "client/src/Portal.tsx",
        read,
      ),
      false,
    );
    eq(
      "النص في تعليق اعتماد لا يخفي حذف الرسالة",
      satisfiedByAnotherImport(
        "تغيّرت بنود الفاتورة",
        "client/src/__tests__/portal.test.tsx",
        consumer,
        "client/src/Portal.tsx",
        (file) =>
          file === "client/src/messages.ts"
            ? "// تغيّرت بنود الفاتورة"
            : read(file),
      ),
      false,
    );
  }

  {
    const consumer =
      'import { Portal } from "../Portal"; expect(message).toContain("تغيّرت بنود الفاتورة");';
    const files = {
      "client/src/Portal.tsx":
        'import "./__tests__/portal.test"; export const message = "رسالة أخرى";',
      "client/src/__tests__/portal.test.tsx": consumer,
    };
    eq(
      "دورة إلى المستهلك لا تجعل نص تأكيده منتجاً للرسالة المحذوفة",
      satisfiedByAnotherImport(
        "تغيّرت بنود الفاتورة",
        "client/src/__tests__/portal.test.tsx",
        consumer,
        "client/src/Portal.tsx",
        (file) => files[file] ?? null,
      ),
      false,
    );
  }

  if (fails.length) {
    console.error("✗ الاختبار الذاتيّ لحارس انجراف الرسائل:");
    for (const f of fails) console.error("  - " + f);
    process.exit(1);
  }
  if (!quiet)
    console.log("✓ الاختبار الذاتيّ لحارس انجراف الرسائل: كلّ الكواشف سليمة.");
}

runSelfTest({ quiet: !SELFTEST_ONLY });
if (SELFTEST_ONLY) process.exit(0);

let changed;
try {
  changed = execSync(`git diff --name-only ${BASE}`, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .split("\n")
    .filter((f) => /[.](ts|tsx)$/.test(f) && !f.includes(".test."));
} catch {
  // يفشل **مفتوحاً**: مرجعٌ غائب (استنساخٌ ضحل) لا يُعطّل عملاً مشروعاً — كبقيّة الحرّاس.
  console.log(`ℹ️ تعذّر قراءة الفرق مقابل «${BASE}» — يُتخطّى الحارس.`);
  process.exit(0);
}

// ⚠️ **الخمولُ يُعلَن، ولا يُترك يبدو نجاحاً** (درسُ ٣/٩/٢٦): شغّلتُ الحارس بعد الالتزام،
// ففرقُ `HEAD` فارغٌ ⇒ صفرُ ملفّاتٍ تُفحَص ⇒ «✓ لا انجراف» — وهي جملةٌ صادقةٌ حرفياً
// ومُضلِّلةٌ عملياً، بنيتُ عليها ثقةً فسقطت الحزمةُ على CI بانجرافٍ حقيقيّ. الفرقُ بين
// «فحصتُ فلم أجد» و«لم أفحص شيئاً» يجب أن يكون **مقروءاً في المخرَج**.
if (changed.length === 0) {
  console.log(
    `ℹ️ حارسُ انجراف الرسائل **خامل**: صفرُ ملفّاتٍ متغيّرة مقابل «${BASE}».`,
  );
  if (BASE === "HEAD")
    console.log(
      "   (بعد الالتزام يكون فرقُ HEAD فارغاً — للفحص عبر الفرع: --base origin/main)",
    );
  process.exit(0);
}

const consumers = execSync("git ls-files", { cwd: REPO_ROOT })
  .toString()
  .split("\n")
  .filter((f) => /[.](ts|tsx)$/.test(f));

/** يقرأ ملفّاً من المستودع أو يُرجع null — بذاكرةٍ مؤقّتة (الملفّ الواحد يُسأل عنه مراراً). */
const fileCache = new Map();
function readRepoFile(rel) {
  if (fileCache.has(rel)) return fileCache.get(rel);
  let body = null;
  try {
    const p = path.join(REPO_ROOT, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile())
      body = fs.readFileSync(p, "utf8");
  } catch {
    body = null;
  }
  fileCache.set(rel, body);
  return body;
}

const findings = [];
for (const file of changed) {
  const stem = path.basename(file).replace(/[.]tsx?$/, "");
  let before;
  try {
    before = execSync(`git show ${BASE}:${file}`, {
      cwd: REPO_ROOT,
      maxBuffer: 1e8,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    continue; // ملفٌّ جديد — لا تعاقدَ سابقاً يُكسر.
  }
  const full = path.join(REPO_ROOT, file);
  if (!fs.existsSync(full)) continue;
  const after = fs.readFileSync(full, "utf8");
  for (const consumer of consumers) {
    if (consumer === file) continue;
    let src;
    try {
      src = fs.readFileSync(path.join(REPO_ROOT, consumer), "utf8");
    } catch {
      continue;
    }
    if (!referencesModule(src, stem)) continue;
    for (const text of extractContractTexts(src)) {
      if (!contractBroken(text, before, after)) continue;
      if (satisfiedByAnotherImport(text, consumer, src, file, readRepoFile))
        continue;
      findings.push({ consumer, text, file });
    }
  }
}

if (findings.length === 0) {
  console.log(`✓ لا انجرافَ في نصٍّ متعاقَدٍ عليه (مقابل ${BASE}).`);
  process.exit(0);
}

console.error(
  `✗ انجرافُ رسائل: ${findings.length} تعاقداً نصّياً كُسر مقابل ${BASE}.`,
);
for (const f of findings) {
  console.error(`  - ${f.consumer}`);
  console.error(`      «${f.text}» لم تعد تطابق ${f.file}`);
}
console.error("");
console.error(
  "  القاعدة: نصُّ رسالةٍ يفحصه مستهلِكٌ **جزءٌ من العقد**. إمّا تُبقيه حرفياً،",
);
console.error(
  "  وإمّا تُضيّق نمطَ المستهلِك على الجزء الثابت من المعنى — ولا تُضعِفه ولا تحذفه.",
);
process.exit(1);
