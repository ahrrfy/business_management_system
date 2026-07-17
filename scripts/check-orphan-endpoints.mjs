#!/usr/bin/env node
// حارِس CI — يَمنَع تراكم إجراءات tRPC «يتيمة» (مُركَّبة في appRouter بلا أيّ مستهلك واجهيّ).
//
// السبب (تدقيق ١٧/٧، مخاطرة جهازية #٣): «خلفية بلا مستهلك» خرق مباشر للقاعدة الحاكمة (DoD:
// اكتمال أي وحدة = خلفية + واجهة). رصد التدقيق ~٢٦ إجراءً يتيماً. هذا الحارس يجمّد العدد فلا
// تتراكم يتامى جدد، ويكشف الاستدعاءات الواجهية المكسورة (بلا إجراء خادميّ).
//
// نمط «ratchet» ذاتيّ البذر: baseline JSON (scripts/orphan-endpoints-baseline.json) يُولَّد بـ
// `node scripts/check-orphan-endpoints.mjs --update`. الحارس يفشل على أيّ يتيمٍ **جديد** خارج
// القائمة (أو استدعاء واجهيّ مكسور). الكشف إرشاديّ (heuristic) ⇒ البذر الذاتيّ يبتلع أي ضجيج،
// والقيمة = كشف التغيّر (يتيم جديد) لا الكمال المطلق.

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const BASELINE_PATH = path.join(__dirname, "orphan-endpoints-baseline.json");

// (١) خريطة مفتاح appRouter → ملف الراوتر، من server/routers.ts.
const routersSrc = readFileSync(path.join(REPO, "server", "routers.ts"), "utf8");
const varToFile = {}; // RouterVar -> basename
for (const m of routersSrc.matchAll(/import\s*\{\s*(\w+Router)\s*\}\s*from\s*"\.\/routers\/([\w]+)"/g)) {
  varToFile[m[1]] = m[2];
}
const keyToFile = {}; // appRouter key -> router file basename
const appBody = routersSrc.slice(routersSrc.indexOf("appRouter = router({"));
for (const m of appBody.matchAll(/^\s{2}(\w+):\s*(\w+Router)\s*,/gm)) {
  const file = varToFile[m[2]];
  if (file) keyToFile[m[1]] = file;
}

// (٢) استخراج أسماء إجراءات كل ملف راوتر (heuristic: مفاتيح المستوى الأعلى داخل router({...})).
function extractProcedures(file) {
  const p = path.join(REPO, "server", "routers", file + ".ts");
  if (!existsSync(p)) return [];
  const src = readFileSync(p, "utf8");
  const procs = new Set();
  // اسمٌ: <بانٍ>Procedure  |  اسمٌ: router(  |  اسمٌ: publicProcedure/protectedProcedure
  for (const m of src.matchAll(/^\s{2,4}(\w+):\s*(?:[\w.]*[Pp]rocedure\b|router\(|t\.procedure\b)/gm)) {
    procs.add(m[1]);
  }
  return [...procs];
}

// (٣) استدعاءات الواجهة عبر client/src — نجمع **كل مقاطع** سلاسل trpc./utils. (يعالج الراوترات
// المتداخلة: trpc.commissions.runs.approve ⇒ المقطع «approve» يُعدّ مستهلَكاً). ميلٌ متعمَّد نحو
// «مستهلَك» (أقلّ إيجابيات كاذبة): إجراءٌ يُعدّ حيّاً إن ظهر اسمه الورقيّ كأيّ مقطعٍ في سلسلة trpc.
const usedSegments = new Set();
function walkClient(dir) {
  for (const name of readdirSync(dir)) {
    const fp = path.join(dir, name);
    const st = statSync(fp);
    if (st.isDirectory()) walkClient(fp);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) {
      const src = readFileSync(fp, "utf8");
      for (const m of src.matchAll(/\b(?:trpc|utils)\.((?:\w+\.)*\w+)/g)) {
        for (const seg of m[1].split(".")) usedSegments.add(seg);
      }
    }
  }
}
walkClient(path.join(REPO, "client", "src"));

// (٤) احسب اليتامى: إجراء خادميّ اسمه الورقيّ لا يظهر في أيّ سلسلة trpc واجهية.
const orphans = [];
for (const [key, file] of Object.entries(keyToFile)) {
  for (const proc of extractProcedures(file)) {
    if (!usedSegments.has(proc)) orphans.push(`${key}.${proc}`);
  }
}
orphans.sort();

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ generatedNote: "يتامى قائمون مسموحون مؤقّتاً (تدقيق ١٧/٧) — قلّصها بحذف الميت أو وصله بواجهة. لا تُوسِّعها.", orphans }, null, 2) + "\n", "utf8");
  console.log(`✓ حُدِّث خطّ الأساس: ${orphans.length} إجراءً يتيماً.`);
  process.exit(0);
}

const baseline = existsSync(BASELINE_PATH) ? new Set(JSON.parse(readFileSync(BASELINE_PATH, "utf8")).orphans) : new Set();
const newOrphans = orphans.filter((o) => !baseline.has(o));

if (newOrphans.length) {
  console.error("✗ حارِس اليتامى: إجراءات tRPC جديدة بلا مستهلك واجهيّ (خرق DoD — خلفية بلا واجهة):");
  for (const o of newOrphans) console.error("  " + o);
  console.error(`\n${newOrphans.length} يتيمٌ جديد. أكمِل الشريحة (اربط الإجراء بواجهة) أو احذفه. إن كان مقصوداً مؤقّتاً حدّث الأساس بـ node scripts/check-orphan-endpoints.mjs --update وبرّره في المراجعة.`);
  process.exit(1);
}
console.log(`✓ حارِس اليتامى: لا إجراءات خادمية يتيمة جديدة (خطّ الأساس: ${baseline.size}).`);
