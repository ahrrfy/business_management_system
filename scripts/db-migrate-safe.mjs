// بوّابة هجرة آمنة للإنتاج: ترفض تطبيق تغييرات المخطّط ما لم توجد نسخة احتياطية «طازجة».
// تحلّ محلّ `pnpm db:push` العاري في الإنتاج — push على قاعدة حيّة بلا نسخة = مقامرة بالبيانات.
//
// الاستخدام:  pnpm db:migrate:safe
// الشروط:    نسخة في BACKUP_DIR عمرها < ١٠ دقائق وحجمها > 2KB (وإلا تتوقّف بتعليمات واضحة).
// ملاحظة:    عند تغييرات هدّامة يعرض drizzle-kit سؤال تأكيد تفاعلياً ⇒ نفّذها من جلسة SSH
//            تفاعلية لا من cron/CI (بلا TTY يفشل السؤال بأمان — البوّابة لا تُطبّق شيئاً).
import "dotenv/config";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const backupDir = process.env.BACKUP_DIR ?? "backups";
const db = process.env.DB_NAME ?? "erp";
const MAX_AGE_MIN = 10;
const MIN_SIZE = 2048;

let newest = null;
try {
  for (const name of readdirSync(backupDir)) {
    if (!name.startsWith(`${db}-`) || !name.endsWith(".sql")) continue;
    const st = statSync(join(backupDir, name));
    if (!newest || st.mtimeMs > newest.mtimeMs) newest = { name, mtimeMs: st.mtimeMs, size: st.size };
  }
} catch {
  /* لا مجلّد نسخ ⇒ newest يبقى null */
}

const ageMin = newest ? (Date.now() - newest.mtimeMs) / 60000 : Infinity;
if (!newest || ageMin > MAX_AGE_MIN || newest.size < MIN_SIZE) {
  console.error("⛔ بوّابة الهجرة: لا نسخة احتياطية طازجة — لن أُطبّق تغييرات المخطّط.");
  if (newest) {
    console.error(`   أحدث نسخة: ${newest.name} (عمرها ${ageMin.toFixed(1)} دقيقة، ${newest.size} bytes)`);
  } else {
    console.error(`   لا نسخ إطلاقاً في «${backupDir}».`);
  }
  console.error("   خذ نسخة الآن ثم أعد المحاولة:  pnpm db:backup && pnpm db:migrate:safe");
  process.exit(1);
}

console.log(`✓ بوّابة الهجرة: نسخة طازجة موجودة (${newest.name}، عمرها ${ageMin.toFixed(1)} دقيقة).`);
if (!process.stdin.isTTY) {
  console.log("⚠ لا جلسة تفاعلية (TTY): إن احتاج drizzle-kit تأكيداً لتغيير هدّام فسيفشل بأمان — أعد التنفيذ من SSH تفاعلي.");
}
console.log("→ تطبيق المخطّط (drizzle-kit push)…");
try {
  execFileSync("pnpm", ["exec", "drizzle-kit", "push"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  console.log("✓ طُبّق المخطّط بنجاح.");
} catch {
  console.error("✗ فشل تطبيق المخطّط — القاعدة لم تُمسّ أو فشلت جزئياً؛ راجع الناتج أعلاه. النسخة الاحتياطية متوفّرة للاستعادة.");
  process.exit(1);
}
