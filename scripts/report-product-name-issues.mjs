#!/usr/bin/env node
/**
 * تقرير قراءة فقط لجودة أسماء المنتجات قبل الترحيل.
 *
 * الاستخدام:
 *   node scripts/report-product-name-issues.mjs --limit 500 --after-id 0 --out ./tmp/product-name-report.json
 *
 * لا يعدّل قاعدة البيانات. الترحيل الفعلي يعتمد على التقرير ومسودة AI وموافقة بشرية.
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";

const DEFAULT_LIMIT = 500;
const DEFAULT_LONG_NAME_LIMIT = 120;
const DEFAULT_SHORT_NAME_LIMIT = 3;

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

function normalizeForComparison(value) {
  let out = String(value ?? "").trim().toLowerCase();
  out = out.replace(/[ً-ٰٟ]/g, "");
  const folds = [["أ", "ا"], ["إ", "ا"], ["آ", "ا"], ["ٱ", "ا"], ["ة", "ه"], ["ى", "ي"], ["ؤ", "و"], ["ئ", "ي"], ["ـ", ""]];
  for (const [from, to] of folds) out = out.split(from).join(to);
  const arabic = "٠١٢٣٤٥٦٧٨٩";
  const persian = "۰۱۲۳۴۵۶۷۸۹";
  out = Array.from(out, (ch) => {
    const ai = arabic.indexOf(ch);
    const pi = persian.indexOf(ch);
    return ai >= 0 ? String(ai) : pi >= 0 ? String(pi) : ch;
  }).join("");
  return out.replace(/\s+/g, " ");
}

function issueFlags(row, options) {
  const name = String(row.name ?? "").trim();
  const normalized = normalizeForComparison(name);
  const issues = [];
  if (!name) issues.push("EMPTY_NAME");
  if (name.length < options.shortNameLimit) issues.push("VERY_SHORT_NAME");
  if (name.length > options.longNameLimit) issues.push("LONG_NAME");
  if (/\s{2,}/.test(name)) issues.push("REPEATED_SPACES");
  if (/^[0-9\s./_-]+$/.test(name)) issues.push("NUMERIC_OR_CODE_ONLY");
  if (!row.storeTitle || !row.seoTitle || !row.posLabel || !row.invoiceLabel) {
    issues.push("CHANNEL_CONTENT_MISSING");
  }
  return { issues, normalized };
}

async function main() {
  const limit = Math.min(2000, Math.max(1, positiveInt(argValue("--limit", DEFAULT_LIMIT), DEFAULT_LIMIT)));
  const afterId = positiveInt(argValue("--after-id", 0), 0);
  const longNameLimit = positiveInt(argValue("--long-name-limit", DEFAULT_LONG_NAME_LIMIT), DEFAULT_LONG_NAME_LIMIT);
  const shortNameLimit = Math.max(1, positiveInt(argValue("--short-name-limit", DEFAULT_SHORT_NAME_LIMIT), DEFAULT_SHORT_NAME_LIMIT));
  const outFile = argValue("--out", "./tmp/product-name-report.json");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL غير موجود — التقرير يحتاج اتصالاً بقاعدة البيانات.");

  const connection = await mysql.createConnection(databaseUrl);
  try {
    const [columnRows] = await connection.query(
      `SELECT COLUMN_NAME AS columnName
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products'`,
    );
    const availableColumns = new Set(columnRows.map((row) => row.columnName));
    const baseColumns = ["id", "name", "productType", "brand", "modelName", "isActive"];
    const optionalColumns = [
      "internalName",
      "storeTitle",
      "seoTitle",
      "shortTitle",
      "posLabel",
      "invoiceLabel",
      "marketingCopy",
    ];
    const selectedColumns = [...baseColumns, ...optionalColumns.filter((column) => availableColumns.has(column))];
    const [rows] = await connection.query(
      `SELECT ${selectedColumns.map((column) => `\`${column}\``).join(", ")}
         FROM products
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ${limit}`,
      [afterId],
    );

    const normalizedGroups = new Map();
    const issueRows = [];
    for (const raw of rows) {
      const row = { ...raw, id: Number(raw.id) };
      const result = issueFlags(row, { longNameLimit, shortNameLimit });
      if (!normalizedGroups.has(result.normalized)) normalizedGroups.set(result.normalized, []);
      normalizedGroups.get(result.normalized).push({ id: row.id, name: row.name, isActive: !!row.isActive });
      if (result.issues.length) {
        issueRows.push({
          id: row.id,
          name: row.name,
          productType: row.productType ?? null,
          brand: row.brand ?? null,
          modelName: row.modelName ?? null,
          isActive: !!row.isActive,
          issues: result.issues,
          lengths: {
            name: String(row.name ?? "").length,
            storeTitle: row.storeTitle ? String(row.storeTitle).length : 0,
            seoTitle: row.seoTitle ? String(row.seoTitle).length : 0,
            shortTitle: row.shortTitle ? String(row.shortTitle).length : 0,
            posLabel: row.posLabel ? String(row.posLabel).length : 0,
            invoiceLabel: row.invoiceLabel ? String(row.invoiceLabel).length : 0,
          },
        });
      }
    }

    const duplicateGroups = Array.from(normalizedGroups.entries())
      .filter(([normalized, members]) => normalized && members.length > 1)
      .map(([normalized, members]) => ({ normalized, members }));

    const report = {
      generatedAt: new Date().toISOString(),
      readOnly: true,
      parameters: { limit, afterId, nextAfterId: rows.length ? Number(rows.at(-1).id) : afterId, longNameLimit, shortNameLimit },
      summary: {
        scanned: rows.length,
        issueCount: issueRows.length,
        duplicateGroupCount: duplicateGroups.length,
        duplicateProductCount: duplicateGroups.reduce((sum, group) => sum + group.members.length, 0),
      },
      issues: issueRows,
      duplicateGroups,
    };

    const destination = path.resolve(outFile);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({ out: destination, ...report.summary, nextAfterId: report.parameters.nextAfterId }, null, 2));
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
