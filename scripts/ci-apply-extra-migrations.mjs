// مُطبِّق مُكمِّل لـCI: بَعد db:push يَكتب schema.ts، هذا السكريبت يُطبّق هَجرات يَدوية
// لا يَفهمها drizzle-kit (مَثلاً GENERATED ALWAYS AS ... STORED — D2 searchNorm).
//
// لماذا لا نَستعمل migrator API كاملاً: snapshot drizzle مُجمَّد عند 0019 ⇒ لو migrator
// يُطبّق من 0000 على قاعدة فارغة، snapshot القديم يَفقد بَعض الأعمدة التي أُضيفت في schema.ts
// بَعد التَجميد (٢٠/٦ قَرار). الحلّ: db:push يَكتب الجداول الحالية + هذا السكريبت يُضيف
// ما لا يُمكن تَمثيله في drizzle-kit (مَثل GENERATED columns).
//
// يَقرأ ملفات SQL مَحدَّدة، يُقسّمها على `--> statement-breakpoint`، ويُنفّذها بالتَرتيب.
// الهَجرات مَكتوبة idempotent (INFORMATION_SCHEMA checks) فآمنة للتَطبيق المُتَكرّر.

import "dotenv/config";
import { createConnection } from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// قائمة الهَجرات اليَدوية التي يُطبِّقها هذا السكريبت (بَعد db:push). تُضاف هُنا فقط
// الهَجرات التي drizzle-kit يَعجز عن تَمثيلها (GENERATED columns، FULLTEXT indexes، إلخ).
const EXTRA_MIGRATIONS = [
  "drizzle/migrations/0035_search_norm_products.sql",
  // 0036 يُضيف voucherCategories + أعمدة receipts. درizzle-kit يَفهم الجداول العادية لكن
  // مَيلُه إسقاط بَعض الـFK/UNIQUE صامتاً ⇒ نُكرّر التَطبيق هنا idempotently كَدفاع متعمّق.
  "drizzle/migrations/0036_vouchers_pro.sql",
  // 0039 توسعة D2: نفس نمط 0035 (GENERATED STORED) على customers.searchNorm/suppliers.searchNorm.
  "drizzle/migrations/0039_search_norm_customers_suppliers.sql",
  // gstack M6 (٧/٧/٢٦): قيود CHECK للـبكج/اللقطة/موجات الأسعار — drizzle-kit db:push لا يبنيها
  // موثوقاً على MySQL 8. snippet idempotent (يفحص INFORMATION_SCHEMA قبل ALTER).
  "drizzle/migrations/extras/0057_0060_bundle_check_constraints.sql",
  // ٨/٧/٢٦ (تشخيص فشل perf.explain على PR #163): db:push يترك invoices بلا فهارسها المُغطّية على
  // قواعد CI بعد تضخّم schema (المذكور في الذاكرة «db:push ينشئ جداول عارية عند فشله النصفي»).
  // الفهارس مطلوبة لحارس perf.explain وللأداء الفعلي. 0031/0032/0033 idempotent (INFORMATION_SCHEMA
  // checks) فآمنة للتَطبيق المتكرّر بعد db:push. الترتيب مهم: 0031→0032→0033 (0033 يُسقط بادئة كرَّرها 0032).
  "drizzle/migrations/0031_scale_composite_indexes.sql",
  "drizzle/migrations/0032_invoice_covering_indexes.sql",
  "drizzle/migrations/0033_drop_redundant_invoice_index.sql",
  // ٨/٧/٢٦: باركودات بديلة (aliases) — jedwal جانبيّ بـFK cascade على productUnits. `db:push`
  // على CI أنشأ الجدول بلا قيد FK فَسقط اختبار A3 (حذف الوحدة لم يُلقِ بدائلها) — إعادة تطبيق
  // idempotent لضمان القيود على CI. راجع ذاكرة «db:push ينشئ جداول عارية عند فشله النصفي».
  "drizzle/migrations/0062_product_unit_barcode_aliases.sql",
  // ١١/٧/٢٦: حقول متجر الجوال B2C (COD) على onlineOrders — أعمدة عادية + UNIQUE على عمود
  // غير-FK؛ نُعيد تطبيقها idempotently (INFORMATION_SCHEMA) لضمان وجودها على CI بعد db:push.
  "drizzle/migrations/0063_online_order_cod_fields.sql",
  // ١١/٧/٢٦: إدارة المتجر (لوحة hPanel) — جدولا storeBanners/storeSettings (بنرات + إعدادات).
  "drizzle/migrations/0064_store_banners.sql",
  "drizzle/migrations/0065_store_settings.sql",
  "drizzle/migrations/0066_store_free_shipping.sql",
  "drizzle/migrations/0067_online_order_delivery_party.sql",
  // ١٢/٧/٢٦: دور courier + ربط جهة التوصيل بحساب (deliveryParties.userId). enum ALTER + عمود/UNIQUE/FK
  // محروسة idempotently — نُعيد تطبيقها لضمان وجودها على CI بعد db:push (لا يُمثّل توسيع enum موثوقاً).
  "drizzle/migrations/0068_courier_role_and_party_user.sql",
  // ١٢/٧/٢٦: سبب إلغاء طلب المتجر (cancelReason) — «تعذّر التسليم» للمندوب. عمود عادي محروس idempotently.
  "drizzle/migrations/0069_online_order_cancel_reason.sql",
];

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("⛔ DATABASE_URL غير محدّد.");
  process.exit(1);
}

// multipleStatements: true لأن الكَتلة الواحدة بَين breakpoints قد تَحتوي على عدّة أوامر
// (SET @var؛ PREPARE؛ EXECUTE؛ DEALLOCATE) — كلها تَستعمل مُتغيّر مُستخدم مُشترَك فيَجب
// تَنفيذها على نَفس الاتصال بَالتَتابع. هذا سكريبت إعداد لا يَستقبل مُدخلات مُستخدم،
// فلا خطر SQL injection من تَفعيل الخاصية.
const conn = await createConnection({ uri: url, multipleStatements: true });

try {
  for (const path of EXTRA_MIGRATIONS) {
    const abs = resolve(path);
    const sql = await readFile(abs, "utf-8");
    // تَقسيم على الـbreakpoint الذي يَستعمله drizzle-kit (نفس النَمط للهَجرات اليَدوية).
    const stmts = sql.split(/-->\s*statement-breakpoint/g)
      .map((s) => s.trim())
      .filter(Boolean)
      // إزالة تَعليقات وحدها (لو سطر بَقي --... بدون SQL فعلي).
      .filter((s) => !s.split("\n").every((line) => line.trim().startsWith("--") || line.trim() === ""));
    console.log(`→ تَطبيق ${path} (${stmts.length} statement(s))…`);
    for (const stmt of stmts) {
      await conn.query(stmt);
    }
  }
  console.log("✓ كل الهَجرات الإضافية مُطبَّقة.");
  await conn.end();
} catch (e) {
  await conn.end().catch(() => {});
  console.error("✗ فشلت هَجرة إضافية:", e?.message ?? e);
  if (e?.sqlMessage) console.error("   SQL:", e.sqlMessage);
  process.exit(1);
}
