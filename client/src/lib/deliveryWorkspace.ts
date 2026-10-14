import Decimal from "decimal.js";

/** Fetch every server page only for an explicit export; fail closed on a broken cursor. */
export async function fetchAllDeliveryPages<T>(
  fetchPage: (
    cursor?: number,
  ) => Promise<{ rows: T[]; hasMore: boolean; nextCursor: number | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<number>();
  let cursor: number | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    rows.push(...page.rows);
    if (!page.hasMore) return rows;
    if (
      page.nextCursor == null ||
      seen.has(page.nextCursor) ||
      !page.rows.length
    ) {
      throw new Error(
        "تعذر استكمال الصفحات. أعد تحميل القائمة ثم أعد التصدير؛ لم يُحفظ تقرير ناقص.",
      );
    }
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export function requireDeliverySelection<T>(
  rows: T[],
  selectedIds: Set<number>,
  id: (row: T) => number,
): T[] {
  const selected = rows.filter((row) => selectedIds.has(id(row)));
  if (selected.length !== selectedIds.size)
    throw new Error(
      "تغيرت بعض الصفوف المحددة ولم تعد تطابق الفلاتر. لم يُصدر التقرير؛ امسح التحديد وأعد تحديد الصفوف الحالية.",
    );
  return selected;
}

export const DELIVERY_WORKSPACE_STATES = [
  { value: "ALL", label: "كل الحالات" },
  { value: "IN_TRANSIT", label: "بالطريق" },
  { value: "DELIVERED_UNCOLLECTED", label: "سلم ولم يحصل" },
  { value: "COLLECTED_UNREMITTED", label: "قبض ولم يورد" },
  { value: "RETURN_PENDING", label: "بانتظار المرتجع" },
  { value: "CLOSED", label: "مغلقة" },
] as const;

export function buildDeliveryCsv(
  rows: Record<string, string>[],
  columns: Array<{
    key: string;
    header: string;
    text?: boolean;
    map?: (row: Record<string, string>) => string | number | null | undefined;
  }>,
  meta: string[][],
): string {
  const cell = (value: string, text = false) => {
    const trimmed = value.trimStart();
    const numericText = text && /^[+\-\d]/.test(trimmed);
    const formula =
      /^[=+@\t\r]/.test(trimmed) ||
      (trimmed.startsWith("-") && !/^-\d+(\.\d+)?$/.test(trimmed));
    return `"${(numericText || formula ? "'" + value : value).replace(/"/g, '""')}"`;
  };
  return (
    "\ufeff" +
    [
      ...meta.map((row) => row.map((value) => cell(value)).join(",")),
      "",
      columns.map((column) => cell(column.header)).join(","),
      ...rows.map((row) =>
        columns
          .map((column) =>
            cell(
              String(
                column.map ? (column.map(row) ?? "") : (row[column.key] ?? ""),
              ),
              column.text,
            ),
          )
          .join(","),
      ),
    ].join("\r\n")
  );
}

export type DeliveryStatementEntry = {
  id: number;
  type: string;
  amount: string;
  entryDate: string | Date;
  invoiceNumber?: string | null;
  notes?: string | null;
};

/** Period statements start at the server opening balance. Fee disclosures never move custody. */
export function buildDeliveryStatement(
  entries: DeliveryStatementEntry[],
  openingBalance: string = "0.00",
) {
  let balance = new Decimal(openingBalance);
  const rows = entries.map((entry) => {
    const amount = new Decimal(entry.amount);
    const ref =
      entry.invoiceNumber ??
      (entry.notes ?? "").match(/[A-Z]{2,6}-[A-Za-z0-9-]+/)?.[0] ??
      "—";
    let debit: string | null = null;
    let credit: string | null = null;
    let description = entry.notes ?? entry.type;
    let info = false;
    if (entry.type === "DELIVERY_DISPATCH") {
      balance = balance.plus(amount);
      debit = amount.toFixed(2);
      description = "إرسالية (عهدة COD)";
    } else if (
      entry.type === "DELIVERY_REMIT" ||
      entry.type === "DELIVERY_WRITEOFF"
    ) {
      balance = balance.minus(amount);
      debit = amount.isNegative() ? amount.neg().toFixed(2) : null;
      credit = amount.isNegative() ? null : amount.toFixed(2);
      description =
        entry.type === "DELIVERY_REMIT"
          ? "توريد / تسوية"
          : amount.isNegative()
            ? "عكس شطب (استرداد نقدي)"
            : "شطب عجز";
    } else {
      info = true;
      credit = amount.abs().toFixed(2);
      description =
        entry.type === "DELIVERY_FEE"
          ? "أجرة على المكتبة (إفصاح)"
          : amount.gte(0)
            ? "أمانة أجرة مقبوضة (إفصاح)"
            : "أمانة أجرة مصروفة / مردودة (إفصاح)";
    }
    return {
      id: entry.id,
      entryDate: entry.entryDate,
      ref,
      description,
      debit,
      credit,
      balance: info ? null : balance.toFixed(2),
      carry: balance.toFixed(2),
      info,
    };
  });
  return { rows, closingBalance: balance.toFixed(2) };
}

export function deliveryTotals<T>(
  rows: T[],
  fields: Array<keyof T>,
): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => [
      field,
      rows
        .reduce(
          (sum, row) => sum.plus(String(row[field] ?? "0")),
          new Decimal(0),
        )
        .toFixed(2),
    ]),
  );
}

export function deliveryStatementReport(statement: {
  entries: DeliveryStatementEntry[];
  openingBalance: string;
  closingBalance: string;
  debitTotal: string;
  creditTotal: string;
}) {
  return {
    ...buildDeliveryStatement(statement.entries, statement.openingBalance),
    totals: {
      "افتتاح الفترة": statement.openingBalance,
      "مدين الفترة": statement.debitTotal,
      "دائن الفترة": statement.creditTotal,
      "ختام الفترة": statement.closingBalance,
    },
  };
}

/** Repeated metadata also survives CSV, whose generic writer has no header metadata block. */
export function withDeliveryExportScope<T>(
  rows: T[],
  scope: { company: string; branch: string; filters: string; scope: string },
  totals: Record<string, string>,
) {
  const exportedAt = new Date().toISOString();
  return rows.map((row) => ({
    ...row,
    exportCompany: scope.company,
    exportBranch: scope.branch,
    exportFilters: scope.filters,
    exportScope: scope.scope,
    exportTime: exportedAt,
    exportCount: String(rows.length),
    exportTotals: Object.entries(totals)
      .map(([key, value]) => `${key}: ${value}`)
      .join(" | "),
  }));
}
