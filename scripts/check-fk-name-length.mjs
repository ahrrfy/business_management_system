#!/usr/bin/env node
// حارِس CI — يمنع أسماء المفاتيح الأجنبية (FK) المُتولَّدة تلقائياً التي تتجاوز حدّ MySQL 8.4
// (٦٤ حرفاً لأيّ مُعرِّف). النمط الذي يُولِّده Drizzle عند استعمال `.references(() => T.C)` inline:
//
//   `${tableName}_${columnName}_${refTableName}_${refColumnName}_fk`
//
// النتيجة السلوكيّة عند التجاوز: `db:push` يفشل بـ«Identifier name '…' is too long» ⇒ كلّ CI جديد
// على أيّ فرعٍ يشتقّ منه يفشل عند setup. (رأينا هذا حرفياً على PR #769 بعد دمج
// `storeRecommendationDailyMetrics_recommendedProductId_products_id_fk` = ٦٥ حرفاً — لُحق بـPR #772.)
//
// **الحلّ الوقائيّ:** أيّ FK يُولَّد اسمه ≥٦٤ حرفاً ⇒ يُعالَج بأحد:
//   (١) استعمالُ `foreignKey({ columns, foreignColumns, name })` صريحاً باسمٍ قصير (نمط PR #772)
//   (٢) تقصيرُ اسمِ العمود أو الجدول (خطرٌ على التوافق)
//
// النطاق: `drizzle/schema.ts` وحده — الملفّ الوحيد الذي يعرّف الجداول عبر `mysqlTable`.
// دقّة الاكتشاف: يفترضُ الحارس أنّ اسم متغيّر JS للجدول المرجَّع = اسم الجدول النصيّ في mysqlTable
// (هذا صحيحٌ لـ٩٩٪ من التعريفات — الاختلافُ يُحرَص عليه يدوياً).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCHEMA_PATH = path.join(REPO_ROOT, "drizzle", "schema.ts");
const MYSQL_ID_LIMIT = 64;

const src = readFileSync(SCHEMA_PATH, "utf8");

// خريطة: اسم متغيّر JS للجدول → اسم الجدول النصيّ.
// نلتقط: `export const VAR = mysqlTable("NAME", ...` — النمط الأشيع في هذا المستودع.
const varToTable = new Map();
for (const m of src.matchAll(/export\s+const\s+(\w+)\s*=\s*mysqlTable\s*\(\s*["']([^"']+)["']/g)) {
  varToTable.set(m[1], m[2]);
}

// المسح: لكلّ تعريف جدول، نلتقط كتلته وننقسم إلى «شرائحِ أعمدة» — بداية كلّ شريحة
// `\n  colVar: ...` (٤ مسافات + اسم متغيّر + ':')، ونتبّع الاستدعاءَ (chain) حتى الفاصلة النهائية
// أو بداية الشريحة التالية. داخل الشريحة نجد `type("colName"` واحدة و`.references()` واحدة.
// هذا يعالج نمط الأسطر المتعدّدة الذي فاتَ الحارسَ الأوّل (السطران ٢-٣ بعيدَين عن bigint).
const violations = [];

// نُلقّم كلّ mysqlTable(...) في كتلته الكاملة عبر عدّ الأقواس من نقطة البداية.
function extractTableBlock(source, startIdx) {
  // startIdx يشير إلى «mysqlTable»
  let depth = 0;
  let i = source.indexOf("(", startIdx);
  if (i === -1) return null;
  const openAt = i;
  depth = 1;
  i++;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    // نتجاوز محتوى النصوص لتفادي عدّ أقواسٍ داخل سلاسل نصيّة
    else if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i++; // تجاوز محرف الهروب
        i++;
      }
    }
    i++;
  }
  return { block: source.substring(openAt, i), endOffset: i };
}

// نمط النوع (النطاق الأشيع في drizzle-orm/mysql-core)
const TYPE_RE = /\b(?:bigint|int|varchar|text|smallint|decimal|boolean|date|timestamp|datetime|mediumint|tinyint|char|json)\s*\(\s*["']([^"']+)["']/;
const REF_RE = /\.references\s*\(\s*\(\s*\)\s*=>\s*(\w+)\s*\.\s*(\w+)/;

// نلتقط اسم الجدول + اسم المتغيّر بمطابقةٍ واحدة تنتهي **قبل** قوس mysqlTable المفتوح،
// فيجد `extractTableBlock` القوسَ الصحيحَ ذاتَه (لا قوس عمودٍ داخليّ).
for (const match of src.matchAll(/export\s+const\s+(\w+)\s*=\s*mysqlTable(?=\s*\()/g)) {
  const tableVar = match[1];
  // نتحقّق من الاسم النصيّ للجدول داخل الاستدعاء
  const afterMysqlTable = src.substring(match.index + match[0].length);
  const nameMatch = afterMysqlTable.match(/^\s*\(\s*["']([^"']+)["']/);
  if (!nameMatch) continue;
  const tableName = nameMatch[1];
  const blockInfo = extractTableBlock(src, match.index + match[0].length);
  if (!blockInfo) continue;

  // نجزّئ الكتلة إلى «شرائح أعمدة»: كلٌّ يبدأ بـ`\n  identifier:` (اسم عمود JS في المستوى الأوّل).
  // نستعمل regex بسيطاً — دقيقٌ بما يكفي لهذا المستودع (تنسيقٌ موحَّد ٢-مسافات).
  const colStarts = [];
  const colRe = /\n\s{2,4}(\w+)\s*:/g;
  let m;
  while ((m = colRe.exec(blockInfo.block)) !== null) {
    colStarts.push({ index: m.index, colVar: m[1] });
  }

  for (let i = 0; i < colStarts.length; i++) {
    const start = colStarts[i].index;
    const end = i + 1 < colStarts.length ? colStarts[i + 1].index : blockInfo.block.length;
    const chunk = blockInfo.block.substring(start, end);

    const refM = chunk.match(REF_RE);
    if (!refM) continue;

    const typeM = chunk.match(TYPE_RE);
    if (!typeM) continue;

    const colName = typeM[1];
    const refVar = refM[1];
    const refJsCol = refM[2];
    const refTableName = varToTable.get(refVar);
    if (!refTableName) continue;
    // اسم العمود المرجَّع = اسم النصّ داخل `type("colName")` في الجدول الآخر. عادةً = JS col name.
    const refColName = refJsCol;

    const fkName = `${tableName}_${colName}_${refTableName}_${refColName}_fk`;
    if (fkName.length > MYSQL_ID_LIMIT) {
      // احسب رقم السطر بحساب `\n` قبل موضع الشريحة داخل الملفّ.
      const absoluteOffset = blockInfo.block.indexOf(chunk) >= 0
        ? (match.index + match[0].length + start)
        : match.index;
      const lineNo = src.substring(0, absoluteOffset).split("\n").length;
      violations.push({
        table: tableName,
        column: colName,
        refTable: refTableName,
        refCol: refColName,
        fkName,
        length: fkName.length,
        line: lineNo,
        tableVar,
      });
    }
  }
}

if (violations.length === 0) {
  console.log("✓ فحص أسماء FK: كلّها ≤٦٤ حرفاً (حدّ MySQL 8.4).");
  process.exit(0);
}

console.error("⛔ حارس check:fk-name — أسماء FK تتجاوز ٦٤ حرفاً (MySQL 8.4 يرفضها):\n");
for (const v of violations) {
  console.error(`  drizzle/schema.ts:${v.line}`);
  console.error(`    الجدول: ${v.table}`);
  console.error(`    العمود: ${v.column} → ${v.refTable}.${v.refCol}`);
  console.error(`    اسم FK المُتولَّد: ${v.fkName}`);
  console.error(`    الطول: ${v.length} (حدّ MySQL: ${MYSQL_ID_LIMIT})`);
  console.error("");
}
console.error(`المُخرج: db:push على قواعد MySQL 8.4 سيفشل بـ«Identifier name '…' is too long».`);
console.error(`الحلّ: استبدلْ \`.references()\` inline بـ\`foreignKey({ columns, foreignColumns, name })\` باسمٍ صريحٍ قصير (نمط PR #772).`);
process.exit(1);
