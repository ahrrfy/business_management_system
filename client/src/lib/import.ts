// محرّك الاستيراد (نقي، قابل للاختبار): قراءة xlsx/csv، مطابقة أعمدة ذكية، قسر أنواع + تطبيع الأرقام العربية.
// التحليل يجري في الواجهة؛ الصفوف المُقسَرة تُرسَل JSON للخادم الذي يعيد التحقّق ويكتب ذرّياً.
// أموال النظام القديم تأتي بصيغ محاسبية («2,988,100.»، «[27,749,996.]») ⇒ قسر moneySigned + تقريب نصّي HALF_UP
// عبر decimal.js حصراً (ممنوع parseFloat/Number على الأموال — يُسمح Number للمقارنة لا للتخزين).
import Decimal from "decimal.js";
import * as XLSX from "xlsx";

export type ImportFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "phone"
  | "money"
  | "moneySigned" // مال موقَّع: يقبل «-123.45» و«[123.45]» (أقواس مربعة = سالب) و«(123.45)» (أقواس محاسبية = سالب)
  | "date"; // تاريخ بسيط YYYY-MM-DD (صيغة ملفات النظام القديم) — غيره يُرفض برسالة واضحة

export type ImportField<TRow> = {
  key: keyof TRow & string;
  label: string; // عربي — للقالب وللمطابقة
  type: ImportFieldType;
  required?: boolean;
  aliases?: string[]; // ترويسات بديلة (عربي/إنجليزي)
  enumValues?: string[]; // القيم القانونية للنوع enum
  enumMap?: Record<string, string>; // مرادفات → قيمة قانونية ("جملة" → "WHOLESALE")
  /** تحويل قيمة نصّية بعد القسر (مثل تطبيع "each" → «قطعة» للوحدات). */
  transform?: (value: string) => string;
  /** حدّ أقصى لطول النصّ بعد القسر — مرآة حدود zod في الخادم (name≤255، legacyCode≤40…):
   *  تجاوزه = خطأ صفّي هنا، وإلا رفض zod دفعة tRPC كاملة بـBAD_REQUEST متجاوزاً skipFailed.
   *  للنوع phone الافتراض ٢٠ (phoneStr.max(20) في الخادم) حتى بلا تحديد. */
  maxLen?: number;
  /** للنوع integer: السالب (شائع في الأنظمة القديمة — بيع على المكشوف) يُقصّ صفراً مع تحذير لا فشل. */
  clampNegativeToZero?: boolean;
  /** نصّ تحذير القصّ (يظهر في المعاينة ولا يمنع الاستيراد). */
  clampWarning?: string;
  validate?: (value: unknown, row: Record<string, unknown>) => string | null;
  example?: string | number;
};

export type CellError = { field: string; message: string };

export type ParsedRow<TRow> = {
  rowNumber: number; // رقم صفّ الإكسل الفعلي (الترويسة = صفّ ١، أوّل بيانات = صفّ ٢)
  raw: Record<string, unknown>;
  values: Partial<TRow>;
  errors: CellError[];
  warnings: CellError[]; // تحذيرات لا تمنع الاستيراد (مثل قصّ مخزون سالب إلى صفر)
};

export type ImportParseResult = {
  headers: string[];
  rows: Record<string, unknown>[];
  rowNumbers: number[]; // رقم صفّ الإكسل الأصلي لكل صفّ بيانات (موازٍ لـ rows، يتجاوز الصفوف الفارغة)
  totalRows: number;
};

export type ColumnMapping<TRow> = Record<string, (keyof TRow & string) | null>;

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

/** صفّ مُرسَل للخادم: قيم الحقول + رقم الصفّ الأصلي (لمطابقة الإكسل في الملخّص). */
export type ImportRow<TRow> = TRow & { rowNumber: number };

/** خيارات تشغيل تُمرَّر من الحوار إلى معالج الاستيراد (الشاشة تمرّرها بدورها لـ payload الخادم إن دعمته). */
export type ImportRunOptions = {
  dryRun?: boolean; // جولة فحص بلا كتابة (تسبق الكتابة عند تقسيم الملف دفعات)
  usdRate?: string; // سعر صرف الدولار — نصّ مالي، إلزامي حين يحوي الملف صفوف USD
  skipFailed?: boolean; // تجاوز الصفوف الفاشلة (الافتراضي: الكل أو لا شيء)
  balanceSign?: "asIs" | "invert"; // اتجاه الرصيد الافتتاحي: كما في الملف / اعكس الإشارة
};

export type ImportHandler<TRow> = (
  rows: ImportRow<TRow>[],
  ctx: { onProgress?: (done: number, total: number) => void; options?: ImportRunOptions },
) => Promise<ImportSummary>;

/** وصف سلوكي لكل مجموعة حقول (يصدر من importFields بجوار FIELDS) — يُمرَّر للحوار كـprop اختياري.
 *  ممنوع الـhardcode لأسماء المفاتيح داخل المكوّن العام أو الـswitch على entityName النصّي. */
export type ImportMeta = {
  /** مفتاح تجميع الدفعات (منتجات: productName) — صفوف المجموعة الواحدة لا تُفصم عبر دفعتين. */
  batchGroupByKey?: string;
  /** مفتاح حقل العملة (لإظهار حقل سعر الصرف وحارس العمود غير المربوط). */
  currencyKey?: string;
  /** مفتاح الرصيد الافتتاحي (لإظهار خيار اتجاه الرصيد ومعاينته). */
  balanceKey?: string;
  /** افتراض اتجاه الرصيد (الموردون: invert — ملفهم يعرض ما ندين به بالسالب بينما AP الجديد موجب). */
  balanceSignDefault?: "asIs" | "invert";
  /** هل تمرّر الشاشةُ الخيارات فعلاً للخادم؟ مفتاح يظهر بلا أثر خادمي = وعد كاذب للمستخدم. */
  supportsServerOptions?: boolean;
  /** مفاتيح كشف التكرار الداخلي: legacyCode إن وُجد، وإلا (الهاتف+الاسم)، وإلا الاسم — الهاتف وحده ليس مفتاحاً. */
  duplicateKeys?: { legacy?: string; phone?: string; name?: string };
  /** تفسير إشارة الرصيد المخزَّنة (بعد تطبيق الاتجاه) — للمعاينة الحيّة. */
  balanceHints?: { positive: string; negative: string };
  /** مفاتيح فحوص المنتجات للملف كاملاً: تعارض ملكية sku (sku واحد تحت منتجَين مختلفَين)
   *  وتكرار الباركود عبر متغيّرات مختلفة (barcode/unit — مرآة كشف الخادم الذي يعمل داخل النداء الواحد فقط). */
  skuConflictKeys?: { sku: string; fallback?: string; owner: string; barcode?: string; unit?: string };
};

// ───────────────────────── تطبيع الأرقام والنصوص ─────────────────────────

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** يحوّل الأرقام العربية/الفارسية إلى ASCII (٠..٩ و ۰..۹ → 0..9). */
export function normalizeDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const ai = ARABIC_DIGITS.indexOf(ch);
    if (ai >= 0) {
      out += String(ai);
      continue;
    }
    const pi = PERSIAN_DIGITS.indexOf(ch);
    if (pi >= 0) {
      out += String(pi);
      continue;
    }
    out += ch;
  }
  return out;
}

/** نصّ رقمي منظَّف: أرقام ASCII، بلا فواصل آلاف (، ٬)، فاصلة عشرية عربية ٫ → نقطة،
 *  ونقطة عشرية زائدة في النهاية تُحذف (صيغة النظام القديم: «2,988,100.» → «2988100»). */
function cleanNumericText(raw: unknown): string {
  return normalizeDigits(String(raw ?? "").trim())
    .replace(/[٬,\s]/g, "") // فواصل الآلاف والمسافات
    .replace(/[٫]/g, ".") // الفاصلة العشرية العربية
    .replace(/\.$/, ""); // نقطة زائدة في النهاية بلا كسور
}

/** تطبيع ترويسة للمطابقة: حذف BOM/التطويل/التشكيل/علامة المطلوب، توحيد الألف (أ/إ/آ → ا)
 *  — كي تتطابق «حد الإئتمان»/«حد الائتمان» و«اخر تعامل»/«آخر تعامل» — وتوحيد المسافات والحالة. */
export function normHeader(s: string): string {
  return String(s ?? "")
    .replace(/^﻿/, "")
    .replace(/[ـ]/g, "") // تطويل
    .replace(/[ً-ْ]/g, "") // تشكيل
    .replace(/[أإآ]/g, "ا") // توحيد الألف
    .replace(/\*+$/, "") // علامة الحقل المطلوب في القالب
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** تقريب نصّي آمن لمنزلتين HALF_UP عبر decimal.js (دالة نقية على السلاسل — لا parseFloat).
 *  نصّ صالح بمنزلتين أو أقل يعود كما هو («1500.50» تبقى)، والزائد يُقرَّب («2291.678» → «2291.68»). */
function roundMoneyText(t: string): string {
  if (/^\d+(\.\d{1,2})?$/.test(t)) return t; // صالح أصلاً — لا تغيير (نحافظ على نصّ المُدخل)
  return new Decimal(t).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** يفصل إشارة السالب المحاسبية قبل التنظيف: «-123» أو «[123]» (مربعة) أو «(123)» (محاسبية).
 *  النظام القديم يكتب السالب بالأقواس في الأرصدة **والمخزون معاً** («[27,749,996.]» للموردين
 *  و«[1.]» لرصيد الأصناف — ١٤٤١ صفاً مقيسة في ملف الأصناف الفعلي) ⇒ الفصل مشترك للنوعين. */
function extractAccountingSign(raw: unknown): { negative: boolean; inner: string } {
  const s = normalizeDigits(String(raw).trim());
  const bracketed = /^\[(.*)\]$/.exec(s) ?? /^\((.*)\)$/.exec(s);
  if (bracketed) return { negative: true, inner: bracketed[1] };
  if (s.startsWith("-")) return { negative: true, inner: s.slice(1) };
  return { negative: false, inner: s };
}

/** تطبيع هاتف عراقي إلى E.164 (المخطط v3 يخزّن +9647…):
 *  «07XXXXXXXXX» (١١ رقماً) → «+9647XXXXXXXXX»، و«009647…»/«9647…» → «+9647…».
 *  ما لا يطابق هذه الأنماط يُمرَّر كما هو (لا رفض) — بدون التطبيع تنقسم قاعدة الهواتف صيغتين
 *  وتفشل مطابقة الموجود مستقبلاً («07…» ≠ «+9647…»). */
export function normalizeIraqPhone(raw: string): string {
  const s = normalizeDigits(String(raw ?? "").trim());
  const digits = s.replace(/[\s-]/g, "");
  if (/^07\d{9}$/.test(digits)) return `+964${digits.slice(1)}`;
  if (/^009647\d{9}$/.test(digits)) return `+${digits.slice(2)}`;
  if (/^9647\d{9}$/.test(digits)) return `+${digits}`;
  return s;
}

// ───────────────────────── قسر القيم ─────────────────────────

export function coerceValue<TRow>(
  field: ImportField<TRow>,
  raw: unknown,
): { value: unknown; error: string | null; warning?: string } {
  const isEmpty = raw == null || String(raw).trim() === "";
  if (isEmpty) {
    return field.required
      ? { value: undefined, error: "حقل مطلوب" }
      : { value: undefined, error: null };
  }

  switch (field.type) {
    case "string": {
      const s = String(raw).trim();
      const v = field.transform ? field.transform(s) : s;
      // إنفاذ حدّ الخادم هنا = خطأ صفّي واضح، بدل رفض zod للدفعة كاملة (BAD_REQUEST بلا رسالة صفّية).
      if (field.maxLen != null && v.length > field.maxLen) {
        return { value: undefined, error: `أطول من المسموح (الحدّ ${field.maxLen} محرفاً)` };
      }
      return { value: v, error: null };
    }

    case "phone": {
      // حدّ الخادم ٢٠ محرفاً (phoneStr.max(20)): ملفات النظام القديم تحشر أحياناً عدّة أرقام في خلية
      // واحدة (قيست حتى ١٢٨ محرفاً في ملف المبيعات) — تمريرها يرفض دفعة tRPC كاملة قبل بلوغ الخدمة.
      const v = normalizeIraqPhone(String(raw));
      const max = field.maxLen ?? 20;
      if (v.length > max) {
        return {
          value: undefined,
          error: `أطول من المسموح (الحدّ ${max} محرفاً) — هاتف واحد فقط في الخلية`,
        };
      }
      return { value: v, error: null };
    }

    case "number": {
      const t = cleanNumericText(raw);
      const n = Number(t);
      if (t === "" || !Number.isFinite(n)) return { value: undefined, error: "قيمة رقمية غير صالحة" };
      return { value: n, error: null };
    }

    case "integer": {
      // المخزون السالب يأتي بالأقواس المربعة أيضاً («[1.]» = ‎-1، كأرصدة الموردين) — تُفصل الإشارة
      // قبل التنظيف كي يسري قصّ السالب صفراً على الصيغتين، وإلا ضاع الصف كاملاً «قيمة رقمية غير صالحة».
      const { negative, inner } = extractAccountingSign(raw);
      const t = cleanNumericText(inner);
      const mag = Number(t);
      if (t === "" || t.startsWith("-") || !Number.isFinite(mag)) {
        return { value: undefined, error: "قيمة رقمية غير صالحة" };
      }
      const n = negative && mag !== 0 ? -mag : mag;
      // السالب يُقصّ صفراً مع تحذير (سياسة منصوصة لا اجتهادية) — قبل فحص الصحيح كي لا يفشل «-4.5» بدل قصّه.
      if (n < 0 && field.clampNegativeToZero) {
        return {
          value: 0,
          error: null,
          warning: field.clampWarning ?? "قيمة سالبة — استُوردت صفراً",
        };
      }
      if (!Number.isInteger(n)) return { value: undefined, error: "يجب أن يكون عدداً صحيحاً" };
      return { value: n, error: null };
    }

    case "money": {
      const t = cleanNumericText(raw);
      if (!/^\d+(\.\d+)?$/.test(t)) {
        return { value: undefined, error: "قيمة مالية غير صالحة (رقم موجب)" };
      }
      return { value: roundMoneyText(t), error: null }; // نصّ — يُمرَّر للخادم كما هو (قاعدة الأموال)
    }

    case "moneySigned": {
      // إشارة السالب تُكتشف قبل التنظيف: «-123.45» أو «[123.45]» (مربعة) أو «(123.45)» (محاسبية).
      const { negative, inner } = extractAccountingSign(raw);
      const t = cleanNumericText(inner);
      // الصيغة العلمية («-2.6E-11» — عَطَب فاصلة عائمة مقيس في ملف الموردين الفعلي) تُقبل
      // وتُطبَّع عبر decimal.js إلى منزلتين — رفضُها كان يُضيع سجلّ المورد كاملاً لا رصيده (≈ صفر).
      if (!/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) {
        return { value: undefined, error: "قيمة مالية غير صالحة (رقم، السالب بـ«-» أو بأقواس [..])" };
      }
      const rounded = roundMoneyText(t);
      const isZero = new Decimal(rounded).isZero();
      return { value: negative && !isZero ? `-${rounded}` : rounded, error: null };
    }

    case "date": {
      const t = normalizeDigits(String(raw).trim());
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
      if (!m) return { value: undefined, error: "تاريخ غير صالح — الصيغة المطلوبة YYYY-MM-DD (مثل 2026-01-15)" };
      const month = Number(m[2]);
      const day = Number(m[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31) {
        return { value: undefined, error: "تاريخ غير صالح — الصيغة المطلوبة YYYY-MM-DD (مثل 2026-01-15)" };
      }
      return { value: t, error: null };
    }

    case "boolean": {
      const s = normalizeDigits(String(raw).trim()).toLowerCase();
      if (["نعم", "true", "1", "yes", "y", "✓"].includes(s)) return { value: true, error: null };
      if (["لا", "false", "0", "no", "n", "✗"].includes(s)) return { value: false, error: null };
      return { value: undefined, error: "قيمة منطقية غير معروفة (نعم/لا)" };
    }

    case "enum": {
      const s = String(raw).trim();
      const mapped = field.enumMap?.[s] ?? field.enumMap?.[normHeader(s)] ?? s;
      if (field.enumValues && !field.enumValues.includes(mapped)) {
        return { value: undefined, error: `قيمة غير مقبولة (المسموح: ${field.enumValues.join("، ")})` };
      }
      return { value: mapped, error: null };
    }

    default:
      return { value: String(raw).trim(), error: null };
  }
}

// ───────────────────────── مطابقة الأعمدة ─────────────────────────

/** مطابقة تلقائية ذكية: ترويسة الملف ⇒ حقل (عبر label/aliases/key) أو null إن لم تُطابِق. */
export function autoMapColumns<TRow>(
  headers: string[],
  fields: ImportField<TRow>[],
): ColumnMapping<TRow> {
  const byNorm = new Map<string, keyof TRow & string>();
  for (const f of fields) {
    byNorm.set(normHeader(f.label), f.key);
    byNorm.set(normHeader(f.key), f.key);
    for (const a of f.aliases ?? []) byNorm.set(normHeader(a), f.key);
  }
  const map: ColumnMapping<TRow> = {};
  for (const h of headers) map[h] = byNorm.get(normHeader(h)) ?? null;
  return map;
}

// ───────────────────────── القراءة والبناء ─────────────────────────

/** يقرأ أوّل ورقة من ملف xlsx/csv ويُرجع الترويسات والصفوف (مع تجاهل الصفوف الفارغة). */
export async function parseSheet(file: File): Promise<ImportParseResult> {
  const buf = await file.arrayBuffer();
  // dateNF إلزامي: بدونه يعيد SheetJS تواريخ CSV بصيغة أميركية «1/7/26» فيرفضها قسر النوع date،
  // بينما تمرّ xlsx (نصوصها المنسّقة محفوظة مسبقاً). يثبت سلوكَه اختبار «تاريخ CSV يبقى ISO».
  const wb = XLSX.read(buf, { type: "array", dateNF: "yyyy-mm-dd" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [], rowNumbers: [], totalRows: 0 };
  const ws = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" });
  if (matrix.length === 0) return { headers: [], rows: [], rowNumbers: [], totalRows: 0 };

  const headers = (matrix[0] as unknown[]).map((h) => String(h ?? "").trim());
  const rows: Record<string, unknown>[] = [];
  const rowNumbers: number[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const arr = (matrix[i] as unknown[]) ?? [];
    if (arr.every((c) => c == null || String(c).trim() === "")) continue; // صف فارغ
    const obj: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      obj[h] = arr[idx];
    });
    rows.push(obj);
    rowNumbers.push(i + 1); // matrix[0] = الترويسة (صفّ ١) ⇒ صفّ البيانات الفعلي = i + 1
  }
  return { headers, rows, rowNumbers, totalRows: rows.length };
}

/** يبني الصفوف المُقسَرة + أخطاء/تحذيرات كل خلية حسب المطابقة وتعريف الحقول. */
export function buildRows<TRow>(
  parse: ImportParseResult,
  mapping: ColumnMapping<TRow>,
  fields: ImportField<TRow>[],
): ParsedRow<TRow>[] {
  const headerForField = new Map<keyof TRow & string, string>();
  for (const [header, fk] of Object.entries(mapping)) {
    if (fk && !headerForField.has(fk)) headerForField.set(fk, header);
  }

  return parse.rows.map((raw, i) => {
    const values: Record<string, unknown> = {};
    const errors: CellError[] = [];
    const warnings: CellError[] = [];

    for (const f of fields) {
      const header = headerForField.get(f.key);
      const rawVal = header != null ? raw[header] : undefined;
      const { value, error, warning } = coerceValue(f, rawVal);
      if (error) errors.push({ field: f.key, message: `${f.label}: ${error}` });
      else if (value !== undefined) values[f.key] = value;
      if (warning) warnings.push({ field: f.key, message: `${f.label}: ${warning}` });
    }

    // تحقّق مخصّص (قد يعتمد على حقول أخرى) — بعد القسر.
    for (const f of fields) {
      if (!f.validate) continue;
      const msg = f.validate(values[f.key], values);
      if (msg) errors.push({ field: f.key, message: `${f.label}: ${msg}` });
    }

    return { rowNumber: parse.rowNumbers[i] ?? i + 1, raw, values: values as Partial<TRow>, errors, warnings };
  });
}

/** أعمدة قالب التنزيل (ترويسة عربية مطابقة للمحلّل + صفّ مثال واحد). */
export function templateColumns<TRow>(
  fields: ImportField<TRow>[],
): { header: string; example: string | number }[] {
  return fields.map((f) => ({
    header: f.required ? `${f.label}*` : f.label,
    example: f.example ?? "",
  }));
}

// ───────────────────────── فحوص الملف الكامل (قبل التقسيم والإرسال) ─────────────────────────
// كشف الخادم يعمل داخل النداء الواحد فقط ويضيع عبر الدفعات ⇒ هذه الفحوص تجري على الملف كاملاً في العميل.

/** مفتاح التكرار الداخلي: legacyCode إن وُجد، وإلا (الهاتف+الاسم)، وإلا الاسم.
 *  الهاتف وحده ليس مفتاح تكرار — الملفات الفعلية فيها هواتف مشتركة مشروعة (عائلة/محل واحد). */
export function duplicateKeyOf(
  values: Record<string, unknown>,
  keys: NonNullable<ImportMeta["duplicateKeys"]>,
): string | null {
  // توحيد حالة الأحرف (legacy/الاسم) يطابق dupKeyOf في الخادم وقيد UNIQUE في MySQL (ترتيب غير حسّاس
  // للحالة) — بدونه يجتاز صفّان لاتينيان متمايزا الحالة فحص العميل ثم تفشل الدفعة في الخادم/القاعدة.
  const legacy = keys.legacy ? String(values[keys.legacy] ?? "").trim().toLowerCase() : "";
  if (legacy) return `L:${legacy}`;
  const name = keys.name ? String(values[keys.name] ?? "").trim().toLowerCase() : "";
  if (!name) return null;
  const phone = keys.phone ? String(values[keys.phone] ?? "").trim() : "";
  return phone ? `PN:${phone}|${name}` : `N:${name}`;
}

/** كشف التكرار الداخلي للملف كاملاً ⇒ خريطة رقم الصف → رسالة (الصف الأول لكل مفتاح يبقى صالحاً). */
export function findFileDuplicates<TRow>(
  rows: ParsedRow<TRow>[],
  keys: NonNullable<ImportMeta["duplicateKeys"]>,
): Map<number, string> {
  const firstSeen = new Map<string, number>();
  const issues = new Map<number, string>();
  for (const r of rows) {
    const key = duplicateKeyOf(r.values as Record<string, unknown>, keys);
    if (!key) continue;
    const first = firstSeen.get(key);
    if (first == null) {
      firstSeen.set(key, r.rowNumber);
      continue;
    }
    // الرسالة تعرض قيمة الملف الفعلية (المفتاح موحَّد الحالة للمقارنة فقط).
    const legacyRaw = keys.legacy
      ? String((r.values as Record<string, unknown>)[keys.legacy] ?? "").trim()
      : "";
    const what = key.startsWith("L:")
      ? `نفس الرقم القديم «${legacyRaw || key.slice(2)}»`
      : key.startsWith("PN:")
        ? "نفس الهاتف والاسم"
        : "نفس الاسم";
    issues.set(r.rowNumber, `مكرّر داخل الملف (${what}) — الصف الأول رقم ${first}`);
  }
  return issues;
}

/** فحص تعارض ملكية sku للملف كاملاً: sku واحد (أو باركوده البديل) تحت منتجَين مختلفَين ⇒ خطأ صفوف واضح قبل الإرسال. */
export function findSkuConflicts<TRow>(
  rows: ParsedRow<TRow>[],
  keys: NonNullable<ImportMeta["skuConflictKeys"]>,
): Map<number, string> {
  const ownersBySku = new Map<string, Set<string>>();
  const skuOf = (values: Record<string, unknown>): string => {
    const sku = String(values[keys.sku] ?? "").trim();
    if (sku) return sku;
    return keys.fallback ? String(values[keys.fallback] ?? "").trim() : "";
  };
  for (const r of rows) {
    const values = r.values as Record<string, unknown>;
    const sku = skuOf(values);
    const owner = String(values[keys.owner] ?? "").trim();
    if (!sku || !owner) continue;
    const owners = ownersBySku.get(sku) ?? new Set<string>();
    owners.add(owner);
    ownersBySku.set(sku, owners);
  }
  const issues = new Map<number, string>();
  for (const r of rows) {
    const values = r.values as Record<string, unknown>;
    const sku = skuOf(values);
    if (!sku) continue;
    const owners = ownersBySku.get(sku);
    if (owners && owners.size > 1) {
      const names = Array.from(owners).slice(0, 2);
      issues.set(
        r.rowNumber,
        `الـSKU «${sku}» مستخدم لمنتجَين مختلفَين («${names[0]}» و«${names[1]}») — وحّد الاسم أو غيّر الـSKU`,
      );
    }
  }
  return issues;
}

/** فحص تكرار الباركود للملف كاملاً (مرآة كشف الخادم batchBarcodes الذي يعمل داخل النداء الواحد فقط):
 *  باركود واحد تحت وحدتَين مختلفتَين (sku أو وحدة) يضيع عبر الدفعات ⇒ دفعات أولى تلتزم ثم تفشل
 *  دفعة لاحقة بـ«باركود مُستخدَم مسبقاً» (استيراد جزئي). يُكشف هنا قبل الإرسال — الصف المكرَّر
 *  حرفياً (نفس sku ونفس الوحدة) لا يُعدّ تعارضاً (الخادم يدمجه بصمت). */
export function findBarcodeConflicts<TRow>(
  rows: ParsedRow<TRow>[],
  keys: NonNullable<ImportMeta["skuConflictKeys"]>,
): Map<number, string> {
  const issues = new Map<number, string>();
  const barcodeKey = keys.barcode ?? keys.fallback;
  if (!barcodeKey) return issues;
  const skuOf = (values: Record<string, unknown>): string => {
    const sku = String(values[keys.sku] ?? "").trim();
    if (sku) return sku;
    return keys.fallback ? String(values[keys.fallback] ?? "").trim() : "";
  };
  // هوية حامل الباركود = (sku، اسم الوحدة) — مطابقة لهوية الوحدة في تجميع الخادم.
  const holderOf = (values: Record<string, unknown>): string => {
    const unit = keys.unit ? String(values[keys.unit] ?? "").trim() : "";
    return `${skuOf(values)} ${unit}`;
  };
  const holdersByBarcode = new Map<string, Set<string>>();
  for (const r of rows) {
    const values = r.values as Record<string, unknown>;
    const barcode = String(values[barcodeKey] ?? "").trim();
    if (!barcode || !skuOf(values)) continue;
    const holders = holdersByBarcode.get(barcode) ?? new Set<string>();
    holders.add(holderOf(values));
    holdersByBarcode.set(barcode, holders);
  }
  for (const r of rows) {
    const values = r.values as Record<string, unknown>;
    const barcode = String(values[barcodeKey] ?? "").trim();
    if (!barcode) continue;
    const holders = holdersByBarcode.get(barcode);
    if (holders && holders.size > 1) {
      issues.set(r.rowNumber, `الباركود «${barcode}» مكرّر داخل الملف`);
    }
  }
  return issues;
}

// ───────────────────────── تقسيم الدفعات ودمج الملخّصات ─────────────────────────

/** يقسّم الصفوف إلى دفعات ≤ batchSize دون فصم مجموعة (groupKeyOf) عبر دفعتين.
 *  مجموعة واحدة أكبر من الحدّ تُرسَل دفعةً وحدها (حدّ الخادم أعلى عمداً كهامش). */
export function splitIntoBatches<T>(
  rows: T[],
  batchSize: number,
  groupKeyOf?: (row: T) => string,
): T[][] {
  if (rows.length === 0) return [];
  // اجمع المجموعات بترتيب أوّل ظهور (بلا مفتاح: كل صفّ مجموعة مستقلة).
  const groups: T[][] = [];
  const groupIndex = new Map<string, number>();
  for (const r of rows) {
    const key = groupKeyOf ? groupKeyOf(r) : "";
    if (groupKeyOf && key) {
      const idx = groupIndex.get(key);
      if (idx != null) {
        groups[idx].push(r);
        continue;
      }
      groupIndex.set(key, groups.length);
    }
    groups.push([r]);
  }
  const batches: T[][] = [];
  let current: T[] = [];
  for (const g of groups) {
    if (current.length > 0 && current.length + g.length > batchSize) {
      batches.push(current);
      current = [];
    }
    current.push(...g);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** يدمج ملخّصات دفعات متتابعة في ملخّص واحد.
 *  committed: الخادم يعيد committed=false لكل دفعة لم تكتب شيئاً — بما فيها دفعة كل صفوفها
 *  «متجاوَز» مشروعاً (إعادة استيراد ملف مستورَد). هذه ليست فشلاً: تُعدّ سليمة ما دامت بلا صفوف
 *  فاشلة — وإلا عُدَّت إعادةُ التشغيل الآمنة الموثَّقة «دفعةً فاشلة» برسائل حمراء كاذبة. */
export function mergeSummaries(parts: ImportSummary[]): ImportSummary {
  return {
    total: parts.reduce((a, p) => a + p.total, 0),
    created: parts.reduce((a, p) => a + p.created, 0),
    updated: parts.reduce((a, p) => a + p.updated, 0),
    skipped: parts.reduce((a, p) => a + p.skipped, 0),
    failed: parts.reduce((a, p) => a + p.failed, 0),
    committed:
      parts.length > 0 &&
      parts.every((p) => p.committed || (p.failed === 0 && p.created + p.updated === 0)),
    rows: parts.flatMap((p) => p.rows),
  };
}
