// تصفير النظام إلى «نظام فارغ» (مصنع): يمسح كل البيانات المُدخلة (فواتير، مخزون، دفتر، ورديات،
// مصروفات، أوامر شغل، مشتريات، منتجات، عملاء، موردون...) ويُبقي فقط: المستخدمين + الفروع + جدول الهجرات.
// أرقام الفواتير وكل العدّادات تبدأ من جديد (TRUNCATE يصفّر AUTO_INCREMENT).
//
// الاستخدام (CLI فقط — عملية لا رجعة فيها):
//   node scripts/reset.mjs --confirm RESET            # نسخة احتياطية تلقائية ثم تصفير
//   node scripts/reset.mjs --confirm RESET --seed     # تصفير ثم إعادة العيّنات (admin/فروع/منتجات عيّنة)
//   node scripts/reset.mjs --confirm RESET --no-backup# تخطّي النسخة الاحتياطية (غير مُستحسَن)
//
// ⚠ يأخذ نسخة احتياطية كاملة أولاً (scripts/backup.mjs)؛ إن فشلت ⇒ يتوقّف ولا يمسح شيئاً.
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import mysql from "mysql2/promise";

// جداول يُحافَظ عليها (هيكل الدخول + الفروع + سجلّ هجرات drizzle). مطابقة غير حسّاسة للحالة.
const KEEP = new Set(["users", "branches", "__drizzle_migrations"]);

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

function fail(msg) { console.error("✗", msg); process.exit(1); }

const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL غير مضبوط في .env — لا أعرف أي قاعدة أصفّر.");

function dbNameFromUrl(u) {
  const m = String(u).match(/\/([^/?]+)(\?.*)?$/);
  return m ? decodeURIComponent(m[1]) : null;
}
const dbName = dbNameFromUrl(url);
if (!dbName) fail(`تعذّر استخراج اسم القاعدة من DATABASE_URL.`);

// ── بوّابة التأكيد ──
if (valueOf("--confirm") !== "RESET") {
  console.error("");
  console.error("⛔ تصفير النظام عملية لا رجعة فيها — تمسح كل البيانات المُدخلة.");
  console.error(`   القاعدة المستهدفة: «${dbName}»`);
  console.error("   يبقى فقط: المستخدمون + الفروع.");
  console.error("");
  console.error("   للتأكيد أعد التشغيل مع:  --confirm RESET");
  console.error("   مثال:  node scripts/reset.mjs --confirm RESET");
  process.exit(1);
}

// ── النسخة الاحتياطية التلقائية (شبكة أمان) ──
if (!flag("--no-backup")) {
  console.log(`• أخذ نسخة احتياطية لـ«${dbName}» قبل التصفير…`);
  try {
    // نمرّر BACKUP_TARGET_URL كي تطابق النسخة قاعدة DATABASE_URL على مضيفها بالضبط (هدف النسخة = هدف الحذف).
    execFileSync(process.execPath, [join("scripts", "backup.mjs"), "--no-rotate"], {
      stdio: "inherit",
      env: { ...process.env, BACKUP_TARGET_URL: url },
    });
  } catch {
    fail("فشلت النسخة الاحتياطية ⇒ أوقفتُ التصفير حفاظاً على البيانات. أصلح النسخ أو مرّر --no-backup صراحةً.");
  }
} else {
  console.warn("⚠ تخطّي النسخة الاحتياطية (--no-backup) — لا شبكة أمان.");
}

// ── التصفير ──
const conn = await mysql.createConnection({ uri: url, multipleStatements: false });
try {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`
  );
  const allTables = rows.map((r) => r.t);
  const toClear = allTables.filter((t) => !KEEP.has(String(t).toLowerCase()));
  const kept = allTables.filter((t) => KEEP.has(String(t).toLowerCase()));

  if (!toClear.length) {
    console.log("• لا جداول بيانات لمسحها (النظام فارغ أصلاً).");
  } else {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of toClear) {
      await conn.query(`TRUNCATE TABLE \`${t}\``);
    }
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
    console.log(`✓ صُفِّرت ${toClear.length} جدولاً: ${toClear.join(", ")}`);
  }
  console.log(`• أُبقيت ${kept.length} جداول: ${kept.join(", ")}`);
} finally {
  await conn.end();
}

// ── إعادة البذرة اختيارياً ──
if (flag("--seed")) {
  console.log("• إعادة البذرة (admin + فروع + منتجات عيّنة)…");
  try {
    execFileSync("pnpm", ["seed"], { stdio: "inherit", shell: process.platform === "win32" });
  } catch {
    console.warn("⚠ تعذّرت إعادة البذرة — نفّذ pnpm seed يدوياً.");
  }
}

console.log("\n✅ اكتمل التصفير. النظام جاهز للبدء من جديد.");
