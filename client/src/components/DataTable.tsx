import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { type ExportColumn, exportRows } from "@/lib/export";
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

type DataTableProps<T extends object> = {
  data: T[];
  columns: ColumnDef<T>[];
  loading?: boolean;
  emptyText?: string;
  filterPlaceholder?: string;
  showFilter?: boolean;
  pageSize?: number;
  exportFilename?: string;
  exportColumns?: ExportColumn<T>[];
};

export function DataTable<T extends object>({
  data,
  columns,
  loading = false,
  emptyText = "لا بيانات.",
  filterPlaceholder = "بحث…",
  showFilter = true,
  pageSize = 50,
  exportFilename,
  exportColumns,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    state: { sorting, globalFilter },
    initialState: { pagination: { pageSize } },
  });

  const canExport = !!(exportFilename && exportColumns && data.length > 0);

  return (
    <div className="space-y-3">
      {(showFilter || canExport) && (
        <div className="flex items-center gap-2">
          {showFilter && (
            <Input
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder={filterPlaceholder}
              className="max-w-xs h-8 text-sm"
            />
          )}
          {canExport && (
            <Button
              variant="outline"
              size="sm"
              className="mr-auto"
              onClick={() =>
                exportRows(data, { filename: exportFilename!, columns: exportColumns! })
              }
            >
              تصدير Excel
            </Button>
          )}
        </div>
      )}

      <ScrollTableShell>
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="text-right">
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    className="p-2 font-medium whitespace-nowrap"
                    onClick={header.column.getToggleSortingHandler()}
                    style={{ cursor: header.column.getCanSort() ? "pointer" : "default" }}
                  >
                    <span className="inline-flex items-center gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === "asc"
                        ? <ChevronUp aria-hidden className="size-3.5" />
                        : header.column.getIsSorted() === "desc"
                          ? <ChevronDown aria-hidden className="size-3.5" />
                          : null}
                    </span>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length} className="p-6 text-center text-muted-foreground">
                  جارٍ التحميل…
                </td>
              </tr>
            ) : table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="p-6 text-center text-muted-foreground">
                  {emptyText}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="border-t">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="p-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </ScrollTableShell>

      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {table.getState().pagination.pageIndex + 1} / {table.getPageCount()} ·{" "}
            {table.getFilteredRowModel().rows.length.toLocaleString("ar-IQ-u-nu-latn")} سطر
          </span>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              aria-label="السابق"
            >
              <ChevronRight aria-hidden className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              aria-label="التالي"
            >
              <ChevronLeft aria-hidden className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
