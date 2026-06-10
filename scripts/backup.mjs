// نسخ احتياطي لقاعدة البيانات عبر mysqldump (بثّ مباشر إلى ملف — لا تخزين في الذاكرة)، ثم تدوير.
// الاستخدام:
//   pnpm db:backup                        # نسخة + تدوير + تشفير gpg مرافق (إن ضُبطت العبارة) + نسخة خارجية
//   node scripts/backup.mjs --no-rotate   # نسخة فقط (نسخ أمان داخلية قبل reset/restore) — بلا تدوير ولا تشفير
//
// المتغيّرات (‎.env): DB_CONTAINER, DB_NAME, DB_ROOT_PW, BACKUP_DIR, BACKUP_OFFSITE_DIR, BACKUP_GPG_PASSPHRASE
// BACKUP_TARGET_URL (يضبطه reset/restore/systemRouter): انسخ بالضبط قاعدة DATABASE_URL على مضيفها
//   ⇒ هدف النسخة = هدف الحذف/الاستعادة دائماً (يمنع نسخ خادم خاطئ ثم تصفير الخادم الحقيقي).
//
// العقد مع المستهلكين (maintenanceService.runBackup / reset / restore / cron):
//   النجاح = رمز خروج 0 + ملف `<db>-<ts>.sql` جديد في BACKUP_DIR. لا أحد يحلّل stdout.
//   أي فشل ⇒ رمز ≠0 **ولا يبقى ملف جزئي/فارغ** (وإلا عُدَّ نسخة صالحة لدى بوّابة الهجرة وشاشة الاستعادة).
//   التشفير يُنتج ملفاً مرافقاً `.sql.gpg` (للدفع/السحب الخارجي) ولا يمسّ ملف `.sql` المحلي.
//
// dotenv ضروري هنا: cron على الخادم يشغّل ببيئة فارغة — بدونها تسقط كلمة المرور للقيمة
// الافتراضية ويفشل النسخ كل ليلة بصمت (مُثبت في المراجعة العدائية ٢٠٢٦/٠٦/١٠).
import "dotenv/config";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, statSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

const container = process.env.DB_CONTAINER ?? "erp-mysql";
const pw = process.env.DB_ROOT_PW ?? "erp_root_pw";
const backupDir = process.env.BACKUP_DIR ?? "backups";
const noRotate = process.argv.includes("--no-rotate");

// --source-data=2 يكتب موضع binlog وقت اللقطة كتعليق ⇒ نقطة بداية دقيقة للاستعادة النقطية-الزمنية.
// متاح في مسارات root فقط (يتطلّب امتياز RELOAD) — كل مساراتنا تعمل بـroot.
const COMMON_DUMP = ["--single-transaction", "--routines", "--events", "--source-data=2"];
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

function parseMysqlUrl(u) {
  const m = String(u).match(/^mysql:\/\/([^:]+):([^@]*)@([^:/]+):(\d+)\/([^/?]+)/);
  return m ? { user: m[1], pass: m[2], host: m[3], port: m[4], db: m[5] } : null;
}
function hasLocalMysqldump() {
  try { execFileSync("mysqldump", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

// تحديد القاعدة الهدف + أمر النسخ. كلمة المرور تمرّ عبر بيئة MYSQL_PWD لا عبر سطر الأوامر —
// على خادم مشترك `ps aux` يكشف سطور الأوامر لكل المستخدمين (و`docker exec -e VAR` بلا قيمة
// يسحب القيمة من بيئة عميل docker نفسه فلا تظهر في argv إطلاقاً).
let db, dumpCmd, dumpArgs, dumpPw;
const targetUrl = process.env.BACKUP_TARGET_URL;
if (targetUrl) {
  const t = parseMysqlUrl(targetUrl);
  if (!t) { console.error("✗ BACKUP_TARGET_URL غير صالح (متوقّع mysql://user:pass@host:port/db)."); process.exit(1); }
  db = t.db;
  if (hasLocalMysqldump()) {
    // mysqldump محلي ⇒ نضرب القاعدة الهدف مباشرةً (يعمل لأي مضيف: Docker مربوط، خدمة أصلية، أو بعيد).
    dumpCmd = "mysqldump";
    dumpArgs = ["-h", t.host, "-P", t.port, `-u${t.user}`, "--databases", t.db, ...COMMON_DUMP];
    dumpPw = t.pass || undefined;
  } else if (LOCAL_HOSTS.has(t.host)) {
    // لا mysqldump محلي لكن المضيف محلي = نفس نسخة Docker المربوطة على المنفذ ⇒ docker exec يصيب الخادم نفسه.
    dumpCmd = "docker";
    dumpArgs = ["exec", "-e", "MYSQL_PWD", container, "mysqldump", "-uroot", "--databases", t.db, ...COMMON_DUMP];
    dumpPw = t.pass || pw;
  } else {
    console.error(`✗ تعذّر ضمان نسخة آمنة للقاعدة «${t.db}» على المضيف «${t.host}»: لا mysqldump محلي والمضيف ليس Docker محلياً.`);
    console.error("  ثبّت أدوات mysql client (mysqldump) أو نفّذ من مضيف القاعدة. (أُوقفت العملية لمنع نسخ خادم خاطئ.)");
    process.exit(1);
  }
} else {
  // السلوك الافتراضي (db:backup المستقل / المهمة المجدولة) عبر Docker بمتغيّرات .env.
  db = process.env.DB_NAME ?? "erp";
  dumpCmd = "docker";
  dumpArgs = ["exec", "-e", "MYSQL_PWD", container, "mysqldump", "-uroot", "--databases", db, ...COMMON_DUMP];
  dumpPw = pw;
}

const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
mkdirSync(backupDir, { recursive: true });
const out = join(backupDir, `${db}-${ts}.sql`);

// --single-transaction: لقطة متّسقة بلا قفل الجداول (آمن أثناء التشغيل).
// بثّ stdout مباشرة إلى الملف ⇒ يصمد لقواعد بأي حجم (لا سقف 512MB في الذاكرة).
// كل مسارات الفشل (فشل التشغيل، خطأ كتابة، رمز ≠0) تُرفض هنا — والملف الجزئي يُمحى لدى المستدعي.
function dumpToFile() {
  return new Promise((resolve, reject) => {
    const sink = createWriteStream(out, { mode: 0o600 });
    const child = spawn(dumpCmd, dumpArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: dumpPw ? { ...process.env, MYSQL_PWD: dumpPw } : process.env,
    });
    let stderrTail = "";
    let settled = false;
    let exitCode = null;
    let sinkClosed = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* تجاهل */ }
      sink.destroy();
      reject(err);
    };
    const maybeDone = () => {
      if (settled || exitCode === null || !sinkClosed) return;
      if (exitCode !== 0) {
        const hint = stderrTail.split("\n").filter(Boolean).slice(-3).join(" | ");
        fail(new Error(`mysqldump فشل (رمز ${exitCode})${hint ? `: ${hint}` : ""}`));
        return;
      }
      settled = true;
      resolve();
    };
    child.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-4096); });
    child.on("error", (e) => fail(new Error(`تعذّر تشغيل ${dumpCmd}: ${e?.message ?? e}`)));
    // خطأ كتابة (امتلاء القرص…) في أي لحظة ⇒ فشل فوري — لا «نجاح» بملف مبتور.
    sink.on("error", (e) => fail(new Error(`فشل كتابة ملف النسخة: ${e?.message ?? e}`)));
    sink.on("close", () => { sinkClosed = true; maybeDone(); });
    child.on("exit", (code) => { exitCode = code ?? 1; maybeDone(); });
    child.stdout.pipe(sink);
  });
}

try {
  await dumpToFile();
  const size = statSync(out).size;
  if (size < 512) {
    throw new Error(`الناتج صغير بشكل مريب (${size} bytes) — قد يكون فشلاً صامتاً`);
  }
  console.log(`✓ نسخة احتياطية: ${out} (${(size / 1024).toFixed(1)} KB)`);
  console.log(`  للاستعادة: pnpm db:restore ${out}  (أو docker exec -i ${container} mysql -uroot -p < ${out} — كلمة المرور تُطلب تفاعلياً)`);
} catch (e) {
  // لا نُبقي ملفاً جزئياً/فارغاً — يُحسب «أحدث نسخة» لدى بوّابة الهجرة وشاشة الاستعادة.
  try { unlinkSync(out); } catch { /* غير موجود أصلاً */ }
  console.error("✗ فشل النسخ الاحتياطي:", e?.message ?? e);
  process.exit(1);
}

if (!noRotate) {
  // تدوير النسخ + نسخ خارجي محلي (BACKUP_OFFSITE_DIR).
  try {
    execFileSync(process.execPath, [join("scripts", "backup-rotate.mjs")], { stdio: "inherit" });
  } catch {
    // التدوير ليس حرجاً بقدر وجود النسخة — لا نُفشل العملية كلّها إن تعثّر.
    console.error("⚠ تعذّر تدوير النسخ القديمة (النسخة الحالية محفوظة).");
  }

  // تشفير مرافق للدفع/السحب الخارجي: <ملف>.sql.gpg (AES256 متماثل). الملف المحلي .sql يبقى كما هو
  // (واجهة الاستعادة داخل النظام تقبل .sql فقط). بدون العبارة السرّية لا تُفتح النسخة الخارجية.
  // العبارة تمرّ عبر stdin (--passphrase-fd 0) — لا تظهر في ps.
  const passphrase = process.env.BACKUP_GPG_PASSPHRASE;
  if (passphrase) {
    const enc = `${out}.gpg`;
    const r = spawnSync(
      "gpg",
      ["--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-fd", "0", "--symmetric", "--cipher-algo", "AES256", "-o", enc, out],
      { input: passphrase }
    );
    if (r.status === 0 && existsSync(enc)) {
      console.log(`✓ نسخة مشفّرة للدفع الخارجي: ${enc}`);
    } else {
      // التشفير مضبوط صراحةً ⇒ فشله ليس تحذيراً بل عطل في سلسلة الحماية الخارجية — نُفشل بصوت عالٍ
      // كي يلتقطه cron/الشاشة، مع إبقاء النسخة المحلية سليمة.
      const err = (r.stderr?.toString() ?? r.error?.message ?? "").split("\n").filter(Boolean).slice(-2).join(" | ");
      console.error(`✗ BACKUP_GPG_PASSPHRASE مضبوطة لكن التشفير فشل${err ? `: ${err}` : ""} — النسخة المحلية ${out} سليمة، ولا ملف خارجي مشفّر.`);
      process.exit(1);
    }
  }

  // تنظيف الملفات المشفّرة اليتيمة: قرينها .sql حذفه التدوير ⇒ تُحذف معه (لا تراكم أبدياً).
  try {
    for (const name of readdirSync(backupDir)) {
      if (!name.endsWith(".sql.gpg")) continue;
      if (!existsSync(join(backupDir, name.slice(0, -4)))) {
        unlinkSync(join(backupDir, name));
      }
    }
  } catch { /* التنظيف تحسيني — لا يُفشل النسخ */ }
}

// تحذير إن كان حجم النسخة صغيراً بشكل غير متوقّع (مؤشّر فقد بيانات).
try {
  const size = statSync(out).size;
  if (size < 2048) console.warn(`⚠ النسخة صغيرة (${size} bytes) — تحقّق من سلامة القاعدة.`);
} catch {
  /* تجاهل */
}
