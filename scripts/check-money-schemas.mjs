#!/usr/bin/env node
// حارِس CI — يَمنَع تعريف حقلٍ ماليّ في مدخلات الراوترات كـ z.string() عارية.
//
// السبب (تدقيق ١٧/٧، مخاطرة جهازية #١): حدود المال ضعيفة النمذجة على الحافة الخادمية —
// z.string() عارية على حقل مالي (مبلغ/سعر/دفعة/عربون…) تقبل السالب والصيغ التالفة فتنفجر داخل
// money() كـINTERNAL_SERVER_ERROR بدل BAD_REQUEST، أو تُدخِل سالباً يشوّه الذمم/الربح. الصحيح
// استعمال مخطّطات server/lib/schemas: nonNegMoneyString / positiveMoneyString / moneyString / signedMoneyString.
//
// النطاق: server/routers/**/*.ts فقط (حيث تُعرَّف عقود الإدخال). z.string() **بـ.regex نقديّ**
// مقبولة (تحقّق مكافئ). shared/schemas أيضاً مقبولة.
//
// نمط «ratchet»: خطّ أساس بالانتهاكات القائمة (BASELINE) — يفشل الحارس على أيّ حقل مالي **جديد**
// عارٍ خارج القائمة. القائمة تُقلَّص بإصلاح الحقول القائمة (لا تُوسَّع).
//
// إخراج: قائمة file:line:field. exit 1 لو ظهر انتهاك جديد.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "server", "routers");

// أسماء الحقول المالية (كلها أموال في عقود الراوترات — الفئة القوية).
const MONEY_FIELDS = [
  "amount", "price", "unitPrice", "deposit", "paid", "paidAmount", "cost", "unitCost",
  "discount", "discountAmount", "fee", "salary", "settlement", "openingBalance",
  "refund", "salePrice", "laborCost", "deliveryCost", "creditLimit", "subtotal",
];
// حقول تحمل اسماً مالياً لكنها ليست مبلغاً (نِسَب/أعلام) — تُستثنى.
const NOT_MONEY = /Percent$|Rate$|Type$|Method$|Enabled$/;

// خطّ الأساس (تدقيق ١٧/٧): الانتهاكات القائمة المسموح بها مؤقّتاً — basename:field.
// تُقلَّص بإصلاح الحقل إلى مخطّط مالي (nonNegMoneyString...). لا تُضِف إليها.
const BASELINE = new Set([
  "catalogRouter.ts:price",
  "customerRouter.ts:creditLimit",
  "customerRouter.ts:openingBalance",
  "expenseRouter.ts:amount",
  "productionRouter.ts:laborCost",
  "quotationRouter.ts:discountAmount",
  "returnRouter.ts:amount",
  "supplierRouter.ts:openingBalance",
]);

const fieldAlt = MONEY_FIELDS.join("|");
// حقل ماليّ : z.string() [بلا .regex مباشرة]
const RE = new RegExp(`\\b(${fieldAlt})\\s*:\\s*z\\.string\\(\\)(?!\\s*\\.regex)`, "g");

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
for (const file of walk(SCAN_ROOT)) {
  const base = path.basename(file);
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(line)) !== null) {
      const field = m[1];
      if (NOT_MONEY.test(field)) continue;
      const sig = `${base}:${field}`;
      if (BASELINE.has(sig)) continue; // موجود في خطّ الأساس — مسموح مؤقّتاً
      violations.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: حقل ماليّ «${field}» بـz.string() عارية — استعمل nonNegMoneyString/positiveMoneyString من server/lib/schemas`);
    }
  });
}

if (violations.length) {
  console.error("✗ حارِس المخطّطات المالية: حقول مالية جديدة بـz.string() عارية:");
  for (const v of violations) console.error("  " + v);
  console.error(`\n${violations.length} انتهاك جديد. عرّف الحقل عبر مخطّط مالي (server/lib/schemas.ts) لضمان رفض السالب/الصيغ التالفة بـBAD_REQUEST واضح.`);
  process.exit(1);
}
console.log("✓ حارِس المخطّطات المالية: لا حقول مالية جديدة بـz.string() عارية.");
