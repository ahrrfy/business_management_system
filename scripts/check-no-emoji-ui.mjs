#!/usr/bin/env node
// حارِس CI — يَفشَل لو ظَهَر إيموجي في واجِهة المُستَخدِم خارِج allowlist.
// السَبب: التَدقيق العَدائي ٢٣/٦/٢٦ كَشَف ١٦ ثَغرة بَصَرية اِنزَلَقَت عَبر مَوجات سابِقة
// لأَن المَسح اعتَمَدَ بَحث ملَفّات بِالاسم وَلَم يُغَطِّ نِطاق يونيكود الإيموجي الكامِل.
//
// النَطاق: client/src/**/*.{ts,tsx} حَصراً (تَجاهُل tests/node_modules/_legacy/docs).
// نَطاق الإيموجي يونيكود الذي يَرفُضه:
//   U+1F300–U+1FAFF (Symbols & Pictographs، Emoticons، Transport، Supplemental)
//   U+2600–U+27BF (Miscellaneous Symbols, Dingbats — بِما فيها ⚠ ⚡ ✓ ✗ ⏰ ⏳ ⭐ إلخ)
//   U+1F1E6–U+1F1FF (Regional Indicators — أَعلام)
// مَع تَحييد المُعدِّلات (Variation Selector، Skin Tone) إن لَزِم.
//
// الـallowlist يَحتَوي مَواقِع مَسموحة بِالقَرار (مَوَثَّقة في الذاكِرة):
//   - WorkOrders CHANNELS — قَنوات الاستِلام (📱💬📞 لِواتساب/فيسبوك/هاتف)
//   - رَسائِل واتساب البُناة — sanitizeForWhatsApp يَنزَع تِلقائياً
//   - مَلَفّات الاختبارات
//   - _legacy/ — مُؤرشَف
//
// إخراج: قائِمة مَوقِع:سَطر:النَصّ. exit 1 لو وُجِدَت ثَغرة.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src");

// السُطور المَسموحة (allowlist) — كل عُنصُر = { file: نَمَط جُزئي، lineHint?: نِطاق سُطور } */
const ALLOW = [
  // CHANNELS في WorkOrders — قَنوات الاستِلام، مَتروكة بِقَرار صَريح
  { file: "client/src/pages/WorkOrders.tsx", reason: "CHANNELS قَنوات الاستِلام (٧/٢٢/٢٦)" },
  { file: "client/src/pages/WorkOrderNew.tsx", reason: "CHANNELS قَنوات الاستِلام" },
  { file: "client/src/pages/WorkOrderStation.tsx", reason: "CHANNELS قَنوات الاستِلام" },
  { file: "client/src/pages/WorkOrderDetail.tsx", reason: "CHANNELS قَنوات الاستِلام" },
];

// أَسطُر مَسموحة فِي WO فَقَط لِأَن CHANNELS مُعَرَّفة كَ const CHANNELS = {...}
// نَتسامَح عِندَ مُطابَقَة "CHANNELS" أَو ".icon" قَريبَة في السَطر.
function isWorkOrderChannelLine(filePath, line) {
  if (!/WorkOrder/.test(filePath)) return false;
  // CHANNELS مُعَرَّفة كَ object literal، الأسطر فيها شكل { label: "...", icon: "..." } أَو الاستِخدام c.icon.
  if (/CHANNELS\b|c\.icon|ch\.icon|channel.*icon/.test(line)) return true;
  // member lines: { v: "X", label: "Y", icon: "..." } أَو { label: "Y", icon: "..." }
  if (/label:\s*"[^"]*"/.test(line) && /icon:\s*"/.test(line)) return true;
  return false;
}

// نَطاق الإيموجي:
//   - Variation Selectors U+FE0E/FE0F، Skin tones U+1F3FB-1F3FF، ZWJ U+200D ⇒ نُهمِلها قَبل المُطابَقة
//   - نَطاق المُحارَف الرَئيسي
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}]/u;
// أَيضاً أَسطُر بِها رَموز مُعَيَّنة شائِعة لَيسَت في النَطاق أَعلاه:
//   ▶ ▼ ◀ ▲ U+25B6/25BC/25C0/25B2 — تَعتَبَر pictographic، نَمنَعُها أَيضاً
const ARROW_GLYPHS = /[\u{25B0}-\u{25FF}\u{2B00}-\u{2BFF}]/u;

const COMBINED_RE = new RegExp(`${EMOJI_RE.source}|${ARROW_GLYPHS.source}`, "u");

function isAllowedFile(relPath) {
  return ALLOW.some(a => a.file && relPath.replace(/\\/g, "/") === a.file);
}

// مَلَفّات/مُجَلَّدات مُستَثناة (نِطاقات مَشروعة):
//   - lib/printing/ — قوالِب طِباعة PDF/إيصال (سُطح طِباعة لا شاشة)
//   - lib/intlPhone.ts — أَعلام الدُوَل (دَلالة دُوَلية لا تُعَوَّض)
//   - lib/import.ts — تَحليل بَيانات (✓/✗ كَقِيَم)
//   - lib/whatsapp.ts و __tests__ — مَتْن الرَسائِل و sanitizeForWhatsApp
const EXCLUDED_PATHS = [
  /[\/\\]lib[\/\\]printing[\/\\]/,
  /[\/\\]lib[\/\\]intlPhone\.ts$/,
  /[\/\\]lib[\/\\]import\.ts$/,
  /[\/\\]lib[\/\\]whatsapp\.ts$/,
  /[\/\\]pages[\/\\]BmsSuperApp\.tsx$/,
];

function isExcluded(file) {
  return EXCLUDED_PATHS.some(rx => rx.test(file));
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "_legacy" || entry.name === "__tests__" || entry.name === "dist") continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      if (/\.(tsx?)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !isExcluded(full)) {
        yield full;
      }
    }
  }
}

const findings = [];
let allowedSkipCount = 0;
for (const file of walk(SCAN_ROOT)) {
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const fileAllowed = isAllowedFile(rel);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!COMBINED_RE.test(line)) continue;
    // تَجاهُل التَعليقات والنُصوص في sanitizeForWhatsApp builders (سَيُنَزَّع وَقت الإرسال)
    if (/sanitizeForWhatsApp|wa\.me|whatsapp\.test/.test(line)) { allowedSkipCount++; continue; }
    if (fileAllowed && isWorkOrderChannelLine(rel, line)) { allowedSkipCount++; continue; }
    // تَجاهُل التَعليقات وَحدَها — فَقَط إن السَطر كاملاً تَعليق
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      allowedSkipCount++;
      continue;
    }
    findings.push({ file: rel, line: i + 1, text: line.trim().slice(0, 200) });
  }
}

if (findings.length === 0) {
  console.log(`✓ صِفر إيموجي في واجِهة المُستَخدِم (${allowedSkipCount} مَسموح/تَعليق مُتَجاوَز).`);
  process.exit(0);
}

console.error(`✗ وُجِدَت ${findings.length} ثَغرة إيموجي UI (${allowedSkipCount} مَسموح):\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.text}`);
}
console.error(`\nالقاعِدة: استَبدِل بِأَيقونة من lucide-react. الـallowlist في scripts/check-no-emoji-ui.mjs.`);
process.exit(1);
