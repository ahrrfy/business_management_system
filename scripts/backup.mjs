// نسخ احتياطي بثّي ثم نشر مشفّر متحقق؛ التدوير معلّق حتى إثبات مجموعة استعادة كاملة.
// الاستخدام:
//   pnpm db:backup                        # نسخة + تشفير متحقق (إن ضُبطت العبارة) + نسخة خارجية، بلا حذف
//   node scripts/backup.mjs --no-rotate   # نسخة فقط (نسخ أمان داخلية قبل reset/restore) — بلا تدوير ولا تشفير
//   node scripts/backup.mjs --all-companies [--no-rotate]
//                                         # تعدد الشركات: نسخة منفصلة لكل شركة فعّالة (من erp_control)،
//                                         # عبر استدعاء هذا السكربت نفسه لكل شركة بـBACKUP_TARGET_URL مختلف.
//
// المتغيّرات (‎.env): DATABASE_URL, DB_CONTAINER, BACKUP_DIR, BACKUP_OFFSITE_DIR, BACKUP_GPG_PASSPHRASE
// BACKUP_TARGET_URL (يضبطه reset/restore/systemRouter/‎--all-companies): انسخ بالضبط قاعدة DATABASE_URL
//   على مضيفها ⇒ هدف النسخة = هدف الحذف/الاستعادة دائماً (يمنع نسخ خادم خاطئ ثم تصفير الخادم الحقيقي).
//
// العقد مع المستهلكين (maintenanceService.runBackup / reset / restore / cron):
//   النجاح = رمز خروج 0 + ملف `<db>-<ts>.sql` جديد في BACKUP_DIR. لا أحد يحلّل stdout.
//   أي فشل ⇒ رمز ≠0 **ولا يبقى ملف جزئي/فارغ** (وإلا عُدَّ نسخة صالحة لدى بوّابة الهجرة وشاشة الاستعادة).
//   التشفير يُنتج ملفاً مرافقاً `.sql.gpg` (للدفع/السحب الخارجي) ولا يمسّ ملف `.sql` المحلي.
//
// dotenv ضروري هنا: cron على الخادم يشغّل ببيئة فارغة — بدونها تسقط كلمة المرور للقيمة
// الافتراضية ويفشل النسخ كل ليلة بصمت (مُثبت في المراجعة العدائية ٢٠٢٦/٠٦/١٠).
import "dotenv/config";
import { publishEncryptedBackup, mirrorPublishedBackup } from "./lib/backup-publication.mjs";
import { encryptBackupWithOwnedAgent } from "./lib/backup-gpg.mjs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, statSync, unlinkSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertDbTarget, targetEnvironment } from "./lib/db-target.mjs";
import { resolveBackupClient, backupDumpCommand, completeBackupDump } from "./lib/backup-client.mjs";

// ─── وضع تعدّد الشركات: نسخة منفصلة لكل شركة فعّالة، ثم خروج (لا يُكمل لمنطق قاعدة واحدة) ───
if (process.argv.includes("--all-companies")) {
  const thisScript = fileURLToPath(import.meta.url);
  const passthroughArgs = process.argv.slice(2).filter((a) => a !== "--all-companies");

  let companies;
  try {
    const out = execFileSync("pnpm", ["exec", "tsx", "server/tenancy/cli/listCompanyConnections.ts"], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    const lastLine = out.trim().split("\n").filter(Boolean).pop();
    companies = JSON.parse(lastLine);
  } catch (e) {
    console.error("✗ فشل جلب قائمة الشركات من erp_control:", e?.message ?? e);
    process.exit(1);
  }

  if (companies.length === 0) {
    console.log("• لا شركات فعّالة في erp_control — لا نسخ لتنفيذها.");
    process.exit(0);
  }

  let failedCodes = [];
  for (const company of companies) {
    console.log(`\n— نسخة الشركة «${company.code}» —`);
    const result = spawnSync(process.execPath, [thisScript, ...passthroughArgs], {
      stdio: "inherit",
      env: { ...process.env, BACKUP_TARGET_URL: company.connectionUrl },
    });
    if (result.status !== 0) failedCodes.push(company.code);
  }

  if (failedCodes.length > 0) {
    console.error(`\n✗ فشلت نسخة ${failedCodes.length} شركة/شركات: ${failedCodes.join(", ")}`);
    process.exit(1);
  }
  console.log(`\n✓ نسخ احتياطي لكل الشركات الفعّالة (${companies.length}) اكتمل بنجاح.`);
  process.exit(0);
}

const container = process.env.DB_CONTAINER ?? "erp-mysql";
const backupDir = process.env.BACKUP_DIR ?? "backups";
const noRotate = process.argv.includes("--no-rotate");

// --source-data=2 يكتب موضع binlog وقت اللقطة كتعليق ⇒ نقطة بداية دقيقة للاستعادة النقطية-الزمنية.
// يتطلّب امتياز RELOAD (عام على الخادم كله، لا يُمنَح لكل قاعدة على حدة) — متاح لمسارات root
// فقط. مستخدمو الشركات المخصّصون (تعدد الشركات — أقلّ امتياز عمداً: هذه القاعدة فقط) لا
// يملكونه، فنُسقطه حين المستخدم ليس root بدل فشل النسخة كلّها (تبقى النسخة صحيحة ومستعادة
// بالكامل، فقط بلا نقطة بداية binlog دقيقة كتعليق).
// `--no-tablespaces` avoids requiring the global PROCESS privilege. This is
// mandatory for the database-scoped application/company users used by
// BACKUP_TARGET_URL, and is harmless for root-operated scheduled backups.
const COMMON_DUMP = ["--single-transaction", "--routines", "--events", "--no-tablespaces"];
const SOURCE_DATA_FLAG = "--source-data=2";
let db, dumpCmd, dumpArgs, dumpCleanup, resolvedTarget, selected;
// Standalone/cron backups follow DATABASE_URL too; never fall back to another server's credentials.
const targetUrl = process.env.BACKUP_TARGET_URL ?? process.env.DATABASE_URL;
try {
  if (!targetUrl)
    throw new Error(
      "DATABASE_URL or BACKUP_TARGET_URL is required to identify the backup target",
    );
  selected = await resolveBackupClient(targetUrl, { container });
  resolvedTarget = selected.target;
  db = resolvedTarget.db;
  const dumpFlags =
    resolvedTarget.user === "root"
      ? [...COMMON_DUMP, SOURCE_DATA_FLAG]
      : COMMON_DUMP;
  const command = backupDumpCommand(selected, [...dumpFlags, db]);
  dumpCmd = command.command;
  dumpArgs = command.args;
  dumpCleanup = command.cleanup;
} catch (error) {
  console.error("✗ تعذّر إثبات هدف النسخة:", error?.message ?? error);
  process.exit(1);
}
const ts = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(backupDir, { recursive: true });
const out = join(backupDir, `${db}-${ts}-${randomUUID().slice(0, 8)}.sql`);
const partial = `${out}.partial`;
process.once("exit", () => dumpCleanup?.());

// --single-transaction: لقطة متّسقة بلا قفل الجداول (آمن أثناء التشغيل).
// بثّ stdout مباشرة إلى الملف ⇒ يصمد لقواعد بأي حجم (لا سقف 512MB في الذاكرة).
// كل مسارات الفشل (فشل التشغيل، خطأ كتابة، رمز ≠0) تُرفض هنا — والملف الجزئي يُمحى لدى المستدعي.
function dumpToFile(guard) {
  return new Promise((resolve, reject) => {
    const sink = createWriteStream(partial, { mode: 0o600, flags: "wx" });
    sink.write(`-- ALROYA_DB_NEUTRAL_BACKUP:${encodeURIComponent(db)}\n`);
    const child = spawn(dumpCmd, dumpArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: targetEnvironment(resolvedTarget),
    });
    let stderrTail = "";
    let settled = false;
    let exitCode = null;
    let sinkClosed = false;
    let childClosed = false;
    let failure;
    let unsubscribe;
    let killTimer;
    const fail = (err) => {
      if (settled || failure) return;
      failure = err;
      try { child.kill(); } catch { /* تجاهل */ }
      dumpCleanup?.();
      child.stdout.unpipe(sink);
      sink.destroy();
      // Wait for both handles before the caller deletes the partial file,
      // including on Windows where destroy() does not close it synchronously.
      if (!childClosed) killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already closed */ }
      }, 5000);
      maybeDone();
    };
    const maybeDone = () => {
      if (settled || !childClosed || !sinkClosed) return;
      if (exitCode !== 0 && !failure) {
        const hint = stderrTail.split("\n").filter(Boolean).slice(-3).join(" | ");
        fail(new Error(`mysqldump فشل (رمز ${exitCode})${hint ? `: ${hint}` : ""}`));
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      unsubscribe?.();
      if (failure) reject(failure);
      else resolve();
    };
    child.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-4096); });
    child.on("error", (e) => fail(new Error(`تعذّر تشغيل ${dumpCmd}: ${e?.message ?? e}`)));
    // خطأ كتابة (امتلاء القرص…) في أي لحظة ⇒ فشل فوري — لا «نجاح» بملف مبتور.
    sink.on("error", (e) => fail(new Error(`فشل كتابة ملف النسخة: ${e?.message ?? e}`)));
    sink.on("close", () => { sinkClosed = true; maybeDone(); });
    child.on("close", (code) => { exitCode = code ?? 1; childClosed = true; maybeDone(); });
    child.stdout.on("error", fail);
    unsubscribe = guard?.onFailure(fail);
    if (!failure) child.stdout.pipe(sink);
    else child.stdout.resume();
  });
}

try {
  await assertDbTarget(resolvedTarget);
  await completeBackupDump(selected, {
    dump: dumpToFile,
    publish() {
      dumpCleanup?.();
      const size = statSync(partial).size;
      if (size < 512) throw new Error(`الناتج صغير بشكل مريب (${size} bytes) — قد يكون فشلاً صامتاً`);
      renameSync(partial, out);
      console.log(`✓ نسخة احتياطية: ${out} (${(size / 1024).toFixed(1)} KB)`);
      console.log(`  للاستعادة الآمنة: أوقف عمال الويب ثم نفّذ pnpm db:restore ${out}`);
    },
    discard() {
      dumpCleanup?.();
      for (const path of [partial, out]) {
        try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    },
  });
} catch (e) {
  dumpCleanup?.();
  // لا نُبقي ملفاً جزئياً/فارغاً — يُحسب «أحدث نسخة» لدى بوّابة الهجرة وشاشة الاستعادة.
  try { unlinkSync(partial); } catch { /* غير موجود أصلاً */ }
  try { unlinkSync(out); } catch { /* غير موجود أصلاً */ }
  console.error("✗ فشل النسخ الاحتياطي:", e?.message ?? e);
  process.exit(1);
}

if (!noRotate) {
  // Retention is deliberately paused until a complete recovery set is verified.
  // Do not call backup-rotate here: it deletes files before offsite publication.
  const passphrase = process.env.BACKUP_GPG_PASSPHRASE;
  const offsite = process.env.BACKUP_OFFSITE_DIR;
  if (offsite && !passphrase) {
    console.error("BACKUP_OFFSITE_REQUIRES_ENCRYPTION: local SQL preserved; no plaintext export");
    process.exit(1);
  }
  if (passphrase) {
    try {
      let revision = null;
      try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* recorded as unknown */ }
      await publishEncryptedBackup({
        sqlFile: out,
        sourceRevision: revision,
        encrypt(partialFile) {
          return encryptBackupWithOwnedAgent({ sqlFile: out, partialFile, passphrase });
        },
      });
      if (offsite) await mirrorPublishedBackup(`${out}.gpg`, offsite);
      console.log(`Verified encrypted publication: ${out}.gpg (integrity only; restore not yet verified)`);
    } catch (error) {
      console.error(`Encrypted publication failed: ${error.message}; local SQL preserved`);
      if (error.diagnosticHome) console.error(`Owned GPG diagnostic home preserved: ${error.diagnosticHome}`);
      process.exit(1);
    }
  }
  console.log("Retention paused: no existing backup or recovery evidence removed.");
}
// تحذير إن كان حجم النسخة صغيراً بشكل غير متوقّع (مؤشّر فقد بيانات).
try {
  const size = statSync(out).size;
  if (size < 2048) console.warn(`⚠ النسخة صغيرة (${size} bytes) — تحقّق من سلامة القاعدة.`);
} catch {
  /* تجاهل */
}
