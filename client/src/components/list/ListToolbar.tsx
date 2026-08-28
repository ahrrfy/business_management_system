// شريط أدوات القائمة الموحّد: بحث/فلاتر/استيراد/تصدير/طباعة/إضافة بترتيب ثابت.
// يعمل داخل فتحة toolbar في DataTable وفي الصفحات اليدوية. يعيد استخدام exportRows.
//   <ListToolbar title="القائمة" count={total} loading={list.isLoading}
//     exportSpec={{ filename: "العملاء", rows, columns: [...] }}
//     onImport={() => setImportOpen(true)} add={{ href: "/customers/new", label: "عميل جديد" }} />
import * as React from "react";
import { FileSpreadsheet, Loader2, MoreHorizontal, Plus, Printer, RefreshCcw, Search, SlidersHorizontal, Upload, X } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { exportRows, type ExportColumn } from "@/lib/export";
import { notify } from "@/lib/notify";
import { BarcodeSearchCue, barcodeSearchInputClass } from "@/components/scan/BarcodeSearchCue";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { cn } from "@/lib/utils";
import { normalizeKnownSystemBarcode } from "@/lib/barcodeScannerInput";
import { WorkspaceBar } from "@/components/workspace/OperationalWorkspace";

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
type SecondaryAction = {
  label: string;
  onSelect: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
};

export type ListToolbarProps<T> = {
  title?: React.ReactNode;
  /** يرسم عنوان الشريط كعنوان الصفحة الدلالي حين يكون هو الرأس الوحيد للشاشة. */
  pageTitle?: boolean;
  count?: number;
  loading?: boolean;
  search?: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    ariaLabel?: string;
    /** الحقل يقبل قارئ HID: يفعّل تصحيح التخطيط العربي والتمييز البصري. */
    barcode?: boolean;
    /** ٢٤/٨ — تركيزٌ تلقائيّ عند تركيب الشاشة. مفيدٌ للشاشات المفتوحة يومياً للكتابة الفوريّة. */
    autoFocus?: boolean;
  };
  /** فلاتر عالية التكرار تبقى في الصف الثاني (فترة/فرع مثلاً)؛ البقية داخل اللوحة الجانبية. */
  quickFilters?: React.ReactNode;
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
  /** أوامر قليلة التكرار تُدمج مع قائمة «المزيد» بدلاً من مزاحمة الإجراء الأساسي. */
  secondaryActions?: SecondaryAction[];
  children?: React.ReactNode;
};

export function ListToolbar<T>({
  title,
  pageTitle = false,
  count,
  loading,
  search,
  quickFilters,
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
  secondaryActions,
  children,
}: ListToolbarProps<T>) {
  const formats = exportSpec?.formats ?? ["xlsx"];
  const [exporting, setExporting] = React.useState(false);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const barcodeInput = useBarcodeInput((code) => search?.onChange(code), {
    enabled: Boolean(search?.barcode),
  });
  // مع fetchAll نُتيح التصدير حتى لو كانت الصفحة الحالية فارغة (قد توجد نتائج في صفحات أخرى).
  const exportDisabled = !exportSpec || exporting || (!exportSpec.fetchAll && exportSpec.rows.length === 0);

  /**
   * كشف الفقدان الصامت: القائمة مُصفَّحة خادمياً (`count > rows.length`) ولا `fetchAll`.
   * الضغط على التصدير الآن سيُصدّر **الصفحة الحالية فقط** بينما المستخدم يظنّ أنه صدَّر
   * كامل المطابقات — بلاغ المالك ٦/٨: «فاتورة ٢٠١ من سقف ٢٠٠ لا تُرى ولا تُصدَّر ولا تُبحَث».
   * نعرض شارة توضّح النطاق ونصّاً في tooltip. أفضل: مرّر `fetchAll` للتصدير الكامل.
   */
  const willExportPartial = Boolean(exportSpec?.fetchAll == null && count != null && count > (exportSpec?.rows.length ?? 0));
  const partialExportHint = willExportPartial
    ? `سيُصدَّر ${(exportSpec?.rows.length ?? 0).toLocaleString("ar-IQ-u-nu-latn")} من ${(count ?? 0).toLocaleString("ar-IQ-u-nu-latn")} — الصفحة المعروضة فقط.`
    : undefined;

  /**
   * إثراء اسم الملف تلقائياً بالتاريخ+الوقت — كان الاسم مثل «العملاء.xlsx» يُعاد كتابته
   * كلّ تصدير ⇒ ملفّات متعدّدة بنفس الاسم يستبدل بعضها بعضاً في مجلّد التنزيلات.
   * الآن: «العملاء_2026-08-25_12-35.xlsx». لا تكرار ولا التباس بأيّ لقطة أحدث.
   */
  function stampFilename(base: string): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
    return `${base}_${stamp}`;
  }

  // متزامنة عمداً: exportRows تفتح حوار «حفظ باسم» داخل إيماءة النقر نفسها —
  // أي await هنا قبلها (كجلب fetchAll) يُبطل الإيماءة فيسقط الحوار للتنزيل التقليدي.
  function doExport(format: "xlsx" | "csv") {
    if (!exportSpec) return;
    const opts = {
      filename: stampFilename(exportSpec.filename),
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

  // عقد مساحة العمل: صف أوامر واحد + صف بحث/فلاتر واحد. الفلاتر الثانوية داخل Sheet ولا
  // تُنشئ صفوفاً إضافية فوق البيانات، والإجراءات الأقل تكراراً داخل قائمة «المزيد».
  const hasFilterSection = Boolean(search || quickFilters || filters || activeFilterCount > 0 || onResetFilters);
  const showResetButton = onResetFilters && (activeFilterCount > 0 || Boolean(search?.value.trim()));
  const hasSecondaryActions = Boolean(onImport || onRefresh || exportSpec || onPrint || secondaryActions?.length);

  return (
    <div className="flex flex-col gap-2" data-operational-toolbar>
      <WorkspaceBar variant="command" label="أوامر القائمة" className="justify-between overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          {title != null && (pageTitle ? <h1 className="text-base font-semibold">{title}</h1> : <span className="text-base font-semibold">{title}</span>)}
          {(count != null || loading) && <span className="shrink-0 text-xs text-muted-foreground">{loading ? "جارٍ التحميل…" : `${(count ?? 0).toLocaleString("ar-IQ-u-nu-latn")} صفّ`}</span>}
        </div>
        <div className="list-toolbar-actions flex min-w-max shrink-0 items-center gap-1.5 whitespace-nowrap [&>*]:shrink-0">
          {add &&
            ("href" in add ? (
              <Button asChild size="sm" className="h-8">
                <Link href={add.href}>
                  <Plus className="size-4" />
                  {add.label ?? "إضافة"}
                </Link>
              </Button>
            ) : (
              <Button size="sm" className="h-8" onClick={add.onClick}>
                <Plus className="size-4" />
                {add.label ?? "إضافة"}
              </Button>
            ))}
          {children}
          {hasSecondaryActions && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8" aria-label="المزيد من إجراءات القائمة">
                  {exporting || refreshing ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <MoreHorizontal aria-hidden className="size-4" />}
                  المزيد
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuLabel>إجراءات القائمة</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {onRefresh && (
                  <DropdownMenuItem disabled={refreshing} onSelect={() => onRefresh()}>
                    <RefreshCcw aria-hidden className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
                    {refreshing ? "جارٍ التحديث…" : refreshLabel}
                  </DropdownMenuItem>
                )}
                {secondaryActions?.map((action) => (
                  <DropdownMenuItem key={action.label} disabled={action.disabled} onSelect={() => action.onSelect()}>
                    {action.icon}
                    {action.label}
                  </DropdownMenuItem>
                ))}
                {onImport && (
                  <DropdownMenuItem onSelect={() => onImport()}>
                    <Upload aria-hidden className="size-4" />
                    {importLabel}
                  </DropdownMenuItem>
                )}
                {exportSpec && formats.includes("xlsx") && (
                  <DropdownMenuItem disabled={exportDisabled} onSelect={() => doExport("xlsx")} title={partialExportHint}>
                    <FileSpreadsheet aria-hidden className="size-4" />
                    {exporting ? "جارٍ التحضير…" : "تصدير Excel"}
                    {willExportPartial && <span className="ms-auto text-2xs text-[var(--sem-warn)]">الصفحة الحالية</span>}
                  </DropdownMenuItem>
                )}
                {exportSpec && formats.includes("csv") && (
                  <DropdownMenuItem disabled={exportDisabled} onSelect={() => doExport("csv")} title={partialExportHint}>
                    <FileSpreadsheet aria-hidden className="size-4" />
                    {exporting ? "جارٍ التحضير…" : "تصدير CSV"}
                    {willExportPartial && <span className="ms-auto text-2xs text-[var(--sem-warn)]">الصفحة الحالية</span>}
                  </DropdownMenuItem>
                )}
                {onPrint && (
                  <DropdownMenuItem disabled={printDisabled} onSelect={() => onPrint()}>
                    <Printer aria-hidden className="size-4" />
                    {printLabel}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </WorkspaceBar>

      {hasFilterSection && (
        <WorkspaceBar variant="filters" label="البحث والفلاتر" className="list-toolbar-filter-panel overflow-hidden">
          {search && (
            <div className={cn("relative min-w-0 flex-1 sm:min-w-40", search.barcode && "sm:min-w-64")}>
              <Search className={cn("pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-muted-foreground", search.barcode ? "left-2" : "right-2")} />
              <Input
                type="search"
                autoFocus={search.autoFocus}
                value={search.value}
                onChange={(e) => search.onChange(search.barcode ? normalizeKnownSystemBarcode(e.target.value) : e.target.value)}
                onKeyDown={(e) => barcodeInput.handleKeyDown(e, search.onChange)}
                placeholder={search.placeholder ?? "بحث…"}
                aria-label={search.ariaLabel ?? search.placeholder ?? "بحث في القائمة"}
                className={cn("h-8 w-full pr-8", search.barcode && `pl-8 ${barcodeSearchInputClass}`)}
              />
              {search.barcode && <BarcodeSearchCue />}
            </div>
          )}
          {quickFilters && <div className="hidden min-w-0 overflow-x-auto sm:block [&>div]:!flex-nowrap">{quickFilters}</div>}
          {(filters || quickFilters || activeFilterCount > 0) && (
            <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 shrink-0">
                  <SlidersHorizontal aria-hidden className="size-3.5" />
                  الفلاتر
                  {activeFilterCount > 0 && <span className="rounded bg-primary px-1.5 text-2xs font-bold text-primary-foreground">{activeFilterCount.toLocaleString("ar-IQ-u-nu-latn")}</span>}
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[min(92vw,34rem)] sm:max-w-lg">
                <SheetHeader className="border-b">
                  <SheetTitle>فلاتر القائمة</SheetTitle>
                  <SheetDescription>الفلاتر الثانوية محفوظة خارج مساحة البيانات وتظهر نتائجها فوراً.</SheetDescription>
                </SheetHeader>
                <div className="grid min-h-0 flex-1 grid-cols-1 content-start gap-3 overflow-y-auto p-4 sm:grid-cols-2">
                  {quickFilters && <div className="sm:hidden">{quickFilters}</div>}
                  {filters}
                </div>
                <SheetFooter className="flex-row border-t">
                  {showResetButton && (
                    <Button type="button" variant="ghost" onClick={onResetFilters}>
                      مسح الفلاتر
                    </Button>
                  )}
                  <SheetClose asChild>
                    <Button type="button" className="ms-auto">
                      عرض النتائج
                    </Button>
                  </SheetClose>
                </SheetFooter>
              </SheetContent>
            </Sheet>
          )}
          {showResetButton && (
            <Button variant="ghost" size="sm" onClick={onResetFilters} className="h-8 shrink-0 text-muted-foreground">
              <X aria-hidden className="size-3.5" />
              مسح
            </Button>
          )}
        </WorkspaceBar>
      )}
    </div>
  );
}
