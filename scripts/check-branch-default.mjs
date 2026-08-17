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
// نقطةٌ عمياء أُغلقت (١٧/٨/٢٦): النطاق كان خادمياً بحتاً، فمرّت شاشاتٌ تشتقّ الفرع بـ
// `me.data?.branchId ?? 1` بلا رصد — والخادم يثق بـ`input.branchId` للأدمن ⇒ أدمن بلا فرعٍ
// مُسنَد يكتب صامتاً على الفرع ١ من الواجهة. الحارس صار يمسح `client/src` أيضاً بنمطٍ ثانٍ.
const ROOTS = [
  path.join(REPO_ROOT, "server", "routers"),
  path.join(REPO_ROOT, "server", "services"),
  path.join(REPO_ROOT, "client", "src"),
];

// الشكل الخطِر: إسنادٌ يحلّ فرعاً من scopedBranchId أو input.branchId وينتهي بافتراضٍ رقميّ صامت.
const RE = /=\s*[^;]*\b(scopedBranchId|input\??\.branchId)\b[^;]*\?\?\s*[01]\b/;
// النمط العميليّ: `me.data?.branchId ?? 1` وأخواته (أيّ قراءةِ branchId من حالةٍ تنتهي بافتراضٍ رقميّ).
const RE_CLIENT = /=\s*[^;]*\bbranchId\b[^;]*\?\?\s*[01]\b/;
// اصطلاح آمن مُستثنى: `Number(... ?? 0) || undefined` ⇒ القيمة النهائية undefined = كل الفروع لا الفرع ١
// (النموذج الصحيح في reorderAlerts/reportsRouter). وجود `|| undefined/null` يعني أن الـ?? 0 ليست نهائية.
const SAFE_IDIOM = /\|\|\s*(undefined|null)\b/;

// خطّ الأساس (تدقيق ١٧/٧): الانتهاك القائم الوحيد (منخفض الخطورة، admin only) — يُصلَح لاحقاً بتنسيقٍ
// مع الواجهة (رفض FORBIDDEN لأدمن بلا فرع بدل الفرع ١). التوقيع = basename|السطرُ مطبَّعُ المسافات. لا تُضِف.
const BASELINE = new Set([
  "inventoryRouter.ts|const branchId = ctx.scopedBranchId ?? input?.branchId ?? ctx.user.branchId ?? 1;",
  // ١٦ موضعاً عميلياً قائماً (١٧/٨/٢٦) — كلّها قيمةٌ انتقالية لحالةٍ أوّلية تُصحَّح بـuseEffect
  // حالما يصل `me.data`، والخادم يقصر غير الأدمن على فرعه. مُجمَّدة كخطّ أساسٍ كي يمنع الحارس
  // **الجديد** بلا فرض إعادة كتابة ١٦ شاشةً في شريحةٍ واحدة. لا تُضِف إليها.
  "BundleForm.tsx|const branchId = me.data?.branchId ?? 1;",
  "ConsignmentSettlements.tsx|const branchId = Number(me.data?.branchId ?? pickedBranch ?? 1);",
  "ContractPrices.tsx|const branchId = Number(me.data?.branchId ?? pickedBranch ?? 1);",
  "Dashboard.tsx|const myBranch = me.data?.branchId ?? 1;",
  "DeliveryHub.tsx|const branchId = Number(me.data?.branchId ?? 0);",
  "Inventory.tsx|const myBranch = me.data?.branchId ?? 1;",
  "InventoryMovements.tsx|const myBranch = me.data?.branchId ?? 1;",
  "ItemLedger.tsx|const myBranch = me.data?.branchId ?? 1;",
  "POS.tsx|const branchId = me.data?.branchId ?? offlineBoot?.branchId ?? pickedBranch ?? 1;",
  "PrintPOS.tsx|const branchId = me.data?.branchId ?? pickedBranch ?? 1;",
  "ProductEdit.tsx|const myBranch = me.data?.branchId ?? 1;",
  "ProductNew.tsx|const myBranch = me.data?.branchId ?? 1;",
  "ProductionRecipes.tsx|const branchId = me.data?.branchId ?? 1;",
  "QuotationNew.tsx|const defaultBranchId = me.data?.branchId ?? 1;",
  "Reception.tsx|() => Number(me.data?.branchId ?? pickedBranch ?? 1),",
  "PurchaseReturnNew.tsx|const defaultBranchId = me.data?.branchId ?? 1;",
  "SalesInvoiceNew.tsx|const defaultBranchId = me.data?.branchId ?? 1;",
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
    else if (
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test.tsx")
    )
      out.push(p);
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
      const isClient = file.includes(`${path.sep}client${path.sep}`);
      if (!(isClient ? RE_CLIENT : RE).test(line)) return;
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
