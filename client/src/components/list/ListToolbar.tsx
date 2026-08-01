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

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        {title != null && <span className="text-base font-semibold">{title}</span>}
        {(count != null || loading) && (
          <span className="text-xs text-muted-foreground">
            {loading ? "جارٍ التحميل…" : `${(count ?? 0).toLocaleString("ar-IQ-u-nu-latn")} صفّ`}
          </span>
        )}
      </div>

      <div className="list-toolbar-actions flex flex-wrap items-end gap-2">
        {search && (
          <div className="relative min-w-48 flex-1 sm:flex-none">
            <Search className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder ?? "بحث…"}
              aria-label={search.ariaLabel ?? search.placeholder ?? "بحث في القائمة"}
              className="h-8 w-full pr-8 sm:w-56"
            />
          </div>
        )}

        {filters}

        {activeFilterCount > 0 && (
          <span className="inline-flex h-8 items-center gap-1 rounded-md bg-primary/10 px-2.5 text-xs font-semibold text-primary">
            <SlidersHorizontal aria-hidden className="size-3.5" />
            {activeFilterCount.toLocaleString("ar-IQ-u-nu-latn")} فلاتر
          </span>
        )}

        {onResetFilters && (activeFilterCount > 0 || Boolean(search?.value.trim())) && (
          <Button variant="ghost" size="sm" onClick={onResetFilters} className="text-muted-foreground">
            <X aria-hidden className="size-4" />
            مسح الفلاتر
          </Button>
        )}

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
            <Button
              variant="outline"
              size="sm"
              disabled={exportDisabled}
              onClick={() => doExport(formats[0])}
            >
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
  );
}
