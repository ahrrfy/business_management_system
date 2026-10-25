#!/usr/bin/env node
/**
 * حارس ومزامن الحقائق المعمارية الحيّة في `CLAUDE.md` (Wave D1).
 *
 * السبب:
 * كانت الأرقام الموثّقة في `CLAUDE.md` متجمّدة عند مرحلة مبكّرة (٢٢٥ صفحة، ٨٢ راوتراً،
 * ١٦٩ خدمة، ٢١٠ جداول، ١١ حارساً، شاردتَي CI، ١٠٠ اختبار وحدة) بينما الواقع تضاعف ٣–٥ مرّات
 * (٢٧٠+ صفحة، ٩٨ راوتراً في البرميل، ٧٤٠+ خدمة، ٣٤٣ جدولاً، ٤٩ حارساً، ٨ شاردات CI، ٥٩٠+ اختبار وحدة).
 *
 * كيف يعمل الحارس:
 *   • الثوابت البنيوية الحرجة (٠٪ تسامح — تفشل فوراً عند الانحراف):
 *       1) عدد شاردات الاختبار في `.github/workflows/ci.yml` يطابق المذكور في `CLAUDE.md`
 *          (`test-shard-1-of-<K>`..`<K>-of-<K>`).
 *       2) إذا وُجد `tsconfig.test.json` أو `check:test-types`، يجب أن يذكره `CLAUDE.md`
 *          بدل العبارة القديمة «خطأ النوع فيها يظهر عند vitest وحده».
 *       3) تطابق عددي ملفات الاختبار بين §٣ و§٥ في `CLAUDE.md`.
 *   • الأرقام الحجمية المتحرّكة (هامش تسامح ±١٠٪ بحدّ أدنى ±٣ لتجنّب تعارضات الدمج اليومية،
 *     مع فشلٍ فوريّ عند الانجراف المعماري):
 *       pages · barrelRouters · services · schemaTables · schemaLines ·
 *       trpcExports · guardsCount · testFiles · unitTestFiles.
 *   • وضع المزامنة (`node scripts/sync-architecture-facts.mjs --sync`):
 *       يحدّث الأرقام والعبارات المذكورة في `CLAUDE.md` بالأرقام الشرقية العربية الدقيقة دون المساس
 *       بأيّ قاعدة عمل أو قيد تشغيليّ (ولا يلمس `AGENTS.md` أبداً).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CLAUDE_MD_PATH = path.join(REPO_ROOT, "CLAUDE.md");

const SELFTEST_ONLY = process.argv.includes("--selftest");
const SYNC_MODE = process.argv.includes("--sync");
const REPORT_ONLY = process.argv.includes("--report");

const ARABIC_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
const MAX_DRIFT_RATIO = 0.1;
const MIN_DRIFT_FLOOR = 3;

export function toArabicDigits(n) {
  return String(Math.trunc(n)).replace(/\d/g, (d) => ARABIC_DIGITS[Number(d)]);
}

export function parseAnyDigits(str) {
  if (!str) return NaN;
  const western = String(str)
    .replace(/[٠-٩]/g, (ch) => String(ARABIC_DIGITS.indexOf(ch)))
    .replace(/[,٬\s]/g, "");
  return Number.parseInt(western, 10);
}

const SKIP_DIRS = new Set(["node_modules", "_legacy", "dist", ".git", "coverage"]);

function countFiles(rootDir, predicate, { skipTestsDir = false } = {}) {
  if (!existsSync(rootDir)) return 0;
  let count = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (skipTestsDir && entry.name === "__tests__") continue;
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && predicate(entry.name)) {
        count += 1;
      }
    }
  }
  return count;
}

export function collectLiveArchitectureFacts(repoRoot = REPO_ROOT) {
  // 1) صفحات الواجهة client/src/pages/**/*.tsx (دون الاختبارات)
  const pages = countFiles(
    path.join(repoRoot, "client", "src", "pages"),
    (name) => /\.tsx$/.test(name) && !/\.(?:test|spec)\.tsx$/.test(name),
    { skipTestsDir: true },
  );

  // 2) الراوترات المستورَدة في برميل server/routers.ts
  const routersBarrelSrc = readFileSync(path.join(repoRoot, "server", "routers.ts"), "utf8");
  const barrelRouters = [
    ...routersBarrelSrc.matchAll(/^\s*import\s+[\s\S]*?from\s*["']\.\/routers\/[^"']+["']/gm),
  ].length;

  // 3) ملفات الخدمات في server/services/**/*.ts (دون الاختبارات)
  const services = countFiles(
    path.join(repoRoot, "server", "services"),
    (name) => /\.ts$/.test(name) && !/\.(?:test|spec)\.ts$/.test(name),
    { skipTestsDir: true },
  );

  // 4) جداول وأسطر drizzle/schema.ts
  const schemaSrc = readFileSync(path.join(repoRoot, "drizzle", "schema.ts"), "utf8");
  const schemaTables = [...schemaSrc.matchAll(/\bmysqlTable\s*\(/g)].length;
  const schemaLines = schemaSrc.split(/\r?\n/).length;

  // 5) الإجراءات/الأدوات المُصدَّرة في server/trpc.ts
  const trpcSrc = readFileSync(path.join(repoRoot, "server", "trpc.ts"), "utf8");
  const trpcExports = [
    ...trpcSrc.matchAll(/^\s*export\s+(?:const|function)\s+[A-Za-z0-9_$]+/gm),
  ].length;

  // 6) عدد الحرّاس المسجّلين في check:guards أو run-guards.mjs
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const runGuardsPath = path.join(repoRoot, "scripts", "run-guards.mjs");
  let guardsCount = 0;
  const aggregate = String(pkg.scripts?.["check:guards"] ?? "");
  const inlineMatches = [...aggregate.matchAll(/pnpm (check:[a-z0-9-]+)/g)].map((m) => m[1]);
  if (inlineMatches.length > 0) {
    guardsCount = inlineMatches.length;
  } else if (existsSync(runGuardsPath)) {
    const runGuardsSrc = readFileSync(runGuardsPath, "utf8");
    const blockMatch = runGuardsSrc.match(/REGISTERED_GUARDS\s*=\s*\[([\s\S]*?)\]/);
    if (blockMatch) {
      guardsCount = [...blockMatch[1].matchAll(/["'](check:[a-z0-9-]+)["']/g)].length;
    }
  }

  // 7) إجمالي ملفات الاختبار في المستودع الرئيسي (client, server, shared, scripts, tests)
  let testFiles = 0;
  for (const sub of ["client", "server", "shared", "scripts", "tests"]) {
    testFiles += countFiles(
      path.join(repoRoot, sub),
      (name) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name),
    );
  }

  // 8) ملفات اختبارات الوحدة المسجّلة في vitest.unit.config.ts
  const unitCfgSrc = readFileSync(path.join(repoRoot, "vitest.unit.config.ts"), "utf8");
  const includeBlockMatch = unitCfgSrc.match(/include\s*:\s*\[([\s\S]*?)\]/);
  const unitTestFiles = includeBlockMatch
    ? [...includeBlockMatch[1].matchAll(/["']([^"']+\.(?:test|spec)\.[cm]?[jt]sx?)["']/g)].length
    : 0;

  // 9) شاردات الاختبار في .github/workflows/ci.yml
  const ciWorkflowSrc = readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const shardMatrixMatch = ciWorkflowSrc.match(/shard\s*:\s*\[([^\]]+)\]/);
  const ciShards = shardMatrixMatch
    ? shardMatrixMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean).length
    : 0;

  // 10) وجود حارس أنواع الاختبارات
  const hasTestTypecheck =
    existsSync(path.join(repoRoot, "tsconfig.test.json")) ||
    Boolean(pkg.scripts?.["check:test-types"]);

  return {
    pages,
    barrelRouters,
    services,
    schemaTables,
    schemaLines,
    trpcExports,
    guardsCount,
    testFiles,
    unitTestFiles,
    ciShards,
    hasTestTypecheck,
  };
}

export function extractDocumentedFacts(claudeMd) {
  const pick = (re) => {
    const m = claudeMd.match(re);
    return m ? parseAnyDigits(m[1]) : null;
  };
  const schemaMatch = claudeMd.match(
    /drizzle\/schema\.ts\s*\(([٠-٩0-9]+)\s*(?:جداول|جدولاً)،\s*([٠-٩0-9]+)\s*سطراً\)/,
  );
  const shardMatch = claudeMd.match(/test-shard-1-of-(\d+)/);

  let guardsDoc = pick(/pnpm check:guards\s+#\s*حزمة الحرّاس\s*\(([٠-٩0-9]+)\s*حارساً\)/);
  if (guardsDoc === null && /حزمة الحرّاس الأحد عشر/.test(claudeMd)) {
    guardsDoc = 11;
  }

  return {
    pages: pick(/client\/src\/pages\s*\(([٠-٩0-9]+)\s*صفحة/),
    barrelRouters: pick(/server\/routers\.ts\s*\(برميل يجمع\s*([٠-٩0-9]+)\s*راوتراً\)/),
    services: pick(/منطق الأعمال داخل withTx\s*\(([٠-٩0-9]+)\s*ملفاً\/حزمة\)/),
    schemaTables: schemaMatch ? parseAnyDigits(schemaMatch[1]) : null,
    schemaLines: schemaMatch ? parseAnyDigits(schemaMatch[2]) : null,
    trpcExports: pick(/مفردات التفويض = `server\/trpc\.ts`\*\*\s*\(([٠-٩0-9]+)\s*إجراءً مُصدَّراً/),
    guardsCount: guardsDoc,
    testFilesSection3: pick(/pnpm test\s+#\s*الحزمة الكاملة\s*\(vitest،\s*TZ=UTC،\s*([٠-٩0-9]+)\s*ملف اختبار\)/),
    unitTestFiles: pick(/pnpm test:unit\s+#\s*([٠-٩0-9]+)\s*ملف منطقيّ بلا قاعدة/),
    testFilesSection5: pick(/## ٥\. اتفاقيات الكود \(مُلزمة — يحرسها\s*([٠-٩0-9]+)\s*ملف اختبار/),
    ciShards: shardMatch ? Number.parseInt(shardMatch[1], 10) : null,
    hasStaleTwoShardProse: /يجزّئها على شاردتين/.test(claudeMd),
    mentionsTestTypecheck:
      claudeMd.includes("tsconfig.test.json") && claudeMd.includes("check:test-types"),
    hasStaleUntypedTestsClaim: claudeMd.includes("خطأ النوع فيها يظهر عند `vitest` وحده"),
  };
}

export function evaluateArchitectureDrift(live, doc) {
  const issues = [];

  const checkTolerance = (label, actual, documented) => {
    if (!Number.isFinite(documented)) {
      issues.push(`${label}: تعذّر استخراج الرقم الموثّق من CLAUDE.md (الواقع الحيّ: ${actual}).`);
      return;
    }
    const maxDelta = Math.max(MIN_DRIFT_FLOOR, Math.ceil(actual * MAX_DRIFT_RATIO));
    const delta = Math.abs(actual - documented);
    if (delta > maxDelta) {
      issues.push(
        `${label}: موثّق ${documented} بينما الواقع الحيّ ${actual} (الفرق ${delta} يتجاوز السقف المسموح ±${maxDelta}).`,
      );
    }
  };

  checkTolerance("صفحات الواجهة (client/src/pages)", live.pages, doc.pages);
  checkTolerance("راوترات البرميل (server/routers.ts)", live.barrelRouters, doc.barrelRouters);
  checkTolerance("ملفات الخدمات (server/services)", live.services, doc.services);
  checkTolerance("جداول المخطّط (drizzle/schema.ts)", live.schemaTables, doc.schemaTables);
  checkTolerance("أسطر المخطّط (drizzle/schema.ts)", live.schemaLines, doc.schemaLines);
  checkTolerance("إجراءات التفويض (server/trpc.ts)", live.trpcExports, doc.trpcExports);
  checkTolerance("عدد الحرّاس (check:guards)", live.guardsCount, doc.guardsCount);
  checkTolerance("ملفات الاختبار (§٣)", live.testFiles, doc.testFilesSection3);
  checkTolerance("ملفات الاختبار (§٥)", live.testFiles, doc.testFilesSection5);
  checkTolerance("اختبارات الوحدة (vitest.unit.config.ts)", live.unitTestFiles, doc.unitTestFiles);

  if (
    Number.isFinite(doc.testFilesSection3) &&
    Number.isFinite(doc.testFilesSection5) &&
    doc.testFilesSection3 !== doc.testFilesSection5
  ) {
    issues.push(
      `تضارب داخليّ في CLAUDE.md بين عدد ملفات الاختبار في §٣ (${doc.testFilesSection3}) و§٥ (${doc.testFilesSection5}).`,
    );
  }

  if (live.ciShards > 0 && doc.ciShards !== live.ciShards) {
    issues.push(
      `شاردات CI: موثّق test-shard-1-of-${doc.ciShards ?? "?"} بينما ci.yml يشغّل ${live.ciShards} شاردات.`,
    );
  }
  if (live.ciShards !== 2 && doc.hasStaleTwoShardProse) {
    issues.push(`شاردات CI: ما زال CLAUDE.md يقول «يجزّئها على شاردتين» بينما العدد الفعلي ${live.ciShards}.`);
  }

  if (live.hasTestTypecheck) {
    if (!doc.mentionsTestTypecheck || doc.hasStaleUntypedTestsClaim) {
      issues.push(
        "فحص أنواع الاختبارات: يجب أن يوثّق CLAUDE.md وجود `tsconfig.test.json` و`check:test-types` بدلاً من الادّعاء القديم بأنّ أنواع الاختبارات لا تفحصها tsc.",
      );
    }
  }

  return issues;
}

export function applyFactsToClaudeMd(claudeMd, live) {
  let out = claudeMd;

  out = out.replace(
    /client\/src\/pages\s*\([٠-٩0-9]+\s*صفحة،/,
    `client/src/pages (${toArabicDigits(live.pages)} صفحة،`,
  );
  out = out.replace(
    /server\/routers\.ts\s*\(برميل يجمع\s*[٠-٩0-9]+\s*راوتراً\)/,
    `server/routers.ts (برميل يجمع ${toArabicDigits(live.barrelRouters)} راوتراً)`,
  );
  out = out.replace(
    /منطق الأعمال داخل withTx\s*\([٠-٩0-9]+\s*ملفاً\/حزمة\)/,
    `منطق الأعمال داخل withTx (${toArabicDigits(live.services)} ملفاً/حزمة)`,
  );
  out = out.replace(
    /drizzle\/schema\.ts\s*\([٠-٩0-9]+\s*(?:جداول|جدولاً)،\s*[٠-٩0-9]+\s*سطراً\)/,
    `drizzle/schema.ts (${toArabicDigits(live.schemaTables)} جدولاً، ${toArabicDigits(live.schemaLines)} سطراً)`,
  );
  out = out.replace(
    /مفردات التفويض = `server\/trpc\.ts`\*\*\s*\([٠-٩0-9]+\s*إجراءً مُصدَّراً جاهزاً\)/,
    `مفردات التفويض = \`server/trpc.ts\`** (${toArabicDigits(live.trpcExports)} إجراءً مُصدَّراً جاهزاً)`,
  );
  out = out.replace(
    /pnpm check:guards\s+#\s*حزمة الحرّاس(?:\s*الأحد عشر|\s*\([٠-٩0-9]+\s*حارساً\))\s*—/,
    `pnpm check:guards                 # حزمة الحرّاس (${toArabicDigits(live.guardsCount)} حارساً) —`,
  );
  out = out.replace(
    /pnpm test\s+#\s*الحزمة الكاملة\s*\(vitest،\s*TZ=UTC،\s*[٠-٩0-9]+\s*ملف اختبار\)/,
    `pnpm test                         # الحزمة الكاملة (vitest، TZ=UTC، ${toArabicDigits(live.testFiles)} ملف اختبار)`,
  );
  out = out.replace(
    /pnpm test:unit\s+#\s*[٠-٩0-9]+\s*ملف منطقيّ بلا قاعدة/,
    `pnpm test:unit                    # ${toArabicDigits(live.unitTestFiles)} ملف منطقيّ بلا قاعدة`,
  );

  if (live.ciShards > 0) {
    out = out.replace(
      /\*\*وCI يجزّئها على (?:شاردتين|[٠-٩0-9]+ شاردات)\*\*\s*ب(?:قاعدتين معزولتين|قواعد معزولة)\s*\(`test-shard-1-of-\d+`(?:\.\.|\/)`(?:\d+-of-\d+|test-shard-\d+-of-\d+)`،\s*واتحادُه(?:ما|ا) الحزمةُ كاملةً بلا تداخل\)/,
      `**وCI يجزّئها على ${toArabicDigits(live.ciShards)} شاردات** بقواعد معزولة (\`test-shard-1-of-${live.ciShards}\`..\`${live.ciShards}-of-${live.ciShards}\`، واتحادُها الحزمةُ كاملةً بلا تداخل)`,
    );
  }

  if (live.hasTestTypecheck) {
    out = out.replace(
      /- ⚠️ \*\*`tsconfig\.json` يستثني `\*\*\/\*\.test\.ts`\*\* ⇒ [^\r\n]+/,
      "- ⚠️ **`tsconfig.json` يستثني `**/*.test.ts`** ⇒ `pnpm check` يفحص كود الإنتاج وحده، بينما يفحص `pnpm check:test-types` (`tsconfig.test.json`) أنواع جميع ملفات الاختبار بمِسنَنةٍ تنازلية (`scripts/test-typecheck-baseline.json`).",
    );
  }

  out = out.replace(
    /## ٥\. اتفاقيات الكود \(مُلزمة — يحرسها\s*[٠-٩0-9]+\s*ملف اختبار/,
    `## ٥. اتفاقيات الكود (مُلزمة — يحرسها ${toArabicDigits(live.testFiles)} ملف اختبار`,
  );

  return out;
}

function runSelfTest({ quiet = false } = {}) {
  const fails = [];
  const assert = (cond, msg) => {
    if (!cond) fails.push(msg);
  };

  assert(toArabicDigits(591) === "٥٩١", "تحويل الأرقام إلى العربية الشرقية");
  assert(parseAnyDigits("١٠٨٧٩") === 10879, "تحليل الأرقام العربية الشرقية");

  const sampleStale = [
    "client/src/pages (٢٢٥ صفحة، wouter + TanStack Query)",
    "   └─ client/src/lib/trpc.ts ──POST /api/trpc──▶ server/routers.ts (برميل يجمع ٨٢ راوتراً)",
    "             └─ server/services/*  : منطق الأعمال داخل withTx (١٦٩ ملفاً/حزمة)",
    "                  └─ drizzle/schema.ts (٢١٠ جداول، ١٠٨٧٩ سطراً) ──▶ MySQL 8",
    "- **مفردات التفويض = `server/trpc.ts`** (٨٠ إجراءً مُصدَّراً جاهزاً): نص",
    "pnpm check:guards                 # حزمة الحرّاس الأحد عشر — بوّابة ما قبل الدفع (§٣.١)",
    "pnpm test                         # الحزمة الكاملة (vitest، TZ=UTC، ٥٦٧ ملف اختبار)",
    "pnpm test:unit                    # ١٠٠ ملف منطقيّ بلا قاعدة — ثوانٍ، للتكرار السريع",
    "- `fileParallelism: false` — الملفات تتسلسل؛ لا تسريع بالتوازي. **وCI يجزّئها على شاردتين** بقاعدتين معزولتين (`test-shard-1-of-2`/`2-of-2`، واتحادُهما الحزمةُ كاملةً بلا تداخل)؛",
    "- ⚠️ **`tsconfig.json` يستثني `**/*.test.ts`** ⇒ `pnpm check` **لا** يفحص أنواع الاختبارات؛ خطأ النوع فيها يظهر عند `vitest` وحده.",
    "## ٥. اتفاقيات الكود (مُلزمة — يحرسها ٤٦٣ ملف اختبار + حرّاس §٣.١)",
  ].join("\n");

  const sampleLive = {
    pages: 272,
    barrelRouters: 98,
    services: 745,
    schemaTables: 343,
    schemaLines: 18787,
    trpcExports: 99,
    guardsCount: 49,
    testFiles: 1395,
    unitTestFiles: 591,
    ciShards: 8,
    hasTestTypecheck: true,
  };

  const beforeIssues = evaluateArchitectureDrift(sampleLive, extractDocumentedFacts(sampleStale));
  assert(beforeIssues.length >= 10, `توقّعنا كشف جميع الانحرافات فجاء ${beforeIssues.length}`);

  const syncedOnce = applyFactsToClaudeMd(sampleStale, sampleLive);
  const syncedTwice = applyFactsToClaudeMd(syncedOnce, sampleLive);
  assert(syncedOnce === syncedTwice, "applyFactsToClaudeMd يجب أن تكون عديمة الأثر عند التكرار (idempotent)");

  const afterIssues = evaluateArchitectureDrift(sampleLive, extractDocumentedFacts(syncedOnce));
  assert(afterIssues.length === 0, `بعد المزامنة يجب أن تختفي كل الانحرافات: ${afterIssues.join(" | ")}`);

  // التحقّق من هامش التسامح ±١٠٪: زيادة ٥ صفحات تمرّ دون تعارض دمج
  const slightlyGrownIssues = evaluateArchitectureDrift(
    { ...sampleLive, pages: 277 },
    extractDocumentedFacts(syncedOnce),
  );
  assert(slightlyGrownIssues.length === 0, "هامش التسامح ±١٠٪ يجب أن يمرّر التغيّر اليومي الطفيف");

  if (fails.length > 0) {
    console.error("✗ الاختبار الذاتيّ لحارس الحقائق المعمارية فشل:");
    for (const f of fails) console.error(`  - ${f}`);
    process.exit(1);
  }
  if (!quiet) {
    console.log("✓ الاختبار الذاتيّ لحارس الحقائق المعمارية (check:arch-facts): سليم.");
  }
}

function main() {
  runSelfTest({ quiet: !SELFTEST_ONLY });
  if (SELFTEST_ONLY) return;

  const live = collectLiveArchitectureFacts(REPO_ROOT);
  const currentClaude = readFileSync(CLAUDE_MD_PATH, "utf8");

  if (SYNC_MODE) {
    const updated = applyFactsToClaudeMd(currentClaude, live);
    if (updated !== currentClaude) {
      writeFileSync(CLAUDE_MD_PATH, updated, "utf8");
      console.log("✓ حُدِّثت الحقائق المعمارية الحيّة في CLAUDE.md بنجاح.");
    } else {
      console.log("✓ CLAUDE.md محدَّث مسبقاً بالحقائق الحيّة.");
    }
    const postIssues = evaluateArchitectureDrift(live, extractDocumentedFacts(updated));
    if (postIssues.length > 0) {
      console.error("✗ بقيت انحرافات بعد --sync:");
      for (const issue of postIssues) console.error(`  - ${issue}`);
      process.exit(1);
    }
    return;
  }

  const doc = extractDocumentedFacts(currentClaude);
  const issues = evaluateArchitectureDrift(live, doc);

  if (REPORT_ONLY) {
    console.log("الحقائق المعمارية الحيّة:", JSON.stringify(live, null, 2));
    console.log("الحقائق الموثّقة في CLAUDE.md:", JSON.stringify(doc, null, 2));
    if (issues.length > 0) {
      console.log(`ℹ️  ${issues.length} انحراف:`);
      for (const issue of issues) console.log(`  - ${issue}`);
    }
    return;
  }

  if (issues.length > 0) {
    console.error(`✗ انحراف الحقائق المعمارية في CLAUDE.md (${issues.length} موضع):\n`);
    for (const issue of issues) console.error(`  - ${issue}`);
    console.error(`\nالإصلاح بضغطة واحدة: node scripts/sync-architecture-facts.mjs --sync`);
    process.exit(1);
  }

  console.log(
    `✓ الحقائق المعمارية في CLAUDE.md متطابقة مع الواقع الحيّ (${live.pages} صفحة · ${live.barrelRouters} راوتر · ${live.services} خدمة · ${live.schemaTables} جدولاً · ${live.guardsCount} حارساً · ${live.ciShards} شاردات CI).`,
  );
}

main();
