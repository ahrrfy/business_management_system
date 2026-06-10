// نسخ احتياطي لقاعدة البيانات عبر mysqldump من حاوية Docker إلى ملف مؤرّخ، ثم تدوير النسخ.
// الاستخدام:
//   pnpm db:backup                        # نسخة + تدوير + نسخة خارجية (إن ضُبط BACKUP_OFFSITE_DIR)
//   node scripts/backup.mjs --no-rotate   # نسخة فقط بلا تدوير
//
// المتغيّرات (‎.env): DB_CONTAINER, DB_NAME, DB_ROOT_PW, BACKUP_DIR, BACKUP_OFFSITE_DIR
// BACKUP_TARGET_URL (يضبطه reset/restore/systemRouter): انسخ بالضبط قاعدة DATABASE_URL على مضيفها
//   ⇒ هدف النسخة = هدف الحذف/الاستعادة دائماً (يمنع نسخ خادم خاطئ ثم تصفير الخادم الحقيقي).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const container = process.env.DB_CONTAINER ?? "erp-mysql";
const pw = process.env.DB_ROOT_PW ?? "erp_root_pw";
const backupDir = process.env.BACKUP_DIR ?? "backups";

const COMMON_DUMP = ["--single-transaction", "--routines", "--events"];
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

function parseMysqlUrl(u) {
  const m = String(u).match(/^mysql:\/\/([^:]+):([^@]*)@([^:/]+):(\d+)\/([^/?]+)/);
  return m ? { user: m[1], pass: m[2], host: m[3], port: m[4], db: m[5] } : null;
}
function hasLocalMysqldump() {
  try { execFileSync("mysqldump", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

// تحديد القاعدة الهدف + أمر النسخ.
let db, dumpCmd, dumpArgs;
const targetUrl = process.env.BACKUP_TARGET_URL;
if (targetUrl) {
  const t = parseMysqlUrl(targetUrl);
  if (!t) { console.error("✗ BACKUP_TARGET_URL غير صالح (متوقّع mysql://user:pass@host:port/db)."); process.exit(1); }
  db = t.db;
  if (hasLocalMysqldump()) {
    // mysqldump محلي ⇒ نضرب القاعدة الهدف مباشرةً (يعمل لأي مضيف: Docker مربوط، خدمة أصلية، أو بعيد).
    dumpCmd = "mysqldump";
    dumpArgs = ["-h", t.host, "-P", t.port, `-u${t.user}`, ...(t.pass ? [`-p${t.pass}`] : []), "--databases", t.db, ...COMMON_DUMP];
  } else if (LOCAL_HOSTS.has(t.host)) {
    // لا mysqldump محلي لكن المضيف محلي = نفس نسخة Docker المربوطة على المنفذ ⇒ docker exec يصيب الخادم نفسه.
    dumpCmd = "docker";
    dumpArgs = ["exec", container, "mysqldump", "-uroot", `-p${t.pass || pw}`, "--databases", t.db, ...COMMON_DUMP];
  } else {
    console.error(`✗ تعذّر ضمان نسخة آمنة للقاعدة «${t.db}» على المضيف «${t.host}»: لا mysqldump محلي والمضيف ليس Docker محلياً.`);
    console.error("  ثبّت أدوات mysql client (mysqldump) أو نفّذ من مضيف القاعدة. (أُوقفت العملية لمنع نسخ خادم خاطئ.)");
    process.exit(1);
  }
} else {
  // السلوك الافتراضي (db:backup المستقل / المهمة المجدولة) عبر Docker بمتغيّرات .env.
  db = process.env.DB_NAME ?? "erp";
  dumpCmd = "docker";
  dumpArgs = ["exec", container, "mysqldump", "-uroot", `-p${pw}`, "--databases", db, ...COMMON_DUMP];
}

const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
mkdirSync(backupDir, { recursive: true });
const out = join(backupDir, `${db}-${ts}.sql`);

try {
  // --single-transaction: لقطة متّسقة بلا قفل الجداول (آمن أثناء التشغيل).
  const dump = execFileSync(dumpCmd, dumpArgs, { maxBuffer: 1024 * 1024 * 512 });
  if (dump.length < 512) {
    throw new Error(`الناتج صغير بشكل مريب (${dump.length} bytes) — قد يكون فشلاً صامتاً`);
  }
  writeFileSync(out, dump);
  console.log(`✓ نسخة احتياطية: ${out} (${(dump.length / 1024).toFixed(1)} KB)`);
  console.log(`  للاستعادة: docker exec -i ${container} mysql -uroot -p${pw} < ${out}`);
} catch (e) {
  console.error("✗ فشل النسخ الاحتياطي:", e?.message ?? e);
  process.exit(1);
}

// تدوير النسخ + نسخ خارجي (إلا إذا مُرّر --no-rotate).
if (!process.argv.includes("--no-rotate")) {
  try {
    execFileSync(process.execPath, [join("scripts", "backup-rotate.mjs")], { stdio: "inherit" });
  } catch {
    // التدوير ليس حرجاً بقدر وجود النسخة — لا نُفشل العملية كلّها إن تعثّر.
    console.error("⚠ تعذّر تدوير النسخ القديمة (النسخة الحالية محفوظة).");
  }
}

// تحذير إن كان حجم النسخة صغيراً بشكل غير متوقّع (مؤشّر فقد بيانات).
try {
  const size = statSync(out).size;
  if (size < 2048) console.warn(`⚠ النسخة صغيرة (${size} bytes) — تحقّق من سلامة القاعدة.`);
} catch {
  /* تجاهل */
}
