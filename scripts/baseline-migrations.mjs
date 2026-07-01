// يُسجِّل قاعدةً طازجة (مُهيَّأة عبر db:push + db:migrate:extra، لا عبر migrator) كأنّها
// طبّقت كل الهجرات الحالية — بلا هذا، db-migrate-apply.mjs (drizzle-orm migrator) يظنّها
// فارغة تماماً ويحاول تنفيذ كل ملفّ هجرة من 0000 فيفشل بـ"الجدول موجود سلفاً" (تأكَّد فعلياً
// عند تطبيقه على قاعدة شركة مُهيَّأة حديثاً في تعدد الشركات).
//
// الآلية: migrator يفحص **آخر صفّ واحد فقط** في __drizzle_migrations (ORDER BY created_at
// DESC LIMIT 1) ويُطبِّق كل هجرة أحدث من created_at ذاك. إدراج صفّ بـcreated_at = توقيت
// آخر هجرة حالية يجعله يظنّ كل الحالي مُطبَّقاً، وأي هجرة *لاحقة* (تُضاف مستقبلاً) ستُطبَّق
// بشكل طبيعي — هذا هو "التأسيس" (baselining) القياسي لقاعدة بيانات push بدل migrate.
//
// الاستخدام:  DATABASE_URL='mysql://...' node scripts/baseline-migrations.mjs
// idempotent: لا يفعل شيئاً إن كان الجدول موجوداً وفيه صفوف سلفاً (لا يطمس تأسيساً سابقاً).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "mysql2/promise";

function fail(msg) { console.error("✗", msg); process.exit(1); }

const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL غير محدّد.");

const journalPath = "drizzle/migrations/meta/_journal.json";
const journal = JSON.parse(readFileSync(journalPath, "utf8"));
const entries = journal.entries;
if (!entries.length) fail("لا هجرات في _journal.json — لا شيء لتأسيسه.");
const latest = entries[entries.length - 1];
const migrationSql = readFileSync(`drizzle/migrations/${latest.tag}.sql`, "utf8");
const hash = createHash("sha256").update(migrationSql).digest("hex");

const conn = await createConnection({ uri: url });
try {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS \`__drizzle_migrations\` (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT
    )
  `);
  const [rows] = await conn.query("SELECT COUNT(*) AS c FROM `__drizzle_migrations`");
  if (rows[0].c > 0) {
    console.log("• __drizzle_migrations فيه صفوف سلفاً — لا تأسيس (قاعدة مُطبَّقة عبر migrator سابقاً أو مُؤسَّسة).");
  } else {
    await conn.query("INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES (?, ?)", [hash, latest.when]);
    console.log(`✓ تأسيس مكتمل عند «${latest.tag}» (${entries.length} هجرة تُعامَل كمُطبَّقة).`);
  }
} finally {
  await conn.end();
}
