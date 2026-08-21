#!/usr/bin/env node
// ═══ حارس: اسم العمود في schema.ts ≠ اسم العمود الذي تتركه الهجرات ═══
//
// **العطل الذي أوجده (٢١/٨/٢٦، بلاغ المالك «تعذّر إتمام مرتجع الشراء»):**
// `mysqlEnum` في drizzle أوّلُ معاملِه هو **اسم العمود في القاعدة**، لا اسم نوع الـenum
// (وهْمٌ مستورَد من Postgres). فمن كتب `settlement: mysqlEnum("purchaseReturnSettlement", …)`
// ظنّ أنّه يُسمّي النوع، بينما ألزم الـORM بكتابة عمودٍ اسمه `purchaseReturnSettlement`.
// وهجرة `0239` — المكتوبة يدوياً — أنشأت العمود باسمه الحقيقيّ `settlement`.
//
// **لماذا مرّ عبر CI أخضرَ بالكامل:** قاعدةُ الاختبار تُبنى بـ`db:push` **من schema.ts**
// (CLAUDE.md §٤-ج) ⇒ العمود يُخلَق هناك بالاسم الخاطئ نفسه فيتطابق الطرفان وتنجح كلّ
// الاختبارات. أمّا الإنتاج فيُبنى بملفّات SQL ⇒ `Unknown column 'purchaseReturnSettlement'`
// على **كل** مرتجع شراء. سبعةُ أعمدةٍ في أربعة جداول كانت مكسورةً هكذا حين كُتب هذا الحارس.
//
// **الاسم المُحتكَم إليه هو الاسم النهائيّ لا التاريخيّ** (مراجعة Codex على PR #694):
// جمعُ كل اسمٍ ذُكر في SQL يجعل عموداً أُنشئ ثمّ **أُسقِط أو أُعيدت تسميته** يبقى في المجموعة،
// فيمرّ الحارس على العطب نفسه الذي جاء يمنعه. لذلك نُعيد **تشغيل** الهجرات بترتيب `_journal.json`
// مطبِّقين ADD/DROP/RENAME/CHANGE وDROP TABLE، فتكون المجموعة هي أعمدةُ الإنتاج الفعليّة.
// (المستودع يحوي فعلاً `RENAME COLUMN earnedWages TO earnedGrossWages` و`CHANGE COLUMN
// paymentMethod woPaymentMethod` وعشرَ عمليّات `DROP COLUMN`.)
//
// **المطابقة ضيّقةٌ عمداً — لا إنذار كاذب:** لا يشتكي إلّا حين يجتمع الشرطان معاً على
// جدولٍ تُنشئه هجرةٌ فعلاً: (١) اسم العمود الذي يكتبه الـORM **غائبٌ** عن الحالة النهائيّة،
// و(٢) اسم **الخاصيّة** موجودٌ فيها. أي أنّ الطرفين يأتيان من التحليل نفسه، فتحليلٌ ناقص
// يُسكِت الحارس ولا يجعله يكذب. واختلافُ الاسمَين مشروعٌ ما دامت الهجرة توافقه
// (١١٣ عموداً كذلك في المستودع اليوم — كلّها تمرّ).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = "drizzle/migrations";
const JOURNAL_FILE = path.join(MIGRATIONS_DIR, "meta/_journal.json");
const SCHEMA_FILE = "drizzle/schema.ts";

/** المعرّف في SQL: `مُقتبَسٌ` أو عارٍ — الهجرات القديمة تكتبه عارياً (`CREATE TABLE voucherCategories`). */
const ident = (quoted, plain) => quoted ?? plain;
/** كلماتٌ تبدأ بها أسطرُ القيود لا الأعمدة (تظهر حين يكون المعرّف عارياً). */
const NOT_A_COLUMN = new Set([
  "PRIMARY", "KEY", "UNIQUE", "CONSTRAINT", "INDEX", "FOREIGN", "FULLTEXT", "SPATIAL", "CHECK",
]);
/**
 * التصفية تسري على **العاري** وحده: `KEY idx (…)` بادئةُ قيد، أمّا `` `key` varchar `` فعمودٌ
 * حقيقيّ (`roles.key` قائمٌ فعلاً) — والاقتباس هو ما يفصل بينهما بلا لَبس.
 */
const isColumn = (quoted, plain) =>
  quoted ? true : Boolean(plain) && !NOT_A_COLUMN.has(plain.toUpperCase());

/** أعمدة schema.ts: [{ table, prop, dbCol }] — `prop: type("dbCol"` هو شكل كل عمود في drizzle. */
export function parseSchemaColumns(source) {
  const out = [];
  let table = null;
  let pendingTableConst = false;
  for (const line of source.split("\n")) {
    const inline = line.match(/^export const \w+ = mysqlTable\(\s*"([^"]+)"/);
    if (inline) { table = inline[1]; pendingTableConst = false; continue; }
    if (/^export const \w+ = mysqlTable\(\s*$/.test(line)) { pendingTableConst = true; continue; }
    if (pendingTableConst) {
      const named = line.match(/^\s*"([^"]+)",\s*$/);
      if (named) { table = named[1]; pendingTableConst = false; }
      continue;
    }
    if (!table) continue;
    const col = line.match(/^\s{4}(\w+):\s*(\w+)\(\s*"([^"]+)"/);
    if (col) out.push({ table, prop: col[1], dbCol: col[3] });
  }
  return out;
}

/**
 * الحالة النهائيّة لأعمدة كل جدول بعد **تشغيل** ملفّات SQL بالترتيب المُعطى.
 * `sqlFiles` مصفوفة نصوصٍ مرتَّبة (ترتيب `_journal.json` ثم ما ليس فيه).
 *
 * ⚠️ `CREATE TABLE` يُوحِّد (union) ولا يستبدل: ملفّاتُ `extras/` تُعيد إنشاء جداولَ قائمة
 * بـ`IF NOT EXISTS`، والاستبدالُ كان يمحو أعمدةً أضافها `ALTER` سابق ⇒ إنذارٌ كاذب.
 * وإسقاطُ جدولٍ ثمّ إعادةُ إنشائه بتعريفٍ مختلف يبقى خارج النموذج (لا حالةَ كهذه اليوم).
 */
export function resolveEffectiveColumns(sqlFiles) {
  const byTable = new Map();
  const ensure = (t) => {
    if (!byTable.has(t)) byTable.set(t, new Set());
    return byTable.get(t);
  };

  for (const raw of sqlFiles) {
    const sql = raw.replace(/^\s*--.*$/gm, "");

    // الترتيب داخل الملفّ الواحد مهمّ (0139: ADD ثمّ DROP على الجدول نفسه) ⇒ نمرّ على
    // العبارات بترتيب ظهورها لا نوعاً بعد نوع.
    const statements = [];
    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`([^`]+)`|(\w+))\s*\(([\s\S]*?)\n\s*\)\s*(?:ENGINE|;|$)/gi,
    )) {
      statements.push({ at: m.index, kind: "create", table: ident(m[1], m[2]), body: m[3] });
    }
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:`([^`]+)`|(\w+))([\s\S]*?)(?:;|$)/gi)) {
      statements.push({ at: m.index, kind: "alter", table: ident(m[1], m[2]), body: m[3] });
    }
    for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:`([^`]+)`|(\w+))/gi)) {
      statements.push({ at: m.index, kind: "dropTable", table: ident(m[1], m[2]) });
    }
    statements.sort((a, b) => a.at - b.at);

    for (const st of statements) {
      if (st.kind === "dropTable") { byTable.delete(st.table); continue; }
      if (st.kind === "create") {
        const cols = ensure(st.table);
        for (const line of st.body.split("\n")) {
          const col = line.match(/^\s*(?:`([^`]+)`|(\w+))\s+[A-Za-z]/);
          if (col && isColumn(col[1], col[2])) cols.add(ident(col[1], col[2]));
        }
        continue;
      }
      // ALTER — الجدول قد يكون غير معروفٍ لنا (أُنشئ قبل التجميد) ⇒ نتتبّعه على أيّ حال.
      const cols = ensure(st.table);
      const ops = [];
      for (const m of st.body.matchAll(
        /ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:`([^`]+)`|(\w+))\s+[A-Za-z]/gi,
      )) {
        if (isColumn(m[1], m[2])) ops.push({ at: m.index, add: ident(m[1], m[2]) });
      }
      // `DROP COLUMN c` أو `DROP c` — و`DROP INDEX/KEY/CONSTRAINT/PRIMARY` تُصفّيها NOT_A_COLUMN.
      for (const m of st.body.matchAll(/DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(?:`([^`]+)`|(\w+))/gi)) {
        if (isColumn(m[1], m[2])) ops.push({ at: m.index, drop: ident(m[1], m[2]) });
      }
      for (const m of st.body.matchAll(
        /RENAME\s+COLUMN\s+(?:`([^`]+)`|(\w+))\s+TO\s+(?:`([^`]+)`|(\w+))/gi,
      )) {
        ops.push({ at: m.index, drop: ident(m[1], m[2]), add: ident(m[3], m[4]) });
      }
      for (const m of st.body.matchAll(
        /CHANGE\s+(?:COLUMN\s+)?(?:`([^`]+)`|(\w+))\s+(?:`([^`]+)`|(\w+))/gi,
      )) {
        ops.push({ at: m.index, drop: ident(m[1], m[2]), add: ident(m[3], m[4]) });
      }
      ops.sort((a, b) => a.at - b.at);
      for (const op of ops) {
        if (op.drop) cols.delete(op.drop);
        if (op.add) cols.add(op.add);
      }
    }
  }
  return byTable;
}

/** الانحراف: الـORM يكتب اسماً لا وجود له في الحالة النهائيّة، واسمُ الخاصيّة موجودٌ فيها. */
export function findDrift(schemaColumns, effectiveColumns) {
  const drift = [];
  for (const c of schemaColumns) {
    if (c.dbCol === c.prop) continue;
    const cols = effectiveColumns.get(c.table);
    if (!cols || cols.size === 0) continue;    // جدولٌ لا تُنشئه هجرة ⇒ لا حكم
    if (cols.has(c.dbCol)) continue;           // الهجرات توافق الـORM ⇒ سليم
    if (cols.has(c.prop)) drift.push(c);
  }
  return drift;
}

/** ملفّات SQL بترتيب `_journal.json` أوّلاً (= ترتيب الإنتاج)، ثمّ ما ليس فيه (extras/يتامى). */
export function orderedMigrationFiles(dir = MIGRATIONS_DIR, journalFile = JOURNAL_FILE) {
  const all = [];
  const walk = (d) => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".sql")) all.push(full);
    }
  };
  walk(dir);
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
  const ordered = [];
  const seen = new Set();
  for (const entry of journal.entries) {
    const file = path.join(dir, `${entry.tag}.sql`);
    if (fs.existsSync(file) && !seen.has(file)) { ordered.push(file); seen.add(file); }
  }
  for (const file of all) if (!seen.has(file)) ordered.push(file);
  return ordered;
}

function selftest() {
  const schema = parseSchemaColumns([
    'export const widgets = mysqlTable(',
    '  "widgets",',
    '  {',
    '    id: bigint("id", { mode: "number" }).primaryKey(),',
    '    status: mysqlEnum("widgetStatus", ["A", "B"]).notNull(),',
    '    kind: mysqlEnum("widgetKind", ["X"]).notNull(),',
    '    tone: mysqlEnum("widgetTone", ["Y"]).notNull(),',
    '  },',
    ');',
  ].join("\n"));

  const CREATE_MATCHING = [
    "CREATE TABLE `widgets` (",
    "  `id` bigint NOT NULL,",
    "  `widgetStatus` enum NOT NULL,",
    "  `widgetKind` enum NOT NULL,",
    "  `widgetTone` enum NOT NULL,",
    "  PRIMARY KEY (`id`)",
    ");",
  ].join("\n");
  const CREATE_DIVERGED = CREATE_MATCHING.replace("`widgetStatus`", "`status`");
  // الشكل العاري (بلا علامات خلفية) الذي تكتبه الهجرات القديمة.
  const CREATE_BARE_DIVERGED = [
    "CREATE TABLE IF NOT EXISTS widgets (",
    "  id BIGINT NOT NULL AUTO_INCREMENT,",
    "  status ENUM('A','B') NOT NULL,",
    "  widgetKind ENUM('X') NOT NULL,",
    "  widgetTone ENUM('Y') NOT NULL,",
    "  PRIMARY KEY (id)",
    ");",
  ].join("\n");

  const cases = [
    {
      name: "يُمسك اسماً خالفته الهجرة منذ الإنشاء",
      sql: [CREATE_DIVERGED],
      expect: ["status"],
    },
    {
      name: "يُمسكه أيضاً حين يكتب المعرّفَ عارياً بلا علامات خلفية",
      sql: [CREATE_BARE_DIVERGED],
      expect: ["status"],
    },
    {
      name: "يُمسك عموداً أُنشئ بالاسم الصحيح ثمّ أُعيدت تسميته (فجوة مراجعة Codex)",
      sql: [CREATE_MATCHING, "ALTER TABLE `widgets` RENAME COLUMN `widgetStatus` TO `status`;"],
      expect: ["status"],
    },
    {
      name: "يُمسك CHANGE COLUMN كما يُمسك RENAME",
      sql: [CREATE_DIVERGED, "ALTER TABLE `widgets` CHANGE COLUMN `widgetKind` `kind` enum NOT NULL;"],
      expect: ["status", "kind"],
    },
    {
      name: "لا يشتكي على عمودٍ توافقه الهجرة، ولا على جدولٍ لا تُنشئه هجرة",
      sql: [CREATE_MATCHING, "CREATE TABLE `gadgets` (\n  `id` bigint NOT NULL\n);"],
      expect: [],
    },
    {
      name: "الترتيب داخل الملفّ الواحد: DROP ثمّ ADD ثمّ DROP لا يُبقي العمود",
      sql: [
        CREATE_MATCHING,
        "ALTER TABLE `widgets` DROP COLUMN `widgetStatus`;\n" +
        "ALTER TABLE `widgets` ADD COLUMN `status` enum NOT NULL;\n" +
        "ALTER TABLE `widgets` DROP COLUMN `status`;",
      ],
      expect: [],
    },
    {
      name: "إسقاط الجدول يُلغي الحكم عليه بدل الحكم بأسماءٍ ميتة",
      sql: [CREATE_DIVERGED, "DROP TABLE IF EXISTS `widgets`;"],
      expect: [],
    },
    {
      name: "الفهارس والقيود ليست أعمدة (ADD INDEX/CONSTRAINT لا يُسمَّم المجموعة)",
      sql: [
        CREATE_MATCHING,
        "ALTER TABLE `widgets` ADD INDEX idx_w (`widgetKind`), ADD CONSTRAINT chk_w CHECK (`id` > 0);",
        "ALTER TABLE `widgets` RENAME COLUMN `widgetStatus` TO `status`;",
      ],
      expect: ["status"],
    },
  ];

  for (const c of cases) {
    const got = findDrift(schema, resolveEffectiveColumns(c.sql)).map((d) => d.prop).sort();
    const want = [...c.expect].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(`⛔ فشل الاختبار الذاتي «${c.name}»: توقّعنا ${JSON.stringify(want)} وجاء ${JSON.stringify(got)}`);
      process.exit(1);
    }
  }
  console.log(`✓ الاختبار الذاتي: ${cases.length} حالاتٍ تمرّ (إنشاء مُقتبَس/عارٍ · إعادة تسمية · CHANGE · إسقاط عمود/جدول · قيود · موافقة).`);
}

function main() {
  if (process.argv.includes("--selftest")) { selftest(); return; }
  const schemaColumns = parseSchemaColumns(fs.readFileSync(SCHEMA_FILE, "utf8"));
  const files = orderedMigrationFiles().map((f) => fs.readFileSync(f, "utf8"));
  const effective = resolveEffectiveColumns(files);
  const drift = findDrift(schemaColumns, effective);
  if (drift.length) {
    console.error("⛔ انحراف اسم العمود بين schema.ts وملفّات الهجرة (يسقط على الإنتاج وحده):\n");
    for (const d of drift) {
      console.error(
        `  ${d.table}.${d.prop}: الـORM يكتب \`${d.dbCol}\` بينما الهجرات تترك \`${d.prop}\``,
      );
    }
    console.error(
      "\nأوّل معامل لـ`mysqlEnum` هو **اسم العمود** لا اسم النوع. صحّح schema.ts ليطابق SQL الهجرة" +
      "\n(لا العكس إن كانت الهجرة منشورة: عمود الإنتاج قائمٌ بالاسم الذي أنشأته)، ثم أعد `pnpm test:db:init`.",
    );
    process.exit(1);
  }
  console.log(
    `✓ لا انحراف في أسماء الأعمدة (${schemaColumns.length} عموداً مفحوصاً، ${effective.size} جدولاً من ${files.length} ملفّ هجرة).`,
  );
}

// لا يُشغَّل عند الاستيراد (اختبارٌ يستورد الدوالّ أعلاه).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
