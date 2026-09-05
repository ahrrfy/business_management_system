#!/usr/bin/env node
/**
 * **تجربةُ تشغيلٍ للهجرات على مخطّطٍ يُطابق الإنتاج** (٢٠/٨).
 *
 * ## لماذا وُجد هذا السكربت
 *
 * ملفّاتُ الهجرات **لا يُنفّذها أيُّ اختبار في المستودع**: قاعدةُ الاختبار تُبنى بـ`db:push`
 * من `drizzle/schema.ts` مباشرةً (`scripts/init-test-db.mjs`)، فـSQL الخامّ لا يُشغَّل قطّ
 * قبل أن يصل خادمَ الإنتاج. ولهذا مرّت هجرةٌ تكتب `` `r`.`status` `` عبر **CI أخضرَ بالكامل**
 * ثمّ سقطت على قاعدة الإنتاج بـ`ER_BAD_FIELD_ERROR — Unknown column 'r.status'`: اسمُ العمود
 * `receiptStatus`، و`status` خاصيّةُ Drizzle لا اسمُ عمود. وSQL الخامّ لا يمرّ بالـORM.
 *
 * ⛔ **ولا يُغني عنه حارسٌ نصّيّ**: `status` اسمُ عمودٍ حقيقيٍّ في جداولَ أخرى، فالمطابقةُ
 * بالاسم إمّا تفوت العطب أو تُنذر كذباً على هجراتٍ صحيحة — والحارسُ الذي يُنذر كذباً يُتجاوَز.
 * الضمانُ الوحيد **تشغيلُ SQL فعلاً**.
 *
 * ## ما يفعله
 *
 * ① يبني قاعدةً بالمخطّط الحاليّ (`db:push` على قاعدةٍ فارغة — نفس مسار `test:db:init`).
 * ② يُسقط ما تُنشئه الهجراتُ المستهدَفة (جداول/أعمدة/فهارس/مفاتيح) فيعود المخطّط إلى
 *    **حالة ما قبلها** — أي حالة الإنتاج.
 * ③ يُطبّق ملفّاتها بترتيبها وبـ`multipleStatements: true` (نفس `db-migrate-apply.mjs`،
 *    فكتلُ `SET @var; PREPARE;` تحتاجه).
 *
 * ## الاستعمال
 *
 *   node scripts/migration-dry-run.mjs --from 0230            # كلُّ هجرةٍ رقمُها ≥ 0230
 *   node scripts/migration-dry-run.mjs --from 0230 --to 0238
 *
 * يقرأ `MIGRATION_DRY_RUN_URL` أو يشتقّ قاعدةً على 3310. ويرفض العمل على 3306 (مرآة الإنتاج).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "mysql2/promise";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const FROM = Number(argOf("--from", "0"));
const TO = Number(argOf("--to", "9999"));
const MIG_DIR = join(process.cwd(), "drizzle/migrations");

const url = process.env.MIGRATION_DRY_RUN_URL
  ?? "mysql://root:testpw@127.0.0.1:3310/erp_migration_dryrun";
if (/:3306\b/.test(url) && process.env.ALLOW_PORT_3306 !== "1") {
  console.error("✗ 3306 مرفوض (قد يكون مرآةَ الإنتاج). استعمل 3310 أو اضبط ALLOW_PORT_3306=1 عن قصد.");
  process.exit(1);
}

const targets = readdirSync(MIG_DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .filter((f) => {
    const n = Number(f.slice(0, 4));
    return n >= FROM && n <= TO;
  })
  .sort();

if (!targets.length) {
  console.error(`✗ لا هجرات في المدى ${FROM}..${TO}`);
  process.exit(1);
}

const stripComments = (sql) =>
  sql.split("\n").map((l) => (l.trim().startsWith("--") ? "" : l)).join("\n");

/** يستخرج ما تُنشئه الهجراتُ المستهدَفة كي يُسقَط قبل التطبيق. */
function artifactsOf(files) {
  const tables = new Set(), cols = new Set(), keys = new Set(), constraints = new Set();
  for (const f of files) {
    const s = stripComments(readFileSync(join(MIG_DIR, f), "utf8"));
    for (const m of s.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`?(\w+)`?/gi)) tables.add(m[1]);
    for (const m of s.matchAll(/ALTER TABLE `(\w+)` ADD COLUMN `(\w+)`/g)) cols.add(`${m[1]}.${m[2]}`);
    for (const m of s.matchAll(/ALTER TABLE\s+`?(\w+)`?([\s\S]*?)(?=;|$)/gi)) {
      const table = m[1];
      const body = m[2];
      for (const c of body.matchAll(/ADD COLUMN\s+`?(\w+)`?/gi)) cols.add(`${table}.${c[1]}`);
      for (const k of body.matchAll(/ADD\s+(?:UNIQUE\s+)?(?:INDEX|KEY)\s+`?(\w+)`?/gi)) keys.add(`${table}.${k[1]}`);
      for (const c of body.matchAll(/ADD\s+CONSTRAINT\s+`?(\w+)`?/gi)) constraints.add(`${table}.${c[1]}`);
    }
    for (const m of s.matchAll(/CREATE (?:UNIQUE )?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?/gi)) keys.add(`${m[2]}.${m[1]}`);
    for (const m of s.matchAll(/ALTER TABLE `(\w+)` ADD (?:UNIQUE )?(?:INDEX|KEY|CONSTRAINT)\s+`(\w+)`/gi)) keys.add(`${m[1]}.${m[2]}`);
  }
  return {
    tables: [...tables],
    cols: [...cols],
    keys: [...keys],
    constraints: [...constraints],
  };
}

const c = await createConnection({ uri: url, multipleStatements: true });
const { tables, cols, keys, constraints } = artifactsOf(targets);

await c.query("SET FOREIGN_KEY_CHECKS = 0");
// الأعمدة المضافة قد تعتمد عليها CHECK/FK؛ إسقاط العمود أولاً يفشل ويترك حالةً جزئية
// تجعل dry-run يختبر إعادة تطبيق فوق المخطط الحالي بدلاً من حالة ما قبل الهجرة.
for (const spec of constraints) {
  const [t, n] = spec.split(".");
  try { await c.query(`ALTER TABLE \`${t}\` DROP FOREIGN KEY \`${n}\``); } catch { /* ليس FK أو الجدول أُسقط */ }
  try { await c.query(`ALTER TABLE \`${t}\` DROP CHECK \`${n}\``); } catch { /* ليس CHECK */ }
  try { await c.query(`ALTER TABLE \`${t}\` DROP INDEX \`${n}\``); } catch { /* ليس UNIQUE constraint */ }
}
for (const spec of keys) {
  const [t, n] = spec.split(".");
  try { await c.query(`ALTER TABLE \`${t}\` DROP FOREIGN KEY \`${n}\``); } catch { /* ليس مفتاحاً */ }
  try { await c.query(`ALTER TABLE \`${t}\` DROP INDEX \`${n}\``); } catch { /* ليس فهرساً */ }
}
for (const t of tables) await c.query(`DROP TABLE IF EXISTS \`${t}\``);
for (const spec of cols) {
  const [t, col] = spec.split(".");
  const [r] = await c.query(
    "SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",
    [t, col],
  );
  if (!r[0].n) continue;
  const [fks] = await c.query(
    "SELECT CONSTRAINT_NAME cn FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL",
    [t, col],
  );
  for (const fk of fks) { try { await c.query(`ALTER TABLE \`${t}\` DROP FOREIGN KEY \`${fk.cn}\``); } catch { /* أُسقط سلفاً */ } }
  try { await c.query(`ALTER TABLE \`${t}\` DROP COLUMN \`${col}\``); } catch { /* عمودٌ مشتركٌ لا يُسقَط */ }
}
await c.query("SET FOREIGN_KEY_CHECKS = 1");

let applied = 0;
for (const f of targets) {
  const sql = readFileSync(join(MIG_DIR, f), "utf8");
  const parts = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  for (const [i, part] of parts.entries()) {
    const clean = stripComments(part).trim();
    if (!clean) continue;
    try {
      await c.query(clean);
    } catch (e) {
      console.error(`\n✗ ${f} — العبارة ${i + 1}`);
      console.error(`   ${e.code}: ${e.sqlMessage ?? e.message}`);
      await c.end();
      process.exit(1);
    }
  }
  applied++;
  console.log(`✓ ${f}`);
}
console.log(`\n✓ نجحت ${applied}/${targets.length} هجرة على مخطّطٍ يُطابق الإنتاج.`);
await c.end();
