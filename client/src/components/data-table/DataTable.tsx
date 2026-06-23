// جدول بيانات موحّد فوق @tanstack/react-table — فرز بنقرة + بحث فوري + حالة فارغة.
// headless ⇒ يلتزم Tailwind/shadcn وRTL. الأعمدة typed عبر ColumnDef<T>.
import { Input } from "@/components/ui/input";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useState } from "react";
import { ChevronUp, ChevronDown, ArrowUpDown } from "lucide-react";

type DataTableProps<T> = {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  toolbar?: React.ReactNode; // أزرار إضافية (تصدير/إضافة) تظهر بجانب البحث
};

export function DataTable<T>({
  columns,
  data,
  searchable = true,
  searchPlaceholder = "بحث…",
  emptyText = "لا بيانات",
  toolbar,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="space-y-3">
      {(searchable || toolbar) && (
        <div className="flex items-center gap-2 justify-between flex-wrap">
          {searchable ? (
            <Input
              className="max-w-xs"
              placeholder={searchPlaceholder}
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
            />
          ) : <span />}
          {toolbar}
        </div>
      )}
      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="text-right">
                {hg.headers.map((h) => {
                  const sortable = h.column.getCanSort();
                  const dir = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      className={`p-2 ${sortable ? "cursor-pointer select-none hover:bg-muted" : ""}`}
                      onClick={sortable ? h.column.getToggleSortingHandler() : undefined}
                    >
                      {h.isPlaceholder ? null : (
                        <span className="inline-flex items-center gap-1">
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {dir === "asc" ? <ChevronUp aria-hidden className="size-3.5" /> : dir === "desc" ? <ChevronDown aria-hidden className="size-3.5" /> : sortable ? <ArrowUpDown aria-hidden className="size-3.5 opacity-30" /> : null}
                        </span>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="border-t">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="p-2">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            ))}
            {table.getRowModel().rows.length === 0 && (
              <tr><td colSpan={columns.length} className="p-6 text-center text-muted-foreground">{emptyText}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {data.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {table.getFilteredRowModel().rows.length.toLocaleString("ar-IQ-u-nu-latn")} من {data.length.toLocaleString("ar-IQ-u-nu-latn")} صفّ
        </p>
      )}
    </div>
  );
}
