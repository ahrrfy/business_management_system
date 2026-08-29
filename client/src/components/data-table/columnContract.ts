import type { Column, ColumnDef } from "@tanstack/react-table";

export type TableColumnKind = "text" | "number" | "money" | "date" | "datetime" | "code" | "phone" | "status" | "actor" | "actions";
export type TableColumnAlign = "start" | "center" | "end";
export type TableColumnWidth = "id" | "date" | "money" | "status" | "actor" | "actions" | "wide";

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData, TValue> {
    kind?: TableColumnKind;
    align?: TableColumnAlign;
    width?: TableColumnWidth;
    wrap?: boolean;
  }
}

const KIND_ALIGN: Partial<Record<TableColumnKind, TableColumnAlign>> = {
  number: "end",
  money: "end",
  date: "center",
  datetime: "center",
  status: "center",
  actions: "center",
};

const KIND_WIDTH: Partial<Record<TableColumnKind, TableColumnWidth>> = {
  money: "money",
  date: "date",
  datetime: "date",
  status: "status",
  actor: "actor",
  actions: "actions",
};

const ALIGN_CLASS: Record<TableColumnAlign, string> = {
  start: "text-start",
  center: "text-center",
  end: "text-end",
};

const WIDTH_CLASS: Record<TableColumnWidth, string> = {
  id: "w-20 min-w-20",
  date: "w-36 min-w-36",
  money: "w-32 min-w-32",
  status: "w-32 min-w-32",
  actor: "w-40 min-w-40",
  actions: "w-28 min-w-28",
  wide: "min-w-64",
};

export type ResolvedColumnPresentation = {
  kind: TableColumnKind;
  align: TableColumnAlign;
  width?: TableColumnWidth;
  wrap: boolean;
};

/** يستنتج العرض من meta؛ الافتراضي نص RTL عند البداية، بلا تخمين من اسم الحقل. */
export function resolveColumnPresentation<T>(column: Column<T, unknown>): ResolvedColumnPresentation {
  const meta = column.columnDef.meta;
  const kind = meta?.kind ?? "text";
  return {
    kind,
    align: meta?.align ?? KIND_ALIGN[kind] ?? "start",
    width: meta?.width ?? KIND_WIDTH[kind],
    wrap: meta?.wrap ?? false,
  };
}

export function columnPresentationClass<T>(column: Column<T, unknown>): string {
  const presentation = resolveColumnPresentation(column);
  return [
    ALIGN_CLASS[presentation.align],
    presentation.width ? WIDTH_CLASS[presentation.width] : "",
    presentation.wrap ? "whitespace-normal [overflow-wrap:anywhere]" : "whitespace-nowrap",
    presentation.kind === "number" || presentation.kind === "money" ? "tabular-nums" : "",
    presentation.kind === "code" ? "font-mono" : "",
  ].filter(Boolean).join(" ");
}

export function columnUsesLtrIsolate<T>(column: Column<T, unknown>): boolean {
  const { kind } = resolveColumnPresentation(column);
  return kind === "number" || kind === "money" || kind === "date" || kind === "datetime" || kind === "code" || kind === "phone";
}

export function withColumnPresentation<T>(
  column: ColumnDef<T, unknown>,
  meta: NonNullable<ColumnDef<T, unknown>["meta"]>,
): ColumnDef<T, unknown> {
  return { ...column, meta: { ...column.meta, ...meta } };
}
