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
  "drizzle/migrations/0034_search_norm_products.sql",
];

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("⛔ DATABASE_URL غير محدّد.");
  process.exit(1);
}

const conn = await createConnection({ uri: url, multipleStatements: false });

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
