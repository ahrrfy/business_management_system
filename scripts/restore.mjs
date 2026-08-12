// استعادة قاعدة البيانات من ملف نسخة احتياطية (.sql) أنتجه scripts/backup.mjs.
// يكتب فوق القاعدة الحالية ⇒ عملية حسّاسة: نسخة أمان أولاً + رمز تأكيد صريح + تحقّق من الملف.
//
// الاستخدام:
//   node scripts/restore.mjs backups/erp-2026-06-09T19-00-00.sql --confirm RESTORE
//   ... --no-backup           # تخطّي نسخة الأمان للحالة الراهنة (غير مُستحسَن)
//   ... --native              # استعمل عميل mysql المحلي بدل docker (لخدمة MySQL أصلية على Windows)
//
// الافتراضي: docker exec -i <DB_CONTAINER> mysql < file  (مطابق لنهج backup.mjs).
import "dotenv/config";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, createReadStream, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";
import { acquireMaintenanceLock } from "./lib/maintenance-lock.mjs";

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--confirm");

function fail(msg) { console.error("✗", msg); process.exit(1); }

const file = positional[0];
if (!file) fail("مسار ملف النسخة مطلوب: node scripts/restore.mjs <ملف.sql> --confirm RESTORE");
if (!existsSync(file)) fail(`الملف غير موجود: ${file}`);

const size = statSync(file).size;
if (size < 512) fail(`الملف صغير بشكل مريب (${size} bytes) — قد يكون تالفاً أو فارغاً.`);

// تحقّق سريع: أوّل الملف يشبه ناتج mysqldump.
const headBuffer = Buffer.alloc(Math.min(size, 4096));
const headFd = openSync(file, "r");
try {
  readSync(headFd, headBuffer, 0, headBuffer.length, 0);
} finally {
  closeSync(headFd);
}
const head = headBuffer.toString("utf8");
if (!/MySQL dump|CREATE TABLE|INSERT INTO|CREATE DATABASE/i.test(head)) {
  fail("لا يبدو الملف ناتج mysqldump صالحاً (لم نجد علامات SQL متوقّعة).");
}

const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL غير مضبوط في .env.");
const dbName = (String(url).match(/\/([^/?]+)(\?.*)?$/) || [])[1];
const targetDb = dbName ? decodeURIComponent(dbName) : "";
if (!/^[A-Za-z0-9_$-]+$/.test(targetDb)) fail("اسم القاعدة في DATABASE_URL غير صالح للاستعادة الآمنة.");

async function validateDumpTarget() {
  const marker = head.match(/^-- ALROYA_DB_NEUTRAL_BACKUP:([^\r\n]+)$/m);
  if (marker && decodeURIComponent(marker[1]) !== targetDb) {
    fail(`النسخة تخص قاعدة «${decodeURIComponent(marker[1])}» لا القاعدة الهدف «${targetDb}».`);
  }
  let sawTargetDirective = false;
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    const use = line.match(/^\s*USE\s+`?([A-Za-z0-9_$-]+)`?\s*;/i);
    const databaseCommand = line.match(/^\s*(?:CREATE|DROP)\s+DATABASE\b/i);
    if (marker && (use || databaseCommand)) fail("نسخة database-neutral تحتوي أوامر تحويل قاعدة غير مسموحة.");
    if (use) {
      if (use[1] !== targetDb) fail(`النسخة تحاول التحويل إلى قاعدة أخرى: ${use[1]}`);
      sawTargetDirective = true;
    }
    if (databaseCommand) {
      const named = line.match(/`([^`]+)`/);
      if (!named || named[1] !== targetDb) fail("النسخة تحتوي CREATE/DROP DATABASE لا يطابق القاعدة الهدف.");
      sawTargetDirective = true;
    }
    if (/^\s*(?:CREATE|ALTER|DROP)\s+USER\b|^\s*(?:GRANT|REVOKE)\b|^\s*SET\s+GLOBAL\b|^\s*INSTALL\s+PLUGIN\b/i.test(line)) {
      fail("النسخة تحتوي أمراً واسع الصلاحية غير مسموح في استعادة التطبيق.");
    }
  }
  if (!marker && !sawTargetDirective) fail("نسخة قديمة بلا هوية قاعدة مؤكدة؛ أعد إنشاء النسخة بالأداة الحالية.");
}
await validateDumpTarget();

// ── بوّابة التأكيد ──
if (valueOf("--confirm") !== "RESTORE") {
  console.error("");
  console.error("⛔ الاستعادة تكتب فوق القاعدة الحالية وتمحو ما بعد تاريخ النسخة.");
  console.error(`   الملف:   ${file} (${(size / 1024).toFixed(1)} KB)`);
  console.error(`   القاعدة: «${dbName}»`);
  console.error("");
  console.error("   للتأكيد:  --confirm RESTORE");
  process.exit(1);
}

let releaseMaintenanceLock;
try {
  releaseMaintenanceLock = acquireMaintenanceLock();
} catch (error) {
  fail(error?.message ?? String(error));
}
process.once("exit", () => releaseMaintenanceLock?.());

// ── نسخة أمان للحالة الراهنة قبل الكتابة فوقها ──
if (!flag("--no-backup")) {
  console.log(`• نسخة أمان للحالة الراهنة لـ«${dbName}» قبل الاستعادة…`);
  try {
    execFileSync(process.execPath, [join("scripts", "backup.mjs"), "--no-rotate"], {
      stdio: "inherit",
      env: { ...process.env, BACKUP_TARGET_URL: url },
    });
  } catch {
    fail("فشلت نسخة الأمان ⇒ أوقفتُ الاستعادة. أصلح النسخ أو مرّر --no-backup صراحةً.");
  }
}

// ── الاستعادة ──
// BC-05: الاستعادة يجب أن تُطابق النسخة تماماً ⇒ نُسقط القاعدة أولاً، وإلا تنجو جداول/صفوف أُنشئت
// بعد تاريخ النسخة (mysqldump --add-drop-table يُسقط جداول النسخة فقط لا الجداول الأحدث منها).
// النسخ تُنشأ بـ--databases فتُعيد إنشاء القاعدة بترميزها الأصلي. نسخة الأمان أعلاه تحمي الحالة الراهنة.
const dropPrefix = Buffer.from(`DROP DATABASE IF EXISTS \`${targetDb}\`;\nCREATE DATABASE \`${targetDb}\`;\nUSE \`${targetDb}\`;\n`);

async function streamInto(command, args, env) {
  const child = spawn(command, args, { stdio: ["pipe", "inherit", "inherit"], env });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown"}`));
    });
  });
  if (dropPrefix) child.stdin.write(dropPrefix);
  // لا نقرأ ملف SQL كاملاً في RAM: دفق بضغط رجعي إلى mysql/docker. هذا يبقي الذاكرة
  // ثابتة حتى عند حد الرفع 200MB ويمنع تجميد/قتل عامل الاستعادة بسبب Buffer مزدوج.
  await Promise.all([pipeline(createReadStream(file), child.stdin), exited]);
}

console.log(`• استعادة «${dbName}» من ${file}…`);
try {
  if (flag("--native") || process.env.DB_NATIVE === "1") {
    // عميل mysql محلي (خدمة Windows أصلية): mysql -h host -P port -u user -ppass < file
    const m = String(url).match(/^mysql:\/\/([^:]+):([^@]*)@([^:/]+):(\d+)\//);
    if (!m) fail("تعذّر تفكيك DATABASE_URL للوضع الأصلي (--native).");
    const [, user, pass, host, port] = m;
    // --binary-mode يعطّل أوامر عميل mysql الموجودة داخل ملفات الإدخال (مثل \! / system).
    // من دونها يستطيع ملف خبيث تنفيذ أوامر نظام بحساب خدمة التطبيق قبل أن يصل SQL للخادم.
    const args = ["--binary-mode=1", "-h", host, "-P", port, "-u", user];
    // BC-04: كلمة المرور عبر MYSQL_PWD لا `-p` على سطر الأوامر (يُكشَف في `ps` على خادم مشترك).
    await streamInto("mysql", args, pass ? { ...process.env, MYSQL_PWD: pass } : process.env);
  } else {
    // docker exec -i <container> mysql -uroot  (الناتج يحوي CREATE/USE DATABASE)
    // BC-04: كلمة المرور عبر MYSQL_PWD (docker exec -e VAR بلا قيمة يسحبها من بيئة عميل docker) لا سطر الأوامر.
    const container = process.env.DB_CONTAINER ?? "erp-mysql";
    const pw = process.env.DB_ROOT_PW ?? "erp_root_pw";
    await streamInto(
      "docker",
      ["exec", "-i", "-e", "MYSQL_PWD", container, "mysql", "--binary-mode=1", "-uroot"],
      { ...process.env, MYSQL_PWD: pw },
    );
  }
} catch (e) {
  fail(`فشلت الاستعادة: ${e?.message ?? e}`);
}

try {
  execFileSync("pnpm", ["db:migrate:apply"], { stdio: "inherit", shell: process.platform === "win32", env: process.env });
  execFileSync("pnpm", ["db:verify"], { stdio: "inherit", shell: process.platform === "win32", env: process.env });
} catch (error) {
  fail(`اكتمل الاستيراد لكن فشلت هجرة/مراجعة المخطط: ${error?.message ?? error}`);
}

releaseMaintenanceLock?.();
releaseMaintenanceLock = undefined;

console.log("\n✅ اكتملت الاستعادة بنجاح.");
