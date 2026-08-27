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
  type VisibilityState,
} from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, ArrowUpDown, Columns3, Rows3, RotateCcw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CopyContextMenu } from "@/lib/copy/CopyContextMenu";
import { TableSkeleton, EmptyState } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { TablePager } from "@/components/table/TablePager";
import { BarcodeSearchCue, barcodeSearchInputClass } from "@/components/scan/BarcodeSearchCue";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { cn } from "@/lib/utils";
import { normalizeKnownSystemBarcode } from "@/lib/barcodeScannerInput";
import { WorkspaceBar, WorkspaceStatusBar } from "@/components/workspace/OperationalWorkspace";

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
  /** ٢٤/٨ — تركيزٌ تلقائيّ لحقل البحث عند تركيب الجدول. مفيدٌ للشاشات التي يفتحها المستخدم
   *  ليكتب فوراً (فواتير/عملاء)، لا يُفعَّل افتراضياً كي لا يخطف التركيزَ من نماذجَ حاضرة. */
  autoFocusSearch?: boolean;
  /** البحث يقبل قارئ HID (باركود/رقم مستند): تصحيح تخطيط عربي + هوية بصرية. */
  barcodeSearch?: boolean;
  emptyText?: string;
  /**
   * مفتاح domain لِـ`@shared/emptyStateMessages` — يمكّن العرض من التمييز التلقائيّ بين
   * `NO_ROWS_YET` (قائمة فارغة أصلاً) و`NO_MATCH_FILTER` (بحث/فلتر بلا مطابقة). قبل هذا كانت
   * الشاشتان تُعرَضان بنفس النصّ «لا بيانات» فيتوهّم الموظّف أنّ الفلتر أفرغ القائمة.
   * إن مُرِّر، يُتَخطّى `emptyText` بالنصّ الاشتقاقيّ المناسب. أمثلة: `"invoices"`, `"customers"`,
   * `"products"`. القائمة الكاملة في `EMPTY_STATE_RESOURCE_KEYS`.
   */
  resourceKey?: string;
  /** تجاوز يدويّ للفراغ الأصليّ (لا صفوف بعد) — استُهلك عادةً كـ`<EmptyState action=… />` مع CTA. */
  emptyState?: React.ReactNode;
  /** تجاوز يدويّ للفراغ بعد فلتر — يعرض عادةً «امسح الفلاتر» كـCTA. */
  emptyFilteredState?: React.ReactNode;
  /** أثناء التحميل: تُعرض صفوف هيكلية (skeleton) بدل النصّ الفارغ — إحساس سرعة أفضل بلا قفزة تخطيط. */
  loading?: boolean;
  /**
   * صدق الخطأ (بلاغ المالك ١٨/٨) — فشلُ الجلب **ليس** «لا نتائج»: بلا هذه الخاصية كان الردّ
   * ٤٠٣/انقطاعُ الشبكة يُعرَض «لا فواتير مطابقة» حرفياً، فيظنّ الموظف أنّ فواتيره غير موجودة
   * بينما الخادم رفض الطلب. الأولوية: تحميل ⇐ خطأ ⇐ فراغ.
   */
  errorState?: { isError: boolean; message?: string; onRetry?: () => void };
  toolbar?: React.ReactNode; // أزرار إضافية (تصدير/إضافة) تظهر بجانب البحث
  // === التَحديد المُتَعَدِّد (اختِياري) ===
  selection?: DataTableSelection<K>;
  getRowId?: (row: T) => K; // مُلزِم لو selection مُعَطاة
  /** عرض مخصص ككروت للهاتف (<md) بدلاً من الجدول العريض. */
  mobileCardRenderer?: (row: T, index: number) => React.ReactNode;
  // نَقرة الصَفّ تُغَيِّر التَحديد (افتِراضياً: false — فقط Shift+Click أَو الـcheckbox)
  rowClickSelects?: boolean;
  /** صنف بصري اختياري للصف مشتق من بياناته (تمييز حالات تشغيلية مهمة). */
  getRowClassName?: (row: T) => string | undefined;
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
  /** مفتاح ثابت لحفظ الأعمدة والكثافة. إن غاب يُشتق مفتاح من المسار ومعرّفات الأعمدة. */
  viewKey?: string;
  /** فرز خادمي مضبوط. بدونه يُعطّل الفرز في serverPagination كي لا يفرز الصفحة الحالية فقط. */
  serverSorting?: {
    value: SortingState;
    onChange: (value: SortingState) => void;
  };
};

type StoredTableView = {
  columnVisibility?: VisibilityState;
  compact?: boolean;
};

function columnIdentity(column: ColumnDef<unknown, unknown>, index: number): string {
  const candidate = column as {
    id?: string;
    accessorKey?: string;
    header?: unknown;
  };
  if (candidate.id) return candidate.id;
  if (candidate.accessorKey) return candidate.accessorKey;
  if (typeof candidate.header === "string") return candidate.header;
  return `column-${index}`;
}

function readTableView(key: string): StoredTableView {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "{}") as StoredTableView;
    return {
      columnVisibility: parsed.columnVisibility && typeof parsed.columnVisibility === "object" ? parsed.columnVisibility : {},
      compact: parsed.compact === true,
    };
  } catch {
    return {};
  }
}

function writeTableView(key: string, value: StoredTableView): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // فشل localStorage لا يعطّل الجدول؛ يبقى التفضيل صالحاً للجلسة الحالية.
  }
}

/** يَختار حاوية الجَدول: محبوسة بِحَجم الشاشة (ترويسة لاصقة) أَو تَمرير أُفُقي بَسيط. */
function TableShell({ bounded, maxHeightClass, children }: { bounded: boolean; maxHeightClass?: string; children: React.ReactNode }) {
  if (bounded)
    return (
      <ScrollTableShell maxHeightClass={maxHeightClass} showColumnVisibility={false}>
        {children}
      </ScrollTableShell>
    );
  return <div className="rounded-md border overflow-x-auto">{children}</div>;
}

export function DataTable<T, K = string>({
  columns,
  data,
  searchable = true,
  searchPlaceholder = "بحث…",
  autoFocusSearch = false,
  barcodeSearch = false,
  emptyText = "لا بيانات",
  resourceKey,
  emptyState,
  emptyFilteredState,
  loading = false,
  errorState,
  toolbar,
  selection,
  getRowId,
  mobileCardRenderer,
  rowClickSelects = false,
  getRowClassName,
  pageSize = 50,
  bounded = true,
  maxHeightClass,
  serverPagination,
  serverSearch,
  viewKey,
  serverSorting,
}: DataTableProps<T, K>) {
  const storageKey = useMemo(() => {
    const scope = viewKey || (typeof window !== "undefined" ? window.location.pathname : "table");
    const ids = columns.map((column, index) => columnIdentity(column as ColumnDef<unknown, unknown>, index)).join("|");
    let hash = 0;
    for (let i = 0; i < ids.length; i += 1) hash = ((hash << 5) - hash + ids.charCodeAt(i)) | 0;
    return `data-table-view:v2:${scope}:${hash >>> 0}`;
  }, [columns, viewKey]);
  const initialView = useMemo(() => readTableView(storageKey), [storageKey]);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(initialView.columnVisibility ?? {});
  const [compact, setCompact] = useState(initialView.compact === true);
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const barcodeInput = useBarcodeInput((code) => (serverSearch ? serverSearch.onChange(code) : setGlobalFilter(code)), { enabled: barcodeSearch });

  useEffect(() => {
    writeTableView(storageKey, { columnVisibility, compact });
  }, [storageKey, columnVisibility, compact]);

  // مَع الترقيم الخادميّ: `data` صفحةٌ جاهزة ⇒ لا ترقيم ولا تصفية محلّيان (كلاهما يعمل على
  // الصفحة وحدها فيُخفي صفوف الخادم ويكذب على المستخدم).
  const serverMode = !!serverPagination;
  const paginated = !serverMode && Number.isFinite(pageSize);
  const effectiveSorting = serverMode ? (serverSorting?.value ?? []) : sorting;
  const table = useReactTable({
    data,
    columns,
    state: serverMode ? { sorting: effectiveSorting, columnVisibility } : { sorting, globalFilter, columnVisibility },
    onSortingChange: serverMode && serverSorting ? (updater) => serverSorting.onChange(typeof updater === "function" ? updater(serverSorting.value) : updater) : setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    enableSorting: !serverMode || !!serverSorting,
    manualSorting: serverMode,
    ...(serverMode ? {} : { onGlobalFilterChange: setGlobalFilter }),
    getCoreRowModel: getCoreRowModel(),
    ...(!serverMode ? { getSortedRowModel: getSortedRowModel() } : {}),
    ...(serverMode ? {} : { getFilteredRowModel: getFilteredRowModel() }),
    ...(paginated ? { getPaginationRowModel: getPaginationRowModel() } : {}),
    initialState: paginated ? { pagination: { pageSize } } : undefined,
  });

  // حِراسة تَطوير: ترقيم خادميّ + بحث محلّيّ = بحثٌ يرى الصفحة وحدها (أسوأ من لا بحث).
  if (serverMode && searchable && !serverSearch) {
    // eslint-disable-next-line no-console
    console.warn("DataTable: serverPagination بلا serverSearch — حقل البحث مُخفى (البحث المحلّي كان سيرى الصفحة وحدها). مرِّر serverSearch أو searchable={false}.");
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

  /**
   * صدق الخطأ: ما يُعرَض حين لا صفوف — رسالةُ الفشل الحقيقية (بزرّ إعادة) إن فشل الجلب،
   * وإلّا نصّ الفراغ. بلا هذا التمييز يُقرأ الرفض ٤٠٣ «لا بيانات» فيُضلّل الموظف والإدارة.
   */
  // تمييز صريح: بحث/فلتر نشط ⇒ NO_MATCH_FILTER، وإلا NO_ROWS_YET. البحث المحلّيّ يقاس بـglobalFilter،
  // والخادميّ بـserverSearch.value. حالة الفلاتر الأخرى (شارة/تاريخ/…) تُمرَّر يدوياً عبر
  // emptyFilteredState (المستدعي يعلم متى تكون فلاتره نشطة).
  const anySearchActive = (serverSearch?.value?.trim() ?? "") !== "" || (globalFilter?.trim() ?? "") !== "";
  const emptyOrError = errorState?.isError ? (
    <div className="flex flex-col items-center gap-2 text-sm">
      <span className="inline-flex items-center gap-1.5 font-bold text-[var(--sem-danger)]">
        <AlertTriangle aria-hidden className="size-4" />
        {errorState.message?.trim() || "تعذّر جلب البيانات — تحقّق من الصلاحية أو الاتصال."}
      </span>
      {errorState.onRetry && (
        <Button size="sm" variant="outline" onClick={errorState.onRetry}>
          <RotateCcw aria-hidden className="size-3.5" /> إعادة المحاولة
        </Button>
      )}
    </div>
  ) : anySearchActive ? (
    // فلتر/بحث نشط — رسالة NO_MATCH_FILTER
    (emptyFilteredState ?? (resourceKey ? <EmptyState resourceKey={resourceKey} reason="NO_MATCH_FILTER" /> : emptyText))
  ) : (
    // لا صفوف أصلاً — رسالة NO_ROWS_YET
    (emptyState ?? (resourceKey ? <EmptyState resourceKey={resourceKey} reason="NO_ROWS_YET" /> : emptyText))
  );

  // مُعَرِّفات الصُفوف المَرئية (للأَزرار الكُلِّية + شِفت‑range).
  const visibleIds = useMemo<K[]>(() => {
    if (!selectionEnabled) return [];
    return visibleRows.map((r) => getRowId!(r.original));
  }, [visibleRows, selectionEnabled, getRowId]);

  // تَرويسات الأَعمِدة كَنُصوص (لِلنَسخ كَ TSV) — مُشتَقَّة مَرّة واحِدة مِن تَعريف الأَعمِدة.
  const leafCols = table.getAllLeafColumns();
  const visibleColumnCount = leafCols.filter((column) => column.getIsVisible()).length;
  const copyHeaders = useMemo<string[]>(() => leafCols.map(columnHeaderText), [leafCols]);

  // قِيَم العَمود الظاهِرة لِكُل عَمود — لِخَيار «نَسخ العَمود كَ TSV».
  const columnValuesByColId = useMemo<Record<string, (string | number | null | undefined)[]>>(() => {
    const out: Record<string, (string | number | null | undefined)[]> = {};
    for (const col of leafCols) {
      out[col.id] = visibleRows.map((r) => cellPrimitive(r.getValue(col.id)));
    }
    return out;
  }, [leafCols, visibleRows]);

  const allVisibleSelected = selectionEnabled && visibleIds.length > 0 && visibleIds.every((id) => selection!.isSelected(id));
  const someVisibleSelected = selectionEnabled && visibleIds.some((id) => selection!.isSelected(id)) && !allVisibleSelected;

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

  const columnControls =
    table.getAllLeafColumns().length > 5 ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="h-8 gap-2">
            <Columns3 aria-hidden className="size-4" />
            الأعمدة {visibleColumnCount}/{leafCols.length}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 min-w-52 overflow-y-auto text-right">
          <DropdownMenuLabel>إظهار تفاصيل الجدول</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {table.getAllLeafColumns().map((column) => (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={column.getIsVisible()}
              disabled={!column.getCanHide() || (column.getIsVisible() && visibleColumnCount === 1)}
              onCheckedChange={(value) => column.toggleVisibility(Boolean(value))}
              onSelect={(event) => event.preventDefault()}
            >
              {columnHeaderText(column)}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={compact} onCheckedChange={(value) => setCompact(Boolean(value))} onSelect={(event) => event.preventDefault()}>
            <Rows3 aria-hidden className="size-4" />
            عرض مدمج
          </DropdownMenuCheckboxItem>
          <DropdownMenuItem
            onSelect={() => {
              setColumnVisibility({});
              setCompact(false);
            }}
          >
            <RotateCcw aria-hidden className="size-4" />
            إعادة ضبط العرض
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  return (
    <div className={compact ? "space-y-2 [&_th]:!p-1.5 [&_td]:!p-1.5 [&_tbody_tr]:text-xs" : "space-y-2"} data-table-density={compact ? "compact" : "comfortable"}>
      {(showSearch || toolbar) && (
        <WorkspaceBar variant="filters" label="بحث وأدوات الجدول" className="justify-between overflow-hidden">
          {showSearch ? (
            <div className={cn("relative min-w-40 flex-1", barcodeSearch ? "max-w-sm" : "max-w-xs")}>
              <Input
                autoFocus={autoFocusSearch}
                className={cn(barcodeSearch && barcodeSearchInputClass)}
                placeholder={searchPlaceholder}
                value={serverSearch ? serverSearch.value : globalFilter}
                onChange={(e) => {
                  const value = barcodeSearch ? normalizeKnownSystemBarcode(e.target.value) : e.target.value;
                  serverSearch ? serverSearch.onChange(value) : setGlobalFilter(value);
                }}
                onKeyDown={(e) => barcodeInput.handleKeyDown(e, serverSearch ? serverSearch.onChange : setGlobalFilter)}
                aria-label={searchPlaceholder}
              />
              {barcodeSearch && <BarcodeSearchCue />}
            </div>
          ) : (
            <span />
          )}
          <div className="flex min-w-0 shrink-0 items-center gap-1.5 overflow-x-auto whitespace-nowrap [&>*]:shrink-0">{toolbar}</div>
        </WorkspaceBar>
      )}
      {mobileCardRenderer ? (
        <>
          {/* عرض الكروت الذكية على شاشات الهاتف (<md) */}
          <div className="md:hidden space-y-2.5">
            {loading && <TableSkeleton rows={4} cols={1} />}
            {!loading && visibleRows.map((row, idx) => <div key={row.id}>{mobileCardRenderer(row.original, idx)}</div>)}
            {!loading && visibleRows.length === 0 && <div className="p-8 text-center text-muted-foreground text-sm bg-card border border-border/60 rounded-xl">{emptyOrError}</div>}
          </div>

          {/* الجدول الكامل للشاشات المتوسطة والأكبر (>=md) */}
          <div className="hidden md:block">
            <TableShell bounded={bounded} maxHeightClass={maxHeightClass}>
              <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
                <thead className="bg-muted">
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
                            className={`border-b border-border/80 px-3 py-2.5 text-xs font-bold text-foreground whitespace-nowrap ${sortable ? "cursor-pointer select-none hover:bg-muted/80" : ""}`}
                            aria-sort={sortable ? (dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none") : undefined}
                            {...(sortable ? { role: "button" as const, tabIndex: 0 } : {})}
                            onClick={sortable ? h.column.getToggleSortingHandler() : undefined}
                            onKeyDown={
                              sortable
                                ? (e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      h.column.getToggleSortingHandler()?.(e);
                                    }
                                  }
                                : undefined
                            }
                          >
                            {h.isPlaceholder ? null : (
                              <span className="inline-flex items-center gap-1">
                                {flexRender(h.column.columnDef.header, h.getContext())}
                                {dir === "asc" ? (
                                  <ChevronUp aria-hidden className="size-3.5" />
                                ) : dir === "desc" ? (
                                  <ChevronDown aria-hidden className="size-3.5" />
                                ) : sortable ? (
                                  <ArrowUpDown aria-hidden className="size-3.5 opacity-30" />
                                ) : null}
                              </span>
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {loading && <TableSkeleton rows={8} cols={columns.length + (selectionEnabled ? 1 : 0)} />}
                  {!loading &&
                    visibleRows.map((row, rowIndex) => {
                      const id = selectionEnabled ? visibleIds[rowIndex] : undefined;
                      const isSelected = selectionEnabled && selection!.isSelected(id as K);
                      return (
                        <tr
                          key={row.id}
                          data-selected={isSelected || undefined}
                          className={`border-t odd:bg-background even:bg-muted/20 hover:bg-accent/35 data-[selected=true]:bg-accent/60 ${getRowClassName?.(row.original) ?? ""} ${selectionEnabled ? "cursor-default" : ""}`}
                          onClick={(e) => {
                            if (!selectionEnabled) return;
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
                                  handleRowToggle(rowIndex, e);
                                  e.preventDefault();
                                }}
                                onChange={() => {
                                  /* noop — التَغيير عَبر onClick */
                                }}
                              />
                            </td>
                          )}
                          {row.getVisibleCells().map((cell) => {
                            const colId = cell.column.id;
                            const cellVal = cellPrimitive(cell.getValue());
                            const rowValues = leafCols.map((c) => cellPrimitive(row.getValue(c.id)));
                            return (
                              <td key={cell.id} className="border-b border-border/55 px-3 py-2.5 align-middle whitespace-nowrap">
                                <CopyContextMenu value={cellVal} rowHeaders={copyHeaders} rowValues={rowValues} columnHeader={columnHeaderText(cell.column)} columnValues={columnValuesByColId[colId]}>
                                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                </CopyContextMenu>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  {!loading && visibleRows.length === 0 && (
                    <tr>
                      <td colSpan={columns.length + (selectionEnabled ? 1 : 0)} className="p-6 text-center text-muted-foreground">
                        {emptyOrError}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableShell>
          </div>
        </>
      ) : (
        <TableShell bounded={bounded} maxHeightClass={maxHeightClass}>
          <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
            <thead className="bg-muted">
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
                        className={`border-b border-border/80 px-3 py-2.5 text-xs font-bold text-foreground whitespace-nowrap ${sortable ? "cursor-pointer select-none hover:bg-muted/80" : ""}`}
                        aria-sort={sortable ? (dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none") : undefined}
                        {...(sortable ? { role: "button" as const, tabIndex: 0 } : {})}
                        onClick={sortable ? h.column.getToggleSortingHandler() : undefined}
                        onKeyDown={
                          sortable
                            ? (e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  h.column.getToggleSortingHandler()?.(e);
                                }
                              }
                            : undefined
                        }
                      >
                        {h.isPlaceholder ? null : (
                          <span className="inline-flex items-center gap-1">
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            {dir === "asc" ? (
                              <ChevronUp aria-hidden className="size-3.5" />
                            ) : dir === "desc" ? (
                              <ChevronDown aria-hidden className="size-3.5" />
                            ) : sortable ? (
                              <ArrowUpDown aria-hidden className="size-3.5 opacity-30" />
                            ) : null}
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {loading && <TableSkeleton rows={8} cols={columns.length + (selectionEnabled ? 1 : 0)} />}
              {!loading &&
                visibleRows.map((row, rowIndex) => {
                  const id = selectionEnabled ? visibleIds[rowIndex] : undefined;
                  const isSelected = selectionEnabled && selection!.isSelected(id as K);
                  return (
                    <tr
                      key={row.id}
                      data-selected={isSelected || undefined}
                      className={`border-t odd:bg-background even:bg-muted/20 hover:bg-accent/35 data-[selected=true]:bg-accent/60 ${getRowClassName?.(row.original) ?? ""} ${selectionEnabled ? "cursor-default" : ""}`}
                      onClick={(e) => {
                        if (!selectionEnabled) return;
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
                              handleRowToggle(rowIndex, e);
                              e.preventDefault();
                            }}
                            onChange={() => {
                              /* noop — التَغيير عَبر onClick */
                            }}
                          />
                        </td>
                      )}
                      {row.getVisibleCells().map((cell) => {
                        const colId = cell.column.id;
                        const cellVal = cellPrimitive(cell.getValue());
                        const rowValues = leafCols.map((c) => cellPrimitive(row.getValue(c.id)));
                        return (
                          <td key={cell.id} className="border-b border-border/55 px-3 py-2.5 align-middle whitespace-nowrap">
                            <CopyContextMenu value={cellVal} rowHeaders={copyHeaders} rowValues={rowValues} columnHeader={columnHeaderText(cell.column)} columnValues={columnValuesByColId[colId]}>
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </CopyContextMenu>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              {!loading && visibleRows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + (selectionEnabled ? 1 : 0)} className="p-6 text-center text-muted-foreground">
                    {emptyOrError}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableShell>
      )}
      {serverMode ? (
        /* شريط الترقيم الموحّد — نفس الصيغة والاتجاه في كل جداول النظام. */
        <TablePager
          page={serverPagination!.page}
          onPageChange={serverPagination!.onPageChange}
          pageSize={serverPagination!.pageSize}
          rowsOnPage={data.length}
          total={serverPagination!.total}
          hasMore={serverPagination!.hasMore}
          isLoading={loading}
          status={selectionEnabled && selection!.count > 0 ? `محدّد: ${selection!.count.toLocaleString("ar-IQ-u-nu-latn")}` : undefined}
          actions={columnControls}
        />
      ) : (
        data.length > 0 && (
          <WorkspaceStatusBar>
            <span>
              {table.getFilteredRowModel().rows.length.toLocaleString("ar-IQ-u-nu-latn")} من {data.length.toLocaleString("ar-IQ-u-nu-latn")} صفّ
              {selectionEnabled && selection!.count > 0 && <> · مُحَدَّد: {selection!.count.toLocaleString("ar-IQ-u-nu-latn")}</>}
            </span>
            {paginated && table.getPageCount() > 1 && (
              <div className="flex items-center gap-2">
                {columnControls}
                <span>
                  صفحة {(table.getState().pagination.pageIndex + 1).toLocaleString("ar-IQ-u-nu-latn")} من {table.getPageCount().toLocaleString("ar-IQ-u-nu-latn")}
                </span>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" className="h-7" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="الصفحة السابقة">
                    <ChevronRight aria-hidden className="size-4" />
                  </Button>
                  <Button size="sm" variant="outline" className="h-7" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="الصفحة التالية">
                    <ChevronLeft aria-hidden className="size-4" />
                  </Button>
                </div>
              </div>
            )}
            {(!paginated || table.getPageCount() <= 1) && columnControls}
          </WorkspaceStatusBar>
        )
      )}
    </div>
  );
}
