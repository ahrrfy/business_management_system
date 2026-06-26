// خدمة الاستيراد بالجملة (بيانات أساسية فقط: عملاء/موردون/منتجات).
// النمط: تحقّق كامل أولاً ⇒ إن وُجد أي فشل لا تُكتب أي بيانات (الكل أو لا شيء) ⇒ وإلا فالكتابة داخل withTx واحد.
// خيار skipFailed (§٥.٤): يكتب الصفوف/المجموعات الصالحة فقط في معاملة واحدة والفاشلة تبقى فاشلة في الملخّص.
// الأموال نصاً عبر toDbMoney (قاعدة §٥). لا استيراد لمستندات مالية (خطِر — انظر CLAUDE.md/الخطة).
import { mysqlCodeFrom, toArabicMessage } from "@shared/errorMap.ar";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  accountingEntries,
  categories,
  customers,
  importBatches,
  productPrices,
  productUnits,
  productVariants,
  products,
  suppliers,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { logger } from "../logger";
import { setStock } from "./inventoryService";
import { localTodayDate } from "./dateRange";
import { money, round2, toDbMoney } from "./money";
import { requireDb, withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { assertPeriodOpen } from "./periodLockService";

// ───────────────────────── العقد المشترك ─────────────────────────

export type OnExisting = "skip" | "update" | "error";
export type BalanceSign = "asIs" | "invert";
export type ImportOptions = {
  dryRun?: boolean;
  onExisting?: OnExisting;
  fileName?: string;
  /** سعر صرف الدولار (نص — decimal.js): إلزامي إن وُجدت صفوف USD برصيد غير صفري. */
  usdRate?: string;
  /** تجاوز الصفوف الفاشلة: اكتب الصالح فقط بدل «الكل أو لا شيء» (افتراضه مطفأ). */
  skipFailed?: boolean;
  /** اتجاه الرصيد الافتتاحي: «كما في الملف» أو «اعكس الإشارة» (افتراض الموردين في الواجهة: اعكس). */
  balanceSign?: BalanceSign;
};

export type ImportRowResult = {
  rowNumber: number;
  status: "created" | "updated" | "skipped" | "failed";
  message?: string;
};

export type ImportSummary = {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  committed: boolean;
  rows: ImportRowResult[];
};

type ImportType = "CUSTOMERS" | "SUPPLIERS" | "PRODUCTS";

// ───────────────────────── مخططات الصفوف (zod) ─────────────────────────

const moneyStr = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "قيمة مالية غير صالحة");
// رصيد موقَّع (§٥.١): العميل يحوّل صيغ الأقواس [123]/(123) إلى سالب صريح قبل الإرسال — الخادم يقبل السالب الصريح فقط.
const moneySignedStr = z.string().trim().regex(/^-?\d+(\.\d{1,2})?$/, "قيمة مالية غير صالحة");
const dateStr = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (الصيغة: YYYY-MM-DD)");
const currencyEnum = z.enum(["IQD", "USD"]);
const phoneStr = z.string().trim().max(20);
const priceTier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);
const customerType = z.enum(["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"]);

/** سعر صرف الدولار: موجب حصراً — الإنفاذ صريح في المخطط (§٥.١)؛ سعر صفري يكتب أرصدة صفرية بصمت لو نُسي.
 *  (حارس النمط داخل refine ضروري: zod v4 يشغّل كل الفحوص حتى بعد فشل regex، وmoney() يرمي على غير الرقمي.) */
const USD_RATE_RE = /^\d+(\.\d{1,2})?$/;
export const usdRateStr = z
  .string()
  .trim()
  .regex(USD_RATE_RE, "سعر صرف غير صالح")
  .refine((v) => !USD_RATE_RE.test(v) || money(v).gt(0), "سعر صرف غير صالح");

export const customerImportRow = z.object({
  rowNumber: z.number().int().positive(),
  name: z.string().trim().min(1).max(255),
  phone: phoneStr.optional(),
  phone2: phoneStr.optional(),
  phone3: phoneStr.optional(),
  whatsapp: phoneStr.optional(),
  address: z.string().trim().max(1000).optional(),
  city: z.string().trim().max(100).optional(),
  district: z.string().trim().max(100).optional(),
  customerType: customerType.optional(),
  defaultPriceTier: priceTier.optional(),
  creditLimit: moneyStr.optional(),
  // إضافات تكامل الاستيراد (§٥.١): رصيد افتتاحي موقَّع + عملته + المعرّف القديم + نشط + آخر تعامل.
  openingBalance: moneySignedStr.optional(),
  currency: currencyEnum.optional(),
  legacyCode: z.string().trim().max(40).optional(),
  isActive: z.boolean().optional(),
  lastDealtAt: dateStr.optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type CustomerImportRow = z.infer<typeof customerImportRow>;

export const supplierImportRow = z.object({
  rowNumber: z.number().int().positive(),
  name: z.string().trim().min(1).max(255),
  phone: phoneStr.optional(),
  phone2: phoneStr.optional(),
  phone3: phoneStr.optional(),
  email: z.string().trim().email("بريد غير صالح").max(320).optional(),
  whatsapp: phoneStr.optional(),
  address: z.string().trim().max(1000).optional(),
  city: z.string().trim().max(100).optional(),
  taxId: z.string().trim().max(50).optional(),
  productTypes: z.string().trim().max(1000).optional(),
  paymentTerms: z.string().trim().max(100).optional(),
  // نفس إضافات العملاء — بلا creditLimit عمداً (عمود «حد الإئتمان» في ملف الموردين كله أصفار ويُتجاهَل، §٤.٢).
  openingBalance: moneySignedStr.optional(),
  currency: currencyEnum.optional(),
  legacyCode: z.string().trim().max(40).optional(),
  isActive: z.boolean().optional(),
  lastDealtAt: dateStr.optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type SupplierImportRow = z.infer<typeof supplierImportRow>;

export const productImportRow = z.object({
  rowNumber: z.number().int().positive(),
  productName: z.string().trim().min(1).max(255),
  categoryName: z.string().trim().max(255).optional(),
  isCustomizable: z.boolean().optional(),
  // sku اختياري (§٥.١): إن غاب فالبديل التلقائي = الباركود؛ كلاهما غائب ⇒ فشل الصف (يُنفَّذ في importProducts).
  sku: z.string().trim().min(1).max(60).optional(),
  variantName: z.string().trim().max(255).optional(),
  color: z.string().trim().max(60).optional(),
  size: z.string().trim().max(60).optional(),
  costPrice: moneyStr.default("0"),
  unitName: z.string().trim().min(1).max(40).default("قطعة"),
  conversionFactor: z.string().trim().regex(/^\d+(\.\d{1,4})?$/, "معامل تحويل غير صالح").default("1"),
  // isBaseUnit بلا افتراض هنا: افتراضه المشروط يُنفَّذ في مرحلة التجميع (§٥.١ — التحقق الصفّي لا يرى سياق المجموعة).
  isBaseUnit: z.boolean().optional(),
  barcode: z.string().trim().max(64).optional(),
  priceTier: priceTier.optional(),
  price: moneyStr.optional(),
  // أسعار صريحة (§٤.٢/§٥.٣): قيمة 0 أو فارغة ⇒ لا يُنشأ سعر لهذه الفئة.
  retailPrice: moneyStr.optional(),
  wholesalePrice: moneyStr.optional(),
  governmentPrice: moneyStr.optional(),
  // مخزون افتتاحي بالوحدة الأساس: السالب يقصّه العميل صفراً بتحذير، والكسري يُرفض هنا.
  openingStock: z.number().int("المخزون الافتتاحي يجب أن يكون عدداً صحيحاً").min(0, "المخزون الافتتاحي لا يكون سالباً").optional(),
});
export type ProductImportRow = z.infer<typeof productImportRow>;

// ───────────────────────── أدوات مساعدة ─────────────────────────

const norm = (s?: string | null): string | null => {
  const t = s?.trim();
  return t || null;
};
const uniq = <T>(arr: (T | null | undefined)[]): T[] =>
  Array.from(new Set(arr.filter((x): x is T => x != null && x !== "")));
const insertId = extractInsertId;

function tally(rows: ImportRowResult[]) {
  return {
    created: rows.filter((r) => r.status === "created").length,
    updated: rows.filter((r) => r.status === "updated").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
    failed: rows.filter((r) => r.status === "failed").length,
  };
}

/** يبني الملخّص ويسجّل الدفعة في importBatches (best-effort، لا يرمي). */
async function finalize(
  importType: ImportType,
  total: number,
  rows: ImportRowResult[],
  committed: boolean,
  options: ImportOptions,
  actor: Actor,
): Promise<ImportSummary> {
  const counts = tally(rows);
  const summary: ImportSummary = {
    total,
    ...counts,
    committed,
    rows: [...rows].sort((a, b) => a.rowNumber - b.rowNumber),
  };

  // تسجيل الدفعة للمساءلة (لا نسجّل المعاينة dry-run؛ لا تغيير حالة).
  if (!options.dryRun) {
    try {
      const db = requireDb();
      await db.insert(importBatches).values({
        batchName: options.fileName?.slice(0, 255) || `استيراد ${importType}`,
        importType,
        fileName: options.fileName?.slice(0, 255) ?? null,
        totalRows: total,
        // عند عدم الالتزام (rollback) لم يُكتب شيء ⇒ صفّر الناجح كي لا يناقض الحالة FAILED.
        successfulRows: committed ? counts.created + counts.updated : 0,
        failedRows: counts.failed,
        // FAILED فقط حين فشلت صفوف فعلاً بلا التزام (rollback «الكل أو لا شيء») — دفعة كلّها
        // «متجاوَز» (إعادة استيراد ملف مستورَد: لا كتابة ولا فشل) تُسجَّل COMPLETED لا فشلاً زائفاً.
        status: committed || counts.failed === 0 ? "COMPLETED" : "FAILED",
        errorLog: summary.rows.filter((r) => r.status === "failed" || r.status === "skipped"),
        createdBy: actor.userId,
        completedAt: new Date(),
      });
    } catch (e) {
      logger.warn({ err: e, importType }, "تعذّر تسجيل دفعة الاستيراد");
    }
  }

  return summary;
}

function markWriteError(rows: ImportRowResult[], message: string): ImportRowResult[] {
  return rows.map((r) =>
    r.status === "created" || r.status === "updated" ? { ...r, status: "failed", message } : r,
  );
}

/** يستخرج sqlMessage من سلسلة الأسباب (DrizzleQueryError يلفّ خطأ mysql2 في cause). */
function sqlMessageFrom(err: unknown): string | null {
  let e: any = err;
  for (let i = 0; i < 5 && e; i++) {
    if (typeof e?.sqlMessage === "string") return e.sqlMessage;
    e = e?.cause;
  }
  return null;
}

/** رسالة فشل الكتابة المعروضة في عمود «السبب»: عربية قابلة للفعل دائماً.
 *  رسالة القاعدة الخام (إنجليزية، تكشف نصّ الاستعلام وقيم الصفوف وأسماء القيود الداخلية)
 *  لا تصل الواجهة أبداً — تُسجَّل في اللوغ للتشخيص فقط. أخطاء الأعمال العربية من خدماتنا
 *  (داخل withTx، كرسائل setStock) تمرّ كما هي. مُصدَّرة للاختبار. */
export function writeErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : "";
  // رسالة drizzle الخام تبدأ بـ«Failed query:» وقد تحوي نصاً عربياً ضمن قيم الصفوف —
  // تُستبعد ولو «بدت» عربية (تسرّب استعلام وبيانات).
  if (raw && /[؀-ۿ]/.test(raw) && !raw.startsWith("Failed query:")) return raw;
  if (mysqlCodeFrom(e) === "ER_DUP_ENTRY") {
    const m = /Duplicate entry '(.*)' for key '([^']+)'/.exec(sqlMessageFrom(e) ?? "");
    const value = m?.[1] ?? "؟";
    const key = (m?.[2] ?? "").toLowerCase();
    // اصطدام حارس السباق البنيوي uq_*_legacy (§٥.٢): استيرادان متزامنان — التعافي بإعادة التشغيل.
    if (key.includes("legacy")) {
      return `تعارض استيراد متزامن — الرقم القديم «${value}» أُدرج للتوّ من عملية أخرى؛ أعد تشغيل الاستيراد (الموجود يُتخطّى).`;
    }
    if (key.includes("barcode")) {
      return `الباركود «${value}» أُدرج للتوّ من عملية أخرى — أعد تشغيل الاستيراد (الموجود يُتخطّى).`;
    }
  }
  // بقية الرموز (ER_DATA_TOO_LONG باسم الحقل العربي، أقفال، اتصال…) تُعرَّب عبر الخريطة المشتركة.
  return toArabicMessage({ cause: e });
}

// ───────────────────── دلالات الرصيد الافتتاحي (مشتركة عملاء/موردين — §٥.٢) ─────────────────────

type PartyBalanceFields = { openingBalance?: string; currency?: "IQD" | "USD" };

/** فحص دلالات الرصيد الحسّاسة: رصيد ≠ 0 بلا عملة لا يُفسَّر، وUSD بلا سعر صرف لا يُحوَّل. يعيد رسالة الفشل أو null. */
function balanceValidationError(r: PartyBalanceFields, options: ImportOptions): string | null {
  if (r.openingBalance === undefined || money(r.openingBalance).isZero()) return null;
  if (!r.currency) return "حدّد العملة — رصيد بلا عملة لا يُفسَّر";
  if (r.currency === "USD" && !options.usdRate) return "حدّد سعر صرف الدولار في خيارات الاستيراد";
  return null;
}

/** قيمة التخزين الموقَّعة: round2(الرصيد × سعر الصرف إن USD) ثم عكس الإشارة إن طُلب — كله decimal.js (§٥.٢). */
function storedOpeningBalance(r: PartyBalanceFields, options: ImportOptions): string {
  if (r.openingBalance === undefined) return "0.00";
  let d = money(r.openingBalance);
  if (d.isZero()) return "0.00";
  if (r.currency === "USD") d = d.times(money(options.usdRate));
  d = round2(d);
  if ((options.balanceSign ?? "asIs") === "invert") d = d.negated();
  return toDbMoney(d);
}

/** قيد دفتر مرجعي يرسّخ الرصيد الافتتاحي المستورد (قرار التحكيم §٩):
 *  بدونه يَعُدّ reconcile كل مستورد برصيدٍ «انحرافاً» زائفاً دائماً من يوم الاستيراد.
 *  dedupeKey فريد على مستوى القاعدة ⇒ ازدواج القيد مستحيل بنيوياً مهما تكرّر الاستيراد. */
async function postOpeningEntry(
  tx: Tx,
  party: "CUSTOMER" | "SUPPLIER",
  partyId: number,
  amount: string,
): Promise<void> {
  await assertPeriodOpen(tx, localTodayDate());
  await tx.insert(accountingEntries).values({
    entryType: "OPENING",
    customerId: party === "CUSTOMER" ? partyId : null,
    supplierId: party === "SUPPLIER" ? partyId : null,
    revenue: toDbMoney("0"),
    cost: toDbMoney("0"),
    profit: toDbMoney("0"),
    taxAmount: toDbMoney("0"),
    amount,
    // localTodayDate() يَمنع انزياح OPENING ليوم سابق عند الاستيراد بعد منتصف الليل
    // (new Date() خام تَستخدم UTC؛ على عمود DATE على بغداد +٠٣:٠٠ يَنزاح يوماً واحداً).
    entryDate: localTodayDate(),
    notes: "رصيد افتتاحي (استيراد من النظام القديم)",
    dedupeKey: `OPENING:${party}:${partyId}`,
  });
}

// مفتاح التكرار داخل الدفعة (§٥.٢/§٤.٣.٤-ب): legacyCode إن وُجد ← (الهاتف+الاسم) ← الاسم.
// الهاتف وحده ليس مفتاحاً: الملفات الفعلية فيها هواتف مشتركة مشروعة (عائلة/محل واحد)،
// ورمي أصحابها «مكرّراً» يُفشل الملف كله أو يُسقط أرصدتهم بصمت.
// توحيد حالة الأحرف (legacy/الاسم) يطابق فحص العميل (duplicateKeyOf) وقيد UNIQUE في MySQL
// (ترتيب utf8mb4 غير حسّاس للحالة): «A1» و«a1» سيصطدمان في القاعدة فليُكشفا هنا أولاً.
function dupKeyOf(r: { legacyCode?: string; phone?: string; name: string }): string {
  const lc = norm(r.legacyCode)?.toLowerCase();
  if (lc) return `l:${lc}`;
  const nameKey = r.name.trim().toLowerCase();
  const phone = norm(r.phone);
  return phone ? `pn:${phone}|${nameKey}` : `n:${nameKey}`;
}

function dupMessage(r: { legacyCode?: string }): string {
  const lc = norm(r.legacyCode);
  return lc ? `مكرّر داخل الملف (الرقم القديم «${lc}» مزدوج)` : "مكرّر داخل الملف";
}

const LEGACY_DEALT_PREFIX = "آخر تعامل (النظام القديم):";

/** دمج آمن لسطر «آخر تعامل» مع الملاحظات: يزيل السطر القديم إن وُجد ثم يُلحق الجديد (لا تراكم عند إعادة الاستيراد). */
function mergeLastDealt(base: string | null, lastDealtAt: string): string {
  const kept = (base ?? "")
    .split("\n")
    .filter((line) => !line.trim().startsWith(LEGACY_DEALT_PREFIX))
    .join("\n")
    .trim();
  const line = `${LEGACY_DEALT_PREFIX} ${lastDealtAt}`;
  return kept ? `${kept}\n${line}` : line;
}

// ───────────────────────── العملاء ─────────────────────────

export async function importCustomers(
  rows: CustomerImportRow[],
  options: ImportOptions,
  actor: Actor,
): Promise<ImportSummary> {
  const onExisting = options.onExisting ?? "skip";
  const skipFailed = options.skipFailed ?? false;
  const db = requireDb();
  const failures = new Map<number, string>(); // rowNumber → سبب الفشل

  // ١) التكرار داخل الدفعة (legacyCode ← هاتف+اسم ← اسم) + دلالات الرصيد الحسّاسة.
  const firstSeen = new Map<string, number>();
  for (const r of rows) {
    const k = dupKeyOf(r);
    if (firstSeen.has(k)) failures.set(r.rowNumber, dupMessage(r));
    else firstSeen.set(k, r.rowNumber);
  }
  for (const r of rows) {
    if (failures.has(r.rowNumber)) continue;
    const err = balanceValidationError(r, options);
    if (err) failures.set(r.rowNumber, err);
  }

  // ٢) البحث عن الموجود (دفعة واحدة) — الأولوية: legacyCode ← الهاتف ← الاسم (لمن بلا هاتف، كالقائم).
  // legacyCode هو المعرّف الطبيعي لملفات النظام القديم: المطابقة به متينة ضد تعديل هاتف/اسم في النظام الجديد،
  // والقيد الفريد uq_customer_legacy هو الحارس الأخير ضد ازدواج طرفٍ برصيد عند استيراد متزامن (ER_DUP_ENTRY ⇒ rollback).
  const legacies = uniq(rows.map((r) => norm(r.legacyCode)));
  const phones = uniq(rows.map((r) => norm(r.phone)));
  const namesNoPhone = uniq(rows.filter((r) => !norm(r.phone)).map((r) => r.name.trim()));
  const byLegacy = new Map<string, number>();
  const byPhone = new Map<string, number>();
  const byName = new Map<string, number>();
  if (legacies.length) {
    for (const e of await db
      .select({ id: customers.id, legacyCode: customers.legacyCode })
      .from(customers)
      .where(inArray(customers.legacyCode, legacies)))
      // مفتاح موحّد الحالة: inArray يطابق بلا حساسية حالة (ترتيب MySQL) فيجب أن تطابقه الخريطة.
      if (e.legacyCode) byLegacy.set(e.legacyCode.toLowerCase(), Number(e.id));
  }
  if (phones.length) {
    for (const e of await db.select({ id: customers.id, phone: customers.phone }).from(customers).where(inArray(customers.phone, phones)))
      if (e.phone) byPhone.set(e.phone, Number(e.id));
  }
  if (namesNoPhone.length) {
    // طابق فقط الموجودين بلا هاتف (تفادي مطابقة شخص آخر بنفس الاسم وله هاتف)، ومفتاح غير حسّاس للحالة.
    for (const e of await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(and(inArray(customers.name, namesNoPhone), isNull(customers.phone))))
      byName.set(e.name.trim().toLowerCase(), Number(e.id));
  }

  // ٣) التصنيف: فشل / موجود (تخطٍّ أو تحديث) / إنشاء.
  const results: ImportRowResult[] = [];
  const toCreate: CustomerImportRow[] = [];
  const toUpdate: { row: CustomerImportRow; id: number }[] = [];
  for (const r of rows) {
    if (failures.has(r.rowNumber)) {
      results.push({ rowNumber: r.rowNumber, status: "failed", message: failures.get(r.rowNumber) });
      continue;
    }
    const lc = norm(r.legacyCode);
    const phone = norm(r.phone);
    const existingId =
      (lc ? byLegacy.get(lc.toLowerCase()) : undefined) ??
      (phone ? byPhone.get(phone) : undefined) ??
      (!phone ? byName.get(r.name.trim().toLowerCase()) : undefined);
    if (existingId) {
      if (onExisting === "skip") results.push({ rowNumber: r.rowNumber, status: "skipped", message: "موجود مسبقاً" });
      else if (onExisting === "error") results.push({ rowNumber: r.rowNumber, status: "failed", message: "موجود مسبقاً" });
      else toUpdate.push({ row: r, id: existingId });
    } else {
      toCreate.push(r);
    }
  }
  for (const r of toCreate) results.push({ rowNumber: r.rowNumber, status: "created" });
  for (const u of toUpdate) {
    // الرصيد الافتتاحي يُطبَّق عند الإنشاء فقط (§٥.٢) — عند التحديث يُتجاهَل برسالة صريحة لا بصمت.
    const balanceIgnored = u.row.openingBalance !== undefined && !money(u.row.openingBalance).isZero();
    results.push({
      rowNumber: u.row.rowNumber,
      status: "updated",
      message: balanceIgnored ? "الرصيد الافتتاحي لا يُطبَّق على موجود — عدّله من شاشة العميل/سند" : undefined,
    });
  }

  const anyFailed = results.some((r) => r.status === "failed");
  if (options.dryRun || (anyFailed && !skipFailed) || (!toCreate.length && !toUpdate.length)) {
    return finalize("CUSTOMERS", rows.length, results, false, options, actor);
  }

  try {
    await withTx(async (tx) => {
      // إدراج صفّاً-صفّاً (لا دفعةً واحدة): نحتاج id كل عميل لقيد OPENING المرجعي ضمن نفس المعاملة.
      for (const r of toCreate) {
        const balance = storedOpeningBalance(r, options);
        const res = await tx.insert(customers).values({
          name: r.name.trim(),
          phone: norm(r.phone),
          phone2: norm(r.phone2),
          phone3: norm(r.phone3),
          whatsapp: norm(r.whatsapp),
          address: norm(r.address),
          city: norm(r.city),
          district: norm(r.district),
          customerType: r.customerType ?? "فرد",
          defaultPriceTier: r.defaultPriceTier ?? "RETAIL",
          creditLimit: r.creditLimit ? toDbMoney(r.creditLimit) : "0",
          currentBalance: balance,
          legacyCode: norm(r.legacyCode),
          notes: r.lastDealtAt ? mergeLastDealt(norm(r.notes), r.lastDealtAt) : norm(r.notes),
          isActive: r.isActive ?? true,
        });
        if (!money(balance).isZero()) await postOpeningEntry(tx, "CUSTOMER", insertId(res), balance);
      }
      for (const { row, id } of toUpdate) {
        const patch: Record<string, unknown> = {};
        if (norm(row.phone) != null) patch.phone = norm(row.phone);
        if (norm(row.phone2) != null) patch.phone2 = norm(row.phone2);
        if (norm(row.phone3) != null) patch.phone3 = norm(row.phone3);
        if (norm(row.whatsapp) != null) patch.whatsapp = norm(row.whatsapp);
        if (norm(row.address) != null) patch.address = norm(row.address);
        if (norm(row.city) != null) patch.city = norm(row.city);
        if (norm(row.district) != null) patch.district = norm(row.district);
        if (row.customerType) patch.customerType = row.customerType;
        if (row.defaultPriceTier) patch.defaultPriceTier = row.defaultPriceTier;
        if (row.creditLimit) patch.creditLimit = toDbMoney(row.creditLimit);
        // ترصين legacyCode على الموجود (مُطابَق بالهاتف/الاسم) ⇒ إعادة الاستيراد القادمة تطابقه بالمعرّف القديم مباشرة.
        if (norm(row.legacyCode) != null) patch.legacyCode = norm(row.legacyCode);
        if (row.lastDealtAt) {
          // دمج آمن مع الملاحظات الموجودة: لا تراكم لسطر «آخر تعامل» عند تكرار الاستيراد.
          const existing = await tx
            .select({ notes: customers.notes })
            .from(customers)
            .where(eq(customers.id, id))
            .limit(1);
          patch.notes = mergeLastDealt(norm(row.notes) ?? existing[0]?.notes ?? null, row.lastDealtAt);
        } else if (norm(row.notes) != null) {
          patch.notes = norm(row.notes);
        }
        if (Object.keys(patch).length) await tx.update(customers).set(patch).where(eq(customers.id, id));
      }
    });
  } catch (e) {
    // الرسالة الخام تُسجَّل كاملة للتشخيص وتُعرَّب للواجهة (لا نصّ SQL/قيود/بيانات صفوف للمستخدم).
    logger.error({ err: e }, "فشل كتابة دفعة استيراد العملاء");
    return finalize("CUSTOMERS", rows.length, markWriteError(results, writeErrorMessage(e)), false, options, actor);
  }
  return finalize("CUSTOMERS", rows.length, results, true, options, actor);
}

// ───────────────────────── الموردون ─────────────────────────

export async function importSuppliers(
  rows: SupplierImportRow[],
  options: ImportOptions,
  actor: Actor,
): Promise<ImportSummary> {
  const onExisting = options.onExisting ?? "skip";
  const skipFailed = options.skipFailed ?? false;
  const db = requireDb();
  const failures = new Map<number, string>();

  // ١) التكرار داخل الدفعة + دلالات الرصيد (نفس قواعد العملاء — §٥.٢).
  const firstSeen = new Map<string, number>();
  for (const r of rows) {
    const k = dupKeyOf(r);
    if (firstSeen.has(k)) failures.set(r.rowNumber, dupMessage(r));
    else firstSeen.set(k, r.rowNumber);
  }
  for (const r of rows) {
    if (failures.has(r.rowNumber)) continue;
    const err = balanceValidationError(r, options);
    if (err) failures.set(r.rowNumber, err);
  }

  // ٢) البحث عن الموجود — الأولوية: legacyCode ← الهاتف ← الاسم (والقيد uq_supplier_legacy حارس السباق).
  const legacies = uniq(rows.map((r) => norm(r.legacyCode)));
  const phones = uniq(rows.map((r) => norm(r.phone)));
  const namesNoPhone = uniq(rows.filter((r) => !norm(r.phone)).map((r) => r.name.trim()));
  const byLegacy = new Map<string, number>();
  const byPhone = new Map<string, number>();
  const byName = new Map<string, number>();
  if (legacies.length) {
    for (const e of await db
      .select({ id: suppliers.id, legacyCode: suppliers.legacyCode })
      .from(suppliers)
      .where(inArray(suppliers.legacyCode, legacies)))
      // مفتاح موحّد الحالة: inArray يطابق بلا حساسية حالة (ترتيب MySQL) فيجب أن تطابقه الخريطة.
      if (e.legacyCode) byLegacy.set(e.legacyCode.toLowerCase(), Number(e.id));
  }
  if (phones.length) {
    for (const e of await db.select({ id: suppliers.id, phone: suppliers.phone }).from(suppliers).where(inArray(suppliers.phone, phones)))
      if (e.phone) byPhone.set(e.phone, Number(e.id));
  }
  if (namesNoPhone.length) {
    for (const e of await db
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .where(and(inArray(suppliers.name, namesNoPhone), isNull(suppliers.phone))))
      byName.set(e.name.trim().toLowerCase(), Number(e.id));
  }

  // ٣) التصنيف.
  const results: ImportRowResult[] = [];
  const toCreate: SupplierImportRow[] = [];
  const toUpdate: { row: SupplierImportRow; id: number }[] = [];
  for (const r of rows) {
    if (failures.has(r.rowNumber)) {
      results.push({ rowNumber: r.rowNumber, status: "failed", message: failures.get(r.rowNumber) });
      continue;
    }
    const lc = norm(r.legacyCode);
    const phone = norm(r.phone);
    const existingId =
      (lc ? byLegacy.get(lc.toLowerCase()) : undefined) ??
      (phone ? byPhone.get(phone) : undefined) ??
      (!phone ? byName.get(r.name.trim().toLowerCase()) : undefined);
    if (existingId) {
      if (onExisting === "skip") results.push({ rowNumber: r.rowNumber, status: "skipped", message: "موجود مسبقاً" });
      else if (onExisting === "error") results.push({ rowNumber: r.rowNumber, status: "failed", message: "موجود مسبقاً" });
      else toUpdate.push({ row: r, id: existingId });
    } else {
      toCreate.push(r);
    }
  }
  for (const r of toCreate) results.push({ rowNumber: r.rowNumber, status: "created" });
  for (const u of toUpdate) {
    const balanceIgnored = u.row.openingBalance !== undefined && !money(u.row.openingBalance).isZero();
    results.push({
      rowNumber: u.row.rowNumber,
      status: "updated",
      message: balanceIgnored ? "الرصيد الافتتاحي لا يُطبَّق على موجود — عدّله من شاشة المورد/سند" : undefined,
    });
  }

  const anyFailed = results.some((r) => r.status === "failed");
  if (options.dryRun || (anyFailed && !skipFailed) || (!toCreate.length && !toUpdate.length)) {
    return finalize("SUPPLIERS", rows.length, results, false, options, actor);
  }

  try {
    await withTx(async (tx) => {
      // إدراج صفّاً-صفّاً: نحتاج id كل مورد لقيد OPENING المرجعي ضمن نفس المعاملة.
      for (const r of toCreate) {
        const balance = storedOpeningBalance(r, options);
        const res = await tx.insert(suppliers).values({
          name: r.name.trim(),
          phone: norm(r.phone),
          phone2: norm(r.phone2),
          phone3: norm(r.phone3),
          email: norm(r.email),
          whatsapp: norm(r.whatsapp),
          address: norm(r.address),
          city: norm(r.city),
          taxId: norm(r.taxId),
          productTypes: norm(r.productTypes),
          paymentTerms: norm(r.paymentTerms),
          currentBalance: balance,
          legacyCode: norm(r.legacyCode),
          notes: r.lastDealtAt ? mergeLastDealt(norm(r.notes), r.lastDealtAt) : norm(r.notes),
          isActive: r.isActive ?? true,
        });
        if (!money(balance).isZero()) await postOpeningEntry(tx, "SUPPLIER", insertId(res), balance);
      }
      for (const { row, id } of toUpdate) {
        const patch: Record<string, unknown> = {};
        if (norm(row.phone) != null) patch.phone = norm(row.phone);
        if (norm(row.phone2) != null) patch.phone2 = norm(row.phone2);
        if (norm(row.phone3) != null) patch.phone3 = norm(row.phone3);
        if (norm(row.email) != null) patch.email = norm(row.email);
        if (norm(row.whatsapp) != null) patch.whatsapp = norm(row.whatsapp);
        if (norm(row.address) != null) patch.address = norm(row.address);
        if (norm(row.city) != null) patch.city = norm(row.city);
        if (norm(row.taxId) != null) patch.taxId = norm(row.taxId);
        if (norm(row.productTypes) != null) patch.productTypes = norm(row.productTypes);
        if (norm(row.paymentTerms) != null) patch.paymentTerms = norm(row.paymentTerms);
        if (norm(row.legacyCode) != null) patch.legacyCode = norm(row.legacyCode);
        if (row.lastDealtAt) {
          const existing = await tx
            .select({ notes: suppliers.notes })
            .from(suppliers)
            .where(eq(suppliers.id, id))
            .limit(1);
          patch.notes = mergeLastDealt(norm(row.notes) ?? existing[0]?.notes ?? null, row.lastDealtAt);
        } else if (norm(row.notes) != null) {
          patch.notes = norm(row.notes);
        }
        if (Object.keys(patch).length) await tx.update(suppliers).set(patch).where(eq(suppliers.id, id));
      }
    });
  } catch (e) {
    // الرسالة الخام تُسجَّل كاملة للتشخيص وتُعرَّب للواجهة (لا نصّ SQL/قيود/بيانات صفوف للمستخدم).
    logger.error({ err: e }, "فشل كتابة دفعة استيراد الموردين");
    return finalize("SUPPLIERS", rows.length, markWriteError(results, writeErrorMessage(e)), false, options, actor);
  }
  return finalize("SUPPLIERS", rows.length, results, true, options, actor);
}

// ───────────────────────── المنتجات (شجرة ٤ جداول) ─────────────────────────
// نموذج مبسّط آمن: كل productName = منتج واحد، متغيّراته بالـ sku، وحداته بالاسم، أسعاره بالفئة.
// الاستيراد يُنشئ منتجات جديدة فقط؛ الـ sku الموجود ⇒ تخطّي/فشل (التحديث عبر شاشة المنتج).

type UnitAgg = {
  unitName: string;
  conversionFactor: string;
  barcode?: string;
  // undefined = لم يُحدَّد في الملف؛ افتراضه المشروط يُحسم بعد التجميع (§٥.١).
  isBaseUnit: boolean | undefined;
  prices: Map<string, string>; // tier → price (مُطبَّع بـ toDbMoney لمقارنة تعارض حتمية)
};
type VariantAgg = {
  sku: string;
  variantName?: string;
  color?: string;
  size?: string;
  costPrice: string;
  openingStock?: number;
  rowNumbers: number[];
  units: Map<string, UnitAgg>;
};
type ProductAgg = {
  productName: string;
  categoryName?: string;
  isCustomizable: boolean;
  rowNumbers: number[];
  variants: Map<string, VariantAgg>;
};

// خرائط الأسعار الصريحة (§٥.٣): retailPrice→RETAIL / wholesalePrice→WHOLESALE / governmentPrice→GOVERNMENT.
const EXPLICIT_PRICE_FIELDS = [
  ["retailPrice", "RETAIL"],
  ["wholesalePrice", "WHOLESALE"],
  ["governmentPrice", "GOVERNMENT"],
] as const;

export async function importProducts(
  rows: ProductImportRow[],
  options: ImportOptions,
  actor: Actor,
): Promise<ImportSummary> {
  const onExisting = options.onExisting ?? "skip";
  const skipFailed = options.skipFailed ?? false;
  const db = requireDb();
  const failures = new Map<number, string>(); // rowNumber → سبب الفشل

  // ١) التجميع: productName → variants(sku) → units(name) → prices(tier) — مع كشف تعارض الصفوف المكرّرة.
  const { groups, skuOwner } = aggregateImportRows(rows, failures);

  // ٢) افتراض isBaseUnit المشروط (sku بصفّ واحد بلا تحديد ⇒ وحدته هي الأساس).
  applyBaseUnitDefaults(groups);

  // ٣) التحقّق على مستوى المتغيّر/الوحدة + تكرار الباركود داخل الملف.
  const batchBarcodes = validateProductGroups(groups, failures);

  // ٤) كشف الموجود في القاعدة: SKU (متغيّر) + الباركود مع sku متغيّره المالك.
  const { existingSkus, existingBarcodeOwner } = await detectExistingProducts(db, skuOwner, batchBarcodes);

  // ٥) تصنيف كل مجموعة منتج: إنشاء / تخطّي / فشل.
  const { results, toCreate } = classifyProductGroups(groups, existingSkus, existingBarcodeOwner, failures, onExisting);

  const anyFailed = results.some((r) => r.status === "failed");
  if (options.dryRun || (anyFailed && !skipFailed) || !toCreate.length) {
    return finalize("PRODUCTS", rows.length, results, false, options, actor);
  }

  // ٦) التنفيذ: إنشاء التصنيفات الناقصة ثم شجرة كل منتج (+ مخزونه الافتتاحي) داخل معاملة واحدة.
  try {
    await withTx((tx) => persistProductsInTx(tx, toCreate, actor));
  } catch (e) {
    // الرسالة الخام تُسجَّل كاملة للتشخيص وتُعرَّب للواجهة (لا نصّ SQL/قيود/بيانات صفوف للمستخدم).
    logger.error({ err: e }, "فشل كتابة دفعة استيراد المنتجات");
    return finalize("PRODUCTS", rows.length, markWriteError(results, writeErrorMessage(e)), false, options, actor);
  }
  return finalize("PRODUCTS", rows.length, results, true, options, actor);
}

type SkuOwner = Map<string, { productName: string; rows: number[] }>;

/** ① التجميع: productName → variants(sku) → units(name) → prices(tier) — مع كشف تعارض الصفوف المكرّرة. */
function aggregateImportRows(
  rows: ProductImportRow[],
  failures: Map<number, string>,
): { groups: Map<string, ProductAgg>; skuOwner: SkuOwner } {
  const groups = new Map<string, ProductAgg>();
  const skuOwner: SkuOwner = new Map(); // sku → المالك الأول + صفوفه
  for (const r of rows) {
    const pName = r.productName.trim();
    let p = groups.get(pName);
    if (!p) {
      p = { productName: pName, categoryName: norm(r.categoryName) ?? undefined, isCustomizable: !!r.isCustomizable, rowNumbers: [], variants: new Map() };
      groups.set(pName, p);
    }
    p.rowNumbers.push(r.rowNumber);

    // sku اختياري في الملف: البديل التلقائي = الباركود (§٥.١)؛ كلاهما غائب ⇒ فشل الصف (ويُفشل المنتج كاملاً).
    const sku = norm(r.sku) ?? norm(r.barcode);
    if (!sku) {
      failures.set(r.rowNumber, "حدّد SKU أو الباركود");
      continue;
    }

    // تضارب ملكية الـ SKU عبر منتجَين ⇒ أفشِل الصفّ الحالي وكل صفوف المالك الأول (لا تتركها «created»).
    const owner = skuOwner.get(sku);
    if (owner && owner.productName !== pName) {
      failures.set(r.rowNumber, `الـ SKU «${sku}» مرتبط بأكثر من منتج`);
      for (const rn of owner.rows) failures.set(rn, `الـ SKU «${sku}» مرتبط بأكثر من منتج`);
    } else if (owner) {
      owner.rows.push(r.rowNumber);
    } else {
      skuOwner.set(sku, { productName: pName, rows: [r.rowNumber] });
    }

    const vName = norm(r.variantName) ?? undefined;
    const vColor = norm(r.color) ?? undefined;
    const vSize = norm(r.size) ?? undefined;
    let v = p.variants.get(sku);
    if (!v) {
      v = { sku, variantName: vName, color: vColor, size: vSize, costPrice: r.costPrice, rowNumbers: [], units: new Map() };
      p.variants.set(sku, v);
    } else if (v.variantName !== vName || v.color !== vColor || v.size !== vSize || v.costPrice !== r.costPrice) {
      // صفّ آخر لنفس الـ SKU بقيم متغيّر متعارضة ⇒ لا تَدمج بصمت (قد يكون خطأ إدخال في التكلفة).
      failures.set(r.rowNumber, `قيم متعارضة لنفس الـ SKU «${sku}» (التكلفة/الاسم/اللون/المقاس)`);
    }
    v.rowNumbers.push(r.rowNumber);

    // المخزون الافتتاحي على مستوى المتغيّر: قيمتان مختلفتان لنفس الـ SKU ⇒ تعارض لا دمج صامت.
    if (r.openingStock !== undefined) {
      if (v.openingStock !== undefined && v.openingStock !== r.openingStock) {
        failures.set(r.rowNumber, `قيم متعارضة للمخزون الافتتاحي لنفس الـ SKU «${sku}»`);
      } else {
        v.openingStock = r.openingStock;
      }
    }

    const uBarcode = norm(r.barcode) ?? undefined;
    let u = v.units.get(r.unitName);
    if (!u) {
      u = { unitName: r.unitName, conversionFactor: r.conversionFactor, barcode: uBarcode, isBaseUnit: r.isBaseUnit, prices: new Map() };
      v.units.set(r.unitName, u);
    } else if (
      u.conversionFactor !== r.conversionFactor ||
      (u.isBaseUnit ?? false) !== (r.isBaseUnit ?? false) ||
      u.barcode !== uBarcode
    ) {
      // وحدة مكرّرة بقيم متعارضة (معامل/أساس/باركود) ⇒ أفشِل بدل الدمج الصامت (المعامل يحكم حساب المخزون).
      failures.set(r.rowNumber, `قيم متعارضة للوحدة «${r.unitName}» داخل الـ SKU «${sku}»`);
    }

    // دمج الأسعار: الحقول الصريحة الثلاثة + (priceTier/price) القديمة للتوافق — سعر 0/فارغ ⇒ تخطَّ الفئة (§٥.٣).
    const setUnitPrice = (tier: string, raw: string, rn: number) => {
      if (money(raw).isZero()) return; // 0 = لا سعر لهذه الفئة في النظام القديم
      const val = toDbMoney(raw); // تطبيع نصّي ⇒ مقارنة تعارض حتمية («2.0» ≡ «2.00»)
      const prev = u.prices.get(tier);
      if (prev != null && prev !== val) failures.set(rn, `سعر متعارض للفئة ${tier} في الوحدة «${u.unitName}»`);
      else u.prices.set(tier, val);
    };
    for (const [field, tier] of EXPLICIT_PRICE_FIELDS) {
      const raw = r[field];
      if (raw !== undefined) setUnitPrice(tier, raw, r.rowNumber);
    }
    if (r.priceTier) {
      if (!r.price) failures.set(r.rowNumber, "السعر مطلوب مع وجود فئة السعر");
      else setUnitPrice(r.priceTier, r.price, r.rowNumber);
    }
  }
  return { groups, skuOwner };
}

/**
 * ② افتراض isBaseUnit المشروط (§٥.١ — بعد التجميع لا في zod، لأن التحقق الصفّي لا يرى سياق المجموعة):
 * sku بصفّ واحد بلا تحديد ⇒ وحدته هي الأساس (ملف الأصناف: الكود فريد ١٠٠٪ ⇒ هذا هو المسار الفعلي).
 * صفّان فأكثر كلاهما بلا تحديد ⇒ يفشلان برسالة «وحدة أساس واحدة بالضبط» — سلوك منصوص لا عرَضي.
 */
function applyBaseUnitDefaults(groups: Map<string, ProductAgg>): void {
  for (const p of Array.from(groups.values())) {
    for (const v of Array.from(p.variants.values())) {
      if (v.rowNumbers.length === 1) {
        const only = Array.from(v.units.values())[0];
        if (only && only.isBaseUnit === undefined) only.isBaseUnit = true;
      }
    }
  }
}

/** ③ التحقّق على مستوى المتغيّر/الوحدة + تكرار الباركود داخل الملف. يُعيد خريطة الباركود → صفوف مالكه. */
function validateProductGroups(
  groups: Map<string, ProductAgg>,
  failures: Map<number, string>,
): Map<string, number[]> {
  const batchBarcodes = new Map<string, number[]>(); // barcode → صفوف المتغيّر المالك
  for (const p of Array.from(groups.values())) {
    for (const v of Array.from(p.variants.values())) {
      const baseUnits = Array.from(v.units.values()).filter((u) => !!u.isBaseUnit);
      if (baseUnits.length !== 1) {
        for (const rn of v.rowNumbers) failures.set(rn, `المتغيّر «${v.sku}» يحتاج وحدة أساس واحدة بالضبط`);
      }
      for (const u of Array.from(v.units.values())) {
        const f = Number(u.conversionFactor);
        if (u.isBaseUnit && f !== 1) {
          for (const rn of v.rowNumbers) failures.set(rn, `وحدة الأساس «${u.unitName}» يجب أن يكون معامل تحويلها ١`);
        }
        if (!u.isBaseUnit && (!Number.isInteger(f) || f < 1)) {
          for (const rn of v.rowNumbers) failures.set(rn, `معامل تحويل «${u.unitName}» يجب أن يكون عدداً صحيحاً ≥ ١`);
        }
        if (u.barcode) {
          const prevRows = batchBarcodes.get(u.barcode);
          if (prevRows) {
            for (const rn of v.rowNumbers) failures.set(rn, `الباركود «${u.barcode}» مكرّر داخل الملف`);
            for (const rn of prevRows) failures.set(rn, `الباركود «${u.barcode}» مكرّر داخل الملف`);
          } else {
            batchBarcodes.set(u.barcode, v.rowNumbers);
          }
        }
      }
    }
  }
  return batchBarcodes;
}

/**
 * ④ كشف الموجود في القاعدة: SKU (متغيّر) + الباركود مع sku متغيّره المالك —
 * الباركود الموجود لمتغيّرٍ من المنتج نفسه ليس «تعارضاً» بل إعادةُ استيراد منتجٍ سبق إنشاؤه:
 * ملف المالك بلا عمود SKU ⇒ sku=الباركود لكل صف، فبدون تمييز المالك كانت إعادة الاستيراد
 * تُصنَّف «فاشل: باركود مُستخدَم» وتُوقف بقية الدفعات (نقيض «إعادة التشغيل آمنة» — §٤.٣.٤-د).
 */
async function detectExistingProducts(
  db: ReturnType<typeof requireDb>,
  skuOwner: SkuOwner,
  batchBarcodes: Map<string, number[]>,
): Promise<{ existingSkus: Set<string>; existingBarcodeOwner: Map<string, string> }> {
  const allSkus = Array.from(skuOwner.keys());
  const allBarcodes = Array.from(batchBarcodes.keys());
  const existingSkus = new Set<string>();
  const existingBarcodeOwner = new Map<string, string>(); // barcode → sku المتغيّر المالك في القاعدة
  if (allSkus.length) {
    for (const e of await db.select({ sku: productVariants.sku }).from(productVariants).where(inArray(productVariants.sku, allSkus)))
      existingSkus.add(e.sku);
  }
  if (allBarcodes.length) {
    for (const e of await db
      .select({ barcode: productUnits.barcode, sku: productVariants.sku })
      .from(productUnits)
      .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
      .where(inArray(productUnits.barcode, allBarcodes)))
      if (e.barcode) existingBarcodeOwner.set(e.barcode, e.sku);
  }
  return { existingSkus, existingBarcodeOwner };
}

/** ⑤ تصنيف كل مجموعة منتج: إنشاء / تخطّي / فشل. يُعيد نتائج كل الصفوف + المجموعات الجاهزة للإنشاء. */
function classifyProductGroups(
  groups: Map<string, ProductAgg>,
  existingSkus: Set<string>,
  existingBarcodeOwner: Map<string, string>,
  failures: Map<number, string>,
  onExisting: string,
): { results: ImportRowResult[]; toCreate: ProductAgg[] } {
  const results: ImportRowResult[] = [];
  const toCreate: ProductAgg[] = [];
  for (const p of Array.from(groups.values())) {
    const groupFailed = p.rowNumbers.some((rn) => failures.has(rn));
    if (groupFailed) {
      for (const rn of p.rowNumbers) results.push({ rowNumber: rn, status: "failed", message: failures.get(rn) ?? "خطأ في صفّ مرتبط بنفس المنتج" });
      continue;
    }
    const skus = Array.from(p.variants.keys());
    const skuSet = new Set(skus);
    const hasExistingSku = skus.some((sku) => existingSkus.has(sku));
    // التعارض الحقيقي: باركود موجود في القاعدة لمتغيّرٍ من «خارج هذا المنتج» (sku المالك ليس من
    // skus المنتج) — أمّا المملوك لأحد متغيّراته نفسها (إعادة استيراد) فيُحسم «موجود مسبقاً» أدناه.
    const barcodeClash = Array.from(p.variants.values()).some((v) =>
      Array.from(v.units.values()).some((u) => {
        if (!u.barcode) return false;
        const ownerSku = existingBarcodeOwner.get(u.barcode);
        return ownerSku != null && !skuSet.has(ownerSku);
      }),
    );

    // «موجود مسبقاً» يسبق فحص التعارض (§٤.٣.٤-د): إعادة استيراد منتجٍ سبق إنشاؤه تتخطّاه لا
    // تُفشله — وإلا استحال استئناف ملفٍ توقّف في منتصفه عبر الواجهة (الدفعة ١ كلها «فاشلة»).
    if (hasExistingSku) {
      if (onExisting === "error") for (const rn of p.rowNumbers) results.push({ rowNumber: rn, status: "failed", message: "الـ SKU موجود مسبقاً" });
      else for (const rn of p.rowNumbers) results.push({ rowNumber: rn, status: "skipped", message: onExisting === "update" ? "موجود — التحديث عبر شاشة المنتج" : "موجود مسبقاً" });
      continue;
    }
    if (barcodeClash) {
      for (const rn of p.rowNumbers) results.push({ rowNumber: rn, status: "failed", message: "باركود مُستخدَم مسبقاً (يجب أن يكون فريداً)" });
      continue;
    }
    toCreate.push(p);
    for (const rn of p.rowNumbers) results.push({ rowNumber: rn, status: "created" });
  }
  return { results, toCreate };
}

/** ⑥ التنفيذ: إنشاء التصنيفات الناقصة ثم شجرة كل منتج (+ مخزونه الافتتاحي) داخل معاملة واحدة. */
async function persistProductsInTx(tx: Tx, toCreate: ProductAgg[], actor: Actor): Promise<void> {
  const catNames = uniq(toCreate.map((p) => p.categoryName));
  const catMap = new Map<string, number>(); // المفتاح: الاسم بحالة موحّدة (تفادي تصادم «X»/«x» على القيد الفريد)
  if (catNames.length) {
    for (const c of await tx.select({ id: categories.id, name: categories.name }).from(categories).where(inArray(categories.name, catNames)))
      catMap.set(c.name.trim().toLowerCase(), Number(c.id));
    for (const name of catNames) {
      const key = name.trim().toLowerCase();
      if (!catMap.has(key)) {
        const res = await tx.insert(categories).values({ name });
        catMap.set(key, insertId(res));
      }
    }
  }

  for (const p of toCreate) {
    const pRes = await tx.insert(products).values({
      name: p.productName,
      categoryId: p.categoryName ? catMap.get(p.categoryName.trim().toLowerCase()) ?? null : null,
      isCustomizable: p.isCustomizable,
    });
    const productId = insertId(pRes);

    for (const v of Array.from(p.variants.values())) {
      const vRes = await tx.insert(productVariants).values({
        productId,
        sku: v.sku,
        variantName: v.variantName ?? null,
        color: v.color ?? null,
        size: v.size ?? null,
        costPrice: toDbMoney(v.costPrice),
      });
      const variantId = insertId(vRes);

      for (const u of Array.from(v.units.values())) {
        const uRes = await tx.insert(productUnits).values({
          variantId,
          unitName: u.unitName,
          conversionFactor: u.conversionFactor,
          barcode: u.barcode ?? null,
          isBaseUnit: !!u.isBaseUnit,
        });
        const productUnitId = insertId(uRes);
        for (const [tier, price] of Array.from(u.prices)) {
          await tx.insert(productPrices).values({
            productUnitId,
            priceTier: tier as z.infer<typeof priceTier>,
            price: toDbMoney(price),
          });
        }
      }

      // المخزون الافتتاحي (§٥.٣): حركة تسوية بمرجع OPENING داخل نفس المعاملة — ذرّيةُ الشجرة ورصيدها معاً.
      if (v.openingStock !== undefined && v.openingStock > 0) {
        await setStock(tx, {
          variantId,
          branchId: actor.branchId,
          targetQuantity: v.openingStock,
          referenceType: "OPENING",
          notes: "رصيد افتتاحي (استيراد)",
          createdBy: actor.userId,
        });
      }
    }
  }
}
