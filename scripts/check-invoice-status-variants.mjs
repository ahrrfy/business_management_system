#!/usr/bin/env node
// حارس عقد variants حالة الفاتورة — يمنع إعادة تعريف variants محلّياً بدلاً من
// استعمال المصدر الوحيد `invoiceStatusBadgeVariant` من `@shared/invoiceStatus`.
//
// السبب: قبل هذا الحارس كانت ٣ خرائط منجرفة تُترجم نفس الحالة إلى variants Badge مختلفة:
//   • Invoices.tsx:           PAID=success · PARTIALLY_PAID=warning · CANCELLED/RETURNED=destructive
//   • ReceptionInvoiceQueue:  PAID=default · PARTIALLY_PAID=secondary · else=outline
//   • InvoiceDetail.tsx:      قاموس classes Tailwind مباشر (bg-emerald-100) يتجاوز variants
// ⇒ حالة PAID الواحدة تظهر بلونٍ مختلف على شاشتَي الفواتير والاستقبال. دلالة الحالة تنكسر.
//
// القاعدة الشكلية:
//   • أيّ سطر في `client/src/**/*.tsx` يجمع:
//       - قيمة حالة فاتورة نصّياً: "PAID" أو "PARTIALLY_PAID" أو "PENDING" أو "CANCELLED"
//         أو "RETURNED" أو "SUPERSEDED"
//       - **مع** كلمة مفتاح تدلّ على تعيين variant Badge: `variant` أو `badgeVariant`
//   ⇒ يُعتبر خريطةً محلّية منجرفة، ويُرفض.
//
// المسموح (استثناءات ضيّقة):
//   • مطابقةٌ لغرضٍ **غير Badge** — مثل تصفية حالة (`status === "PAID" && ...`) بلا كلمة variant.
//   • ملف المصدر نفسه (`shared/invoiceStatus.ts`).
//   • ملفات الاختبار (`*.test.ts`, `*.test.tsx`).
//   • تعليقات (بادئة `//` أو `*`).
//
// النطاق: `client/src/**/*.tsx` (الشاشات والمكوّنات — حيث تعيش الشارات).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src");

// حالات الفاتورة الحقيقية (مرآة `shared/invoiceStatus.ts`).
const STATUS_LITERALS = [
  '"PAID"',
  '"PARTIALLY_PAID"',
  '"PENDING"',
  '"CANCELLED"',
  '"RETURNED"',
  '"SUPERSEDED"',
];

// كلمات مفتاح تدلّ على أنّ السياق **تعيين variant Badge**.
// نتغاضى عن استعمالها العام (مثل variant="outline" على Button) بشرط ألّا يكون في السطر
// نفسه literal حالة فاتورة — الاجتماع هو ما يُنشئ الانحراف.
const VARIANT_MARKERS = [
  /\bvariant\s*[=:]/i,           // variant=... أو variant: ...
  /\bbadgeVariant\b/,            // badgeVariant const/prop
  /\bstatusVariant\b/,           // اسمٌ شائع لخريطة محلّية
];

// ملفات تستعمل literals `PAID`/`PENDING`/`CANCELLED` لغير حالة الفاتورة (payroll accrual،
// مراجعات المتجر، حالة تحويل مخزون). قيم `PAID`/`PENDING`/... شائعة عبر domains — الحارس
// المضيّق يمسك ما يخصّ حالة الفاتورة فقط. أيّ إضافةٍ هنا يجب أن تكون واعية موثَّقة.
const EXEMPT_FILES = new Set([
  // Payroll accrual: request.status ∈ {PENDING, APPROVED, PAID, RETURNED} — حالة سلفة موظف.
  "client/src/components/hr/PayrollAccrualOperations.tsx",
  // Store reviews: review.status ∈ {PENDING, APPROVED, REJECTED} — حالة مراجعة عميل.
  "client/src/pages/store/StoreProductReviewManager.tsx",
  // Transfers: transfer.status ∈ {DRAFT, DISPATCHED, ARRIVED, CANCELLED} — حالة تحويل مخزون.
  "client/src/pages/TransfersLog.tsx",
]);

function* walkTsx(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "dist" || entry.name === "_legacy") continue;
      yield* walkTsx(full);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

const findings = [];

for (const file of walkTsx(SCAN_ROOT)) {
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
  if (EXEMPT_FILES.has(rel)) continue;

  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // تجاهل التعليقات المفردة
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    const hasStatus = STATUS_LITERALS.some((lit) => line.includes(lit));
    if (!hasStatus) continue;

    const hasVariant = VARIANT_MARKERS.some((rx) => rx.test(line));
    if (!hasVariant) continue;

    // استعمالٌ مباشر لـinvoiceStatusBadgeVariant في السطر نفسه = خطأ مُلتَبس
    // (لأنّ الدالّة لا تحتاج literal الحالة — تأخذ status متغيّراً). فلن نستثنيه؛ لكن
    // إن كان السطر يستدعي الدالّة صراحةً فلا سبب لكتابة literal حالةٍ فيه.
    findings.push({
      file: rel,
      line: i + 1,
      text: trimmed.slice(0, 200),
    });
  }
}

if (findings.length === 0) {
  console.log(`✓ عقد variants حالة الفاتورة محفوظ — لا خرائط محلّية.`);
  process.exit(0);
}

console.error(`✗ خرائط variants محلّية لحالة الفاتورة (${findings.length} انتهاك):\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.text}`);
}
console.error(`
القاعدة: استعمل \`invoiceStatusBadgeVariant(status)\` من \`@shared/invoiceStatus\`:

  import { invoiceStatusBadgeVariant, invoiceStatusLabel } from "@shared/invoiceStatus";
  <Badge variant={invoiceStatusBadgeVariant(r.status)}>{invoiceStatusLabel(r.status)}</Badge>

المصدر الوحيد يمنع انحراف الشاشات (كانت PAID تظهر بألوان مختلفة عبر ٣ شاشات).
`);
process.exit(1);
