// تحقّق نهائي ضدّ ملفات المالك الحقيقية (قراءة فقط من D:\مراجعات اكسل):
// يمرّر الملفات الثلاثة (عملاء/موردون/أصناف) عبر نفس مسار الإنتاج —
// دوال العميل (autoMapColumns/buildRows من client/src/lib/import.ts) ثم مخططات zod المصدَّرة
// (حدود الراوتر نفسها) ثم دوال الخادم مباشرة (importCustomers/importSuppliers/importProducts) —
// ضدّ قاعدة الجلسة erp_import_integration حصراً (حارس صارم يوقف التنفيذ على أي قاعدة أخرى).
// المرحلة أ: dry-run (بلا كتابة). المرحلة ب: تنفيذ فعلي skipFailed=true بالترتيب: الأصناف ثم الموردون ثم العملاء.
// ثم تأكيدات SQL مستقلة عبر mysql2 + إعادة حساب الأرصدة من الملف الخام بـdecimal.js (مستقلاً عن دوال الخدمة).
// الحكم: عتبة الـ١٪ تُطبَّق على الفشل **غير المفسَّر** فقط؛ الصفوف المرفوضة بالتصميم (صف إجمالي ذيلي/
// تكرار legacy حقيقي في المصدر/مخزون كسري — فشلها الصحيح منصوص في العقد) تُسرَد فرداً-فرداً وتُسقَّف
// بـ١٠ صفوف لكل ملف (تضخّمها = رائحة خلل منهجي يتخفّى خلف التصنيف، لا صفوف خردة معدودة).
// التشغيل: pnpm --dir "D:\business_management_system__import-integration" exec tsx scripts/verify-import-real.mjs
// ⚠ لإعادة تحقّق نظيف بعد تشغيل سابق كتب بيانات: صفّر قاعدة الجلسة أولاً
//   (node scripts/reset.mjs --confirm RESET — يُبقي users/branches) — وإلا فالسكربت متسامح
//   (onExisting=skip + قياس فروقات) لكن مجاميع «المتوقَّع» تصير صفراً للموجود مسبقاً.

import { config as dotenvConfig } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { File as NodeFile } from "node:buffer";
import Decimal from "decimal.js";
import mysql from "mysql2/promise";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenvConfig({ path: path.join(ROOT, ".env") });

// ───────────────────── حارس قاعدة الجلسة (لا تنفيذ على غير erp_import_integration) ─────────────────────
const EXPECTED_DB = "erp_import_integration";
const dbUrl = process.env.DATABASE_URL ?? "";
const dbNameFromUrl = (() => {
  try {
    return new URL(dbUrl).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
})();
if (dbNameFromUrl !== EXPECTED_DB) {
  console.error(`⛔ توقّف: DATABASE_URL يشير إلى «${dbNameFromUrl || "غير معروف"}» وليس «${EXPECTED_DB}» — لا تنفيذ.`);
  process.exit(1);
}

// استيراد ديناميكي بعد اجتياز الحارس (وحدات الخادم كسولة الاتصال لكن لا نخاطر).
const importLib = await import("../client/src/lib/import.ts");
const fieldsLib = await import("../client/src/lib/importFields.ts");
const svc = await import("../server/services/importService.ts");

const { parseSheet, autoMapColumns, buildRows, findFileDuplicates, findSkuConflicts, findBarcodeConflicts } = importLib;
const { CUSTOMER_FIELDS, SUPPLIER_FIELDS, PRODUCT_FIELDS, CUSTOMER_IMPORT_META, SUPPLIER_IMPORT_META, PRODUCT_IMPORT_META } = fieldsLib;
const { importCustomers, importSuppliers, importProducts, customerImportRow, supplierImportRow, productImportRow } = svc;

const USD_RATE = "1450";
const FILES = {
  customers: "D:\\مراجعات اكسل\\مراجعة  العملاء.Xlsx", // مسافة مزدوجة في الاسم — مقصودة
  suppliers: "D:\\مراجعات اكسل\\مراجعة  الموردين.Xlsx",
  products: "D:\\مراجعات اكسل\\مراجعة الأصناف.Xlsx",
};

const log = (...a) => console.error("[verify]", ...a);

// ───────────────────── حساب مستقل لرصيد النظام القديم (أقواس/فواصل/نقطة زائدة) ─────────────────────
// لا يستعمل دوال الخدمة — إعادة تنفيذ القواعد من النصّ الخام بـdecimal.js للمقارنة المستقلة.
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
function asciiDigits(s) {
  return String(s ?? "").replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
}
function parseLegacySigned(raw) {
  let s = asciiDigits(String(raw ?? "").trim());
  let negative = false;
  const br = /^\[(.*)\]$/.exec(s) ?? /^\((.*)\)$/.exec(s);
  if (br) {
    negative = true;
    s = br[1];
  } else if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  s = s.replace(/[٬,\s]/g, "").replace(/٫/g, ".").replace(/\.$/, "");
  if (s === "") return new Decimal(0);
  let d = new Decimal(s).toDecimalPlaces(2, Decimal.ROUND_HALF_UP); // مرآة تقريب العميل النصّي
  if (negative && !d.isZero()) d = d.negated();
  return d;
}
/** القيمة المخزَّنة المتوقَّعة: تقريب → ×سعر الصرف إن USD → تقريب → عكس إن invert (مرآة §٥.٢ بالضبط). */
function expectedStored(rawBalance, currency, balanceSign) {
  let d = parseLegacySigned(rawBalance);
  if (d.isZero()) return new Decimal(0);
  if (currency === "USD") d = d.times(new Decimal(USD_RATE));
  d = d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (balanceSign === "invert") d = d.negated();
  return d;
}

// ───────────────────── قراءة الملف وتجهيز الصفوف عبر دوال العميل نفسها ─────────────────────
const FileCtor = globalThis.File ?? NodeFile;
async function loadEntity(name, filePath, fields, zodSchema) {
  const file = new FileCtor([fs.readFileSync(filePath)], path.basename(filePath));
  const parse = await parseSheet(file);
  const mapping = autoMapColumns(parse.headers, fields); // مطابقة آلية صرفة — بلا أي تدخل يدوي
  const parsedRows = buildRows(parse, mapping, fields);

  const clientFailed = []; // { rowNumber, message } — أخطاء قسر خلايا في العميل
  const warnings = [];
  const serverRows = []; // صفوف اجتازت القسر + zod (حدود الراوتر) → تُرسَل للخدمة
  const byRowNumber = new Map(); // rowNumber → { raw, values }
  let zodFailed = 0;

  for (const r of parsedRows) {
    byRowNumber.set(r.rowNumber, { raw: r.raw, values: r.values });
    for (const w of r.warnings) warnings.push({ rowNumber: r.rowNumber, message: w.message });
    if (r.errors.length) {
      clientFailed.push({ rowNumber: r.rowNumber, message: r.errors.map((e) => e.message).join(" | ") });
      continue;
    }
    const z = zodSchema.safeParse({ ...r.values, rowNumber: r.rowNumber });
    if (!z.success) {
      zodFailed++;
      clientFailed.push({ rowNumber: r.rowNumber, message: `zod: ${z.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ")}` });
      continue;
    }
    serverRows.push(z.data);
  }

  return { name, filePath, parse, mapping, parsedRows, clientFailed, warnings, serverRows, byRowNumber, zodFailed };
}

function mappingReport(entity) {
  const mapped = {};
  const unmapped = [];
  for (const [header, fieldKey] of Object.entries(entity.mapping)) {
    if (!header) continue; // ترويسة فارغة (عمود ذيلي فارغ في بعض الملفات)
    if (fieldKey) mapped[header] = fieldKey;
    else unmapped.push(header);
  }
  return { mapped, unmappedHeaders: unmapped };
}

function summarize(summary) {
  return { total: summary.total, created: summary.created, updated: summary.updated, skipped: summary.skipped, failed: summary.failed, committed: summary.committed };
}
function failedSamples(entity, summary, limit = 20) {
  const out = entity.clientFailed.map((f) => ({ rowNumber: f.rowNumber, source: "client", message: f.message }));
  for (const r of summary.rows) {
    if (r.status === "failed") out.push({ rowNumber: r.rowNumber, source: "server", message: r.message ?? "" });
  }
  out.sort((a, b) => a.rowNumber - b.rowNumber);
  return out.slice(0, limit);
}

// ───────────────────── التنفيذ ─────────────────────
async function main() {
  const sql = await mysql.createConnection(dbUrl);
  const [[{ db }]] = await sql.query("SELECT DATABASE() AS db");
  if (db !== EXPECTED_DB) {
    console.error(`⛔ توقّف: الاتصال الفعلي على «${db}» وليس «${EXPECTED_DB}».`);
    process.exit(1);
  }
  log(`القاعدة: ${db} ✓`);

  // الفاعل: admin + الفرع الرئيسي (من قاعدة الجلسة لا افتراضاً أعمى)
  const [admins] = await sql.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  const [mains] = await sql.query("SELECT id FROM branches WHERE code='MAIN' LIMIT 1");
  if (!admins.length || !mains.length) {
    console.error("⛔ لا admin أو لا فرع MAIN في قاعدة الجلسة — شغّل pnpm seed أولاً.");
    process.exit(1);
  }
  const actor = { userId: Number(admins[0].id), branchId: Number(mains[0].id) };
  log(`الفاعل: user=${actor.userId} branch=${actor.branchId}`);

  // قراءة الملفات الثلاثة عبر دوال العميل
  const customers = await loadEntity("customers", FILES.customers, CUSTOMER_FIELDS, customerImportRow);
  const suppliers = await loadEntity("suppliers", FILES.suppliers, SUPPLIER_FIELDS, supplierImportRow);
  const products = await loadEntity("products", FILES.products, PRODUCT_FIELDS, productImportRow);
  log(`قُرئت الملفات: عملاء=${customers.parse.totalRows} موردون=${suppliers.parse.totalRows} أصناف=${products.parse.totalRows}`);

  // فحوص الملف الكامل في العميل (كما يفعل ImportDialog قبل الإرسال)
  const custDup = findFileDuplicates(customers.parsedRows, CUSTOMER_IMPORT_META.duplicateKeys);
  const suppDup = findFileDuplicates(suppliers.parsedRows, SUPPLIER_IMPORT_META.duplicateKeys);
  const prodSkuConf = findSkuConflicts(products.parsedRows, PRODUCT_IMPORT_META.skuConflictKeys);
  const prodBarConf = findBarcodeConflicts(products.parsedRows, PRODUCT_IMPORT_META.skuConflictKeys);

  // ───── المرحلة أ: dry-run (skipFailed=false) — نداء واحد لكل ملف (مستوى الخدمة بلا حدّ دفعات) ─────
  const custOptsA = { dryRun: true, onExisting: "skip", usdRate: USD_RATE, balanceSign: "asIs", skipFailed: false, fileName: path.basename(FILES.customers) };
  const suppOptsA = { dryRun: true, onExisting: "skip", usdRate: USD_RATE, balanceSign: "invert", skipFailed: false, fileName: path.basename(FILES.suppliers) };
  const prodOptsA = { dryRun: true, onExisting: "skip", skipFailed: false, fileName: path.basename(FILES.products) };

  log("المرحلة أ: dry-run …");
  const dryCust = await importCustomers(customers.serverRows, custOptsA, actor);
  const drySupp = await importSuppliers(suppliers.serverRows, suppOptsA, actor);
  const t0p = Date.now();
  const dryProd = await importProducts(products.serverRows, prodOptsA, actor);
  log(`dry-run تمّ (أصناف ${Date.now() - t0p}ms)`);

  const phaseA = {
    customers: {
      file: FILES.customers,
      totalRows: customers.parse.totalRows,
      ...mappingReport(customers),
      clientCellErrors: customers.clientFailed.length,
      clientWarnings: customers.warnings.length,
      fileDuplicates: custDup.size,
      dryRun: summarize(dryCust),
      failureSamples: failedSamples(customers, dryCust),
    },
    suppliers: {
      file: FILES.suppliers,
      totalRows: suppliers.parse.totalRows,
      ...mappingReport(suppliers),
      clientCellErrors: suppliers.clientFailed.length,
      clientWarnings: suppliers.warnings.length,
      fileDuplicates: suppDup.size,
      duplicateSamples: Array.from(suppDup.entries()).slice(0, 5).map(([rowNumber, message]) => ({ rowNumber, message })),
      dryRun: summarize(drySupp),
      failureSamples: failedSamples(suppliers, drySupp),
    },
    products: {
      file: FILES.products,
      totalRows: products.parse.totalRows,
      ...mappingReport(products),
      clientCellErrors: products.clientFailed.length,
      clientWarnings: products.warnings.length, // قصّ المخزون السالب إلى صفر
      warningSamples: products.warnings.slice(0, 5),
      skuConflicts: prodSkuConf.size,
      barcodeConflicts: prodBarConf.size,
      dryRun: summarize(dryProd),
      failureSamples: failedSamples(products, dryProd),
    },
  };

  // ───── لقطة SQL قبل الكتابة (القاعدة فيها بذرة: منتجات/مورد عيّنة — نقيس الفروقات لا المطلقات) ─────
  async function snapshot() {
    const q = async (s) => (await sql.query(s))[0][0];
    return {
      customers: await q("SELECT COUNT(*) c, COALESCE(MAX(id),0) m FROM customers"),
      suppliers: await q("SELECT COUNT(*) c, COALESCE(MAX(id),0) m FROM suppliers"),
      products: await q("SELECT COUNT(*) c, COALESCE(MAX(id),0) m FROM products"),
      variants: await q("SELECT COUNT(*) c, COALESCE(MAX(id),0) m FROM productVariants"),
      stockSum: await q("SELECT COALESCE(SUM(quantity),0) s FROM branchStock"),
      movements: await q("SELECT COUNT(*) c, COALESCE(MAX(id),0) m FROM inventoryMovements"),
      entries: await q("SELECT COUNT(*) c, COALESCE(MAX(id),0) m FROM accountingEntries"),
    };
  }
  const before = await snapshot();
  log("لقطة ما قبل الكتابة:", JSON.stringify(before));

  // ───── المرحلة ب: تنفيذ فعلي skipFailed=true — الأصناف ثم الموردون ثم العملاء ─────
  log("المرحلة ب: الأصناف (قد تستغرق دقائق) …");
  const t1 = Date.now();
  const comProd = await importProducts(products.serverRows, { ...prodOptsA, dryRun: false, skipFailed: true }, actor);
  const prodMs = Date.now() - t1;
  log(`الأصناف: ${prodMs}ms — ${JSON.stringify(summarize(comProd))}`);

  const t2 = Date.now();
  const comSupp = await importSuppliers(suppliers.serverRows, { ...suppOptsA, dryRun: false, skipFailed: true }, actor);
  const suppMs = Date.now() - t2;
  log(`الموردون: ${suppMs}ms — ${JSON.stringify(summarize(comSupp))}`);

  const t3 = Date.now();
  const comCust = await importCustomers(customers.serverRows, { ...custOptsA, dryRun: false, skipFailed: true }, actor);
  const custMs = Date.now() - t3;
  log(`العملاء: ${custMs}ms — ${JSON.stringify(summarize(comCust))}`);

  const after = await snapshot();

  // ───── الحسابات المستقلة من الملف الخام (decimal.js) على الصفوف المُنشأة فعلاً ─────
  function createdRowNumbers(summary) {
    return new Set(summary.rows.filter((r) => r.status === "created").map((r) => r.rowNumber));
  }
  function headerOf(entity, fieldKey) {
    for (const [h, k] of Object.entries(entity.mapping)) if (k === fieldKey) return h;
    return null;
  }
  function expectedPartySum(entity, summary, balanceSign) {
    const created = createdRowNumbers(summary);
    const hBal = headerOf(entity, "openingBalance");
    const hCur = headerOf(entity, "currency");
    const hLegacy = headerOf(entity, "legacyCode");
    let sum = new Decimal(0);
    let legacyFilled = 0;
    let nonZero = 0;
    for (const rn of created) {
      const { raw } = entity.byRowNumber.get(rn);
      const cur = String(raw[hCur] ?? "").trim().toUpperCase() || undefined;
      const d = expectedStored(raw[hBal], cur, balanceSign);
      if (!d.isZero()) nonZero++;
      sum = sum.plus(d);
      if (String(raw[hLegacy] ?? "").trim() !== "") legacyFilled++;
    }
    return { createdCount: created.size, sum, nonZero, legacyFilled, created };
  }

  const expCust = expectedPartySum(customers, comCust, "asIs");
  const expSupp = expectedPartySum(suppliers, comSupp, "invert");

  // ───── تصنيف الفشل: مرفوض بالتصميم (خردة يجب أن تفشل) مقابل غير مفسَّر (فقدان منهجي محتمل) ─────
  function classifyFailures(entity, summary) {
    const all = entity.clientFailed
      .map((f) => ({ rowNumber: f.rowNumber, source: "client", message: f.message }))
      .concat(
        summary.rows
          .filter((r) => r.status === "failed")
          .map((r) => ({ rowNumber: r.rowNumber, source: "server", message: r.message ?? "" })),
      );
    const hName = headerOf(entity, "name");
    const hLegacy = headerOf(entity, "legacyCode");
    const hPhone = headerOf(entity, "phone");
    const designRejected = [];
    const unexplained = [];
    for (const f of all) {
      const raw = entity.byRowNumber.get(f.rowNumber)?.raw ?? {};
      const nameRaw = hName ? String(raw[hName] ?? "").trim() : "";
      const legacyRaw = hLegacy ? String(raw[hLegacy] ?? "").trim() : "";
      const phoneRaw = hPhone ? String(raw[hPhone] ?? "").trim() : "";
      // بصمة صف الإجمالي الذيلي في ملفَي المالك: اسم رقمي صرف + بلا رقم قديم + بلا هاتف
      // (العملاء legacy معبّأ ٣٢٥/٣٢٥ ⇒ لا عميل حقيقي يطابق البصمة).
      const trailerRow =
        nameRaw !== "" && /^\d+(\.\d+)?$/.test(nameRaw) && legacyRaw === "" && phoneRaw === "";
      let reason = null;
      if (trailerRow) reason = "صف إجمالي ذيلي (اسم رقمي صرف بلا رقم قديم ولا هاتف) — يجب ألا يُستورد";
      else if (f.message.includes("مكرّر داخل الملف"))
        reason = "تكرار حقيقي في بيانات المصدر — الصف الأول يفوز (العقد §٥.٢)";
      else if (f.message.includes("يجب أن يكون عدداً صحيحاً"))
        reason = "مخزون كسري حقيقي — فشل الصف منصوص (العقد §٤.٢)";
      if (reason) designRejected.push({ ...f, reason });
      else unexplained.push(f);
    }
    return { designRejected, unexplained };
  }

  // الأصناف: مجموع «الرصيد» الصالح (بعد قصّ السالب صفراً) على الصفوف المُنشأة + عدد حركات OPENING المتوقَّع
  const prodCreated = createdRowNumbers(comProd);
  let expStockSum = 0;
  const movedSkus = new Set();
  let createdWithLegacyStockGt0 = 0;
  for (const rn of prodCreated) {
    const { values } = products.byRowNumber.get(rn);
    const qty = values.openingStock ?? 0;
    expStockSum += qty;
    if (qty > 0) {
      const sku = String(values.sku ?? "").trim() || String(values.barcode ?? "").trim();
      movedSkus.add(sku);
      createdWithLegacyStockGt0++;
    }
  }

  // ───── تأكيدات SQL مستقلة ─────
  const q1 = async (s, p = []) => (await sql.query(s, p))[0];

  // العملاء
  const [custAgg] = await q1("SELECT COUNT(*) c, COALESCE(SUM(currentBalance),0) s, SUM(legacyCode IS NOT NULL) lc FROM customers WHERE id > ?", [before.customers.m]);
  const [custOpen] = await q1("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s, COUNT(DISTINCT dedupeKey) dk FROM accountingEntries WHERE entryType='OPENING' AND customerId IS NOT NULL AND id > ?", [before.entries.m]);
  // الموردون
  const [suppAgg] = await q1("SELECT COUNT(*) c, COALESCE(SUM(currentBalance),0) s, SUM(legacyCode IS NOT NULL) lc FROM suppliers WHERE id > ?", [before.suppliers.m]);
  const [suppOpen] = await q1("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s, COUNT(DISTINCT dedupeKey) dk FROM accountingEntries WHERE entryType='OPENING' AND supplierId IS NOT NULL AND id > ?", [before.entries.m]);
  // الأصناف
  const [prodAgg] = await q1("SELECT COUNT(*) c FROM products WHERE id > ?", [before.products.m]);
  const [varAgg] = await q1("SELECT COUNT(*) c FROM productVariants WHERE id > ?", [before.variants.m]);
  const [stockAgg] = await q1("SELECT COALESCE(SUM(quantity),0) s FROM branchStock");
  const [moveAgg] = await q1("SELECT COUNT(*) c, COALESCE(SUM(quantity),0) s FROM inventoryMovements WHERE referenceType='OPENING' AND id > ?", [before.movements.m]);

  // عيّنة: عميل «ابراهيم توصيل»
  const ibrahimRaw = customers.parsedRows.find((r) => String(r.raw[headerOf(customers, "name")] ?? "").trim() === "ابراهيم توصيل");
  let sampleIbrahim = { found: false };
  if (ibrahimRaw) {
    const hBal = headerOf(customers, "openingBalance");
    const hCur = headerOf(customers, "currency");
    const exp = expectedStored(ibrahimRaw.raw[hBal], String(ibrahimRaw.raw[hCur] ?? "").trim().toUpperCase(), "asIs");
    const rows = await q1("SELECT id, name, currentBalance, legacyCode FROM customers WHERE name = ?", ["ابراهيم توصيل"]);
    sampleIbrahim = {
      found: rows.length > 0,
      fileRawBalance: String(ibrahimRaw.raw[hBal] ?? ""),
      fileCurrency: String(ibrahimRaw.raw[hCur] ?? ""),
      expectedStored: exp.toFixed(2),
      dbBalance: rows[0]?.currentBalance ?? null,
      dbLegacyCode: rows[0]?.legacyCode ?? null,
      match: rows.length > 0 && new Decimal(rows[0].currentBalance).eq(exp),
    };
  }

  // عيّنتان: موردان رصيدهما بأقواس مربعة في الملف — التخزين بعد invert يجب أن يكون موجباً بنفس القيمة المطلقة
  const hSBal = headerOf(suppliers, "openingBalance");
  const hSCur = headerOf(suppliers, "currency");
  const hSLegacy = headerOf(suppliers, "legacyCode");
  const bracketRows = suppliers.parsedRows
    .filter((r) => /^\[.*\]$/.test(String(r.raw[hSBal] ?? "").trim()) && expSupp.created.has(r.rowNumber))
    .slice(0, 2);
  const bracketSamples = [];
  for (const r of bracketRows) {
    const legacy = String(r.raw[hSLegacy] ?? "").trim();
    const exp = expectedStored(r.raw[hSBal], String(r.raw[hSCur] ?? "").trim().toUpperCase(), "invert");
    const rows = await q1("SELECT id, name, currentBalance FROM suppliers WHERE legacyCode = ? AND id > ?", [legacy, before.suppliers.m]);
    bracketSamples.push({
      rowNumber: r.rowNumber,
      legacyCode: legacy,
      fileRawBalance: String(r.raw[hSBal] ?? ""),
      expectedStored: exp.toFixed(2), // موجب = نحن ندين للمورد (AP) بعد العكس
      dbBalance: rows[0]?.currentBalance ?? null,
      signPositive: rows.length > 0 && new Decimal(rows[0].currentBalance).gt(0),
      match: rows.length > 0 && new Decimal(rows[0].currentBalance).eq(exp),
    });
  }

  await sql.end();

  // ───── الحكم ─────
  const problems = [];
  const eq = (a, b) => new Decimal(String(a)).eq(new Decimal(String(b)));
  const cls = {
    customers: classifyFailures(customers, comCust),
    suppliers: classifyFailures(suppliers, comSupp),
    products: classifyFailures(products, comProd),
  };
  const pct = (entity, c) => {
    const failed = c.designRejected.length + c.unexplained.length;
    const total = entity.parse.totalRows;
    return {
      failed,
      designRejected: c.designRejected.length,
      unexplained: c.unexplained.length,
      total,
      rawPct: Number(((failed / total) * 100).toFixed(2)),
      unexplainedPct: Number(((c.unexplained.length / total) * 100).toFixed(2)),
    };
  };
  const rates = { customers: pct(customers, cls.customers), suppliers: pct(suppliers, cls.suppliers), products: pct(products, cls.products) };
  for (const [k, v] of Object.entries(rates)) {
    if (v.unexplainedPct > 1) problems.push(`نسبة الفشل غير المفسَّر ${k} = ${v.unexplainedPct}% (> 1%)`);
    if (v.designRejected > 10) problems.push(`المرفوض بالتصميم في ${k} = ${v.designRejected} صفاً (> 10) — رائحة خلل منهجي، يلزم فحص يدوي`);
  }

  if (Number(custAgg.c) !== expCust.createdCount) problems.push(`عدد العملاء المنشأ في DB (${custAgg.c}) ≠ المبلَّغ (${expCust.createdCount})`);
  if (!eq(custAgg.s, expCust.sum.toFixed(2))) problems.push(`SUM(currentBalance) عملاء DB=${custAgg.s} ≠ متوقَّع=${expCust.sum.toFixed(2)}`);
  if (Number(custAgg.lc) !== expCust.legacyFilled) problems.push(`legacyCode عملاء DB=${custAgg.lc} ≠ متوقَّع=${expCust.legacyFilled}`);
  if (Number(custOpen.c) !== expCust.nonZero) problems.push(`قيود OPENING عملاء=${custOpen.c} ≠ أرصدة غير صفرية=${expCust.nonZero}`);
  if (!eq(custOpen.s, expCust.sum.toFixed(2))) problems.push(`SUM(amount) قيود OPENING عملاء=${custOpen.s} ≠ ${expCust.sum.toFixed(2)}`);
  if (Number(custOpen.dk) !== Number(custOpen.c)) problems.push("dedupeKey غير فريد في قيود OPENING للعملاء");

  if (Number(suppAgg.c) !== expSupp.createdCount) problems.push(`عدد الموردين المنشأ في DB (${suppAgg.c}) ≠ المبلَّغ (${expSupp.createdCount})`);
  if (!eq(suppAgg.s, expSupp.sum.toFixed(2))) problems.push(`SUM(currentBalance) موردون DB=${suppAgg.s} ≠ متوقَّع=${expSupp.sum.toFixed(2)}`);
  if (Number(suppAgg.lc) !== expSupp.legacyFilled) problems.push(`legacyCode موردون DB=${suppAgg.lc} ≠ متوقَّع=${expSupp.legacyFilled}`);
  if (Number(suppOpen.c) !== expSupp.nonZero) problems.push(`قيود OPENING موردون=${suppOpen.c} ≠ أرصدة غير صفرية=${expSupp.nonZero}`);
  if (!eq(suppOpen.s, expSupp.sum.toFixed(2))) problems.push(`SUM(amount) قيود OPENING موردون=${suppOpen.s} ≠ ${expSupp.sum.toFixed(2)}`);

  if (sampleIbrahim.found === false) problems.push("عيّنة «ابراهيم توصيل» غير موجودة في DB");
  else if (!sampleIbrahim.match) problems.push(`عيّنة «ابراهيم توصيل»: DB=${sampleIbrahim.dbBalance} ≠ متوقَّع=${sampleIbrahim.expectedStored}`);
  for (const b of bracketSamples) {
    if (!b.signPositive) problems.push(`مورد ببراكيت ${b.legacyCode}: الإشارة ليست موجبة بعد invert (DB=${b.dbBalance})`);
    if (!b.match) problems.push(`مورد ببراكيت ${b.legacyCode}: DB=${b.dbBalance} ≠ متوقَّع=${b.expectedStored}`);
  }

  if (Number(varAgg.c) !== prodCreated.size) problems.push(`متغيّرات DB (${varAgg.c}) ≠ صفوف أصناف منشأة (${prodCreated.size})`);
  const stockDelta = Number(stockAgg.s) - Number(before.stockSum.s);
  if (stockDelta !== expStockSum) problems.push(`Δ SUM(branchStock.quantity)=${stockDelta} ≠ مجموع «الرصيد» الصالح=${expStockSum}`);
  if (Number(moveAgg.c) !== movedSkus.size) problems.push(`حركات OPENING=${moveAgg.c} ≠ متوقَّع=${movedSkus.size}`);
  if (Number(moveAgg.s) !== expStockSum) problems.push(`SUM(quantity) حركات OPENING=${moveAgg.s} ≠ ${expStockSum}`);

  const report = {
    db: EXPECTED_DB,
    actor,
    options: { usdRate: USD_RATE, balanceSign: { customers: "asIs", suppliers: "invert" }, phaseA: { skipFailed: false }, phaseB: { skipFailed: true, order: ["products", "suppliers", "customers"] } },
    phaseA,
    phaseB: {
      products: { durationMs: prodMs, summary: summarize(comProd), failureSamples: failedSamples(products, comProd) },
      suppliers: { durationMs: suppMs, summary: summarize(comSupp), failureSamples: failedSamples(suppliers, comSupp) },
      customers: { durationMs: custMs, summary: summarize(comCust), failureSamples: failedSamples(customers, comCust) },
    },
    sqlVerification: {
      customers: {
        createdInDb: Number(custAgg.c),
        createdReported: expCust.createdCount,
        sumCurrentBalanceDb: String(custAgg.s),
        sumExpectedFromFile: expCust.sum.toFixed(2),
        sumMatch: eq(custAgg.s, expCust.sum.toFixed(2)),
        legacyCodeFilledDb: Number(custAgg.lc),
        legacyCodeExpected: expCust.legacyFilled,
        openingEntries: { count: Number(custOpen.c), expectedNonZeroBalances: expCust.nonZero, sumAmount: String(custOpen.s), distinctDedupeKeys: Number(custOpen.dk) },
        sampleIbrahim,
      },
      suppliers: {
        createdInDb: Number(suppAgg.c),
        createdReported: expSupp.createdCount,
        sumCurrentBalanceDb: String(suppAgg.s),
        sumExpectedFromFile: expSupp.sum.toFixed(2),
        sumMatch: eq(suppAgg.s, expSupp.sum.toFixed(2)),
        legacyCodeFilledDb: Number(suppAgg.lc),
        legacyCodeExpected: expSupp.legacyFilled,
        openingEntries: { count: Number(suppOpen.c), expectedNonZeroBalances: expSupp.nonZero, sumAmount: String(suppOpen.s), distinctDedupeKeys: Number(suppOpen.dk) },
        bracketSamples,
      },
      products: {
        productsCreatedInDb: Number(prodAgg.c),
        variantsCreatedInDb: Number(varAgg.c),
        rowsReportedCreated: prodCreated.size,
        stockSumDelta: stockDelta,
        stockSumExpectedFromFile: expStockSum,
        openingMovements: { count: Number(moveAgg.c), expected: movedSkus.size, sumQuantity: Number(moveAgg.s) },
      },
    },
    verdict: {
      failureRates: rates,
      // المرفوض بالتصميم مسرود فرداً-فرداً (شفافية كاملة — لا تصنيف صامت)، وغير المفسَّر كذلك.
      failureClassification: Object.fromEntries(
        Object.entries(cls).map(([k, c]) => [
          k,
          { designRejected: c.designRejected.slice(0, 20), unexplained: c.unexplained.slice(0, 20) },
        ]),
      ),
      problems,
      ok: problems.length === 0,
    },
  };

  console.log("===REPORT_START===");
  console.log(JSON.stringify(report, null, 1));
  console.log("===REPORT_END===");
  process.exit(problems.length === 0 ? 0 : 2);
}

main().catch((e) => {
  console.error("⛔ فشل التحقّق:", e?.stack ?? e);
  process.exit(1);
});
