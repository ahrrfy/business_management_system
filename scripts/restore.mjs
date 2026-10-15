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
import { execFileSync, spawn } from "node:child_process";
import { closeSync, createReadStream, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";
import { acquireMaintenanceLock } from "./lib/maintenance-lock.mjs";

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
const headBuffer = Buffer.alloc(Math.min(size, 4096));
const headFd = openSync(file, "r");
try {
  readSync(headFd, headBuffer, 0, headBuffer.length, 0);
} finally {
  closeSync(headFd);
}
const head = headBuffer.toString("utf8");
if (!/MySQL dump|CREATE TABLE|INSERT INTO|CREATE DATABASE/i.test(head)) {
  fail("لا يبدو الملف ناتج mysqldump صالحاً (لم نجد علامات SQL متوقّعة).");
}

const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL غير مضبوط في .env.");
const dbName = (String(url).match(/\/([^/?]+)(\?.*)?$/) || [])[1];
const targetDb = dbName ? decodeURIComponent(dbName) : "";
if (!/^[A-Za-z0-9_$-]+$/.test(targetDb)) fail("اسم القاعدة في DATABASE_URL غير صالح للاستعادة الآمنة.");

const DANGEROUS_SQL_PATTERN = new RegExp(
  [
    String.raw`\bINTO\s+(?:OUTFILE|DUMPFILE)\b`,
    String.raw`\bLOAD_FILE\s*\(`,
    String.raw`\bLOAD\s+(?:DATA|XML)\b`,
    String.raw`\b(?:GRANT|REVOKE)\b`,
    String.raw`\b(?:CREATE|ALTER|DROP|RENAME)\s+(?:DEFINER\s*=\s*[^\s]+(?:\s*@\s*[^\s]+)?\s+)?(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:USER|ROLE|SERVER|TABLESPACE|LOGFILE\s+GROUP)\b`,
    String.raw`\bSET\s+(?:GLOBAL|PERSIST|PERSIST_ONLY|PASSWORD|DEFAULT\s+ROLE|ROLE)\b`,
    String.raw`@@(?:GLOBAL|PERSIST|PERSIST_ONLY)\s*\.`,
    String.raw`\b(?:INSTALL|UNINSTALL)\s+(?:PLUGIN|COMPONENT)\b`,
    String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*[^\s]+(?:\s*@\s*[^\s]+)?\s+)?(?:AGGREGATE\s+)?FUNCTION\b[\s\S]*?\bSONAME\b`,
    String.raw`\b(?:PREPARE|EXECUTE|DEALLOCATE\s+PREPARE)\b`,
    String.raw`\b(?:SHUTDOWN|FLUSH\s+PRIVILEGES|RESET\s+(?:MASTER|SLAVE|REPLICA|PERSIST)|CHANGE\s+(?:MASTER|REPLICATION)|(?:START|STOP)\s+(?:SLAVE|REPLICA|GROUP_REPLICATION)|PURGE\s+BINARY\s+LOGS|BINLOG)\b`,
  ].join("|"),
  "i",
);

async function validateDumpTarget() {
  const marker = head.match(/^-- ALROYA_DB_NEUTRAL_BACKUP:([^\r\n]+)$/m);
  if (marker && decodeURIComponent(marker[1]) !== targetDb) {
    fail(`النسخة تخص قاعدة «${decodeURIComponent(marker[1])}» لا القاعدة الهدف «${targetDb}».`);
  }
  let sawTargetDirective = false;

  const SAFE_SQL_MODE_VALUE_RE =
    /^(?:NO_AUTO_VALUE_ON_ZERO|ONLY_FULL_GROUP_BY|STRICT_TRANS_TABLES|STRICT_ALL_TABLES|NO_ZERO_IN_DATE|NO_ZERO_DATE|ERROR_FOR_DIVISION_BY_ZERO|NO_ENGINE_SUBSTITUTION|TRADITIONAL|\s|,)*$/i;

  function inspectStatement(rawStmt, stmtLiterals = [], literalsTruncated = false) {
    const stmt = rawStmt.replace(/\s+/g, " ").trim();
    if (!stmt) return;

    if (/^(?:DELIMITER|SYSTEM)\b|\bDELIMITER\b|\\!|\\[gG]\b/i.test(stmt)) {
      fail("النسخة تحتوي أمراً واسع الصلاحية غير مسموح في استعادة التطبيق.");
    }

    if (
      /''\s*\.\s*(?:''|`[^`]+`|[A-Za-z0-9_$-]+)|(?:`[^`]+`|[A-Za-z0-9_$-]+)\s*\.\s*''/.test(
        stmt,
      )
    ) {
      fail("النسخة تحتوي أمراً واسع الصلاحية غير مسموح في استعادة التطبيق.");
    }

    if (/\bSQL_MODE\b|@OLD_SQL_MODE\b/i.test(stmt)) {
      const isAllowedSqlModeSet =
        /^SET\s+(?:SESSION\s+|LOCAL\s+)?(?:@OLD_SQL_MODE\s*:?=\s*@@(?:SESSION\.|LOCAL\.)?SQL_MODE\s*,\s*)?(?:@@(?:SESSION\.|LOCAL\.)?)?SQL_MODE\s*:?=\s*(?:''|@OLD_SQL_MODE|IFNULL\s*\(\s*@OLD_SQL_MODE\s*,\s*''\s*\))$/i.test(
          stmt,
        );
      const allLiteralsSafe =
        !literalsTruncated &&
        stmtLiterals.every((lit) => SAFE_SQL_MODE_VALUE_RE.test(lit));
      if (!isAllowedSqlModeSet || !allLiteralsSafe) {
        fail("النسخة تحتوي أمراً واسع الصلاحية غير مسموح في استعادة التطبيق.");
      }
    }

    if (/^USE\b/i.test(stmt)) {
      if (marker) fail("نسخة database-neutral تحتوي أوامر تحويل قاعدة غير مسموحة.");
      const use = stmt.match(/^USE\s+(?:`([^`]+)`|([A-Za-z0-9_$-]+))\s*$/i);
      const useDb = use ? (use[1] ?? use[2]) : "";
      if (!useDb || useDb !== targetDb) {
        fail(`النسخة تحاول التحويل إلى قاعدة أخرى: ${useDb || stmt}`);
      }
      sawTargetDirective = true;
    }

    if (/\b(?:CREATE|DROP|ALTER)\s+(?:DATABASE|SCHEMA)\b/i.test(stmt)) {
      if (marker) fail("نسخة database-neutral تحتوي أوامر تحويل قاعدة غير مسموحة.");
      if (/\bALTER\s+(?:DATABASE|SCHEMA)\b/i.test(stmt)) {
        fail("النسخة تحتوي CREATE/DROP DATABASE لا يطابق القاعدة الهدف.");
      }
      const dbMatch = stmt.match(
        /^(?:CREATE|DROP)\s+(?:DATABASE|SCHEMA)(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+(?:`([^`]+)`|([A-Za-z0-9_$-]+))\b/i,
      );
      const namedDb = dbMatch ? (dbMatch[1] ?? dbMatch[2]) : "";
      if (!namedDb || namedDb !== targetDb) {
        fail("النسخة تحتوي CREATE/DROP DATABASE لا يطابق القاعدة الهدف.");
      }
      sawTargetDirective = true;
    }

    const sanitizedTableClauseStmt = stmt.replace(
      /(?:\bON|[A-Za-z0-9_$`])\s*\((?![^()]*\b(?:SELECT|FROM|JOIN|TABLE|TABLES)\b)[^()]*\)/gi,
      "()",
    );
    const tableListClauses = [
      ...sanitizedTableClauseStmt.matchAll(
        /\b(?:FROM|USING|UPDATE|DELETE|TABLE|TABLES)\b[\s\S]*?(?=\b(?:SELECT|WHERE|GROUP|HAVING|ORDER|LIMIT|WINDOW|UNION|EXCEPT|INTERSECT|FOR|LOCK|INTO|SET|VALUES|VALUE)\b|$)/gi,
      ),
    ].map((m) => m[0]);

    const crossDbMatches = [
      ...stmt.matchAll(
        /\b(?:INTO|INSERT|REPLACE|TRUNCATE|UPDATE|DELETE|FROM|JOIN|STRAIGHT_JOIN|TABLE|TABLES|RENAME(?:\s+(?:TO|AS))?|TO|USING|REFERENCES|LIKE|CALL|VIEW|TRIGGER|PROCEDURE|FUNCTION|EVENT|INDEX|DESCRIBE|DESC|EXPLAIN|SHOW|ANALYZE|CHECK|OPTIMIZE|REPAIR|HANDLER)\s+(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE|QUICK|EXTENDED|LOCAL|TEMPORARY|NO_WRITE_TO_BINLOG)\s+)*(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:(?:TABLE|TABLES)\s+)?(?![0-9]+\s*\.\s*[0-9]+\b)(?:`([^`]+)`|([A-Za-z0-9_$-]+))\s*\.\s*(?:`[^`]+`|[A-Za-z0-9_$-]+)/gi,
      ),
      ...(
        /\b(?:INDEX|TRIGGER)\b/i.test(stmt)
          ? stmt.matchAll(
              /\bON\s+(?![0-9]+\s*\.\s*[0-9]+\b)(?:`([^`]+)`|([A-Za-z0-9_$-]+))\s*\.\s*(?:`[^`]+`|[A-Za-z0-9_$-]+)/gi,
            )
          : []
      ),
      ...(
        /^(?:ALTER|DROP|RENAME|LOCK|TRUNCATE|ANALYZE|CHECK|OPTIMIZE|REPAIR)\b/i.test(stmt)
          ? stmt.matchAll(
              /(?![0-9]+\s*\.\s*[0-9]+\b)(?:`([^`]+)`|([A-Za-z0-9_$-]+))\s*\.\s*(?:`[^`]+`|[A-Za-z0-9_$-]+)/gi,
            )
          : []
      ),
      ...stmt.matchAll(
        /(?![0-9]+\s*\.\s*[0-9]+\b)(?:`([^`]+)`|([A-Za-z0-9_$-]+))\s*\.\s*(?:`[^`]+`|[A-Za-z0-9_$-]+)\s*\.\s*(?:\*|`[^`]+`|[A-Za-z0-9_$-]+)/gi,
      ),
      ...tableListClauses.flatMap((clause) => [
        ...clause.matchAll(
          /(?:^|,|\(|\b(?:FROM|USING|UPDATE|DELETE|TABLE|TABLES|JOIN|STRAIGHT_JOIN|TO)\b)\s*(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE|QUICK|EXTENDED|LOCAL|TEMPORARY|NO_WRITE_TO_BINLOG)\s+)*(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:(?:TABLE|TABLES)\s+)?(?![0-9]+\s*\.\s*[0-9]+\b)(?:`([^`]+)`|([A-Za-z0-9_$-]+))\s*\.\s*(?:`[^`]+`|[A-Za-z0-9_$-]+)/gi,
        ),
      ]),
    ];
    for (const match of crossDbMatches) {
      const refDb = match[1] ?? match[2] ?? "";
      if (
        refDb &&
        refDb.toLowerCase() !== "new" &&
        refDb.toLowerCase() !== "old" &&
        refDb !== targetDb
      ) {
        fail(`النسخة تحاول التحويل إلى قاعدة أخرى: ${refDb}`);
      }
    }

    if (DANGEROUS_SQL_PATTERN.test(stmt)) {
      fail("النسخة تحتوي أمراً واسع الصلاحية غير مسموح في استعادة التطبيق.");
    }
  }

  let inRegularComment = false;
  let versionedCommentDepth = 0;
  let quote = null;
  let currentLiteralBuffer = "";
  let statementLiterals = [];
  let statementLiteralsTruncated = false;
  let currentDelimiter = ";";
  let statementBuffer = "";

  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!inRegularComment && quote === null && versionedCommentDepth === 0) {
      if (/^\s*(?:\\!|system\s+)/i.test(line)) {
        fail("النسخة تحتوي أمراً واسع الصلاحية غير مسموح في استعادة التطبيق.");
      }
      if (/^\s*DELIMITER(?:\s|$)/i.test(line)) {
        if (statementBuffer.trim() !== "") {
          fail("النسخة تحتوي أمراً واسع الصلاحية غير مسموح في استعادة التطبيق.");
        }
        const delimMatch = line.match(/^\s*DELIMITER\s+([;/$|!~^:]{1,16})\s*$/i);
        if (!delimMatch) {
          fail("النسخة تحتوي أمراً واسع الصلاحية غير مسموح في استعادة التطبيق.");
        }
        currentDelimiter = delimMatch[1];
        continue;
      }
    }
    let i = 0;
    const len = line.length;
    while (i < len) {
      const ch = line[i];
      const next = line[i + 1];

      if (inRegularComment) {
        if (ch === "*" && next === "/") {
          inRegularComment = false;
          statementBuffer += " ";
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }

      if (quote !== null) {
        if (ch === "\\") {
          if (quote !== "`") {
            if (currentLiteralBuffer.length < 512) {
              currentLiteralBuffer += next ?? "";
            } else {
              statementLiteralsTruncated = true;
            }
          }
          i += 2;
          continue;
        }
        if (ch === quote) {
          if (next === quote) {
            if (quote !== "`") {
              if (currentLiteralBuffer.length < 512) {
                currentLiteralBuffer += quote;
              } else {
                statementLiteralsTruncated = true;
              }
            }
            i += 2;
            continue;
          }
          if (quote === "`") {
            statementBuffer += "`";
          } else if (statementLiterals.length < 32) {
            statementLiterals.push(currentLiteralBuffer);
          } else {
            statementLiteralsTruncated = true;
          }
          currentLiteralBuffer = "";
          quote = null;
          i += 1;
          continue;
        }
        if (quote === "`") {
          statementBuffer += ch;
        } else if (currentLiteralBuffer.length < 512) {
          currentLiteralBuffer += ch;
        } else {
          statementLiteralsTruncated = true;
        }
        i += 1;
        continue;
      }

      if (versionedCommentDepth > 0 && ch === "*" && next === "/") {
        versionedCommentDepth -= 1;
        statementBuffer += " ";
        i += 2;
        continue;
      }

      if (ch === "/" && next === "*") {
        const isMysqlConditional = line[i + 2] === "!";
        const isMariaConditional =
          (line[i + 2] === "M" || line[i + 2] === "m") && line[i + 3] === "!";
        if (isMysqlConditional || isMariaConditional) {
          versionedCommentDepth += 1;
          i += isMariaConditional ? 4 : 3;
          while (i < len && /[0-9]/.test(line[i])) i += 1;
          statementBuffer += " ";
          continue;
        }
        inRegularComment = true;
        statementBuffer += " ";
        i += 2;
        continue;
      }

      if (
        (ch === "-" &&
          next === "-" &&
          (line[i + 2] === undefined || line.charCodeAt(i + 2) <= 0x20)) ||
        ch === "#"
      ) {
        break;
      }

      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        currentLiteralBuffer = "";
        if (ch === "`") statementBuffer += "`";
        else statementBuffer += "''";
        i += 1;
        continue;
      }

      if (ch === "\\" && (next === "!" || next === "g" || next === "G")) {
        fail("النسخة تحتوي أمراً واسع الصلاحية غير مسموح في استعادة التطبيق.");
      }

      if (line.startsWith(currentDelimiter, i)) {
        inspectStatement(statementBuffer, statementLiterals, statementLiteralsTruncated);
        if (currentDelimiter !== ";") {
          for (const subStmt of statementBuffer.split(";")) {
            inspectStatement(subStmt, statementLiterals, statementLiteralsTruncated);
          }
        }
        statementBuffer = "";
        statementLiterals = [];
        statementLiteralsTruncated = false;
        i += currentDelimiter.length;
        continue;
      }

      if (ch.charCodeAt(0) <= 0x20) {
        if (statementBuffer.length > 0 && !statementBuffer.endsWith(" ")) {
          statementBuffer += " ";
        }
      } else {
        statementBuffer += ch;
      }
      i += 1;
    }

    if (!inRegularComment && quote === null) {
      if (statementBuffer.length > 0 && !statementBuffer.endsWith(" ")) {
        statementBuffer += " ";
      }
      if (statementBuffer.length > 32 * 1024 * 1024) {
        fail("النسخة تحتوي أمراً واسع الصلاحية غير مسموح في استعادة التطبيق.");
      }
    } else if (quote !== null && quote !== "`") {
      if (currentLiteralBuffer.length < 512) {
        currentLiteralBuffer += "\n";
      } else {
        statementLiteralsTruncated = true;
      }
    }
  }

  if (inRegularComment || versionedCommentDepth > 0 || quote !== null || currentDelimiter !== ";") {
    fail("النسخة تحتوي أمراً واسع الصلاحية غير مسموح في استعادة التطبيق.");
  }
  if (statementBuffer.trim()) {
    inspectStatement(statementBuffer, statementLiterals, statementLiteralsTruncated);
  }
  if (!marker && !sawTargetDirective) fail("نسخة قديمة بلا هوية قاعدة مؤكدة؛ أعد إنشاء النسخة بالأداة الحالية.");
}
await validateDumpTarget();

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

let releaseMaintenanceLock;
try {
  releaseMaintenanceLock = acquireMaintenanceLock();
} catch (error) {
  fail(error?.message ?? String(error));
}
process.once("exit", () => releaseMaintenanceLock?.());

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
// BC-05: الاستعادة يجب أن تُطابق النسخة تماماً ⇒ نُسقط القاعدة أولاً، وإلا تنجو جداول/صفوف أُنشئت
// بعد تاريخ النسخة (mysqldump --add-drop-table يُسقط جداول النسخة فقط لا الجداول الأحدث منها).
// النسخ تُنشأ بـ--databases فتُعيد إنشاء القاعدة بترميزها الأصلي. نسخة الأمان أعلاه تحمي الحالة الراهنة.
const dropPrefix = Buffer.from(`DROP DATABASE IF EXISTS \`${targetDb}\`;\nCREATE DATABASE \`${targetDb}\`;\nUSE \`${targetDb}\`;\n`);

async function streamInto(command, args, env) {
  const child = spawn(command, args, { stdio: ["pipe", "inherit", "inherit"], env });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown"}`));
    });
  });
  if (dropPrefix) child.stdin.write(dropPrefix);
  // لا نقرأ ملف SQL كاملاً في RAM: دفق بضغط رجعي إلى mysql/docker. هذا يبقي الذاكرة
  // ثابتة حتى عند حد الرفع 200MB ويمنع تجميد/قتل عامل الاستعادة بسبب Buffer مزدوج.
  await Promise.all([pipeline(createReadStream(file), child.stdin), exited]);
}

console.log(`• استعادة «${dbName}» من ${file}…`);
try {
  if (flag("--native") || process.env.DB_NATIVE === "1") {
    // عميل mysql محلي (خدمة Windows أصلية): mysql -h host -P port -u user -ppass < file
    const m = String(url).match(/^mysql:\/\/([^:]+):([^@]*)@([^:/]+):(\d+)\//);
    if (!m) fail("تعذّر تفكيك DATABASE_URL للوضع الأصلي (--native).");
    const [, user, pass, host, port] = m;
    // --binary-mode يعطّل أوامر عميل mysql الموجودة داخل ملفات الإدخال (مثل \! / system).
    // من دونها يستطيع ملف خبيث تنفيذ أوامر نظام بحساب خدمة التطبيق قبل أن يصل SQL للخادم.
    const args = ["--binary-mode=1", "-h", host, "-P", port, "-u", user];
    // BC-04: كلمة المرور عبر MYSQL_PWD لا `-p` على سطر الأوامر (يُكشَف في `ps` على خادم مشترك).
    await streamInto("mysql", args, pass ? { ...process.env, MYSQL_PWD: pass } : process.env);
  } else {
    // docker exec -i <container> mysql -u<user> (يسحب هوية القاعدة من DATABASE_URL إن توفّرت)
    // BC-04: كلمة المرور عبر MYSQL_PWD (docker exec -e VAR بلا قيمة يسحبها من بيئة عميل docker) لا سطر الأوامر.
    const parsedCreds = String(url).match(/^mysql:\/\/([^:]+):([^@]*)@/);
    const dbUser = parsedCreds?.[1] ? decodeURIComponent(parsedCreds[1]) : (process.env.DB_USER ?? "root");
    const container = process.env.DB_CONTAINER ?? "erp-mysql";
    const pw = parsedCreds?.[2] ? decodeURIComponent(parsedCreds[2]) : (process.env.DB_ROOT_PW ?? "erp_root_pw");
    await streamInto(
      "docker",
      ["exec", "-i", "-e", "MYSQL_PWD", container, "mysql", "--binary-mode=1", `-u${dbUser}`],
      { ...process.env, MYSQL_PWD: pw },
    );
  }
} catch (e) {
  fail(`فشلت الاستعادة: ${e?.message ?? e}`);
}

try {
  execFileSync("pnpm", ["db:migrate:apply"], { stdio: "inherit", shell: process.platform === "win32", env: process.env });
  execFileSync("pnpm", ["db:verify"], { stdio: "inherit", shell: process.platform === "win32", env: process.env });
} catch (error) {
  fail(`اكتمل الاستيراد لكن فشلت هجرة/مراجعة المخطط: ${error?.message ?? error}`);
}

releaseMaintenanceLock?.();
releaseMaintenanceLock = undefined;

console.log("\n✅ اكتملت الاستعادة بنجاح.");
