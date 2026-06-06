// نسخ احتياطي لقاعدة erp عبر mysqldump من حاوية Docker إلى ملف مؤرّخ.
// الاستخدام: pnpm db:backup
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const container = process.env.DB_CONTAINER ?? "erp-mysql";
const db = process.env.DB_NAME ?? "erp";
const pw = process.env.DB_ROOT_PW ?? "erp_root_pw";

const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
mkdirSync("backups", { recursive: true });
const out = `backups/${db}-${ts}.sql`;

try {
  const dump = execFileSync(
    "docker",
    ["exec", container, "mysqldump", `-uroot`, `-p${pw}`, "--databases", db, "--single-transaction", "--routines"],
    { maxBuffer: 1024 * 1024 * 512 }
  );
  writeFileSync(out, dump);
  console.log(`✓ نسخة احتياطية: ${out} (${dump.length} bytes)`);
  console.log("  للاستعادة: docker exec -i", container, `mysql -uroot -p${pw} <`, out);
} catch (e) {
  console.error("فشل النسخ الاحتياطي:", e?.message ?? e);
  process.exit(1);
}
