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

  console.log(`✓ تحقّق المخطط: ${Object.keys(expected).length} جدولاً مطابقة لـ snapshot (${snapFiles[snapFiles.length - 1]}).`);
  await conn.end();
} catch (e) {
  await conn.end().catch(() => {});
  console.error("✗ تحقّق المخطط تعذّر:", e?.message ?? e);
  process.exit(1);
}
