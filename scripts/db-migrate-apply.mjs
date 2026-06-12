// مُطبِّق هجرات Drizzle عبر drizzle-orm migrator API مباشرةً.
// يحلّ محلّ `drizzle-kit migrate` لأنّ الأخير يفشل صامتاً ولا يطبع أخطاء useful.
// يقرأ ملفات SQL من drizzle/migrations/ ويطبّق ما لم يُسجَّل في __drizzle_migrations.
import "dotenv/config";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createConnection } from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("⛔ DATABASE_URL غير محدّد.");
  process.exit(1);
}

const conn = await createConnection(url);
const db = drizzle(conn);

try {
  console.log("→ قراءة journal والتحقّق من الهجرات المُطبَّقة…");
  await migrate(db, { migrationsFolder: "./drizzle/migrations" });
  console.log("✓ كل الهجرات حديثة.");
  await conn.end();
} catch (e) {
  await conn.end().catch(() => {});
  console.error("✗ فشلت هجرة:", e?.message ?? e);
  if (e?.sqlMessage) console.error("   SQL:", e.sqlMessage);
  process.exit(1);
}
