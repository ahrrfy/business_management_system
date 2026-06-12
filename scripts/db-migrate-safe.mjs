// بوّابة هجرة آمنة للإنتاج: ترفض تطبيق تغييرات المخطّط ما لم توجد نسخة احتياطية «طازجة».
// تستخدم `drizzle-kit migrate` (لا تفاعلية) بدلاً من `push` (تفاعلية تتوقف عند enum/destrucive).
//
// الاستخدام:  pnpm db:migrate:safe
// الشروط:    نسخة في BACKUP_DIR عمرها < ١٠ دقائق وحجمها > 2KB (وإلا تتوقّف بتعليمات واضحة).
// سير العمل: pnpm db:generate (محلّي) → commit → git pull (VPS) → pnpm db:backup && pnpm db:migrate:safe
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
console.log("→ تطبيق ملفات الهجرة (drizzle-orm migrator — لا تفاعلي مع أخطاء واضحة)…");
try {
  execFileSync("node", ["scripts/db-migrate-apply.mjs"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  console.log("✓ طُبّقت الهجرات بنجاح.");
} catch {
  console.error("✗ فشل تطبيق الهجرات — القاعدة لم تُمسّ أو فشلت جزئياً؛ راجع الناتج أعلاه. النسخة الاحتياطية متوفّرة للاستعادة.");
  process.exit(1);
}
