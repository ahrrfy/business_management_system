// محرّك الاستيراد (نقي، قابل للاختبار): قراءة xlsx/csv، مطابقة أعمدة ذكية، قسر أنواع + تطبيع الأرقام العربية.
// التحليل يجري في الواجهة؛ الصفوف المُقسَرة تُرسَل JSON للخادم الذي يعيد التحقّق ويكتب ذرّياً.
import * as XLSX from "xlsx";

export type ImportFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "phone"
  | "money";

export type ImportField<TRow> = {
  key: keyof TRow & string;
  label: string; // عربي — للقالب وللمطابقة
  type: ImportFieldType;
  required?: boolean;
  aliases?: string[]; // ترويسات بديلة (عربي/إنجليزي)
  enumValues?: string[]; // القيم القانونية للنوع enum
  enumMap?: Record<string, string>; // مرادفات → قيمة قانونية ("جملة" → "WHOLESALE")
  validate?: (value: unknown, row: Record<string, unknown>) => string | null;
  example?: string | number;
};

export type CellError = { field: string; message: string };

export type ParsedRow<TRow> = {
  rowNumber: number; // 1-based: يطابق صفّ الإكسل بعد الترويسة
  raw: Record<string, unknown>;
  values: Partial<TRow>;
  errors: CellError[];
};

export type ImportParseResult = {
  headers: string[];
  rows: Record<string, unknown>[];
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

export type ImportHandler<TRow> = (
  rows: ImportRow<TRow>[],
  ctx: { onProgress?: (done: number, total: number) => void },
) => Promise<ImportSummary>;

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

/** نصّ رقمي منظَّف: أرقام ASCII، بلا فواصل آلاف (، ٬)، فاصلة عشرية عربية ٫ → نقطة. */
function cleanNumericText(raw: unknown): string {
  return normalizeDigits(String(raw ?? "").trim())
    .replace(/[٬,\s]/g, "") // فواصل الآلاف والمسافات
    .replace(/[٫]/g, "."); // الفاصلة العشرية العربية
}

/** تطبيع ترويسة للمطابقة: حذف BOM/التطويل/التشكيل/علامة المطلوب، وتوحيد المسافات والحالة. */
export function normHeader(s: string): string {
  return String(s ?? "")
    .replace(/^﻿/, "")
    .replace(/[ـ]/g, "") // تطويل
    .replace(/[ً-ْ]/g, "") // تشكيل
    .replace(/\*+$/, "") // علامة الحقل المطلوب في القالب
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ───────────────────────── قسر القيم ─────────────────────────

export function coerceValue<TRow>(
  field: ImportField<TRow>,
  raw: unknown,
): { value: unknown; error: string | null } {
  const isEmpty = raw == null || String(raw).trim() === "";
  if (isEmpty) {
    return field.required
      ? { value: undefined, error: "حقل مطلوب" }
      : { value: undefined, error: null };
  }

  switch (field.type) {
    case "string":
      return { value: String(raw).trim(), error: null };

    case "phone":
      return { value: normalizeDigits(String(raw).trim()), error: null };

    case "number": {
      const t = cleanNumericText(raw);
      const n = Number(t);
      if (t === "" || !Number.isFinite(n)) return { value: undefined, error: "قيمة رقمية غير صالحة" };
      return { value: n, error: null };
    }

    case "integer": {
      const t = cleanNumericText(raw);
      const n = Number(t);
      if (t === "" || !Number.isFinite(n)) return { value: undefined, error: "قيمة رقمية غير صالحة" };
      if (!Number.isInteger(n)) return { value: undefined, error: "يجب أن يكون عدداً صحيحاً" };
      return { value: n, error: null };
    }

    case "money": {
      const t = cleanNumericText(raw);
      if (!/^\d+(\.\d{1,2})?$/.test(t)) {
        return { value: undefined, error: "قيمة مالية غير صالحة (رقم موجب، منزلتان عشريتان كحدّ أقصى)" };
      }
      return { value: t, error: null }; // نصّ — تُمرَّر للخادم كما هي (قاعدة الأموال)
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
  const wb = XLSX.read(buf, { type: "array" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [], totalRows: 0 };
  const ws = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" });
  if (matrix.length === 0) return { headers: [], rows: [], totalRows: 0 };

  const headers = (matrix[0] as unknown[]).map((h) => String(h ?? "").trim());
  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const arr = (matrix[i] as unknown[]) ?? [];
    if (arr.every((c) => c == null || String(c).trim() === "")) continue; // صف فارغ
    const obj: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      obj[h] = arr[idx];
    });
    rows.push(obj);
  }
  return { headers, rows, totalRows: rows.length };
}

/** يبني الصفوف المُقسَرة + أخطاء كل خلية حسب المطابقة وتعريف الحقول. */
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

    for (const f of fields) {
      const header = headerForField.get(f.key);
      const rawVal = header != null ? raw[header] : undefined;
      const { value, error } = coerceValue(f, rawVal);
      if (error) errors.push({ field: f.key, message: `${f.label}: ${error}` });
      else if (value !== undefined) values[f.key] = value;
    }

    // تحقّق مخصّص (قد يعتمد على حقول أخرى) — بعد القسر.
    for (const f of fields) {
      if (!f.validate) continue;
      const msg = f.validate(values[f.key], values);
      if (msg) errors.push({ field: f.key, message: `${f.label}: ${msg}` });
    }

    return { rowNumber: i + 1, raw, values: values as Partial<TRow>, errors };
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
