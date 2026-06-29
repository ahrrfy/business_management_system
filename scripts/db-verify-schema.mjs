// تحقّق المخطط بعد الهجرة: يقارن أحدث snapshot لـDrizzle (المخطط المتوقّع بعد كل
// الهجرات) بأعمدة القاعدة الفعلية، ويفشل بصوتٍ عالٍ عند أي انحراف (جدول/عمود ناقص).
//
// لماذا: «تطبيق الهجرات» قد ينجح شكلياً بينما القاعدة منحرفة فعلياً (مثال ١٢/٦: baseline
// سُجّل «مُطبَّقاً» على قاعدة كانت أقدم منه ⇒ عمود branchStock.lastCountedAt ناقص ظهر
// للمستخدم كـ«تعذّر إتمام البيع» بلا أثر). هذه الخطوة تكشف ذلك قبل أن يكسر ميزة إنتاجية.
//
// الاستخدام:  pnpm db:verify   (تُستدعى آلياً ضمن pnpm prod:deploy بعد الهجرة)
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "mysql2/promise";

const META_DIR = "./drizzle/migrations/meta";

// 1) أحدث snapshot = المخطط المرجعي الكامل بعد كل الهجرات.
const snapFiles = readdirSync(META_DIR)
  .filter((f) => f.endsWith("_snapshot.json"))
  .sort();
if (!snapFiles.length) {
  console.error("⛔ تحقّق المخطط: لا snapshot في", META_DIR);
  process.exit(1);
}
const snap = JSON.parse(readFileSync(join(META_DIR, snapFiles[snapFiles.length - 1]), "utf-8"));

// شكل المرجع: table -> Set(column)
const expected = {};
for (const [tname, tdef] of Object.entries(snap.tables ?? {})) {
  // قد يأتي الاسم بصيغة schema.table في بعض اللهجات؛ MySQL يستعمل الاسم المجرّد.
  const bare = tname.includes(".") ? tname.split(".").pop() : tname;
  expected[bare] = new Set(Object.keys(tdef.columns ?? {}));
}

const url = process.env.DATABASE_URL;
if (!url) { console.error("⛔ DATABASE_URL غير محدّد."); process.exit(1); }

const conn = await createConnection(url);
const dbName = new URL(url).pathname.replace(/^\//, "");

try {
  const [rows] = await conn.query(
    "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?",
    [dbName]
  );
  const actual = {}; // table -> Set(column)
  for (const r of rows) (actual[r.TABLE_NAME] ??= new Set()).add(r.COLUMN_NAME);

  const missingTables = [];
  const missingCols = [];
  for (const [table, cols] of Object.entries(expected)) {
    if (!actual[table]) { missingTables.push(table); continue; }
    for (const col of cols) if (!actual[table].has(col)) missingCols.push(`${table}.${col}`);
  }

  if (missingTables.length || missingCols.length) {
    console.error("⛔ تحقّق المخطط فشل — القاعدة منحرفة عن snapshot:");
    if (missingTables.length) console.error("   جداول ناقصة:", missingTables.join(", "));
    if (missingCols.length) console.error("   أعمدة ناقصة:", missingCols.join(", "));
    console.error("   السبب الأرجح: هجرة لم تُطبَّق فعلياً أو baseline سُجّل على قاعدة أقدم.");
    console.error("   عالِج بـ db:generate لهجرة جديدة، أو راجع __drizzle_migrations.");
    await conn.end();
    process.exit(1);
  }

  // ── تحقّق الفهارس الحرجة (سدّ ثغرة F7، ٢٩/٦): db:verify كان يفحص الأعمدة لا الفهارس ⇒ فشل فهرس
  //    0013 الصامت (idx_receipt_bucket_status على عمود bucketId محذوف) بقي غير مرئي حتى أُكتشف بالتدقيق.
  //    هنا نؤكّد وجود الفهارس التي يكسر غيابُها الأداء/التقارير إنتاجياً (أُضيفت في 0030/0031/0032).
  const CRITICAL_INDEXES = [
    ["receipts", "idx_receipt_bucket_status"], // F1: أُسقط مع bucketId في 0017، أُعيد في 0030
    ["receipts", "idx_receipt_shift_date"], // Z-report
    ["invoices", "idx_invoice_branch_status_date"], // S1: أعمار الذمم
    ["invoices", "idx_invoice_date_status"], // S2: تقارير المبيعات (مُغطٍّ)
    ["invoices", "idx_invoice_branch_date_status"], // S2: تقارير المبيعات بفرع (مُغطٍّ)
    ["accountingEntries", "idx_entry_branch_type_date"], // GL/P&L
    ["accountingEntries", "idx_entry_customer_date"],
    ["accountingEntries", "idx_entry_supplier_date"],
    ["inventoryMovements", "idx_move_branch_date"],
    ["inventoryMovements", "idx_move_branch_variant_type"],
    ["auditLogs", "idx_audit_user_action_date"],
    ["auditLogs", "idx_audit_entity"],
    ["branchStock", "idx_stock_branch_qty"],
  ];
  const [idxRows] = await conn.query(
    "SELECT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? GROUP BY TABLE_NAME, INDEX_NAME",
    [dbName],
  );
  const haveIdx = new Set(idxRows.map((r) => `${r.TABLE_NAME}.${r.INDEX_NAME}`));
  const missingIdx = CRITICAL_INDEXES.filter(([t, i]) => !haveIdx.has(`${t}.${i}`)).map(([t, i]) => `${t}.${i}`);
  if (missingIdx.length) {
    console.error("⛔ تحقّق الفهارس فشل — فهارس حرجة مفقودة (خطر مسح جداول كاملة أو علّة صامتة كـ0013):");
    console.error("   " + missingIdx.join(", "));
    console.error("   السبب الأرجح: هجرة فهرس لم تُطبَّق، أو أُسقط الفهرس مع عمود محذوف، أو خطأ اسم عمود في الهجرة.");
    console.error("   عالِج: راجع الهجرة المعنيّة وأعد إنشاء الفهرس (نمط idempotent كـ0030/0031/0032).");
    await conn.end();
    process.exit(1);
  }

  console.log(`✓ تحقّق المخطط: ${Object.keys(expected).length} جدولاً مطابقة لـ snapshot (${snapFiles[snapFiles.length - 1]}).`);
  console.log(`✓ تحقّق الفهارس: ${CRITICAL_INDEXES.length} فهرساً حرجاً موجودة.`);
  await conn.end();
} catch (e) {
  await conn.end().catch(() => {});
  console.error("✗ تحقّق المخطط تعذّر:", e?.message ?? e);
  process.exit(1);
}
