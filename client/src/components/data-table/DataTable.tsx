// جدول بيانات موحّد فوق @tanstack/react-table — فرز بنقرة + بحث فوري + حالة فارغة.
// headless ⇒ يلتزم Tailwind/shadcn وRTL. الأعمدة typed عبر ColumnDef<T>.
//
// وضعان للترقيم والبحث:
//   • **محلّي (الافتراضي):** الصفوف كلّها في `data`؛ الترقيم والبحث في المتصفّح. صالح فقط
//     للقوائم المحدودة بطبيعتها (فروع/فئات/مستخدمون).
//   • **خادميّ (`serverPagination`):** `data` = صفحة واحدة جاءت من الخادم؛ الترقيم يُدار خارجاً.
//
// ⚠️ لماذا وُجد الوضع الخادميّ: كانت الشاشات الطويلة تمرّر `limit` **بلا `offset`** ثم تترك هذا
// المكوّن يُرقّم محلّياً فوق المقتطَع ⇒ الجدول *يبدو* مُرقَّماً بينما الصفوف بعد السقف **غير
// موجودة أصلاً** بلا أي مؤشّر (الفاتورة ٢٠١ من سقف ٢٠٠ لا تُرى ولا تُبحَث).
//
// ⚠️ **قاعدة مُلزِمة:** البحث المحلّي يُصفّي `data` وحدها = الصفحة المعروضة. فمع `serverPagination`
// **يجب** تمرير `serverSearch` (بحث خادميّ على كامل المجموعة) وإلا كان البحث أكذبَ من الاقتطاع
// (يقول «لا نتائج» وهي في صفحة أخرى). المكوّن يفرض ذلك: مع الترقيم الخادميّ يُعطَّل البحث
// المحلّي، ويُعرض حقل البحث **فقط** إن مُرِّر serverSearch.
import { Input } from "@/components/ui/input";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyContextMenu } from "@/lib/copy/CopyContextMenu";
import { TableSkeleton } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { TablePager } from "@/components/table/TablePager";

// نَصّ تَرويسة قابِل لِلنَسخ مِن تَعريف العَمود — لو الـheader نَصّ نَستَعمِله، وإلّا نَرجِع لِـid.
function columnHeaderText(col: { columnDef: { header?: unknown }; id: string }): string {
  const h = col.columnDef.header;
  if (typeof h === "string") return h;
  return col.id;
}

// تَحويل قيمة الخَلية إلى نَصّ آمِن لِلنَسخ — primitives فَقَط (نَتَجَنَّب JSON لِعَناصِر React).
function cellPrimitive(v: unknown): string | number | null | undefined {
  if (v === null || v === undefined) return undefined;
  const t = typeof v;
  if (t === "string" || t === "number") return v as string | number;
  if (t === "boolean") return v ? "نَعَم" : "لا";
  return undefined;
}

// عَقد التَحديد المُتَعَدِّد الاختِياري — يَتَوافَق مَع useRowSelection في SelectionBar.
export type DataTableSelection<K> = {
  selected: Set<K>;
  toggle: (id: K) => void;
  isSelected: (id: K) => boolean;
  count: number;
  // اختِياري — لو وُجد نُمَرِّر «تَحديد كل المَرئي» مَع شِفت‑range.
  setMany?: (ids: K[], value: boolean) => void;
};

type DataTableProps<T, K = string> = {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  /** أثناء التحميل: تُعرض صفوف هيكلية (skeleton) بدل النصّ الفارغ — إحساس سرعة أفضل بلا قفزة تخطيط. */
  loading?: boolean;
  toolbar?: React.ReactNode; // أزرار إضافية (تصدير/إضافة) تظهر بجانب البحث
  // === التَحديد المُتَعَدِّد (اختِياري) ===
  selection?: DataTableSelection<K>;
  getRowId?: (row: T) => K; // مُلزِم لو selection مُعَطاة
  // نَقرة الصَفّ تُغَيِّر التَحديد (افتِراضياً: false — فقط Shift+Click أَو الـcheckbox)
  rowClickSelects?: boolean;
  /** حجم الصفحة لِلتَرقيم المحلّي (افتِراضياً ٥٠). مَرِّر Infinity لِتَعطيل التَرقيم (عَرض الكُل).
   *  يُتجاهَل مَع serverPagination (حجم الصفحة عندئذٍ من الخادم). */
  pageSize?: number;
  /** حَبس الجَدول في حاوية بِحَجم الشاشة (ترويسة لاصقة + تَمرير داخِلي). افتِراضياً true. */
  bounded?: boolean;
  /** صنف الارتِفاع الأقصى لِلحاوية المَحبوسة (يُمَرَّر لِـScrollTableShell). */
  maxHeightClass?: string;
  /** الترقيم الخادميّ: `data` = صفحة واحدة. يُعطِّل الترقيم والبحث المحلّيين. */
  serverPagination?: {
    page: number; // بدءاً من ٠
    onPageChange: (page: number) => void;
    pageSize: number;
    /** الإجمالي حين يكون معلوماً (COUNT) — يُعطي «من N» وعدد الصفحات. */
    total?: number;
    /** بديل الإجمالي في وضع keyset (بلا COUNT). */
    hasMore?: boolean;
  };
  /** البحث الخادميّ — **إلزاميّ عملياً مع serverPagination** (انظر رأس الملف). */
  serverSearch?: {
    value: string;
    onChange: (value: string) => void;
  };
};

/** يَختار حاوية الجَدول: محبوسة بِحَجم الشاشة (ترويسة لاصقة) أَو تَمرير أُفُقي بَسيط. */
function TableShell({
  bounded,
  maxHeightClass,
  children,
}: {
  bounded: boolean;
  maxHeightClass?: string;
  children: React.ReactNode;
}) {
  if (bounded) return <ScrollTableShell maxHeightClass={maxHeightClass}>{children}</ScrollTableShell>;
  return <div className="rounded-md border overflow-x-auto">{children}</div>;
}

export function DataTable<T, K = string>({
  columns,
  data,
  searchable = true,
  searchPlaceholder = "بحث…",
  emptyText = "لا بيانات",
  loading = false,
  toolbar,
  selection,
  getRowId,
  rowClickSelects = false,
  pageSize = 50,
  bounded = true,
  maxHeightClass,
  serverPagination,
  serverSearch,
}: DataTableProps<T, K>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [lastIndex, setLastIndex] = useState<number | null>(null);

  // مَع الترقيم الخادميّ: `data` صفحةٌ جاهزة ⇒ لا ترقيم ولا تصفية محلّيان (كلاهما يعمل على
  // الصفحة وحدها فيُخفي صفوف الخادم ويكذب على المستخدم).
  const serverMode = !!serverPagination;
  const paginated = !serverMode && Number.isFinite(pageSize);
  const table = useReactTable({
    data,
    columns,
    state: serverMode ? { sorting } : { sorting, globalFilter },
    onSortingChange: setSorting,
    ...(serverMode ? {} : { onGlobalFilterChange: setGlobalFilter }),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    ...(serverMode ? {} : { getFilteredRowModel: getFilteredRowModel() }),
    ...(paginated ? { getPaginationRowModel: getPaginationRowModel() } : {}),
    initialState: paginated ? { pagination: { pageSize } } : undefined,
  });

  // حِراسة تَطوير: ترقيم خادميّ + بحث محلّيّ = بحثٌ يرى الصفحة وحدها (أسوأ من لا بحث).
  if (serverMode && searchable && !serverSearch) {
    // eslint-disable-next-line no-console
    console.warn(
      "DataTable: serverPagination بلا serverSearch — حقل البحث مُخفى (البحث المحلّي كان سيرى الصفحة وحدها). مرِّر serverSearch أو searchable={false}.",
    );
  }

  // البحث يظهر إن طُلب — ومع الترقيم الخادميّ **فقط** إن كان خادمياً (لا بحثَ يرى الصفحة وحدها).
  const showSearch = searchable && (!serverMode || !!serverSearch);

  const selectionEnabled = !!selection && !!getRowId;
  if (selection && !getRowId) {
    // حِراسة تَطوير — نُذَكِّر المُستَهلِك بِأَنّ getRowId مُلزِم مَع selection.
    // eslint-disable-next-line no-console
    console.warn("DataTable: selection مُعَطاة بِلا getRowId — التَحديد مُعَطَّل.");
  }

  const visibleRows = table.getRowModel().rows;

  // مُعَرِّفات الصُفوف المَرئية (للأَزرار الكُلِّية + شِفت‑range).
  const visibleIds = useMemo<K[]>(() => {
    if (!selectionEnabled) return [];
    return visibleRows.map((r) => getRowId!(r.original));
  }, [visibleRows, selectionEnabled, getRowId]);

  // تَرويسات الأَعمِدة كَنُصوص (لِلنَسخ كَ TSV) — مُشتَقَّة مَرّة واحِدة مِن تَعريف الأَعمِدة.
  const leafCols = table.getAllLeafColumns();
  const copyHeaders = useMemo<string[]>(() => leafCols.map(columnHeaderText), [leafCols]);

  // قِيَم العَمود الظاهِرة لِكُل عَمود — لِخَيار «نَسخ العَمود كَ TSV».
  const columnValuesByColId = useMemo<Record<string, (string | number | null | undefined)[]>>(() => {
    const out: Record<string, (string | number | null | undefined)[]> = {};
    for (const col of leafCols) {
      out[col.id] = visibleRows.map((r) => cellPrimitive(r.getValue(col.id)));
    }
    return out;
  }, [leafCols, visibleRows]);

  const allVisibleSelected = selectionEnabled && visibleIds.length > 0
    && visibleIds.every((id) => selection!.isSelected(id));
  const someVisibleSelected = selectionEnabled
    && visibleIds.some((id) => selection!.isSelected(id))
    && !allVisibleSelected;

  const toggleAllVisible = () => {
    if (!selectionEnabled) return;
    const next = !allVisibleSelected;
    if (selection!.setMany) {
      selection!.setMany(visibleIds, next);
    } else {
      // fallback: toggle فَردي لِكل عُنصُر يَختَلِف حالُه عَن المَطلوب.
      for (const id of visibleIds) {
        if (selection!.isSelected(id) !== next) selection!.toggle(id);
      }
    }
  };

  const handleRowToggle = (rowIndex: number, e: React.MouseEvent | React.ChangeEvent) => {
    if (!selectionEnabled) return;
    const id = visibleIds[rowIndex];
    const isShift = (e as React.MouseEvent).shiftKey === true;
    if (isShift && lastIndex !== null && lastIndex !== rowIndex) {
      const [from, to] = lastIndex < rowIndex ? [lastIndex, rowIndex] : [rowIndex, lastIndex];
      const rangeIds = visibleIds.slice(from, to + 1);
      const anchorSelected = selection!.isSelected(visibleIds[lastIndex]);
      if (selection!.setMany) {
        selection!.setMany(rangeIds, anchorSelected);
      } else {
        for (const rid of rangeIds) {
          if (selection!.isSelected(rid) !== anchorSelected) selection!.toggle(rid);
        }
      }
    } else {
      selection!.toggle(id);
    }
    setLastIndex(rowIndex);
  };

  return (
    <div className="space-y-3">
      {(showSearch || toolbar) && (
        <div className="flex items-center gap-2 justify-between flex-wrap">
          {showSearch ? (
            <Input
              className="max-w-xs"
              placeholder={searchPlaceholder}
              value={serverSearch ? serverSearch.value : globalFilter}
              onChange={(e) =>
                serverSearch ? serverSearch.onChange(e.target.value) : setGlobalFilter(e.target.value)
              }
            />
          ) : <span />}
          {toolbar}
        </div>
      )}
      <TableShell bounded={bounded} maxHeightClass={maxHeightClass}>
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="text-right">
                {selectionEnabled && (
                  <th className="p-2 w-10 text-center">
                    <input
                      type="checkbox"
                      aria-label="تَحديد كل المَرئي"
                      className="size-4 cursor-pointer accent-primary"
                      checked={allVisibleSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someVisibleSelected;
                      }}
                      onChange={toggleAllVisible}
                    />
                  </th>
                )}
                {hg.headers.map((h) => {
                  const sortable = h.column.getCanSort();
                  const dir = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      className={`p-2 ${sortable ? "cursor-pointer select-none hover:bg-muted" : ""}`}
                      aria-sort={sortable ? (dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none") : undefined}
                      {...(sortable ? { role: "button" as const, tabIndex: 0 } : {})}
                      onClick={sortable ? h.column.getToggleSortingHandler() : undefined}
                      onKeyDown={sortable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); h.column.getToggleSortingHandler()?.(e); } } : undefined}
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
            {loading && (
              <TableSkeleton rows={8} cols={columns.length + (selectionEnabled ? 1 : 0)} />
            )}
            {!loading && visibleRows.map((row, rowIndex) => {
              const id = selectionEnabled ? visibleIds[rowIndex] : undefined;
              const isSelected = selectionEnabled && selection!.isSelected(id as K);
              return (
                <tr
                  key={row.id}
                  data-selected={isSelected || undefined}
                  className={`border-t data-[selected=true]:bg-accent/60 ${selectionEnabled ? "cursor-default" : ""}`}
                  onClick={(e) => {
                    if (!selectionEnabled) return;
                    // نَقرة الصَفّ تُغَيِّر التَحديد فَقَط لو: شِفت، أَو rowClickSelects.
                    // نَتَجَنَّب العَناصِر التَفاعُلية داخِل الخَلية.
                    const target = e.target as HTMLElement;
                    if (target.closest("button, a, input, select, textarea, [role=button]")) return;
                    if (e.shiftKey || rowClickSelects) {
                      handleRowToggle(rowIndex, e);
                    }
                  }}
                >
                  {selectionEnabled && (
                    <td className="p-2 w-10 text-center" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label="تَحديد الصَفّ"
                        className="size-4 cursor-pointer accent-primary"
                        checked={isSelected}
                        onClick={(e) => {
                          // نَدعَم Shift+Click عَلى الـcheckbox نَفسه أَيضاً.
                          handleRowToggle(rowIndex, e);
                          // لا نُكَرِّر التَغيير في onChange.
                          e.preventDefault();
                        }}
                        onChange={() => { /* noop — التَغيير عَبر onClick */ }}
                      />
                    </td>
                  )}
                  {row.getVisibleCells().map((cell) => {
                    const colId = cell.column.id;
                    const cellVal = cellPrimitive(cell.getValue());
                    const rowValues = leafCols.map((c) => cellPrimitive(row.getValue(c.id)));
                    return (
                      <td key={cell.id} className="p-2">
                        <CopyContextMenu
                          value={cellVal}
                          rowHeaders={copyHeaders}
                          rowValues={rowValues}
                          columnHeader={columnHeaderText(cell.column)}
                          columnValues={columnValuesByColId[colId]}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </CopyContextMenu>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {!loading && visibleRows.length === 0 && (
              <tr><td colSpan={columns.length + (selectionEnabled ? 1 : 0)} className="p-6 text-center text-muted-foreground">{emptyText}</td></tr>
            )}
          </tbody>
        </table>
      </TableShell>
      {serverMode ? (
        <>
          {selectionEnabled && selection!.count > 0 && (
            <div className="text-xs text-muted-foreground">
              مُحَدَّد: {selection!.count.toLocaleString("ar-IQ-u-nu-latn")}
            </div>
          )}
          {/* شريط الترقيم الموحّد — نفس الصيغة والاتجاه في كل جداول النظام. */}
          <TablePager
            page={serverPagination!.page}
            onPageChange={serverPagination!.onPageChange}
            pageSize={serverPagination!.pageSize}
            rowsOnPage={data.length}
            total={serverPagination!.total}
            hasMore={serverPagination!.hasMore}
            isLoading={loading}
            className="border-t-0 p-0 pt-1"
          />
        </>
      ) : data.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {table.getFilteredRowModel().rows.length.toLocaleString("ar-IQ-u-nu-latn")} من {data.length.toLocaleString("ar-IQ-u-nu-latn")} صفّ
            {selectionEnabled && selection!.count > 0 && (
              <> · مُحَدَّد: {selection!.count.toLocaleString("ar-IQ-u-nu-latn")}</>
            )}
          </span>
          {paginated && table.getPageCount() > 1 && (
            <div className="flex items-center gap-2">
              <span>
                صفحة {(table.getState().pagination.pageIndex + 1).toLocaleString("ar-IQ-u-nu-latn")} من{" "}
                {table.getPageCount().toLocaleString("ar-IQ-u-nu-latn")}
              </span>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                  aria-label="الصفحة السابقة"
                >
                  <ChevronRight aria-hidden className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                  aria-label="الصفحة التالية"
                >
                  <ChevronLeft aria-hidden className="size-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
