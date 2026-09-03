#!/usr/bin/env node
/**
 * مقياس الاحتكاك — عدّادُ العلل البنيوية المتكرّرة عبر النظام كلّه.
 *
 * السبب (فحصٌ شامل ٢/٩/٢٦، برنامج v2): الفحص الذرّي لكلّ الوحدات أثبت أنّ العلّة ليست في
 * وحدةٍ بعينها — بل **عللٌ بنيوية تتكرّر في الجميع بنفس الشكل**. ومن غير مقياسٍ آليّ يصير
 * كلّ ادّعاء ترشيقٍ **غير قابلٍ للتكذيب**، فتُنفَق جلساتٌ على تحسينٍ لا أحد يعرف أوقع أم لا.
 *
 * هذا الملفّ **مقياسٌ لا قاعدةَ أسلوب**: لا يقول «اكتب هكذا»، بل يعدّ كم مرّةً تكرّرت كلُّ
 * علّةٍ، ويُجمّد العدد، ويرفض ارتفاعه. ثمانيةُ محاور، كلٌّ منها بصمةٌ **بنيوية** لا نصّية:
 *
 *   D1 لحام المعاني        — جدولٌ يحمل حالتين متوازيتين أو أكثر
 *   D2 القاعدة المكرّرة     — مسندُ «رصيد الفاتورة المفتوح» مكتوباً بيدٍ في ملفٍّ بعد ملفّ
 *   D3 قرارٌ خارج السجلّ    — إجراءُ اعتماد/رفض غير مُسجَّلٍ في سجلّ القرارات
 *   D4 الشاشة العملاقة      — صفحةٌ فوق ١٢٠٠ سطر أو مكوّنٌ فوق ٤٠٠
 *   D5 انحراف الإنشاء/التعديل — شاشتان لنموذجٍ واحد (*New.tsx و*Edit.tsx)
 *   D6 تعدّد المفردات       — قاموسُ تسمياتٍ عربيّ محلّيّ داخل شاشة
 *   D7 السؤال عمّا يُعرَف    — `branchId` إلزاميّ في عقدٍ يعرفه الخادم من الفاعل
 *   D8 العكس غير الذرّي     — خدمةٌ تكتب عكسَها بيدها بدل محرّك العكس
 *
 * ⚠️ التعليقات تُجرَّد قبل أيّ مطابقةٍ نصّية: النثر العربيّ في هذا المستودع يشرح هذه العلل
 * توثيقياً في عشرات المواضع. حارسٌ يُنذر على تعليقٍ يُتجاوَز فيصير مسرحياً (CLAUDE.md §٤-ج).
 *
 * ⚠️ ولا يُقاس ما لا يُكتشَف يقيناً: «نسبة الأتمتة» و«الخطوة التالية» و«اللقطة قبل التعديل»
 * تحتاج سجلّاتٍ لم تُبنَ بعد (`shared/automationRegistry.ts` وأخواتها) — تُضاف محاورُها حين
 * تُبنى. عدُّ ما لا دليلَ عليه يُنتج رقماً يطمئن ولا يعني شيئاً.
 *
 * المِسنَنة **تنازلية** (scripts/ratchet-core.mjs): الأساس يُخفَّض أو يبقى، ولا يُرفَع أبداً.
 * التحديث بعد الترحيل: node scripts/check-friction.mjs --update-baseline
 * التقرير وحده (بلا حجب):  node scripts/check-friction.mjs --report
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMonotonicDescent } from "./ratchet-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BASELINE_PATH = path.join(__dirname, "friction-baseline.json");
const BASELINE_REL = "scripts/friction-baseline.json";

const UPDATE = process.argv.includes("--update-baseline");
const SELFTEST_ONLY = process.argv.includes("--selftest");
/** وضعُ التقرير: يطبع اللوحة ويخرج بـ0 دائماً. تُستعمل في الموجة صفر قبل التشديد. */
const REPORT_ONLY = process.argv.includes("--report");

// ───────────────────────────── أدوات مشتركة ─────────────────────────────

/**
 * يجرّد التعليقات (سطرية/كتلية/JSX) قبل المطابقة.
 * بسيطٌ عمداً: لا يحلّل السلاسل النصّية — ولو ابتلع تعليقاً داخل نصّ فالاتجاه آمن
 * (تقليلُ الإنذار الكاذب) لا العكس.
 */
export function stripComments(source) {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const SKIP_DIRS = new Set(["__tests__", "node_modules", "_legacy", "dist", ".git", "coverage"]);

function* walk(dir, extRe) {
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
      yield* walk(full, extRe);
    } else if (entry.isFile() && extRe.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
      yield full;
    }
  }
}

const relOf = (full) => path.relative(REPO_ROOT, full).replace(/\\/g, "/");
const countLines = (src) => src.split("\n").length;
const exists = (rel) => existsSync(path.join(REPO_ROOT, rel));

// ───────────────────── الكواشف (دوالُّ نقيّة قابلة للاختبار) ─────────────────────

/**
 * D1 — لحام المعاني: جدولٌ يحمل حالتين متوازيتين أو أكثر.
 * البصمة: عمودان `mysqlEnum` أو أكثر داخل كتلة `mysqlTable` واحدة، اسمُ كلٍّ منهما يدلّ
 * على حالة. صفٌّ بحالتين يعني معنيَين ملحومَين — ولا قيدَ في المخطّط على حاصل ضربهما.
 */
export function detectStatusFusion(schemaSource) {
  const src = stripComments(schemaSource);
  const out = new Map();
  // كتلةُ جدولٍ تبدأ بـ`export const x = mysqlTable("name", {` وتنتهي عند بداية الجدول التالي.
  const tableRe = /mysqlTable\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*,\s*\{/g;
  const starts = [];
  let m;
  while ((m = tableRe.exec(src)) !== null) starts.push({ name: m[1], at: m.index });
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i].at;
    const to = i + 1 < starts.length ? starts[i + 1].at : src.length;
    const body = src.slice(from, to);
    const enums = [...body.matchAll(/(\w+)\s*:\s*mysqlEnum\(/g)].map((x) => x[1]);
    const stateEnums = enums.filter((n) => /status|state$|state[A-Z_]/i.test(n));
    if (stateEnums.length >= 2) out.set(starts[i].name, stateEnums.length);
  }
  return out;
}

/**
 * D2 — القاعدة المكرّرة: مسندُ «رصيد الفاتورة المفتوح».
 * البصمة: `paidAmount` و`returnedTotal` في تعبيرٍ حسابيّ واحد. هذا المسند مكتوبٌ بيدٍ في
 * أكثر من عشرين ملفاً وقد **انحرف فعلاً** (أحدها أسقط `GREATEST`). مصدرُه الواحد يجب أن
 * يكون `shared/predicates/`.
 */
export function detectOpenBalancePredicate(source) {
  const src = stripComments(source);
  // نافذةٌ قصيرة تمنع التقاط ملفٍّ يذكر الاسمين في موضعين غير مترابطين.
  const re = /paidAmount[\s\S]{0,120}?returnedTotal|returnedTotal[\s\S]{0,120}?paidAmount/g;
  const hits = src.match(re) ?? [];
  // يُشترط وجودُ طرحٍ في النافذة نفسها — وإلّا فهو عرضٌ لا حساب.
  return hits.filter((h) => /-/.test(h)).length;
}

/**
 * D3 — إجراءُ قرارٍ في راوتر (اعتماد/رفض/حسم).
 *
 * ⚠️ **`approve: z.boolean()` حقلُ zod لا إجراء** — والنمطُ الأوّل كان يبتلعه فيعدّ
 * موضعَين وهميَّين في `purchaseRouter.ts` وحدَه (وهما داخل خطّ الأساس الأصليّ ٧٥).
 * حارسٌ يعدّ ما ليس علّةً يُنتج مقياساً لا يُصدَّق، فيُتجاوَز. لذلك يُستثنى `z.` صراحةً.
 */
export function detectDecisionProcedures(source) {
  const src = stripComments(source);
  const re = /^\s{2,}(approve|reject|decide)([A-Z]\w*)?\s*:\s*(?!z\s*\.)[A-Za-z_$]/gm;
  return [...src.matchAll(re)].map((x) => `${x[1]}${x[2] ?? ""}`);
}

/** D6 — قاموسُ تسمياتٍ عربيّ محلّيّ داخل شاشة (يجب أن يأتي من `shared/`). */
export function detectLocalLabelMap(source) {
  const src = stripComments(source);
  const re =
    /const\s+[A-Z][A-Z0-9_]*(?:LABEL|LABELS|_AR|_CLS|_TEXT)\b[^=]*=\s*\{[\s\S]{0,600}?\}/g;
  return (src.match(re) ?? []).filter((block) => /[؀-ۿ]/.test(block)).length;
}

/**
 * D7 — `branchId` إلزاميّ في عقد راوتر.
 * الخادم يعرف الفرع من `Actor`؛ وطلبُه من العميل تحصيلُ حاصلٍ وسطحُ هجوم — وسبعةُ مواضع
 * تقارنه بالمعروف ثمّ ترمي خطأً، أي أنّ الحقل موجودٌ ليُرفَض.
 */
export function detectRequiredBranchId(source) {
  const src = stripComments(source);
  const re = /branchId\s*:\s*z\s*\.\s*number\(\)((?:\s*\.\s*\w+\([^)]*\))*)/g;
  let n = 0;
  for (const m of src.matchAll(re)) {
    const chain = m[1] ?? "";
    if (!/\.(optional|nullish|nullable|default)\s*\(/.test(chain)) n += 1;
  }
  return n;
}

/**
 * D8 — خدمةٌ تكتب عكسَها بيدها: تُصدّر `cancel|reverse|correct|void` **وتكتب مالاً أو مخزوناً**.
 * الشرط المزدوج مقصود: دالّةُ إلغاءٍ لا تمسّ مالاً ولا مخزوناً ليست تنفيذَ عكسٍ ماليّ.
 */
export function detectHandWrittenReversal(source) {
  const src = stripComments(source);
  const declares =
    /export\s+(?:async\s+)?function\s+(cancel|reverse|correct|void)[A-Z]\w*/.test(src) ||
    /export\s+const\s+(cancel|reverse|correct|void)[A-Z]\w*\s*=/.test(src);
  const writes = /\bpostEntry\b/.test(src) || /\bapplyMovement\b/.test(src);
  return declares && writes ? 1 : 0;
}

// ───────────────────────────── جمع القياس ─────────────────────────────

/** سقوفُ الحجم — فوقها تُقسَّم الشاشة مكوّنياً (D4). */
const PAGE_LINE_CAP = 1200;
const COMPONENT_LINE_CAP = 400;

/** سجلّ القرارات — ما دام غائباً فكلُّ إجراءِ قرارٍ خارجه. */
const DECISION_REGISTRY_REL = "shared/decisionRegistry.ts";

function collect() {
  /** @type {Map<string, number>} مفتاحٌ مسطَّح `<محور>::<مفتاح>` ⇒ عدد. */
  const current = new Map();
  const axisTotals = new Map();
  const bump = (axis, key, n) => {
    if (n <= 0) return;
    current.set(`${axis}::${key}`, n);
    axisTotals.set(axis, (axisTotals.get(axis) ?? 0) + n);
  };

  // ── D1 — لحام الحالات في المخطّط
  const schemaPath = path.join(REPO_ROOT, "drizzle", "schema.ts");
  if (existsSync(schemaPath)) {
    for (const [table, n] of detectStatusFusion(readFileSync(schemaPath, "utf8"))) {
      bump("D1", table, n);
    }
  }

  // ── D2 · D3 · D7 · D8 — الخادم
  const serverRoot = path.join(REPO_ROOT, "server");
  const registered = loadRegisteredDecisions();
  const routerKeys = routerKeyByFile();
  for (const file of walk(serverRoot, /\.ts$/)) {
    const rel = relOf(file);
    const src = readFileSync(file, "utf8");

    bump("D2", rel, detectOpenBalancePredicate(src));

    if (rel.startsWith("server/routers/")) {
      // المطابقةُ بالزوج: إجراءٌ في راوترٍ لا مفتاحَ له في البرميل يبقى غيرَ مُسجَّل
      // (`routerKey` غيرُ معرَّف ⇒ المفتاح لا يطابق شيئاً) — وهو الصواب: راوترٌ خارج
      // البرميل لا يصله طلبٌ أصلاً، فوجودُ قرارٍ فيه إمّا شيفرةٌ ميتة أو تسجيلٌ ناقص.
      const routerKey = routerKeys.get(rel);
      const decisions = detectDecisionProcedures(src).filter((d) => !registered.has(`${routerKey}:${d}`));
      bump("D3", rel, decisions.length);
      bump("D7", rel, detectRequiredBranchId(src));
    }
    if (rel.startsWith("server/services/")) {
      bump("D8", rel, detectHandWrittenReversal(src));
    }
  }

  // ── D2 أيضاً في shared (المسند يُكتب هناك أحياناً)
  for (const file of walk(path.join(REPO_ROOT, "shared"), /\.ts$/)) {
    const rel = relOf(file);
    // ⚠️ **المصدرُ الواحد ليس تكراراً.** `shared/predicates/**` هي بالتعريف حيث يُكتب المسند
    // مرّةً واحدة ليُستورَد؛ عدُّها انتهاكاً يجعل الحارس يُنذر على العلاج نفسه — وحارسٌ
    // يُنذر كذباً يُتجاوَز فيصير مسرحياً (CLAUDE.md §٤-ج).
    if (rel.startsWith("shared/predicates/")) continue;
    bump("D2", rel, detectOpenBalancePredicate(readFileSync(file, "utf8")));
  }

  // ── D4 · D6 — الواجهة
  const pagesRoot = path.join(REPO_ROOT, "client", "src", "pages");
  const componentsRoot = path.join(REPO_ROOT, "client", "src", "components");
  for (const [root, cap] of [
    [pagesRoot, PAGE_LINE_CAP],
    [componentsRoot, COMPONENT_LINE_CAP],
  ]) {
    for (const file of walk(root, /\.tsx?$/)) {
      const rel = relOf(file);
      const src = readFileSync(file, "utf8");
      // العدد هو **الفائض فوق السقف** لا عددَ الأسطر: فيكون الرقم «كم سطراً فوق الميزانية»،
      // ويسقط الملفّ من المقياس حين يبلغ السقف. عدُّ الأسطر كاملةً كان يبتلع بقيّة المحاور.
      const excess = countLines(src) - cap;
      if (excess > 0) bump("D4", rel, excess);
      bump("D6", rel, detectLocalLabelMap(src));
    }
  }

  // ── D5 — ثنائيات إنشاء/تعديل
  for (const file of walk(pagesRoot, /New\.tsx$/)) {
    const rel = relOf(file);
    const editRel = rel.replace(/New\.tsx$/, "Edit.tsx");
    if (exists(editRel)) bump("D5", rel.replace(/New\.tsx$/, ""), 1);
  }

  return { current, axisTotals };
}

/**
 * خريطةُ ملفِّ الراوتر ⇐ مفتاحه في البرميل (`server/routers/purchaseRouter.ts` ⇐ `purchases`).
 * تُقرأ من `server/routers.ts` نفسِه: سطرُ الاستيراد يربط المتغيّر بالملفّ، ومدخلُ الكائن
 * يربط المتغيّر بالمفتاح. ⛔ ولا تُشتقّ بقصّ «Router» من الاسم — `purchaseRouter` مفتاحُه
 * `purchases` لا `purchase`، فالاشتقاق يُنتج مفاتيحَ لا وجودَ لها فيصير كلُّ شيءٍ غيرَ مُسجَّل.
 */
export function routerKeyByFile() {
  const out = new Map();
  const mounts = [];
  const files = [path.join(REPO_ROOT, "server/routers.ts")];
  const routersDir = path.join(REPO_ROOT, "server/routers");
  if (existsSync(routersDir)) files.push(...walk(routersDir, /\.ts$/));

  for (const p of files) {
    if (!existsSync(p)) continue;
    const rel = relOf(p);
    if (rel.includes("__tests__")) continue;
    const src = stripComments(readFileSync(p, "utf8"));
    const dir = path.posix.dirname(rel.split(path.sep).join("/"));

    // ⚠️ الأقواس تحمل أكثر من اسمٍ أحياناً (`{ voucherRouter, voucherCategoryRouter }`)
    // — ونمطُ الاسم الواحد كان يُسقط الملفَّ كلَّه فيصير «بلا مفتاح» ⇒ إنذارٌ كاذب.
    const varToFile = new Map();
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](\.[^"']*)["']/g)) {
      const target = path.posix.normalize(path.posix.join(dir, m[2])) + ".ts";
      for (const raw of m[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/).pop().trim();
        if (name) varToFile.set(name, target);
      }
    }
    // مفتاحُ التركيب المحلّيّ هو ما يستعمله السجلّ (`cashVariance` لا `treasury.cashVariance`)،
    // ولذلك نمسح الراوترات المتداخلة كما نمسح البرميل: `cashVarianceRouter` مُركَّبٌ داخل
    // `treasuryRouter` ولا يظهر في `server/routers.ts` إطلاقاً.
    for (const m of src.matchAll(/^\s+(\w+)\s*:\s*(\w+)\s*,?\s*$/gm)) {
      const file = varToFile.get(m[2]);
      if (file) mounts.push({ parent: rel.split(path.sep).join("/"), child: file, key: m[1] });
    }
  }

  // ⭐ **المسارُ الكامل لا المفتاح المحلّيّ**: `salesRouter` مُركَّبٌ مرّتين — مرّةً في الجذر
  // (`sales`) ومرّةً داخل البطاقات الرقمية (`digitalCards.sales`). فمفتاحٌ محلّيٌّ باسم
  // `sales` يُطابق الاثنين، وهي عينُ الفضفاضة التي نُغلقها. الجذرُ `server/routers.ts`.
  const byParent = new Map();
  for (const m of mounts) {
    if (!byParent.has(m.parent)) byParent.set(m.parent, []);
    byParent.get(m.parent).push(m);
  }
  const seen = new Set();
  const descend = (parentRel, prefix) => {
    if (seen.has(parentRel)) return; // حلقةٌ في التركيب — نقف بدل أن ندور
    seen.add(parentRel);
    for (const m of byParent.get(parentRel) ?? []) {
      const full = prefix ? `${prefix}.${m.key}` : m.key;
      if (!out.has(m.child)) out.set(m.child, full);
      descend(m.child, full);
    }
    seen.delete(parentRel);
  };
  descend("server/routers.ts", "");
  return out;
}

/**
 * أزواجُ (مفتاحُ الراوتر · اسمُ الإجراء) المُسجَّلة في سجلّ القرارات.
 *
 * ⭐ **كانت المطابقةُ بالاسم المجرَّد فكانت تكذب** (٣/٩/٢٦): تسجيلُ `"approve"` مرّةً واحدة
 * يُرضي الحارسَ عن **كلّ** `approve` في **كلّ** راوتر — وهي ثلاثةَ عشرَ موضعاً بقراراتٍ
 * مختلفة تماماً. فيبلغ `D3` صفرَه بينما إجراءُ قرارٍ جديدٌ باسمٍ عامّ يمرّ بلا إنذار.
 * ومقياسٌ يبلغ صفرَه بمطابقةٍ فضفاضة **أسوأ من غيابه**: يُعلن نصراً ويُطفئ الانتباه.
 * والسجلُّ يحمل `procedure: { router, name }` أصلاً — فلا عذرَ للمطابقة المجرَّدة.
 */
function loadRegisteredDecisions() {
  const p = path.join(REPO_ROOT, DECISION_REGISTRY_REL);
  if (!existsSync(p)) return new Set();
  const src = stripComments(readFileSync(p, "utf8"));
  // النقطةُ مقبولةٌ في المفتاح: المسارُ الكامل هو ما يُميّز `digitalCards.sales` عن `sales`.
  const pairRe = /router\s*:\s*["'`]([\w.]+)["'`]\s*,\s*name\s*:\s*["'`](\w+)["'`]/g;
  return new Set([...src.matchAll(pairRe)].map((x) => `${x[1]}:${x[2]}`));
}

const AXIS_LABEL = {
  D1: "لحام المعاني — جدولٌ بحالتين متوازيتين",
  D2: "القاعدة المكرّرة — مسندُ الرصيد المفتوح بيدٍ",
  D3: "قرارٌ خارج سجلّ القرارات",
  D4: `أسطرٌ فوق السقف — صفحة > ${PAGE_LINE_CAP} أو مكوّن > ${COMPONENT_LINE_CAP}`,
  D5: "انحراف الإنشاء/التعديل — شاشتان لنموذج",
  D6: "قاموسُ تسمياتٍ محلّيّ في شاشة",
  D7: "`branchId` إلزاميّ يعرفه الخادم",
  D8: "عكسٌ مكتوبٌ بيدٍ خارج محرّك العكس",
};
const AXES = Object.keys(AXIS_LABEL);

function printDashboard(axisTotals, current) {
  const fileCount = (axis) =>
    [...current.keys()].filter((k) => k.startsWith(`${axis}::`)).length;
  console.log("\n  المحور  الحالات  المواضع  العلّة");
  console.log("  ──────  ───────  ───────  " + "─".repeat(52));
  for (const axis of AXES) {
    const total = axisTotals.get(axis) ?? 0;
    console.log(
      `  ${axis.padEnd(6)}  ${String(total).padStart(7)}  ${String(fileCount(axis)).padStart(7)}  ${AXIS_LABEL[axis]}`,
    );
  }
  const grand = AXES.reduce((s, a) => s + (axisTotals.get(a) ?? 0), 0);
  console.log("  ──────  ───────  ───────  " + "─".repeat(52));
  console.log(`  ${"الإجمالي".padEnd(6)}  ${String(grand).padStart(7)}\n`);
}

// ───────────────────────────── الاختبار الذاتيّ ─────────────────────────────

function runSelfTest({ quiet }) {
  const fails = [];
  const eq = (name, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fails.push(`${name}: توقّعنا ${JSON.stringify(want)} فجاء ${JSON.stringify(got)}`);
    }
  };

  // D1
  const fusion = detectStatusFusion(`
    export const a = mysqlTable("receipts", {
      id: int("id"),
      status: mysqlEnum("status", ["A","B"]),
      approvalStatus: mysqlEnum("approvalStatus", ["C","D"]),
    });
    export const b = mysqlTable("clean", {
      status: mysqlEnum("status", ["A"]),
      name: varchar("name", { length: 10 }),
    });
  `);
  eq("D1 يمسك الجدول ذا الحالتين", fusion.get("receipts"), 2);
  eq("D1 لا يمسك جدولاً بحالةٍ واحدة", fusion.get("clean"), undefined);

  // D2
  eq("D2 يمسك المسند الحسابيّ", detectOpenBalancePredicate("const x = total - paidAmount - returnedTotal;"), 1);
  eq("D2 لا يمسك عرضاً بلا طرح", detectOpenBalancePredicate("select({ paidAmount, returnedTotal })"), 0);
  eq("D2 يتجاهل التعليقات", detectOpenBalancePredicate("// total - paidAmount - returnedTotal"), 0);

  // D3
  eq(
    "D3 يمسك إجراءات القرار",
    detectDecisionProcedures(`
  approve: managerProcedure
  rejectClose: adminProcedure
  decideControl: x
  approvedAt: timestamp()`),
    ["approve", "rejectClose", "decideControl"],
  );

  // D6
  eq(
    "D6 يمسك قاموساً عربياً محلّياً",
    detectLocalLabelMap('const STATUS_LABEL: Record<string,string> = { A: "مدفوعة", B: "معلّقة" };'),
    1,
  );
  eq("D6 لا يمسك قاموساً لاتينياً", detectLocalLabelMap('const X_LABEL = { A: "paid" };'), 0);

  // D7
  eq("D7 يمسك الإلزاميّ", detectRequiredBranchId("branchId: z.number().int().positive(),"), 1);
  eq("D7 لا يمسك الاختياريّ", detectRequiredBranchId("branchId: z.number().int().optional(),"), 0);
  eq("D7 لا يمسك ذا الافتراض", detectRequiredBranchId("branchId: z.number().default(1),"), 0);

  // D8
  eq(
    "D8 يمسك العكس اليدويّ",
    detectHandWrittenReversal("export async function cancelSale(){ await postEntry(x); }"),
    1,
  );
  eq(
    "D8 لا يمسك إلغاءً بلا أثرٍ ماليّ",
    detectHandWrittenReversal("export async function cancelDraft(){ await tx.update(x); }"),
    0,
  );

  if (fails.length > 0) {
    console.error("✗ الاختبار الذاتيّ لمقياس الاحتكاك فشل:\n");
    for (const f of fails) console.error(`  ${f}`);
    process.exit(1);
  }
  if (!quiet) console.log("✓ الاختبار الذاتيّ لمقياس الاحتكاك: كلّ الكواشف سليمة.");
}

// ───────────────────────────── التنفيذ ─────────────────────────────

runSelfTest({ quiet: !SELFTEST_ONLY });
if (SELFTEST_ONLY) process.exit(0);

const { current, axisTotals } = collect();

if (UPDATE) {
  const asObj = Object.fromEntries(
    [...current.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(BASELINE_PATH, JSON.stringify(asObj, null, 2) + "\n", "utf8");
  console.log(`✓ حُدِّث خطّ أساس الاحتكاك: ${current.size} موضعاً مجمَّداً.`);
  printDashboard(axisTotals, current);
  process.exit(0);
}

const BASELINE = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : {};

const findings = [];
for (const [key, count] of current) {
  const allowed = BASELINE[key] ?? 0;
  if (count > allowed) {
    const [axis, subject] = key.split("::");
    findings.push(
      allowed === 0
        ? `[${axis}] ${subject}: ${count} (الأساس ٠) ⇒ ${AXIS_LABEL[axis]}`
        : `[${axis}] ${subject}: ${count} (الأساس ${allowed}، +${count - allowed})`,
    );
  }
}

const descent = assertMonotonicDescent({
  baselinePath: BASELINE_REL,
  baseline: BASELINE,
  label: "مقياس الاحتكاك",
});

const stale = Object.keys(BASELINE).filter((k) => !current.has(k));

if (REPORT_ONLY) {
  console.log("مقياس الاحتكاك — تقريرٌ (لا يحجب):");
  printDashboard(axisTotals, current);
  if (findings.length > 0) {
    console.log(`ℹ️  ${findings.length} موضعاً فوق خطّ الأساس:`);
    for (const f of findings.slice(0, 30)) console.log(`   ${f}`);
    if (findings.length > 30) console.log(`   … و${findings.length - 30} غيرها`);
  } else {
    console.log("✓ لا موضعَ فوق خطّ الأساس.");
  }
  process.exit(0);
}

if (!descent.ok) {
  console.error(descent.message);
  process.exit(1);
}

if (findings.length === 0) {
  console.log(`✓ مقياس الاحتكاك ضمن خطّ الأساس — ${current.size} موضعاً.`);
  printDashboard(axisTotals, current);
  if (!descent.skipped) console.log(descent.message);
  if (stale.length > 0) {
    console.log(`ℹ️  ${stale.length} موضعاً نظيفاً يمكن حذفه من ${BASELINE_REL}:`);
    for (const k of stale.slice(0, 20)) console.log(`   - ${k}`);
    if (stale.length > 20) console.log(`   … و${stale.length - 20} غيرها`);
  }
  process.exit(0);
}

console.error(`✗ الاحتكاك ارتفع — ${findings.length} موضعاً فوق خطّ الأساس:\n`);
for (const f of findings.slice(0, 40)) console.error(`  ${f}`);
if (findings.length > 40) console.error(`  … و${findings.length - 40} غيرها`);
printDashboard(axisTotals, current);
console.error(`
القاعدة: هذه المحاور الثمانية تنزل ولا تصعد. لكلٍّ منها علاجٌ مُعرَّفٌ في خطة v2:

  D1 ⇒ صفٌّ واحد = معنًى واحد؛ حالةٌ مخزَّنةٌ واحدة وما عداها طوابعُ زمنية.
  D2 ⇒ المسند إلى shared/predicates/ ويُستورَد — لا يُعاد كتابته.
  D3 ⇒ سجِّل الإجراء في ${DECISION_REGISTRY_REL} ليظهر في صندوق القرار الموحّد.
  D4 ⇒ قسّم الشاشة مكوّنياً في نفس الشريحة (لا لاحقاً).
  D5 ⇒ محرّرٌ واحد بوضعين (RecordForm mode="create"|"edit").
  D6 ⇒ انقل القاموس إلى shared/terms.ts — لا شاشةَ تُعرّف مصطلحاً محلّياً.
  D7 ⇒ اجعل branchId اختيارياً؛ الخادم يشتقّه من Actor ويرفض ما خالفه صراحةً.
  D8 ⇒ سجّل آثار العملية واعكسها بمحرّك العكس الواحد.

خطّ الأساس (تنازليّ — لا يُرفَع): ${BASELINE_REL}
التحديث بعد الترحيل: node scripts/check-friction.mjs --update-baseline
`);
process.exit(1);
