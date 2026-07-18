#!/usr/bin/env node
// حارِس CI — يَمنَع بناء **حدود اليوم بمكوّناتٍ محلية** (تابعة لمنطقة عملية Node) في الخادم.
//
// السبب (تدقيق ١٧/٧، مخاطرة جهازية #٧): النظام يفرض TZ=UTC واتصال القاعدة timezone:"Z"، فـ«اليوم
// التجاريّ» = يوم UTC. لكن أنماطاً مثل `new Date(); d.setHours(0,0,0,0)` أو
// `new Date(x.getFullYear(), x.getMonth(), x.getDate())` تَبني الحدود بمنطقة عملية Node، فتنزاح ثلاث
// ساعات (بل يوماً كاملاً قرب منتصف الليل) على أي جهاز يعمل بغير TZ=UTC (تشغيل يدويّ بلا cross-env،
// أو جهاز متجرٍ بمنطقة بغداد). المصدر الواحد الصحيح: server/services/businessDay.ts (بناءٌ بـDate.UTC).
//
// النمط الصحيح: استورد من businessDay — utcDayStart/utcNextDayStart/utcTodayStart/todayUtcDate/utcDayRange،
// أو ابنِ صراحةً بـ`Date.UTC(...)` / `.setUTCHours(...)`. «اليوم بتوقيت بغداد» (منطق «فعّال اليوم» للمتجر)
// له baghdadToday() صراحةً وهو حتميّ (Date.now()+offset ⇒ toISOString، مستقلّ عن المنطقة) — غير مشمول.
//
// النطاق: server/routers/** + server/services/** (تجاهُل *.test.ts والتعليقات وبيتَي المصدر المُصرَّح
// بهما businessDay.ts/dateRange.ts). خطّ الأساس فارغ — الشجرة نظيفة بعد ترحيل المخاطرة #٧.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ROOTS = [path.join(REPO_ROOT, "server", "routers"), path.join(REPO_ROOT, "server", "services")];

// البيوت المصرَّح بها لبناء الحدود (businessDay مصدر الحقيقة، dateRange يفوّض إليه).
const ALLOWED = new Set(["businessDay.ts", "dateRange.ts"]);

// الأنماط الخطِرة (بناء حدّ يومٍ بمكوّناتٍ محلية — تابعة لمنطقة Node):
const PATTERNS = [
  // ١) اقتطاع منتصف الليل محلياً: d.setHours(0,0,0,0). (setUTCHours حتميّ ⇒ غير مشمول.)
  { re: /\.setHours\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/, why: "اقتطاعُ منتصف ليلٍ محليّ (setHours) — استعمل .setUTCHours أو utcTodayStart()/utcDayStart()" },
  // ٢) بناء Date من قِيَم مُشتقّة بجالِبات محلية: new Date(x.getFullYear(), x.getMonth(), ...).
  { re: /new Date\([^;]*?\.get(?:FullYear|Month|Date)\(\)\s*,/, why: "بناءُ Date بمكوّنات محلية (getFullYear/Month/Date) — استعمل Date.UTC أو businessDay" },
  // ٣) بناء Date من قِيَم حرفية: new Date(2026, 6, 17). (يُفسَّر بمنطقة Node.)
  { re: /new Date\(\s*\d{4}\s*,\s*\d{1,2}\s*,/, why: "بناءُ Date بمكوّنات حرفية محلية — استعمل Date.UTC(y, m, d)" },
];

// خطّ الأساس: فارغ. التوقيع = basename|السطرُ مطبَّعُ المسافات. لا تُضِف — رَحِّل النمط بدلاً من إسكاته.
const BASELINE = new Set([]);

function normSig(base, trimmedLine) {
  return base + "|" + trimmedLine.replace(/\s+/g, " ").trim();
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const violations = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const base = path.basename(file);
    if (ALLOWED.has(base)) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return; // تعليق
      const hit = PATTERNS.find((p) => p.re.test(line));
      if (!hit) return;
      const sig = normSig(base, trimmed);
      if (BASELINE.has(sig)) return;
      violations.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: ${hit.why}`);
    });
  }
}

if (violations.length) {
  console.error("✗ حارِس حدود اليوم: بناءُ حدّ يومٍ بمكوّناتٍ محلية جديد (يَنزاح على غير TZ=UTC):");
  for (const v of violations) console.error("  " + v);
  console.error(`\n${violations.length} انتهاك جديد. استورد من server/services/businessDay.ts (utcDayStart/utcNextDayStart/utcTodayStart/todayUtcDate) أو ابنِ بـDate.UTC — لا تبنِ حدود اليوم بمكوّناتٍ محلية.`);
  process.exit(1);
}
console.log("✓ حارِس حدود اليوم: لا بناءَ حدّ يومٍ بمكوّناتٍ محلية جديد.");
