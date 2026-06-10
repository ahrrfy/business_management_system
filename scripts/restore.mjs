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
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

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
const head = readFileSync(file, { encoding: "utf8" }).slice(0, 4096);
if (!/MySQL dump|CREATE TABLE|INSERT INTO|CREATE DATABASE/i.test(head)) {
  fail("لا يبدو الملف ناتج mysqldump صالحاً (لم نجد علامات SQL متوقّعة).");
}

const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL غير مضبوط في .env.");
const dbName = (String(url).match(/\/([^/?]+)(\?.*)?$/) || [])[1];

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
const sql = readFileSync(file);
console.log(`• استعادة «${dbName}» من ${file}…`);
try {
  if (flag("--native") || process.env.DB_NATIVE === "1") {
    // عميل mysql محلي (خدمة Windows أصلية): mysql -h host -P port -u user -ppass < file
    const m = String(url).match(/^mysql:\/\/([^:]+):([^@]*)@([^:/]+):(\d+)\//);
    if (!m) fail("تعذّر تفكيك DATABASE_URL للوضع الأصلي (--native).");
    const [, user, pass, host, port] = m;
    const args = ["-h", host, "-P", port, "-u", user];
    if (pass) args.push(`-p${pass}`);
    execFileSync("mysql", args, { input: sql, stdio: ["pipe", "inherit", "inherit"] });
  } else {
    // docker exec -i <container> mysql -uroot -p<pw>  (الناتج يحوي CREATE/USE DATABASE)
    const container = process.env.DB_CONTAINER ?? "erp-mysql";
    const pw = process.env.DB_ROOT_PW ?? "erp_root_pw";
    execFileSync("docker", ["exec", "-i", container, "mysql", "-uroot", `-p${pw}`], {
      input: sql,
      stdio: ["pipe", "inherit", "inherit"],
      maxBuffer: 1024 * 1024 * 512,
    });
  }
} catch (e) {
  fail(`فشلت الاستعادة: ${e?.message ?? e}`);
}

console.log("\n✅ اكتملت الاستعادة بنجاح.");
