// نسخ احتياطي لقاعدة البيانات عبر mysqldump من حاوية Docker إلى ملف مؤرّخ، ثم تدوير النسخ.
// الاستخدام:
//   pnpm db:backup                        # نسخة + تدوير + نسخة خارجية (إن ضُبط BACKUP_OFFSITE_DIR)
//   node scripts/backup.mjs --no-rotate   # نسخة فقط بلا تدوير
//
// المتغيّرات (‎.env): DB_CONTAINER, DB_NAME, DB_ROOT_PW, BACKUP_DIR, BACKUP_OFFSITE_DIR
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const container = process.env.DB_CONTAINER ?? "erp-mysql";
const db = process.env.DB_NAME ?? "erp";
const pw = process.env.DB_ROOT_PW ?? "erp_root_pw";
const backupDir = process.env.BACKUP_DIR ?? "backups";

const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
mkdirSync(backupDir, { recursive: true });
const out = join(backupDir, `${db}-${ts}.sql`);

try {
  // --single-transaction: لقطة متّسقة بلا قفل الجداول (آمن أثناء التشغيل).
  const dump = execFileSync(
    "docker",
    ["exec", container, "mysqldump", `-uroot`, `-p${pw}`, "--databases", db, "--single-transaction", "--routines", "--events"],
    { maxBuffer: 1024 * 1024 * 512 }
  );
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
