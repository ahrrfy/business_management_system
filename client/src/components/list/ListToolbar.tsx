// شريط أدوات القائمة الموحّد: بحث/فلاتر/استيراد/تصدير/طباعة/إضافة بترتيب ثابت.
// يعمل داخل فتحة toolbar في DataTable وفي الصفحات اليدوية. يعيد استخدام exportRows.
//   <ListToolbar title="القائمة" count={total} loading={list.isLoading}
//     exportSpec={{ filename: "العملاء", rows, columns: [...] }}
//     onImport={() => setImportOpen(true)} add={{ href: "/customers/new", label: "عميل جديد" }} />
import * as React from "react";
import { FileSpreadsheet, Loader2, Plus, Printer, RefreshCcw, Search, SlidersHorizontal, Upload, X } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { exportRows, type ExportColumn } from "@/lib/export";
import { notify } from "@/lib/notify";
import { BarcodeSearchCue, barcodeSearchInputClass } from "@/components/scan/BarcodeSearchCue";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { cn } from "@/lib/utils";
import { normalizeKnownSystemBarcode } from "@/lib/barcodeScannerInput";

export type ExportSpec<T> = {
  filename: string;
  columns: ExportColumn<T>[];
  /** الصفوف المفلترة الحالية (الصفحة المعروضة في القوائم المُصفّحة من الخادم). */
  rows: T[];
  sheetName?: string;
  /** افتراضي ["xlsx"]؛ إن أُضيف "csv" تظهر قائمة منسدلة للاختيار. */
  formats?: Array<"xlsx" | "csv">;
  /**
   * اختياري: يجلب **كل** الصفوف المطابقة للفلاتر (لا الصفحة المعروضة فقط) قبل التصدير.
   * إن وُجد، يُصدّر الزرّ المجموعة الكاملة (مع مؤشّر تحضير)؛ وإلّا يُصدّر `rows` (الصفحة الحالية).
   * تستعمله القوائم المُصفّحة خادمياً عبر fetchAllPaged (@/lib/fetchAllRows).
   */
  fetchAll?: () => Promise<T[]>;
};

type AddSpec = { label?: string } & ({ href: string } | { onClick: () => void });

export type ListToolbarProps<T> = {
  title?: React.ReactNode;
  count?: number;
  loading?: boolean;
  search?: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    ariaLabel?: string;
    /** الحقل يقبل قارئ HID: يفعّل تصحيح التخطيط العربي والتمييز البصري. */
    barcode?: boolean;
  };
  filters?: React.ReactNode;
  /** عدد الفلاتر المفعّلة حالياً، من دون حقل البحث. */
  activeFilterCount?: number;
  /** عند تمريرها يظهر إجراء موحّد لمسح البحث والفلاتر النشطة. */
  onResetFilters?: () => void;
  exportSpec?: ExportSpec<T>;
  onImport?: () => void;
  importLabel?: string;
  onPrint?: () => void;
  printLabel?: string;
  printDisabled?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshLabel?: string;
  add?: AddSpec;
  children?: React.ReactNode;
};

export function ListToolbar<T>({
  title,
  count,
  loading,
  search,
  filters,
  activeFilterCount = 0,
  onResetFilters,
  exportSpec,
  onImport,
  importLabel = "استيراد",
  onPrint,
  printLabel = "طباعة",
  printDisabled = false,
  onRefresh,
  refreshing = false,
  refreshLabel = "تحديث",
  add,
  children,
}: ListToolbarProps<T>) {
  const formats = exportSpec?.formats ?? ["xlsx"];
  const [exporting, setExporting] = React.useState(false);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const filtersId = React.useId();
  const barcodeInput = useBarcodeInput(
    (code) => search?.onChange(code),
    { enabled: Boolean(search?.barcode) },
  );
  // مع fetchAll نُتيح التصدير حتى لو كانت الصفحة الحالية فارغة (قد توجد نتائج في صفحات أخرى).
  const exportDisabled =
    !exportSpec || exporting || (!exportSpec.fetchAll && exportSpec.rows.length === 0);

  // متزامنة عمداً: exportRows تفتح حوار «حفظ باسم» داخل إيماءة النقر نفسها —
  // أي await هنا قبلها (كجلب fetchAll) يُبطل الإيماءة فيسقط الحوار للتنزيل التقليدي.
  function doExport(format: "xlsx" | "csv") {
    if (!exportSpec) return;
    const opts = {
      filename: exportSpec.filename,
      columns: exportSpec.columns,
      sheetName: exportSpec.sheetName,
      format,
    };
    if (!exportSpec.fetchAll) {
      if (exportSpec.rows.length === 0) {
        notify.err("لا بيانات للتصدير");
        return;
      }
      exportRows(exportSpec.rows, opts);
      return;
    }
    // نمرّر دالة الجلب نفسها: الحوار يُفتح فوراً والجلب يجري بالتوازي (المؤشّر يبقى يعمل).
    const fetchAll = exportSpec.fetchAll;
    setExporting(true);
    exportRows(() => fetchAll().finally(() => setExporting(false)), opts);
  }

  // إعادة التصميم (١٢/٨/٢٦): صفَّان بنيوياً — عنوان+إجراءات فوق، صندوق فلاتر مؤطَّر تحت. زرّ
  // «الفلاتر» المنسدل السابق كان يكتب `data-open` بلا CSS ⇒ منسدلٌ موهوم لا أثر له. الآن
  // الفلاتر ظاهرة داخل قسمها الخاصّ بشكلٍ متّسق. زرّ الطيّ يظهر على sm فأدنى فقط (مساحة الشاشة
  // ضيقة)، ومسحُ الفلاتر داخل القسم لا يزاحم الإجراءات.
  const hasFilterSection = Boolean(search || filters || activeFilterCount > 0 || onResetFilters);
  const [filtersCollapsed, setFiltersCollapsed] = React.useState(false);
  void filtersOpen; void setFiltersOpen; void filtersId; // — أُبقيَ الـuseState/useId للتوافق مع المستهلكين.

  const showResetButton = onResetFilters && (activeFilterCount > 0 || Boolean(search?.value.trim()));

  return (
    <div className="flex flex-col gap-2.5">
      {/* الصفّ ١: عنوان+عدد ⟵ إجراءات (استيراد/تحديث/تصدير/طباعة/إضافة). البحث والفلاتر انتقلا للصفّ ٢. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {title != null && <span className="text-base font-semibold">{title}</span>}
          {(count != null || loading) && (
            <span className="text-xs text-muted-foreground">
              {loading ? "جارٍ التحميل…" : `${(count ?? 0).toLocaleString("ar-IQ-u-nu-latn")} صفّ`}
            </span>
          )}
        </div>
        <div className="list-toolbar-actions flex flex-wrap items-center gap-2">
          {onImport && (
            <Button variant="outline" size="sm" onClick={onImport}>
              <Upload className="size-4" />
              {importLabel}
            </Button>
          )}
          {onRefresh && (
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
              <RefreshCcw aria-hidden className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
              {refreshing ? "جارٍ التحديث…" : refreshLabel}
            </Button>
          )}
          {exportSpec &&
            (formats.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={exportDisabled}>
                    {exporting ? <Loader2 className="size-4 animate-spin" /> : <FileSpreadsheet className="size-4" />}
                    {exporting ? "جارٍ التحضير…" : "تصدير"}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {formats.includes("xlsx") && (
                    <DropdownMenuItem onSelect={() => doExport("xlsx")}>Excel (.xlsx)</DropdownMenuItem>
                  )}
                  {formats.includes("csv") && (
                    <DropdownMenuItem onSelect={() => doExport("csv")}>CSV (.csv)</DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button variant="outline" size="sm" disabled={exportDisabled} onClick={() => doExport(formats[0])}>
                {exporting ? <Loader2 className="size-4 animate-spin" /> : <FileSpreadsheet className="size-4" />}
                {exporting ? "جارٍ التحضير…" : "تصدير Excel"}
              </Button>
            ))}
          {onPrint && (
            <Button variant="outline" size="sm" onClick={onPrint} disabled={printDisabled}>
              <Printer className="size-4" />
              {printLabel}
            </Button>
          )}
          {add &&
            ("href" in add ? (
              <Button asChild size="sm">
                <Link href={add.href}>
                  <Plus className="size-4" />
                  {add.label ?? "إضافة"}
                </Link>
              </Button>
            ) : (
              <Button size="sm" onClick={add.onClick}>
                <Plus className="size-4" />
                {add.label ?? "إضافة"}
              </Button>
            ))}
          {children}
        </div>
      </div>

      {/* الصفّ ٢: صندوق فلاتر مؤطَّر (يظهر فقط عند وجود بحث/فلاتر). طيّة اختياريّة على mobile فقط
          كي لا يبتلع الفلاتر الشاشة الصغيرة، وعلى sm فأعلى يبقى ظاهراً دائماً. */}
      {hasFilterSection && (
        <div className="list-toolbar-filter-panel rounded-lg border border-border/60 bg-muted/30 p-2.5">
          <div className="flex items-center justify-between gap-2 sm:hidden">
            <button
              type="button"
              onClick={() => setFiltersCollapsed((v) => !v)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"
              aria-expanded={!filtersCollapsed}
            >
              <SlidersHorizontal aria-hidden className="size-3.5" />
              الفلاتر
              {activeFilterCount > 0 && (
                <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-primary">
                  {activeFilterCount.toLocaleString("ar-IQ-u-nu-latn")}
                </span>
              )}
            </button>
            {showResetButton && (
              <Button variant="ghost" size="sm" onClick={onResetFilters} className="h-7 gap-1 text-muted-foreground">
                <X aria-hidden className="size-3.5" /> مسح
              </Button>
            )}
          </div>
          <div className={cn("flex flex-wrap items-end gap-x-3 gap-y-2", filtersCollapsed && "hidden sm:flex")}>
            {search && (
              <div className={cn("relative min-w-48 flex-1 sm:flex-none", search.barcode && "w-full sm:min-w-80")}>
                <Search
                  className={cn(
                    "pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-muted-foreground",
                    search.barcode ? "left-2" : "right-2",
                  )}
                />
                <Input
                  type="search"
                  value={search.value}
                  onChange={(e) => search.onChange(
                    search.barcode ? normalizeKnownSystemBarcode(e.target.value) : e.target.value,
                  )}
                  onKeyDown={(e) => barcodeInput.handleKeyDown(e, search.onChange)}
                  placeholder={search.placeholder ?? "بحث…"}
                  aria-label={search.ariaLabel ?? search.placeholder ?? "بحث في القائمة"}
                  className={cn(
                    "h-8 w-full pr-8 sm:w-64",
                    search.barcode && `pl-8 sm:w-80 ${barcodeSearchInputClass}`,
                  )}
                />
                {search.barcode && <BarcodeSearchCue />}
              </div>
            )}
            {filters}
            {activeFilterCount > 0 && (
              <span className="hidden sm:inline-flex h-8 items-center gap-1 rounded-md bg-primary/10 px-2.5 text-xs font-semibold text-primary">
                <SlidersHorizontal aria-hidden className="size-3.5" />
                {activeFilterCount.toLocaleString("ar-IQ-u-nu-latn")} فلاتر
              </span>
            )}
            {showResetButton && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onResetFilters}
                className="hidden sm:inline-flex text-muted-foreground"
              >
                <X aria-hidden className="size-4" />
                مسح الفلاتر
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
