import {
  autoMapColumns,
  buildRows,
  coerceValue,
  parseSheet,
  type ImportField,
} from "@/lib/import";

export type StatutoryAccountImportRow = {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  parentCode?: string | null;
  isPosting?: boolean;
  sortOrder?: number;
  notes?: string | null;
};

export const MAX_STATUTORY_IMPORT_BYTES = 10 * 1024 * 1024;

const TYPE_MAP: Record<string, StatutoryAccountImportRow["type"]> = {
  asset: "ASSET",
  assets: "ASSET",
  "أصل": "ASSET",
  "أصول": "ASSET",
  liability: "LIABILITY",
  liabilities: "LIABILITY",
  "التزام": "LIABILITY",
  "التزامات": "LIABILITY",
  equity: "EQUITY",
  "حقوق الملكية": "EQUITY",
  "ملكية": "EQUITY",
  revenue: "REVENUE",
  revenues: "REVENUE",
  income: "REVENUE",
  "إيراد": "REVENUE",
  "إيرادات": "REVENUE",
  expense: "EXPENSE",
  expenses: "EXPENSE",
  "مصروف": "EXPENSE",
  "مصروفات": "EXPENSE",
};

const BALANCE_MAP: Record<string, StatutoryAccountImportRow["normalBalance"]> = {
  debit: "DEBIT",
  dr: "DEBIT",
  "مدين": "DEBIT",
  credit: "CREDIT",
  cr: "CREDIT",
  "دائن": "CREDIT",
};

export const STATUTORY_ACCOUNT_FIELDS: ImportField<StatutoryAccountImportRow>[] = [
  {
    key: "code",
    label: "رمز الحساب*",
    type: "string",
    required: true,
    maxLen: 30,
    aliases: ["الرمز", "رمز الحساب", "account code", "code"],
  },
  {
    key: "name",
    label: "اسم الحساب*",
    type: "string",
    required: true,
    maxLen: 160,
    aliases: ["الحساب", "اسم الحساب", "account name", "name"],
  },
  {
    key: "type",
    label: "نوع الحساب*",
    type: "enum",
    required: true,
    enumValues: ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"],
    enumMap: TYPE_MAP,
    aliases: ["النوع", "نوع الحساب", "account type", "type"],
  },
  {
    key: "normalBalance",
    label: "طبيعة الرصيد*",
    type: "enum",
    required: true,
    enumValues: ["DEBIT", "CREDIT"],
    enumMap: BALANCE_MAP,
    aliases: ["الطبيعة", "طبيعة الرصيد", "normal balance", "normalBalance"],
  },
  {
    key: "parentCode",
    label: "رمز الحساب الأب",
    type: "string",
    maxLen: 30,
    aliases: ["الحساب الأب", "رمز الأب", "parent code", "parentCode"],
  },
  {
    key: "isPosting",
    label: "حساب ترحيل",
    type: "boolean",
    aliases: ["ترحيل", "حساب ترحيل", "posting", "isPosting"],
  },
  {
    key: "sortOrder",
    label: "الترتيب",
    type: "integer",
    rejectNegative: true,
    aliases: ["ترتيب", "sort order", "sortOrder"],
  },
  {
    key: "notes",
    label: "ملاحظات",
    type: "string",
    maxLen: 500,
    aliases: ["الملاحظات", "notes"],
  },
];

function asRecord(value: unknown, rowNumber: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`الصف ${rowNumber}: يجب أن يكون كائناً.`);
  }
  return value as Record<string, unknown>;
}

function validateStructure(rows: readonly StatutoryAccountImportRow[]): void {
  if (rows.length === 0) throw new Error("الملف لا يحتوي حسابات.");
  if (rows.length > 1500) throw new Error("الحد الأعلى 1500 حساب في الإصدار الواحد.");
  const byCode = new Map<string, StatutoryAccountImportRow>();
  for (const row of rows) {
    if (byCode.has(row.code)) throw new Error(`رمز الحساب مكرر: ${row.code}.`);
    byCode.set(row.code, row);
  }
  for (const row of rows) {
    if (!row.parentCode) continue;
    const parent = byCode.get(row.parentCode);
    if (!parent || row.parentCode === row.code) {
      throw new Error(`الحساب ${row.code} يشير إلى أب غير صالح (${row.parentCode}).`);
    }
    if (parent.type !== row.type) {
      throw new Error(`نوع الحساب ${row.code} لا يطابق نوع أبيه ${row.parentCode}.`);
    }
    const visited = new Set([row.code]);
    let cursor: StatutoryAccountImportRow | undefined = row;
    while (cursor?.parentCode) {
      if (visited.has(cursor.parentCode)) {
        throw new Error(`دورة أبوّة مكتشفة عند الحساب ${row.code}.`);
      }
      visited.add(cursor.parentCode);
      cursor = byCode.get(cursor.parentCode);
    }
  }
}

/** يطبّع JSON ذي المفاتيح القياسية ويطبّق نفس قسر ملف Excel قبل إرساله للخادم. */
export function normalizeStatutoryAccountRows(rawRows: readonly unknown[]): StatutoryAccountImportRow[] {
  const rows = rawRows.map((raw, index) => {
    const source = asRecord(raw, index + 1);
    const values: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const field of STATUTORY_ACCOUNT_FIELDS) {
      const result = coerceValue(field, source[field.key]);
      if (result.error) errors.push(`${field.label}: ${result.error}`);
      else if (result.value !== undefined) values[field.key] = result.value;
    }
    if (errors.length) throw new Error(`الصف ${index + 1}: ${errors.join("؛ ")}`);
    return {
      code: String(values.code),
      name: String(values.name),
      type: values.type as StatutoryAccountImportRow["type"],
      normalBalance: values.normalBalance as StatutoryAccountImportRow["normalBalance"],
      parentCode: values.parentCode ? String(values.parentCode) : null,
      isPosting: values.isPosting == null ? true : Boolean(values.isPosting),
      sortOrder: values.sortOrder == null ? index : Number(values.sortOrder),
      notes: values.notes ? String(values.notes) : null,
    };
  });
  validateStructure(rows);
  return rows;
}

export async function parseStatutoryAccountsFile(file: File): Promise<StatutoryAccountImportRow[]> {
  if (file.size > MAX_STATUTORY_IMPORT_BYTES) {
    throw new Error("حجم الملف يتجاوز الحد الأعلى المسموح (10 ميغابايت).");
  }
  if (/\.json$/i.test(file.name)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      throw new Error("ملف JSON غير صالح؛ راجع البنية والفواصل والأقواس.");
    }
    if (!Array.isArray(parsed)) throw new Error("ملف JSON يجب أن يحتوي مصفوفة حسابات.");
    return normalizeStatutoryAccountRows(parsed);
  }
  if (!/\.(xlsx|csv)$/i.test(file.name)) {
    throw new Error("الصيغة غير مدعومة. اختر XLSX أو CSV أو JSON.");
  }
  const parsed = await parseSheet(file);
  const mapping = autoMapColumns(parsed.headers, STATUTORY_ACCOUNT_FIELDS);
  const required = STATUTORY_ACCOUNT_FIELDS.filter((field) => field.required);
  const mapped = new Set(Object.values(mapping));
  const missing = required.filter((field) => !mapped.has(field.key));
  if (missing.length) {
    throw new Error(`أعمدة مطلوبة غير موجودة: ${missing.map((field) => field.label).join("، ")}.`);
  }
  const built = buildRows(parsed, mapping, STATUTORY_ACCOUNT_FIELDS);
  const invalid = built.filter((row) => row.errors.length > 0);
  if (invalid.length) {
    const sample = invalid
      .slice(0, 5)
      .map((row) => `صف ${row.rowNumber}: ${row.errors.map((error) => error.message).join("؛ ")}`)
      .join(" | ");
    throw new Error(`${invalid.length} صف غير صالح. ${sample}`);
  }
  return normalizeStatutoryAccountRows(built.map((row) => row.values));
}

function normalizedName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[^a-zA-Z0-9\u0600-\u06FF]+/g, "")
    .toLowerCase();
}

type MappingRow = {
  internalAccountId: number;
  internalCode: string;
  internalName: string;
  internalType: string;
  statutoryAccountId: number | null;
};

type StatutoryChoice = {
  id: number;
  code: string;
  name: string;
  type: string;
  isPosting: boolean;
};

/** اقتراح محافظ: رمز مطابق أو اسم فريد مطابق ضمن النوع؛ لا يحفظ ولا يعتمد تلقائياً. */
export function suggestStatutoryMappings(
  mappings: readonly MappingRow[],
  accounts: readonly StatutoryChoice[],
): Record<number, number> {
  const uniqueCode = new Map<string, number | null>();
  const uniqueName = new Map<string, number | null>();
  const indexUnique = (index: Map<string, number | null>, key: string, id: number) => {
    if (!index.has(key)) index.set(key, id);
    else index.set(key, null);
  };
  for (const account of accounts) {
    if (!account.isPosting) continue;
    indexUnique(uniqueCode, `${account.type}\0${account.code.trim()}`, account.id);
    indexUnique(uniqueName, `${account.type}\0${normalizedName(account.name)}`, account.id);
  }

  const result: Record<number, number> = {};
  for (const row of mappings) {
    if (row.statutoryAccountId) continue;
    const codeMatch = uniqueCode.get(`${row.internalType}\0${row.internalCode.trim()}`);
    if (codeMatch != null) {
      result[row.internalAccountId] = codeMatch;
      continue;
    }
    const nameMatch = uniqueName.get(`${row.internalType}\0${normalizedName(row.internalName)}`);
    if (nameMatch != null) result[row.internalAccountId] = nameMatch;
  }
  return result;
}
