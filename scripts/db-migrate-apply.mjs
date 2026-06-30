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

// multipleStatements:true — هَجرات يَدوية مُعَيَّنة (مَثل 0035) تَحوي كَتل SET @var؛ PREPARE؛
// EXECUTE؛ DEALLOCATE بَين breakpoints. drizzle migrator يَنفّذ كل كَتلة كَquery واحد فيَفشل
// مَع multipleStatements:false (mysql2 يَرفض الكَتلة). الـconnection مَحلّي للإعداد فقط
// (لا يَستقبل input مُستخدم) ⇒ تَفعيل multipleStatements آمن. (نَفس نَهج ci-apply-extra-migrations.mjs.)
const conn = await createConnection({ uri: url, multipleStatements: true });
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
