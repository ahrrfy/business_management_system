#!/usr/bin/env node
/**
 * حارس ازدواج حقل البحث — يمنع ظهور حقلَي بحثٍ متجاورَين في شاشةٍ واحدة.
 *
 * السبب (١/٩/٢٦، أُمسِك بجولةٍ بصرية لا باختبار): `DataTable` يُصدِّر حقلَ بحثٍ خاصاً به
 * و**`searchable` افتراضُه `true`**. فكلُّ شاشةٍ لها بحثٌ في `ListToolbar` ثمّ تُحوَّل إلى
 * `DataTable` تُظهر **حقلَي بحثٍ متطابقَين المظهر مختلفَي الأثر**: الأعلى يُصفّي الاستعلام
 * والأدنى يُصفّي الصفحة المعروضة. الموظّف يكتب في أحدهما فيرى نتيجةً لا يفهم سببها.
 *
 * لا يمسكه `tsc` (كلاهما نوعٌ صحيح) ولا أيّ حارسٍ قائم — عيبٌ بصريٌّ صامت.
 * أُمسك فعلاً على `AssetRegister` و`DigitalSubscriptions` عند تحويلهما.
 *
 * القاعدة: شاشةٌ فيها `<DataTable>` **و**بحثٌ في شريط أدواتها يجب أن تُصرّح بأحد أمرين:
 *   • `searchable={false}`  — البحث في الشريط وحده (الحالة الغالبة)، أو
 *   • `serverSearch={…}`    — البحث مربوطٌ بالخادم عبر DataTable نفسه.
 *
 * ⛔ صفر تسامح — لا خطّ أساس: المخالفات كانت صفراً حين كُتب الحارس.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = path.join(REPO_ROOT, "client", "src", "pages");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const offenders = [];
let scanned = 0;

for (const file of walk(PAGES)) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("<DataTable")) continue;
  scanned++;
  // بحثٌ في شريط الأدوات: `search={{ value, onChange, … }}` — النمط الموحّد في ListToolbar.
  if (!/search=\{\{/.test(src)) continue;
  if (/searchable=\{false\}/.test(src)) continue;
  if (/serverSearch=/.test(src)) continue;
  offenders.push(path.relative(REPO_ROOT, file).split(path.sep).join("/"));
}

if (offenders.length) {
  console.error(`✗ ازدواج حقل البحث — ${offenders.length} شاشة تعرض حقلَي بحثٍ متجاورَين:\n`);
  for (const f of offenders) console.error(`  - ${f}`);
  console.error(`
الجذر: \`DataTable\` افتراضُه \`searchable={true}\` فيرسم حقلَ بحثٍ ثانياً تحت بحث \`ListToolbar\`.
الحقلان متطابقا المظهر مختلفا الأثر (استعلام مقابل صفحة معروضة) ⇒ الموظّف لا يفهم أيّهما يعمل.

الإصلاح — صرّح بأيّهما يبحث:
  <DataTable … searchable={false} />        // البحث في الشريط وحده (الغالب)
  <DataTable … serverSearch={{ value, onChange }} />   // البحث عبر DataTable إلى الخادم
`);
  process.exit(1);
}

console.log(`✓ لا ازدواج بحث — ${scanned} شاشة تستعمل DataTable، كلٌّ بحقل بحثٍ واحد.`);
