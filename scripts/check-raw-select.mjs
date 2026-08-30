#!/usr/bin/env node
// حارس اعتماد AppSelect — يمنع `<select>` HTML خامّاً جديداً في `client/src/pages/**`.
//
// السبب: `<select>` الأصليّ يظهر مقتطعاً في Chromium (تدقيق ٣١/٧/٢٦: القوائم المنسدلة تُقصّ
// أسفل الـviewport). البديل `AppSelect` من `@/components/ui/AppSelect`:
//   - عرض popup يطابق الـtrigger (بلا اقتصاص)
//   - حبس تركيز + تنقّل كامل بلوحة المفاتيح (Type-ahead)
//   - RTL-aware + حسّاس لـ`data-theme`
//   - نظام ألوان النظام (بدل style افتراضي المتصفّح المتباين)
//   - API قريب من `<select>`: `onValueChange={setX}` بدل `onChange={(e) => setX(e.target.value)}`
//
// النطاق: `client/src/pages/**/*.tsx`. المكوّنات المشتركة (`client/src/components/**`) خارج النطاق
// (بعض المكوّنات المخصّصة تلفّ `<select>` عمداً لسبب معيّن — تلك تُقيَّم فرديّاً).
//
// خطّ الأساس النصّي القديم مجمَّد في `scripts/raw-select-baseline.json` ولا يُوسَّع. القياس
// الحاكم دقيقٌ عبر AST ويقارن الشجرة الحالية بقاعدة دمجها مع origin/main: الدين الموروث يمرّ
// ما لم يزد، وأيّ زيادة جديدة تفشل، بما فيها `<select` متعدد الأسطر أو عدة tags في السطر نفسه.
// `--update-baseline` يخفض الخطّ القديم فقط، ولا يضيف سماحاً جديداً.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src", "pages");
const BASELINE_PATH = path.join(__dirname, "raw-select-baseline.json");
const UPDATE = process.argv.includes("--update-baseline");
const SELFTEST_ONLY = process.argv.includes("--selftest");
const BASE_REF = process.env.RAW_SELECT_BASE_REF || "origin/main";

const BASELINE = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : {};

function* walkTsx(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "__tests__" ||
        entry.name === "node_modules" ||
        entry.name === "_legacy" ||
        entry.name === "dist"
      )
        continue;
      yield* walkTsx(full);
    } else if (
      entry.isFile() &&
      /\.tsx$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      yield full;
    }
  }
}

const relOf = (full) => path.relative(REPO_ROOT, full).replace(/\\/g, "/");

/**
 * يعدّ عناصر `<select>` JSX الفعلية، لا السطور التي تذكر النص. هذا يمسك تلقائياً:
 * - tag متعدد الأسطر (`<select` ثم الخصائص في السطر التالي)
 * - كل تكرار حين توجد عدة tags في السطر نفسه
 * ويتجاهل التعليقات وtemplate literals و`<Select>`/`<selector>` بلا heuristics هشّة.
 */
export function countRawSelects(source, fileName = "source.tsx") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let count = 0;

  function visit(node) {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(sourceFile) === "select"
    ) {
      count++;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return count;
}

/** Ratchet عدديّ: الاستعمال الموروث مسموح، والزيادة وحدها مخالفة. */
export function findCountIncreases(current, base) {
  const findings = [];
  for (const [file, count] of current) {
    const allowed = base.get(file) ?? 0;
    if (count > allowed) {
      findings.push({ file, count, allowed, increase: count - allowed });
    }
  }
  return findings;
}

/** يبقي خط الأساس القديم monotonic: حذف/خفض فقط، بلا إضافة ملف أو رفع سماح. */
export function reduceLegacyBaseline(baseline, current) {
  return Object.entries(baseline)
    .map(([file, allowed]) => [
      file,
      Math.min(Number(allowed), current.get(file) ?? 0),
    ])
    .filter(([, allowed]) => allowed > 0)
    .sort(([a], [b]) => a.localeCompare(b));
}

/** اختبار ذاتي قصير يُنفَّذ بصمت في كل تشغيل للحارس، أو منفرداً مع --selftest. */
export function runSelfTest({ quiet = false } = {}) {
  const multiline = `
    export function Example() {
      return (
        <select
          value="A"
          onChange={() => undefined}
        >
          <option value="A">A</option>
        </select>
      );
    }
  `;
  const repeated = `const X = () => <><select /><select></select><div><select /></div></>;`;
  const ignored = `
    // <select>
    const html = \`<select><option>print only</option></select>\`;
    const text = "<select>";
    const X = () => <><Select /><selector /></>;
  `;

  assert.equal(countRawSelects(multiline), 1, "يجب عدّ <select> متعدد الأسطر");
  assert.equal(
    countRawSelects(repeated),
    3,
    "يجب عدّ كل تكرارات <select> في السطر نفسه",
  );
  assert.equal(
    countRawSelects(ignored),
    0,
    "يجب تجاهل النصوص والتعليقات والمكوّنات الأخرى",
  );

  const inherited = new Map([["legacy.tsx", 3]]);
  assert.deepEqual(
    findCountIncreases(inherited, new Map([["legacy.tsx", 3]])),
    [],
  );
  assert.deepEqual(
    findCountIncreases(
      new Map([["legacy.tsx", 2]]),
      new Map([["legacy.tsx", 3]]),
    ),
    [],
  );
  assert.deepEqual(
    findCountIncreases(
      new Map([["legacy.tsx", 4]]),
      new Map([["legacy.tsx", 3]]),
    ),
    [{ file: "legacy.tsx", count: 4, allowed: 3, increase: 1 }],
  );
  assert.deepEqual(findCountIncreases(new Map([["new.tsx", 2]]), new Map()), [
    { file: "new.tsx", count: 2, allowed: 0, increase: 2 },
  ]);
  assert.deepEqual(
    reduceLegacyBaseline(
      { "legacy.tsx": 3, "removed.tsx": 2 },
      new Map([
        ["legacy.tsx", 9],
        ["new.tsx", 4],
      ]),
    ),
    [["legacy.tsx", 3]],
    "تحديث baseline يجب ألا يرفع السماح أو يضيف ملفاً جديداً",
  );

  if (!quiet) {
    console.log(
      "✓ selftest: JSX متعدد الأسطر + التكرارات + ratchet الزيادة تعمل بدقة.",
    );
  }
}

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * يثبّت ratchet على قاعدة دمج الفرع لا رأس main الحيّ.
 *
 * في CI تنتظر check-test-build شرائح الاختبار قبل أن تبدأ. قد يتقدّم origin/main في تلك
 * الأثناء (وقع في #878 و#879 حين خفّض #876 دين <select> من 4 إلى 2)، بينما HEAD يبقى مرجع
 * دمج GitHub القديم. المقارنة المباشرة برأس main الجديد تنسب خفض main إلى الـPR كزيادة كاذبة.
 */
function comparisonBase(ref) {
  try {
    const sha = git(["merge-base", "HEAD", ref]).trim();
    if (!sha) throw new Error("git merge-base أعاد نتيجة فارغة");
    return sha;
  } catch (error) {
    const detail =
      error?.stderr?.toString().trim() || error?.message || String(error);
    throw new Error(
      `تعذّر تثبيت قاعدة دمج ratchet من «${ref}». نفّذ git fetch origin main ثم أعد الحارس.\n${detail}`,
    );
  }
}

function baseFiles(ref) {
  try {
    return new Set(
      git(["ls-tree", "-r", "--name-only", ref, "--", "client/src/pages"])
        .split(/\r?\n/)
        .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx")),
    );
  } catch (error) {
    const detail =
      error?.stderr?.toString().trim() || error?.message || String(error);
    throw new Error(
      `تعذّر قراءة مرجع ratchet «${ref}». نفّذ git fetch origin main ثم أعد الحارس.\n${detail}`,
    );
  }
}

function changedFilesFrom(ref) {
  return new Set(
    git(["diff", "--name-only", ref, "--", "client/src/pages"])
      .split(/\r?\n/)
      .filter(Boolean),
  );
}

runSelfTest({ quiet: !SELFTEST_ONLY });
if (SELFTEST_ONLY) process.exit(0);

const current = new Map();
for (const file of walkTsx(SCAN_ROOT)) {
  const rel = relOf(file);
  const text = readFileSync(file, "utf8");
  current.set(rel, countRawSelects(text, rel));
}

if (UPDATE) {
  // لا نضيف ملفات ولا نزيد عدداً: هذا الخيار يخفض الخطّ النصّي القديم فقط بعد الترحيل.
  const reduced = reduceLegacyBaseline(BASELINE, current);
  const asObj = Object.fromEntries(reduced);
  writeFileSync(BASELINE_PATH, JSON.stringify(asObj, null, 2) + "\n", "utf8");
  const total = reduced.reduce((sum, [, count]) => sum + count, 0);
  console.log(
    `✓ خُفِّض خطّ الأساس فقط: ${reduced.length} ملفاً · ${total} <select> مجمَّداً.`,
  );
  process.exit(0);
}

const COMPARISON_BASE = comparisonBase(BASE_REF);
const baseFileSet = baseFiles(COMPARISON_BASE);
const changed = changedFilesFrom(COMPARISON_BASE);
const baseCounts = new Map();
for (const [file, count] of current) {
  if (!baseFileSet.has(file)) {
    baseCounts.set(file, 0);
  } else if (!changed.has(file)) {
    // الملف مطابق للمرجع؛ لا حاجة إلى git show/parse لمئات الملفات الموروثة.
    baseCounts.set(file, count);
  } else {
    const baseSource = git(["show", `${COMPARISON_BASE}:${file}`]);
    baseCounts.set(file, countRawSelects(baseSource, file));
  }
}

const findings = findCountIncreases(current, baseCounts);
const exactFiles = [...current.values()].filter((count) => count > 0).length;
const exactTotal = [...current.values()].reduce((sum, count) => sum + count, 0);
const baselineFiles = Object.keys(BASELINE).length;
const baselineTotal = Object.values(BASELINE).reduce(
  (sum, count) => sum + Number(count),
  0,
);
const reducedBy = [...current].reduce(
  (sum, [file, count]) =>
    sum + Math.max(0, (baseCounts.get(file) ?? 0) - count),
  0,
);

if (findings.length === 0) {
  console.log(
    `✓ اعتماد AppSelect محفوظ — لا زيادة فوق قاعدة الدمج ${COMPARISON_BASE.slice(0, 12)} ` +
      `(من ${BASE_REF}).`,
  );
  console.log(
    `  القياس الدقيق: ${exactFiles} ملفاً · ${exactTotal} <select> ` +
      `(الخطّ النصّي الموروث بلا توسيع: ${baselineFiles} ملفاً · ${baselineTotal}).`,
  );
  if (reducedBy > 0)
    console.log(`  خُفِّض الدين في هذه الشجرة بمقدار ${reducedBy} <select>.`);
  process.exit(0);
}

console.error(
  `✗ استعمال <select> جديد فوق قاعدة الدمج ${COMPARISON_BASE.slice(0, 12)} ` +
    `(من ${BASE_REF}) — ${findings.length} ملف مخالف:\n`,
);
for (const finding of findings) {
  console.error(
    `  ${finding.file}: ${finding.count} <select> ` +
      `(المرجع ${finding.allowed}، +${finding.increase})`,
  );
}
console.error(`
القاعدة: استعمل \`AppSelect\` من \`@/components/ui/AppSelect\`:

  import { AppSelect } from "@/components/ui/AppSelect";
  <AppSelect value={branchId} onValueChange={setBranchId} placeholder="اختر الفرع">
    {branches.map(b => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
  </AppSelect>

الفوائد: popup غير مقتطع + لوحة مفاتيح كاملة + RTL + dark mode + توكنز النظام.

لتخفيض الخطّ القديم بعد الترحيل: node scripts/check-raw-select.mjs --update-baseline
`);
process.exit(1);
