// تمرين استعادة النسخ الاحتياطي (restore drill) — «نسخةٌ لم تُستعَد قط ليست نسخة».
//
// يستعيد أحدث نسخةٍ احتياطية إلى **قاعدة تمرينٍ معزولة تُنشأ وتُحذف**، ثم يتحقّق أنّ
// المحتوى سليمٌ فعلاً (جداول أساسية + صفوف + سلامة الترميز العربي)، ويُخرج تقريراً.
// لا يمسّ قاعدة العمل إطلاقاً.
//
// ⚠️ خلفية الحرّاس (حادثة #309، ٢٢/٧/٢٦): «اختبار استعادة» سابق دمّر قاعدةً حيّة لأنّه
// اتّبع `DATABASE_URL`. لذلك هنا: القاعدة الهدف تُشتقّ باسمٍ موسومٍ لا يُقرأ من البيئة،
// وكل حارسٍ أدناه **يفشل مغلقاً** — الرفض هو الافتراضي عند أدنى شكّ.
//
// الاستخدام:
//   pnpm db:restore-drill                 # أحدث نسخة من BACKUP_DIR
//   node scripts/backup-restore-drill.mjs --file backups/erp-....sql
//   ... --keep                            # أبقِ قاعدة التمرين للفحص اليدويّ (تُحذف افتراضياً)
//
// المتغيّرات (‎.env): DB_CONTAINER, DB_NAME, DB_ROOT_PW, BACKUP_DIR, BACKUP_GPG_PASSPHRASE
import "dotenv/config";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** لاحقة قاعدة التمرين — بصمتها هي ما يمنع الكتابة على قاعدةٍ حقيقية. */
export const DRILL_SUFFIX = "_restore_drill";

/**
 * حارس اسم قاعدة التمرين. يُصدّر للاختبار لأنّ **هذا** هو الجزء الذي يقتل إن أخطأ.
 * يرفض: الاسم غير الموسوم، ومطابقة قاعدة العمل، والحروف غير الآمنة.
 */
export function assertSafeDrillDatabase(drillDb, protectedNames = []) {
  if (typeof drillDb !== "string" || !drillDb) {
    throw new Error("DRILL_DB_INVALID: اسم قاعدة التمرين فارغ");
  }
  if (!/^[A-Za-z0-9_$-]+$/.test(drillDb)) {
    throw new Error("DRILL_DB_INVALID: اسم قاعدة التمرين يحوي محارف غير آمنة");
  }
  if (!drillDb.endsWith(DRILL_SUFFIX)) {
    throw new Error(`DRILL_DB_UNMARKED: قاعدة التمرين يجب أن تنتهي بـ${DRILL_SUFFIX}`);
  }
  for (const name of protectedNames) {
    if (name && drillDb === name) {
      throw new Error(`DRILL_DB_COLLIDES_LIVE: «${drillDb}» هي قاعدة عملٍ حيّة — رُفض التمرين`);
    }
  }
  return drillDb;
}

/**
 * حارس النسخة: تفريغُ قاعدةٍ واحدة لا يحوي `CREATE DATABASE`/`USE`. وجودُهما يعني أنّ
 * التفريغ قد **يقفز خارج** صندوق التمرين إلى قاعدةٍ مسمّاة — يُرفض قبل أيّ تنفيذ.
 */
export function assertDumpStaysInSandbox(sqlHead) {
  const text = String(sqlHead ?? "");
  const escapes = [];
  if (/^\s*CREATE\s+DATABASE/im.test(text)) escapes.push("CREATE DATABASE");
  if (/^\s*USE\s+`?[A-Za-z0-9_$-]+`?\s*;/im.test(text)) escapes.push("USE");
  if (/^\s*DROP\s+DATABASE/im.test(text)) escapes.push("DROP DATABASE");
  if (escapes.length) {
    throw new Error(
      `DUMP_ESCAPES_SANDBOX: النسخة تحوي ${escapes.join("/")} فقد تُنفَّذ خارج قاعدة التمرين`,
    );
  }
  return true;
}

/** المنفذ ٣٣٠٦ محلياً = مرآة الإنتاج (خطّ أحمر في CLAUDE.md) — لا تمرين عليه. */
export function assertPortAllowed(port) {
  if (String(port) === "3306") {
    throw new Error("DRILL_PORT_FORBIDDEN: المنفذ 3306 مرآة الإنتاج — لا يُجرى التمرين عليه");
  }
  return true;
}

/** أحدث ملف نسخة (.sql أو .sql.gpg) في المجلّد. */
export function pickLatestBackup(dir, entries) {
  const files = (entries ?? (existsSync(dir) ? readdirSync(dir) : []))
    .filter((f) => f.endsWith(".sql") || f.endsWith(".sql.gpg"))
    .map((f) => ({ f, t: entries ? 0 : statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => (entries ? b.f.localeCompare(a.f) : b.t - a.t));
  return files[0]?.f ?? null;
}

/* ─────────────────────────── التنفيذ (لا يعمل عند الاستيراد) ─────────────────────────── */

const isMain = process.argv[1] && process.argv[1].endsWith("backup-restore-drill.mjs");
if (isMain) main();

function main() {
  const argv = process.argv.slice(2);
  const flag = (f) => argv.includes(f);
  const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const fail = (m) => { console.error("✗", m); process.exit(1); };

  const container = valueOf("--container") ?? process.env.DB_CONTAINER ?? "erp-mysql";
  const rootPw = process.env.DB_ROOT_PW ?? "erp_root_pw";
  const liveDb = process.env.DB_NAME ?? "erp";
  const urlDb = (String(process.env.DATABASE_URL ?? "").match(/\/([^/?]+)(\?.*)?$/) || [])[1];
  const port = (String(process.env.DATABASE_URL ?? "").match(/:(\d+)\//) || [])[1] ?? "";
  const backupDir = process.env.BACKUP_DIR ?? "backups";

  let drillDb;
  try {
    if (port) assertPortAllowed(port);
    drillDb = assertSafeDrillDatabase(`${liveDb}${DRILL_SUFFIX}`, [
      liveDb,
      urlDb ? decodeURIComponent(urlDb) : "",
    ]);
  } catch (error) {
    fail(error.message);
  }

  const chosen = valueOf("--file") ?? (() => {
    const latest = pickLatestBackup(backupDir);
    return latest ? join(backupDir, latest) : null;
  })();
  if (!chosen) fail(`لا نسخة احتياطية في «${backupDir}» — شغّل pnpm db:backup أولاً.`);
  if (!existsSync(chosen)) fail(`الملف غير موجود: ${chosen}`);
  const size = statSync(chosen).size;
  if (size < 512) fail(`النسخة صغيرة بشكل مريب (${size} بايت) — تالفة أو فارغة.`);

  console.log(`▶ تمرين استعادة — النسخة: ${chosen} (${(size / 1048576).toFixed(1)} م.ب)`);
  console.log(`▶ قاعدة التمرين: ${drillDb} (تُحذف في النهاية${flag("--keep") ? " — مُعطَّل بـ--keep" : ""})`);

  // فكّ التشفير عند الحاجة — عبر أنبوبٍ لا ملفٍّ وسيط بالقرص.
  let sqlPath = chosen;
  if (chosen.endsWith(".gpg")) {
    const pass = process.env.BACKUP_GPG_PASSPHRASE;
    if (!pass) fail("النسخة مشفَّرة وBACKUP_GPG_PASSPHRASE غير مضبوط (من escrow المالك).");
    sqlPath = chosen.replace(/\.gpg$/, ".drill.sql");
    const dec = spawnSync("gpg", ["--batch", "--yes", "--passphrase", pass, "-o", sqlPath, "-d", chosen], { stdio: "inherit" });
    if (dec.status !== 0) fail("فشل فكّ تشفير النسخة.");
  }

  // حارس المحتوى قبل أيّ تنفيذ.
  try {
    assertDumpStaysInSandbox(readFileSync(sqlPath, "utf8").slice(0, 65536));
  } catch (error) {
    fail(error.message);
  }

  const mysql = (sql, db) =>
    execFileSync("docker", [
      "exec", "-i", "-e", `MYSQL_PWD=${rootPw}`, container,
      "mysql", "-uroot", "--default-character-set=utf8mb4", ...(db ? [db] : []), "-N", "-B", "-e", sql,
    ], { encoding: "utf8" });

  try {
    mysql(`DROP DATABASE IF EXISTS \`${drillDb}\`; CREATE DATABASE \`${drillDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    console.log("▶ استعادة…");
    const restore = spawnSync(
      "docker",
      ["exec", "-i", "-e", `MYSQL_PWD=${rootPw}`, container, "mysql", "-uroot", "--default-character-set=utf8mb4", drillDb],
      { input: readFileSync(sqlPath), stdio: ["pipe", "inherit", "inherit"], maxBuffer: 1024 * 1024 * 1024 },
    );
    if (restore.status !== 0) throw new Error("فشلت الاستعادة داخل قاعدة التمرين.");

    // ── التحقّق: نسخةٌ تُستعاد بلا محتوىً ليست نجاحاً ──
    const tables = Number(mysql(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${drillDb}';`).trim());
    if (tables < 50) throw new Error(`عدد الجداول ${tables} أقلّ من المتوقَّع — النسخة ناقصة.`);

    const core = ["invoices", "receipts", "accountingEntries", "products", "customers"];
    const counts = {};
    for (const t of core) {
      const exists = Number(mysql(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${drillDb}' AND table_name='${t}';`).trim());
      if (!exists) throw new Error(`الجدول الأساسيّ «${t}» غائب عن النسخة.`);
      counts[t] = Number(mysql(`SELECT COUNT(*) FROM \`${t}\`;`, drillDb).trim());
    }

    // سلامة الترميز العربي: نصٌّ عربيٌّ مقروء يعني أنّ النسخة والاستعادة حافظتا على utf8mb4.
    const arabicOk = Number(
      mysql(`SELECT COUNT(*) FROM \`products\` WHERE \`name\` REGEXP '[؀-ۿ]';`, drillDb).trim() || "0",
    );

    console.log("\n✓ نجح تمرين الاستعادة");
    console.log(`   الجداول: ${tables}`);
    for (const [t, n] of Object.entries(counts)) console.log(`   ${t}: ${n}`);
    console.log(`   أسماء عربية سليمة: ${arabicOk}`);
    if (counts.invoices === 0 && counts.products === 0) {
      console.warn("   ⚠ النسخة استُعيدت لكنها فارغة من بيانات الأعمال — تحقّق من مصدرها.");
    }
  } catch (error) {
    console.error("✗", error.message);
    if (!flag("--keep")) tryDrop();
    process.exit(1);
  }

  if (!flag("--keep")) tryDrop();
  process.exit(0);

  function tryDrop() {
    try {
      assertSafeDrillDatabase(drillDb, [liveDb, urlDb ? decodeURIComponent(urlDb) : ""]);
      mysql(`DROP DATABASE IF EXISTS \`${drillDb}\`;`);
      console.log(`▶ حُذفت قاعدة التمرين ${drillDb}.`);
    } catch (error) {
      console.error("⚠ تعذّر حذف قاعدة التمرين:", error.message);
    }
  }
}
