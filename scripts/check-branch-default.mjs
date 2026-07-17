#!/usr/bin/env node
// حارِس CI — يَمنَع اشتقاق فرعٍ **عامل** من scopedBranchId/input.branchId ثمّ السقوط الصامت على
// فرعٍ افتراضيّ (?? 1 / ?? 0).
//
// السبب (تدقيق ١٧/٧، مخاطرة جهازية #٢): نمط الفرع الافتراضي الصامت عاد بعد استئصاله مرّتين.
// الخطير تحديداً: حلّ الفرع النطاقيّ لاستعلام/كتابة ثمّ `?? 1` ⇒ أدمن/مستخدم بلا فرع يعمل صامتاً
// على الفرع ١ (تسريب/خلط بيانات فرع لم يُطلَب). النمط الصحيح (reorderAlerts): admin ⇒ null=كل
// الفروع، غير الأدمن ⇒ فرعه، وإلا FORBIDDEN — لا `?? 1`.
//
// ⚠️ موجَّه لا حرفيّ: يلتقط **شكل حلّ الفرع العامل** فقط، فلا يمسك الـ~٩٥ موضعاً الحميدة (فاعل
// تدقيق `{ branchId: ctx.user.branchId ?? 1 }`، مفاتيح/أقفال نصّية، افتراض واجهة).
//
// النطاق: server/routers/** + server/services/** (تجاهُل *.test.ts والتعليقات).
// نمط «ratchet»: خطّ أساس بالانتهاك القائم الوحيد (inventoryRouter:361، منخفض الخطورة — admin only).

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ROOTS = [path.join(REPO_ROOT, "server", "routers"), path.join(REPO_ROOT, "server", "services")];

// الشكل الخطِر: إسنادٌ يحلّ فرعاً من scopedBranchId أو input.branchId وينتهي بافتراضٍ رقميّ صامت.
const RE = /=\s*[^;]*\b(scopedBranchId|input\??\.branchId)\b[^;]*\?\?\s*[01]\b/;
// اصطلاح آمن مُستثنى: `Number(... ?? 0) || undefined` ⇒ القيمة النهائية undefined = كل الفروع لا الفرع ١
// (النموذج الصحيح في reorderAlerts/reportsRouter). وجود `|| undefined/null` يعني أن الـ?? 0 ليست نهائية.
const SAFE_IDIOM = /\|\|\s*(undefined|null)\b/;

// خطّ الأساس (تدقيق ١٧/٧): الانتهاك القائم الوحيد (منخفض الخطورة، admin only) — يُصلَح لاحقاً بتنسيقٍ
// مع الواجهة (رفض FORBIDDEN لأدمن بلا فرع بدل الفرع ١). التوقيع = basename|السطرُ مطبَّعُ المسافات. لا تُضِف.
const BASELINE = new Set([
  "inventoryRouter.ts|const branchId = ctx.scopedBranchId ?? input?.branchId ?? ctx.user.branchId ?? 1;",
]);

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
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return; // تعليق
      if (!RE.test(line)) return;
      if (SAFE_IDIOM.test(line)) return; // `... || undefined` = كل الفروع لا الفرع الافتراضي
      const sig = normSig(base, trimmed);
      if (BASELINE.has(sig)) return;
      violations.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: اشتقاق فرعٍ عامل بافتراضٍ صامت (?? 0/1) — استعمل نمط G3: admin⇒null، غيره⇒فرعه، وإلا FORBIDDEN (لا ?? 1)`);
    });
  }
}

if (violations.length) {
  console.error("✗ حارِس الفرع الافتراضي: اشتقاق فرعٍ عامل بسقوطٍ صامت جديد:");
  for (const v of violations) console.error("  " + v);
  console.error(`\n${violations.length} انتهاك جديد. لا تُسقِط على فرعٍ افتراضي — ارفض FORBIDDEN أو اطلب اختياراً صريحاً (نمط inventoryRouter reorderAlerts).`);
  process.exit(1);
}
console.log("✓ حارِس الفرع الافتراضي: لا اشتقاق فرعٍ عامل بسقوطٍ صامت جديد.");
