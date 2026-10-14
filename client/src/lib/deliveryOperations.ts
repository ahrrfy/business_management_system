import {
  matchesDeliverySearch,
  scoreDeliverySearch,
  type DeliverySearchTarget,
} from "@shared/deliverySearch";
import { digitsArabicToLatin } from "@shared/numberNormalize";
import { D } from "@/lib/money";
import {
  statementQueueRemaining,
  type CompanyStatementQueueCandidate,
} from "@/components/delivery/companyStatementQueue";

export interface OperationalSearchRow {
  id?: number;
  invoiceId?: number | null;
  customerName?: string | null;
  recipientName?: string | null;
  title?: string | null;
  partyName?: string | null;
  driverName?: string | null;
  customerPhone?: string | null;
  recipientPhone?: string | null;
  deliveryPhone?: string | null;
  address?: string | null;
  deliveryAddress?: string | null;
  returnDeclaredReason?: string | null;
  orderNumber?: string | null;
  invoiceNumber?: string | null;
  consignmentNumber?: string | null;
  externalTrackingRef?: string | null;
}

export function operationalSearchTarget(
  row: OperationalSearchRow,
): DeliverySearchTarget {
  return {
    names: [
      row.customerName,
      row.recipientName,
      row.title,
      row.partyName,
      row.driverName,
    ],
    phones: [row.customerPhone, row.recipientPhone, row.deliveryPhone],
    addresses: [row.address, row.deliveryAddress, row.returnDeclaredReason],
    references: [
      row.orderNumber,
      row.invoiceNumber,
      row.consignmentNumber,
      row.externalTrackingRef,
      row.id,
      row.invoiceId,
    ],
  };
}

export function filterOperationalRows<T extends OperationalSearchRow>(
  rows: readonly T[],
  query: string,
): T[] {
  return rows
    .filter((row) => matchesDeliverySearch(operationalSearchTarget(row), query))
    .sort(
      (a, b) =>
        scoreDeliverySearch(operationalSearchTarget(b), query) -
        scoreDeliverySearch(operationalSearchTarget(a), query),
    );
}

/** Change only displayed IDs; hidden selections and manually entered amounts survive. */
export function mergeDisplayedSelection<T>(
  current: Readonly<Record<number, T>>,
  displayed: readonly { id: number }[],
  value: (id: number) => NoInfer<T>,
) {
  const next = { ...current };
  for (const row of displayed) next[row.id] = value(row.id);
  return next;
}

export function manifestCanPrint(state: {
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  hasNextPage: boolean;
  requestedIds?: readonly number[];
  availableIds: readonly number[];
}) {
  return (
    !state.isLoading &&
    !state.isFetching &&
    !state.isError &&
    !state.hasNextPage &&
    state.availableIds.length > 0 &&
    (!state.requestedIds ||
      (state.requestedIds.length > 0 &&
        state.requestedIds.every((id) => state.availableIds.includes(id))))
  );
}

export type StatementImportSource = {
  consignmentId?: unknown;
  externalTrackingRef?: unknown;
  collectedAmount?: unknown;
  partyId?: unknown;
};

/** This financial-preview reader rejects malformed/ragged files instead of dropping cells. */
export async function readStatementImportFile(file: File) {
  const buffer = await file.arrayBuffer();
  let matrix: unknown[][];
  if (/\.csv$/i.test(file.name)) {
    const { default: Papa } = await import("papaparse");
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(buffer)
      .replace(/^\uFEFF/, "");
    const header = text.split(/\r?\n/, 1)[0];
    const delimiter = header.includes("\t")
      ? "\t"
      : header.includes(",")
        ? ","
        : ";";
    const parsed = Papa.parse<string[]>(text, {
      header: false,
      skipEmptyLines: false,
      delimiter,
    });
    if (parsed.errors.length)
      throw new Error("ملف CSV غير سليم؛ راجع علامات الاقتباس والفواصل");
    matrix = parsed.data;
  } else if (/\.xlsx$/i.test(file.name)) {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount > 2001)
      throw new Error("يلزم ملف من 1 إلى 2000 سطر بيانات في الورقة الأولى");
    matrix = [];
    sheet.eachRow({ includeEmpty: true }, (row, index) => {
      matrix[index - 1] = (row.values as unknown[]).slice(1);
    });
    if (
      matrix.some((row) =>
        row.some((cell) => cell != null && typeof cell === "object"),
      )
    )
      throw new Error(
        "استخدم قيماً نصية ورقمية ثابتة؛ المعادلات والروابط والخلايا المركبة غير مقبولة",
      );
  } else throw new Error("الصيغة المقبولة CSV أو XLSX");
  const first = matrix[0] ?? [];
  if (first.some((header) => typeof header !== "string" || !header.trim()))
    throw new Error("ترويسات الأعمدة يجب أن تكون نصوصاً غير فارغة");
  const headers = first.map((header) => String(header).trim());
  if (new Set(headers).size !== headers.length)
    throw new Error("ترويسات الأعمدة مكررة");
  if (
    !headers.includes("collectedAmount") ||
    (!headers.includes("consignmentId") &&
      !headers.includes("externalTrackingRef"))
  )
    throw new Error(
      "يلزم عمود collectedAmount مع consignmentId أو externalTrackingRef",
    );
  const rows: StatementImportSource[] = [],
    rowNumbers: number[] = [];
  for (let index = 1; index < matrix.length; index++) {
    const cells = matrix[index] ?? [];
    if (cells.every((cell) => cell == null || String(cell).trim() === ""))
      continue;
    if (
      /\.csv$/i.test(file.name)
        ? cells.length !== headers.length
        : cells.length > headers.length
    )
      throw new Error(`عدد الخلايا لا يطابق الترويسات في السطر ${index + 1}`);
    rows.push(
      Object.fromEntries(
        headers.map((header, column) => [header, cells[column] ?? ""]),
      ),
    );
    rowNumbers.push(index + 1);
  }
  if (!rows.length || rows.length > 2000)
    throw new Error("يجب أن يحتوي الملف من 1 إلى 2000 سطر بيانات");
  return { rows, rowNumbers };
}
export type StatementImportVerdict =
  | "READY"
  | "INVALID_AMOUNT"
  | "INVALID_REFERENCE"
  | "EXCESS_AMOUNT"
  | "INVALID_ID"
  | "UNMATCHED"
  | "AMBIGUOUS"
  | "WRONG_PARTY"
  | "IDENTIFIER_CONFLICT"
  | "DUPLICATE"
  | "ALREADY_SELECTED";
export const STATEMENT_IMPORT_REASON: Record<StatementImportVerdict, string> = {
  READY: "جاهز للإضافة",
  INVALID_AMOUNT: "مبلغ غير صالح: قيمة غير سالبة بمنزلتين كحد أقصى",
  INVALID_REFERENCE: "رقم البوليصة يجب أن يكون نصاً محفوظاً دون تحويل رقمي",
  INVALID_ID: "معرّف الإرسالية غير صالح",
  UNMATCHED: "لا إرسالية مفتوحة مطابقة للشركة المختارة",
  AMBIGUOUS: "رقم التتبع يطابق أكثر من إرسالية",
  WRONG_PARTY: "السطر يخص جهة أخرى",
  IDENTIFIER_CONFLICT: "معرّف الإرسالية ورقم التتبع لا يتطابقان",
  DUPLICATE: "إرسالية مكررة داخل الملف",
  ALREADY_SELECTED: "الإرسالية محددة مسبقاً؛ المبلغ الحالي محفوظ",
  EXCESS_AMOUNT: "المبلغ يتجاوز المتبقي على الإرسالية",
};
const cellText = (value: unknown) =>
  digitsArabicToLatin(String(value ?? "")).trim();
const validId = (value: string) =>
  /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));

/** Exact identities only. Search scores and fuzzy/barcode-zero matching never authorize an import. */
export function previewStatementImport(
  sources: readonly StatementImportSource[],
  candidates: readonly CompanyStatementQueueCandidate[],
  partyId: number,
  selectedIds: ReadonlySet<number>,
) {
  const preview = sources.map((source, index) => {
    const rawId = cellText(source.consignmentId);
    const tracking = cellText(source.externalTrackingRef);
    const rawAmount = cellText(source.collectedAmount).replace(/٫/g, ".");
    let verdict: StatementImportVerdict = "READY";
    const matches = rawId
      ? candidates.filter((c) => String(c.id) === rawId)
      : candidates.filter(
          (c) => tracking && cellText(c.externalTrackingRef) === tracking,
        );
    const candidate = matches.length === 1 ? matches[0] : undefined;
    if (
      cellText(source.partyId) &&
      cellText(source.partyId) !== String(partyId)
    )
      verdict = "WRONG_PARTY";
    else if (rawId && !validId(rawId)) verdict = "INVALID_ID";
    else if (
      source.externalTrackingRef != null &&
      typeof source.externalTrackingRef !== "string"
    )
      verdict = "INVALID_REFERENCE";
    else if (
      !/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(rawAmount) ||
      D(rawAmount || "0").gt("9999999999999.99")
    )
      verdict = "INVALID_AMOUNT";
    else if (matches.length > 1) verdict = "AMBIGUOUS";
    else if (!candidate) verdict = "UNMATCHED";
    else if (
      rawId &&
      tracking &&
      cellText(candidate.externalTrackingRef) !== tracking
    )
      verdict = "IDENTIFIER_CONFLICT";
    else if (selectedIds.has(candidate.id)) verdict = "ALREADY_SELECTED";
    else if (D(rawAmount).gt(statementQueueRemaining(candidate)))
      verdict = "EXCESS_AMOUNT";
    return {
      rowNumber: index + 2,
      reference: rawId || tracking,
      candidate,
      collectedAmount: verdict === "READY" ? D(rawAmount).toFixed(2) : null,
      sourceCollectedAmount: rawAmount,
      verdict,
    };
  });
  const counts = new Map<number, number>();
  for (const row of preview)
    if (row.candidate)
      counts.set(row.candidate.id, (counts.get(row.candidate.id) ?? 0) + 1);
  return preview.map((row) =>
    row.verdict === "READY" &&
    row.candidate &&
    (counts.get(row.candidate.id) ?? 0) > 1
      ? { ...row, verdict: "DUPLICATE" as const, collectedAmount: null }
      : row,
  );
}
