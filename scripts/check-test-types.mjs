#!/usr/bin/env node
/**
 * حارس أنواع الاختبارات (مسنَنةٌ تنازلية) — يغلق فجوة استثناء `**\/*.test.ts(x)` من `tsconfig.json`.
 *
 * السبب (توصية المراجعة المعمارية Wave B3 + CLAUDE.md §٣):
 * ملفّ `tsconfig.json` الأساسي يستثني `**\/*.test.ts` و`**\/*.test.tsx` تاريخياً، فكان `pnpm check`
 * يمرّ أخضرَ بينما تنجرف عقودُ الأنواع في ملفات الاختبار بصمتٍ ولا يظهر العطب إلّا متأخّراً أو يبقى
 * كامناً تحت المحاكاة (`vi.mock`).
 *
 * ⭐ ما يفعله هذا الحارس بدقّة:
 *   ١) يفحص شجرة الاختبارات عبر `tsconfig.test.json` (`tsc --noEmit --pretty false`):
 *        • محلياً: يستثمر الكاش التزايديّ المنفصل (`tsbuildinfo.test`) ليكتمل في ثوانٍ بعد التهيئة الأولى.
 *        • في CI (`CI=true`): يمرّر `--incremental false` لتوفير ~٨٠٠ ميغابايت من رسم البصمات التزايديّ
 *          على مشغّلات البناء الباردة، مع سقف ذاكرة `10240 MB` يتّسع لشجرة `AppRouter` + ١٤٠٠+ ملفّ اختبار.
 *   ٢) يجمّع عدد أخطاء TypeScript لكلّ ملفّ على حدة (`{ "path/to/file.test.ts": count }`).
 *   ٣) يرفض أيّ ملفّ اختبار جديد يحمل خطأ نوعٍ واحداً، ويرفض ارتفاع أخطاء أيّ ملفّ قديم عن سقفه.
 *   ٤) يفرض المسنَنة التنازلية (`assertMonotonicDescent`) مقابل `origin/main` فلا يُرفَع سقفٌ في PR.
 *   ٥) يفشل مغلقاً إذا خرج `tsc` برمزٍ غير صفريّ دون تشخيصات قابلةٍ للتحليل (خطأ إعداد أو نفاد ذاكرة).
 *
 * التحديث بعد تنظيف ملفّاتٍ من أخطاء الأنواع:
 *   node scripts/check-test-types.mjs --update-baseline
 * التقرير الإحصائيّ (بلا حجب):
 *   node scripts/check-test-types.mjs --report
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMonotonicDescent } from "./ratchet-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BASELINE_PATH = path.join(__dirname, "test-typecheck-baseline.json");
const BASELINE_REL = "scripts/test-typecheck-baseline.json";
const TSCONFIG_REL = "tsconfig.test.json";
const TSC_BIN = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const DEFAULT_HEAP_MB = 10240;

const UPDATE = process.argv.includes("--update-baseline");
const SELFTEST_ONLY = process.argv.includes("--selftest");
const REPORT_ONLY = process.argv.includes("--report");

/** يوحّد المسارات النسبية إلى صيغة POSIX من جذر المستودع. */
export function normalizeDiagnosticPath(rawPath, repoRoot = REPO_ROOT) {
  const cleaned = String(rawPath ?? "").trim();
  if (!cleaned) return "";
  const resolved = path.isAbsolute(cleaned)
    ? path.relative(repoRoot, cleaned)
    : cleaned;
  return resolved.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** يبني معاملات `tsc` مع تعطيل الكاش التزايديّ في بيئات CI الباردة لتقليص استهلاك الذاكرة. */
export function buildTscArgs(env = process.env) {
  const isColdCi =
    env.CI === "true" || env.CI === "1" || env.GITHUB_ACTIONS === "true";
  const args = [TSC_BIN, "-p", TSCONFIG_REL, "--noEmit", "--pretty", "false"];
  if (isColdCi) {
    args.push("--incremental", "false");
  }
  return args;
}

/** يضمن سقف ذاكرة كافٍ لشجرة الاختبارات حتّى لو ورثت العملية سقفاً أدنى من متغيّر خارجيّ. */
export function resolveCompilerNodeOptions(
  existingNodeOptions = process.env.NODE_OPTIONS ?? "",
  minHeapMb = DEFAULT_HEAP_MB,
) {
  const cleaned = String(existingNodeOptions ?? "").trim();
  const match = cleaned.match(/--max-old-space-size=(\d+)/);
  if (match) {
    const currentMb = Number.parseInt(match[1], 10);
    if (Number.isFinite(currentMb) && currentMb >= minHeapMb) {
      return cleaned;
    }
    return cleaned.replace(
      /--max-old-space-size=\d+/g,
      `--max-old-space-size=${minHeapMb}`,
    );
  }
  return `${cleaned} --max-old-space-size=${minHeapMb}`.trim();
}

/**
 * يحلّل مخرجات `tsc --pretty false` ويجمّع عدد الأخطاء لكل ملفّ.
 * الصيغة القياسية: `path/to/file.ts(line,col): error TSxxxx: message`
 */
export function parseTscDiagnostics(rawOutput, repoRoot = REPO_ROOT) {
  /** @type {Record<string, number>} */
  const counts = {};
  let globalErrorLines = 0;

  for (const rawLine of String(rawOutput ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fileMatch = line.match(/^(.+?)\(\d+,\d+\):\s+error\s+TS\d+:/);
    if (fileMatch) {
      const rel = normalizeDiagnosticPath(fileMatch[1], repoRoot);
      if (rel) {
        counts[rel] = (counts[rel] ?? 0) + 1;
      } else {
        globalErrorLines += 1;
      }
      continue;
    }
    if (/^error\s+TS\d+:/.test(line)) {
      globalErrorLines += 1;
    }
  }

  const sorted = Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
  return { counts: sorted, globalErrorLines };
}

/** يكتشف فشل تنفيذ `tsc` البنيوي (إعداد معطوب أو انهيار بلا تشخيصات ملفات). */
export function detectCompilerExecutionFailure({
  status,
  signal,
  error,
  parsed,
}) {
  if (error) {
    return `تعذّر تشغيل مترجم TypeScript: ${error.message || String(error)}`;
  }
  if (signal) {
    return `توقّف مترجم TypeScript بإشارة غير متوقعة (${signal}).`;
  }
  if (parsed.globalErrorLines > 0) {
    return `أبلغ مترجم TypeScript عن ${parsed.globalErrorLines} خطأ إعداد عام في ${TSCONFIG_REL}.`;
  }
  if (status !== 0 && Object.keys(parsed.counts).length === 0) {
    return `خرج مترجم TypeScript بالرمز ${String(status)} دون تشخيصات ملفات قابلة للتحليل.`;
  }
  return null;
}

/** يقارن خريطة الأخطاء الحالية بخطّ الأساس المجمَّد. */
export function evaluateTestTypeBaseline(current, baseline) {
  const findings = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline[file];
    if (allowed === undefined) {
      findings.push({
        file,
        count,
        allowed: 0,
        message: `${file}: ${count} خطأ نوع (ملفّ نظيف/جديد خارج خطّ الأساس — أصلِح الأنواع قبل الدفع)`,
      });
    } else if (count > allowed) {
      findings.push({
        file,
        count,
        allowed,
        message: `${file}: ${count} خطأ نوع (الأساس ${allowed}، +${count - allowed}) — ارتفعت أخطاء الأنواع`,
      });
    }
  }
  const stale = Object.keys(baseline).filter((file) => !(file in current));
  return { findings, stale };
}

function runSelfTest({ quiet }) {
  const fails = [];
  const eq = (name, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fails.push(`${name}: توقّعنا ${JSON.stringify(want)} فجاء ${JSON.stringify(got)}`);
    }
  };

  const sampleOut = [
    "server\\services\\__tests__\\sale.test.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "  Type 'string' is not assignable.",
    "server/services/__tests__/sale.test.ts(29,3): error TS2345: Argument of type '{}' is not assignable.",
    "client/src/pages/Storefront.test.tsx(8,10): error TS2304: Cannot find name 'foo'.",
  ].join("\r\n");

  const parsed = parseTscDiagnostics(sampleOut, REPO_ROOT);
  eq("تجميع أخطاء Windows وPOSIX لكل ملف", parsed.counts, {
    "client/src/pages/Storefront.test.tsx": 1,
    "server/services/__tests__/sale.test.ts": 2,
  });
  eq("لا أخطاء إعداد عامة في العيّنة", parsed.globalErrorLines, 0);

  eq(
    "يرفع سقف الذاكرة الموروث إن كان أقلّ من الحدّ الأدنى الآمن",
    resolveCompilerNodeOptions("--max-old-space-size=6144", 10240),
    "--max-old-space-size=10240",
  );
  eq(
    "يحافظ على سقف الذاكرة الأعلى إن وُجد",
    resolveCompilerNodeOptions("--max-old-space-size=12288", 10240),
    "--max-old-space-size=12288",
  );
  eq(
    "يعطّل الكاش التزايديّ في CI البارد لتقليص استهلاك الذاكرة",
    buildTscArgs({ CI: "true" }).slice(-2),
    ["--incremental", "false"],
  );
  eq(
    "يبقي الكاش التزايديّ محلياً لسرعة التكرار",
    buildTscArgs({}).includes("--incremental"),
    false,
  );

  const evalClean = evaluateTestTypeBaseline(
    { "server/a.test.ts": 2 },
    { "server/a.test.ts": 2, "server/cleaned.test.ts": 1 },
  );
  eq("ملفّ مطابق للأساس يمرّ", evalClean.findings.length, 0);
  eq("رصد الملفّ المنظَّف في stale", evalClean.stale, ["server/cleaned.test.ts"]);

  const evalRegressed = evaluateTestTypeBaseline(
    { "server/a.test.ts": 3, "server/new.test.ts": 1 },
    { "server/a.test.ts": 2 },
  );
  eq("يمسك الارتفاع والملفّ الجديد معاً", evalRegressed.findings.length, 2);

  const crashMsg = detectCompilerExecutionFailure({
    status: 2,
    signal: null,
    error: null,
    parsed: { counts: {}, globalErrorLines: 0 },
  });
  eq("يفشل مغلقاً عند انهيار tsc بلا تشخيصات", Boolean(crashMsg), true);

  const globalCfgMsg = detectCompilerExecutionFailure({
    status: 1,
    signal: null,
    error: null,
    parsed: parseTscDiagnostics("error TS5058: The specified path does not exist.", REPO_ROOT),
  });
  eq("يفشل مغلقاً عند خطأ إعداد TS5058", Boolean(globalCfgMsg), true);

  if (fails.length > 0) {
    console.error("✗ الاختبار الذاتيّ لحارس أنواع الاختبارات فشل:\n");
    for (const f of fails) console.error(`  ${f}`);
    process.exit(1);
  }
  if (!quiet) {
    console.log("✓ الاختبار الذاتيّ لحارس أنواع الاختبارات: كلّ الحالات سليمة.");
  }
}

runSelfTest({ quiet: !SELFTEST_ONLY });
if (SELFTEST_ONLY) process.exit(0);

if (!existsSync(path.join(REPO_ROOT, TSCONFIG_REL))) {
  console.error(`✗ ملفّ الإعداد ${TSCONFIG_REL} غير موجود.`);
  process.exit(1);
}
if (!existsSync(TSC_BIN)) {
  console.error(`✗ مترجم TypeScript غير موجود في ${TSC_BIN}. شغّل pnpm install أوّلاً.`);
  process.exit(1);
}

const nodeOptions = resolveCompilerNodeOptions(process.env.NODE_OPTIONS, DEFAULT_HEAP_MB);
const tscResult = spawnSync(
  process.execPath,
  buildTscArgs(process.env),
  {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
    },
  },
);

const combinedOutput = `${tscResult.stdout ?? ""}\n${tscResult.stderr ?? ""}`;
const parsed = parseTscDiagnostics(combinedOutput, REPO_ROOT);
const execFailure = detectCompilerExecutionFailure({
  status: tscResult.status,
  signal: tscResult.signal,
  error: tscResult.error,
  parsed,
});

if (execFailure) {
  console.error(`✗ ${execFailure}`);
  if (combinedOutput.trim()) {
    console.error(combinedOutput.trim().slice(0, 4000));
  }
  process.exit(1);
}

const current = parsed.counts;
const totalErrors = Object.values(current).reduce((sum, n) => sum + n, 0);
const fileCount = Object.keys(current).length;

if (UPDATE) {
  writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + "\n", "utf8");
  console.log(
    `✓ حُدِّث خطّ أساس أنواع الاختبارات (${BASELINE_REL}): ${fileCount} ملفّ · ${totalErrors} خطأ نوع.`,
  );
  process.exit(0);
}

if (REPORT_ONLY) {
  console.log(
    `تقرير أنواع الاختبارات (${TSCONFIG_REL}) — ${fileCount} ملفّ · ${totalErrors} خطأ نوع:\n`,
  );
  for (const [file, count] of Object.entries(current).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${file}`);
  }
  process.exit(0);
}

const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : {};

const { findings, stale } = evaluateTestTypeBaseline(current, baseline);

const descent = assertMonotonicDescent({
  baselinePath: BASELINE_REL,
  baseline,
  label: "أنواع الاختبارات",
});
if (!descent.ok) {
  console.error(descent.message);
  process.exit(1);
}

if (findings.length === 0) {
  console.log(
    `✓ حارس أنواع الاختبارات: لا تراجع في شجرة الاختبارات (${fileCount} ملفّ ضمن خطّ الأساس · ${totalErrors} إجمالاً).`,
  );
  if (!descent.skipped) console.log(descent.message);
  if (stale.length > 0) {
    console.log(
      `ℹ️  ${stale.length} ملفّ اختبار نظُف تماماً من أخطاء الأنواع — أنزِل خطّ الأساس بـ:`,
    );
    console.log("   node scripts/check-test-types.mjs --update-baseline");
    for (const f of stale.slice(0, 15)) console.log(`   - ${f}`);
    if (stale.length > 15) console.log(`   … و${stale.length - 15} غيرها`);
  }
  process.exit(0);
}

console.error(`✗ حارس أنواع الاختبارات — ${findings.length} انتهاك:\n`);
for (const f of findings.slice(0, 30)) console.error(`  ${f.message}`);
if (findings.length > 30) console.error(`  … و${findings.length - 30} غيرها`);
console.error(`
القاعدة: لا يدخل ملفّ اختبار جديد بأخطاء TypeScript، ولا ترتفع أخطاء ملفّ قائم عن خطّ الأساس.
خطّ الأساس التنازليّ: ${BASELINE_REL}
التحديث بعد تنظيف ملفّاتٍ فقط: node scripts/check-test-types.mjs --update-baseline
`);
process.exit(1);
