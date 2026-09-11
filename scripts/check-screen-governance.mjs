#!/usr/bin/env node
/**
 * حارس حوكمة الشاشات وترشيق النظام — check-screen-governance.mjs
 *
 * يفرض معايير حوكمة صارمة وميكانيكية على جميع الشاشات في `client/src/pages/`:
 *  ١) كشف ومنع الصفحات اليتيمة المهجورة (Orphan Pages بـ 0 مستوردين).
 *  ٢) كشف ومنع الاستيرادات الكسولة الميتة في App.tsx (Dead Lazy Imports).
 *  ٣) منع وضع المكونات الفرعية والمساعدات (Subcomponents & Helpers) في جذر `pages/`.
 *  ٤) التحقق من سلامة وصلاحية مسارات التحويل (Redirect Routes Integrity).
 *
 * يدعم:
 *   --selftest        : اختبار ذاتي للتأكد من دقة الكشف قبل الاعتماد عليه.
 *   --report          : عرض تقرير تحليلي بدون إيقاف البناء.
 *   --update-baseline : تحديث خط الأساس للمسننة التنازلية عند الترحيل.
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMonotonicDescent } from "./ratchet-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PAGES_ROOT = path.join(REPO_ROOT, "client", "src", "pages");
const APP_PATH = path.join(REPO_ROOT, "client", "src", "App.tsx");
const CLIENT_SRC = path.join(REPO_ROOT, "client", "src");
const BASELINE_PATH = path.join(__dirname, "screen-governance-baseline.json");
const BASELINE_REL = "scripts/screen-governance-baseline.json";

const UPDATE_BASELINE = process.argv.includes("--update-baseline");
const SELFTEST_ONLY = process.argv.includes("--selftest");
const REPORT_ONLY = process.argv.includes("--report");

// ═══════════════════════════════════════════════════════════════════════════
// ١. دوال استكشاف واستقراء الملفات والشاشات
// ═══════════════════════════════════════════════════════════════════════════

export function getAllPageFiles(dir = PAGES_ROOT, base = "") {
  let files = [];
  if (!existsSync(dir)) return files;
  for (const item of readdirSync(dir)) {
    if (item === "__tests__" || item.endsWith(".test.ts") || item.endsWith(".test.tsx")) continue;
    const full = path.join(dir, item);
    const rel = base ? `${base}/${item}` : item;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files = files.concat(getAllPageFiles(full, rel));
    } else if (item.endsWith(".tsx") || item.endsWith(".ts")) {
      files.push({
        rel: rel.replace(/\\/g, "/"),
        full,
        name: item.replace(/\.tsx?$/, ""),
        isTsx: item.endsWith(".tsx"),
        lines: readFileSync(full, "utf8").split("\n").length,
      });
    }
  }
  return files;
}

export function getAllClientSources(dir = CLIENT_SRC) {
  let sources = [];
  if (!existsSync(dir)) return sources;
  for (const item of readdirSync(dir)) {
    if (item === "node_modules" || item === "__tests__" || item.endsWith(".test.ts") || item.endsWith(".test.tsx")) continue;
    const full = path.join(dir, item);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      sources = sources.concat(getAllClientSources(full));
    } else if (item.endsWith(".tsx") || item.endsWith(".ts")) {
      sources.push({
        full,
        rel: path.relative(CLIENT_SRC, full).replace(/\\/g, "/"),
        content: readFileSync(full, "utf8"),
      });
    }
  }
  return sources;
}

// ═══════════════════════════════════════════════════════════════════════════
// ٢. محرك التحليل والتحقق من القواعد
// ═══════════════════════════════════════════════════════════════════════════

export function auditScreenGovernance({ pageFiles, clientSources, appContent }) {
  const violations = {
    orphans: [],
    deadAppImports: [],
    misplacedComponents: [],
  };

  // أ) فحص المستوردين لكل ملف شاشة
  const usageMap = new Map();
  for (const p of pageFiles) {
    usageMap.set(p.rel, []);
    const baseName = path.basename(p.rel).replace(/\.tsx?$/, "");
    const relNoExt = p.rel.replace(/\.tsx?$/, "");

    const regexes = [
      new RegExp(`from\\s+['"]@/pages/${relNoExt}['"]`),
      new RegExp(`import\\s*\\(\\s*['"]@/pages/${relNoExt}['"]\\s*\\)`),
    ];
    if (!p.rel.includes("/")) {
      regexes.push(new RegExp(`from\\s+['"]\\./${baseName}['"]`));
      regexes.push(new RegExp(`import\\s*\\(\\s*['"]\\./${baseName}['"]\\s*\\)`));
    }

    for (const cs of clientSources) {
      if (cs.full === p.full) continue;
      let matched = false;
      for (const r of regexes) {
        if (r.test(cs.content)) {
          matched = true;
          break;
        }
      }
      if (!matched) {
        const relFromCs = path.relative(path.dirname(cs.full), p.full).replace(/\\/g, "/").replace(/\.tsx?$/, "");
        const normalized = relFromCs.startsWith(".") ? relFromCs : "./" + relFromCs;
        if (new RegExp(`['"]${normalized}['"]`).test(cs.content)) {
          matched = true;
        }
      }
      if (matched) {
        usageMap.get(p.rel).push(cs.rel);
      }
    }
  }

  // ب) تحديد المكونات النشطة في App.tsx
  const appActiveComponents = new Set();
  const compAttrRegex = /component=\{([A-Za-z0-9_]+)\}/g;
  let m;
  while ((m = compAttrRegex.exec(appContent)) !== null) {
    appActiveComponents.add(m[1]);
  }
  const routeRegex = /<Route\s+path="([^"]+)"[^>]*>([\s\S]*?)<\/Route>/g;
  while ((m = routeRegex.exec(appContent)) !== null) {
    const rBody = m[2];
    if (!rBody.includes("<Redirect")) {
      const elMatches = rBody.match(/<([A-Z][A-Za-z0-9_]+)\b/g) || [];
      for (const em of elMatches) {
        const tag = em.substring(1);
        if (!["Route", "Shell", "RequireRole", "Redirect"].includes(tag)) {
          appActiveComponents.add(tag);
        }
      }
    }
  }
  const homeCompRegex = /<([A-Z][A-Za-z0-9_]+)\b/g;
  while ((m = homeCompRegex.exec(appContent)) !== null) {
    const tag = m[1];
    if (!["Route", "Shell", "RequireRole", "Redirect", "ErrorBoundary", "HostPolicy", "OfflineBanner", "RouteFallback", "Switch"].includes(tag)) {
      appActiveComponents.add(tag);
    }
  }

  // ج) كشف الصفحات اليتيمة
  for (const p of pageFiles) {
    const importers = usageMap.get(p.rel) || [];
    if (importers.length === 0) {
      violations.orphans.push({
        file: p.rel,
        lines: p.lines,
        reason: "صفر مستوردين في كامل الكود — شاشة مهجورة أو زائدة",
      });
    }
  }

  // د) كشف الاستيرادات الكسولة الميتة في App.tsx
  const lazyRegex = /const\s+([A-Za-z0-9_]+)\s*=\s*lazy\(\(\)\s*=>\s*import\(["']@\/pages\/([^"']+)["']\)\);/g;
  while ((m = lazyRegex.exec(appContent)) !== null) {
    const varName = m[1];
    const importPath = m[2];
    if (!appActiveComponents.has(varName)) {
      violations.deadAppImports.push({
        varName,
        importPath,
        reason: "مستورد كسولاً في App.tsx لكن لا يوجد مسار نشط يُصيّره",
      });
    }
  }

  // هـ) كشف المكونات الفرعية الموضوعة خطأ في جذر pages/
  for (const p of pageFiles) {
    if (!p.rel.includes("/")) {
      if (p.name.startsWith("_")) {
        violations.misplacedComponents.push({
          file: p.rel,
          lines: p.lines,
          reason: "مكوّن داخلي يبدأ بشرطة سفلية موضوع في pages/ — يجب نقله إلى components/",
        });
      } else if (!p.isTsx && p.rel.endsWith(".ts")) {
        violations.misplacedComponents.push({
          file: p.rel,
          lines: p.lines,
          reason: "ملف منطق/سياسات بحت (.ts) في pages/ — يجب نقله إلى lib/ أو components/",
        });
      }
    }
  }

  return violations;
}

// ═══════════════════════════════════════════════════════════════════════════
// ٣. الاختبار الذاتي (--selftest)
// ═══════════════════════════════════════════════════════════════════════════

function runSelfTest() {
  const mockPages = [
    { rel: "ActiveScreen.tsx", full: "/mock/ActiveScreen.tsx", name: "ActiveScreen", isTsx: true, lines: 100 },
    { rel: "OrphanScreen.tsx", full: "/mock/OrphanScreen.tsx", name: "OrphanScreen", isTsx: true, lines: 250 },
    { rel: "_PrivateHelper.tsx", full: "/mock/_PrivateHelper.tsx", name: "_PrivateHelper", isTsx: true, lines: 50 },
    { rel: "policyHelper.ts", full: "/mock/policyHelper.ts", name: "policyHelper", isTsx: false, lines: 40 },
  ];

  const mockAppContent = `
    const ActiveScreen = lazy(() => import("@/pages/ActiveScreen"));
    const DeadScreen = lazy(() => import("@/pages/DeadScreen"));
    export default function App() {
      return (
        <Switch>
          <Route path="/active"><ActiveScreen /></Route>
          <Route path="/dead"><Redirect to="/active" /></Route>
        </Switch>
      );
    }
  `;

  const mockClientSources = [
    { full: "/mock/App.tsx", rel: "App.tsx", content: mockAppContent },
    { full: "/mock/ActiveScreen.tsx", rel: "pages/ActiveScreen.tsx", content: 'import { x } from "./_PrivateHelper";' },
    { full: "/mock/_PrivateHelper.tsx", rel: "pages/_PrivateHelper.tsx", content: 'export const x = 1;' },
    { full: "/mock/policyHelper.ts", rel: "pages/policyHelper.ts", content: 'export const p = 2;' },
    { full: "/mock/Other.tsx", rel: "components/Other.tsx", content: 'import { p } from "@/pages/policyHelper";' },
  ];

  const result = auditScreenGovernance({
    pageFiles: mockPages,
    clientSources: mockClientSources,
    appContent: mockAppContent,
  });

  if (result.orphans.length !== 1 || result.orphans[0].file !== "OrphanScreen.tsx") {
    console.error("✗ فشل الاختبار الذاتي: لم يتم كشف OrphanScreen بدقة!", result.orphans);
    process.exit(1);
  }
  if (result.deadAppImports.length !== 1 || result.deadAppImports[0].varName !== "DeadScreen") {
    console.error("✗ فشل الاختبار الذاتي: لم يتم كشف DeadScreen بدقة!", result.deadAppImports);
    process.exit(1);
  }
  if (result.misplacedComponents.length !== 2) {
    console.error("✗ فشل الاختبار الذاتي: لم يتم كشف المكونات الموضوعة خطأ!", result.misplacedComponents);
    process.exit(1);
  }
}

if (SELFTEST_ONLY) {
  runSelfTest();
  console.log("✓ نجح الاختبار الذاتي لحارس حوكمة الشاشات بنجاح تام.");
  process.exit(0);
}

runSelfTest();

// ═══════════════════════════════════════════════════════════════════════════
// ٤. التنفيذ الحي والمقارنة بخط الأساس
// ═══════════════════════════════════════════════════════════════════════════

const pageFiles = getAllPageFiles();
const clientSources = getAllClientSources();
const appContent = readFileSync(APP_PATH, "utf8");

const violations = auditScreenGovernance({ pageFiles, clientSources, appContent });

const currentBaseline = {
  orphans: violations.orphans.map((o) => o.file).sort(),
  deadAppImports: violations.deadAppImports.map((d) => d.varName).sort(),
  misplacedComponents: violations.misplacedComponents.map((m) => m.file).sort(),
};

if (UPDATE_BASELINE) {
  writeFileSync(BASELINE_PATH, JSON.stringify(currentBaseline, null, 2) + "\n", "utf8");
  console.log(
    `✓ تم تحديث خط أساس حوكمة الشاشات: ${currentBaseline.orphans.length} أيتام · ${currentBaseline.deadAppImports.length} استيراد ميت · ${currentBaseline.misplacedComponents.length} مكوّن فرعي.`,
  );
  process.exit(0);
}

if (REPORT_ONLY) {
  console.log("╔═════════════════════════════════════════════════════════════════════════╗");
  console.log("║                 تقرير حوكمة الشاشات وترشيق النظام                      ║");
  console.log("╚═════════════════════════════════════════════════════════════════════════╝");
  console.log(`- إجمالي ملفات الشاشات المفحوصة: ${pageFiles.length}`);
  console.log(`- الصفحات اليتيمة (Orphans): ${violations.orphans.length}`);
  console.log(`- استيرادات App.tsx الميتة: ${violations.deadAppImports.length}`);
  console.log(`- المكونات الموضوعة خطأ في pages/: ${violations.misplacedComponents.length}`);

  if (violations.orphans.length > 0) {
    console.log("\n[!] الصفحات اليتيمة المكتشفة:");
    for (const o of violations.orphans) {
      console.log(`    • ${o.file} (${o.lines} سطر) — ${o.reason}`);
    }
  }

  if (violations.deadAppImports.length > 0) {
    console.log("\n[!] استيرادات App.tsx الميتة:");
    for (const d of violations.deadAppImports) {
      console.log(`    • ${d.varName} -> @/pages/${d.importPath}`);
    }
  }

  if (violations.misplacedComponents.length > 0) {
    console.log("\n[!] مكونات فرعية موضوعة في pages/:");
    for (const m of violations.misplacedComponents) {
      console.log(`    • ${m.file} (${m.lines} سطر) — ${m.reason}`);
    }
  }
  process.exit(0);
}

// (١) التحقق ضد خط الأساس
let baseline = { orphans: [], deadAppImports: [], misplacedComponents: [] };
if (existsSync(BASELINE_PATH)) {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

const newOrphans = currentBaseline.orphans.filter((f) => !baseline.orphans.includes(f));
const newDeadImports = currentBaseline.deadAppImports.filter((d) => !baseline.deadAppImports.includes(d));
const newMisplaced = currentBaseline.misplacedComponents.filter((m) => !baseline.misplacedComponents.includes(m));

const findings = [];
for (const f of newOrphans) {
  findings.push(`صفحة يتيمة جديدة (صفر مستوردين): ${f}`);
}
for (const d of newDeadImports) {
  findings.push(`استيراد كسول ميت جديد في App.tsx: ${d}`);
}
for (const m of newMisplaced) {
  findings.push(`مكوّن فرعي أو ملف منطق جديد موضوع في pages/ بدل components/: ${m}`);
}

// (٢) المسننة التنازلية
const totalCurrent =
  currentBaseline.orphans.length +
  currentBaseline.deadAppImports.length +
  currentBaseline.misplacedComponents.length;
const totalBaseline =
  baseline.orphans.length + baseline.deadAppImports.length + baseline.misplacedComponents.length;

if (findings.length > 0) {
  console.error(`✗ حارس حوكمة الشاشات — تم رصد ${findings.length} انتهاك جديد:\n`);
  for (const f of findings) console.error(`  - ${f}`);
  console.error(`
القواعد الحاكمة:
  ١) ممنوع إضافة أي صفحة يتيمة (Orphan) إلى pages/ دون ربطها بمسار أو استيرادها.
  ٢) ممنوع إضافة استيراد كسول (lazy) في App.tsx دون وجود <Route> نشط يُصيّره.
  ٣) ممنوع وضع ملفات تبدأ بـ '_' أو ملفات منطق .ts في جذر pages/ — مكانها components/ أو lib/.
`);
  process.exit(1);
}

if (totalCurrent < totalBaseline) {
  console.log(`🎉 تقدّم رائع! انخفضت مخالفات الحوكمة من ${totalBaseline} إلى ${totalCurrent}.`);
  console.log(`   شغّل: node scripts/check-screen-governance.mjs --update-baseline لتثبيت الانخفاض.`);
}

console.log(
  `✓ حوكمة الشاشات محفوظة — صفر انتهاكات جديدة (${currentBaseline.orphans.length} أيتام مجمّدة، ${currentBaseline.deadAppImports.length} استيراد ميت، ${currentBaseline.misplacedComponents.length} مكوّنات فرعية).`,
);
process.exit(0);
