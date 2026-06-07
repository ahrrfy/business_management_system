// حوار الاستيراد الموحّد (Products/Customers/Suppliers): ملف → اختيار أعمدة ذكي → معاينة/تحقّق → تنفيذ ذرّي → ملخّص.
// التحقّق على مستوى الواجهة بوّابة أولى؛ لا يُرسَل شيء ما لم تَخلُ كل الصفوف من الأخطاء (الكل-أو-لا-شيء)،
// والخادم يعيد التحقّق ويكتب داخل معاملة واحدة (دفاع متعدّد الطبقات).
import * as React from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { exportRows } from "@/lib/export";
import { notify } from "@/lib/notify";
import {
  autoMapColumns,
  buildRows,
  parseSheet,
  type ColumnMapping,
  type ImportField,
  type ImportHandler,
  type ImportParseResult,
  type ImportSummary,
  type ParsedRow,
} from "@/lib/import";

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const PREVIEW_LIMIT = 100;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export type ImportDialogProps<TRow> = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  entityName: string;
  fields: ImportField<TRow>[];
  onImport: ImportHandler<TRow>;
  onDone?: (summary: ImportSummary) => void;
  maxBytes?: number;
};

type Step = "file" | "map" | "running" | "done";

export function ImportDialog<TRow>({
  open,
  onOpenChange,
  title,
  entityName,
  fields,
  onImport,
  onDone,
  maxBytes = DEFAULT_MAX_BYTES,
}: ImportDialogProps<TRow>) {
  const [step, setStep] = React.useState<Step>("file");
  const [fileName, setFileName] = React.useState("");
  const [parse, setParse] = React.useState<ImportParseResult | null>(null);
  const [mapping, setMapping] = React.useState<ColumnMapping<TRow>>({});
  const [summary, setSummary] = React.useState<ImportSummary | null>(null);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  function reset() {
    setStep("file");
    setFileName("");
    setParse(null);
    setMapping({});
    setSummary(null);
    setProgress(null);
    setBusy(false);
  }

  function close() {
    if (busy) return; // لا تُغلق أثناء التنفيذ
    onOpenChange(false);
    // تأخير إعادة الضبط حتى ينتهي انتقال الإغلاق
    setTimeout(reset, 200);
  }

  function downloadTemplate() {
    const example = {} as TRow;
    exportRows([example], {
      filename: `قالب-${entityName}`,
      columns: fields.map((f) => ({
        key: f.key,
        header: f.required ? `${f.label}*` : f.label,
        map: () => f.example ?? "",
      })),
    });
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      notify.err(new Error("الصيغة غير مدعومة — استخدم ملف .xlsx أو .csv"));
      return;
    }
    if (file.size > maxBytes) {
      notify.err(new Error(`الملف كبير جداً (الحدّ ${Math.round(maxBytes / 1024 / 1024)}MB).`));
      return;
    }
    try {
      const result = await parseSheet(file);
      if (result.totalRows === 0) {
        notify.err(new Error("لا صفوف بيانات في الملف."));
        return;
      }
      setFileName(file.name);
      setParse(result);
      setMapping(autoMapColumns(result.headers, fields));
      setStep("map");
    } catch {
      notify.err(new Error("تعذّرت قراءة الملف — تأكّد أنه Excel/CSV سليم."));
    }
  }

  const built: ParsedRow<TRow>[] = React.useMemo(
    () => (parse ? buildRows(parse, mapping, fields) : []),
    [parse, mapping, fields],
  );
  const invalidCount = built.filter((r) => r.errors.length > 0).length;
  const validRows = built.filter((r) => r.errors.length === 0);

  const mappedFieldKeys = new Set(Object.values(mapping).filter(Boolean) as string[]);
  const unmappedRequired = fields.filter((f) => f.required && !mappedFieldKeys.has(f.key));

  async function runImport() {
    if (!validRows.length || invalidCount > 0 || unmappedRequired.length) return;
    setBusy(true);
    setStep("running");
    setProgress({ done: 0, total: validRows.length });
    try {
      const result = await onImport(
        validRows.map((r) => ({ ...(r.values as TRow), rowNumber: r.rowNumber })),
        { onProgress: (done, total) => setProgress({ done, total }) },
      );
      setSummary(result);
      setStep("done");
      if (result.committed && result.failed === 0) {
        notify.ok(`تم استيراد ${result.created + result.updated} سجلّاً`);
      } else if (!result.committed) {
        notify.err(new Error("لم يُستورَد شيء — راجِع تفاصيل الأخطاء."));
      }
      onDone?.(result);
    } catch (e) {
      notify.err(e);
      setStep("map");
    } finally {
      setBusy(false);
    }
  }

  function exportErrorLog() {
    const rows = built
      .filter((r) => r.errors.length > 0)
      .map((r) => ({ row: r.rowNumber, errors: r.errors.map((e) => e.message).join(" • ") }));
    exportRows(rows, {
      filename: `أخطاء-استيراد-${entityName}`,
      columns: [
        { key: "row", header: "الصف" },
        { key: "errors", header: "الأخطاء" },
      ],
    });
  }

  // أعمدة المعاينة = الحقول المربوطة بالترتيب.
  const previewFields = fields.filter((f) => mappedFieldKeys.has(f.key));

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent
        dir="rtl"
        showCloseButton={!busy}
        className="max-h-[88vh] w-[min(95vw,900px)] max-w-[min(95vw,900px)] overflow-hidden sm:max-w-[min(95vw,900px)]"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            ارفع ملف Excel/CSV. لن يُكتب شيء حتى تَخلو كل الصفوف من الأخطاء (الكل أو لا شيء).
          </DialogDescription>
        </DialogHeader>

        {/* الخطوة ١: اختيار الملف */}
        {step === "file" && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void onFile(e.dataTransfer.files?.[0]);
              }}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-10 text-center text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/40"
            >
              <Upload className="size-7" />
              <span className="text-sm font-medium text-foreground">اختر ملفاً أو أفلِته هنا</span>
              <span className="text-xs">صيغ مدعومة: .xlsx · .csv</span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                لا تملك قالباً؟ نزّل قالباً فارغاً بالأعمدة الصحيحة.
              </span>
              <Button variant="outline" size="sm" onClick={downloadTemplate}>
                <Download className="size-4" />
                تنزيل القالب
              </Button>
            </div>
          </div>
        )}

        {/* الخطوة ٢: المطابقة والمعاينة */}
        {step === "map" && parse && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-1 text-muted-foreground">
                <FileSpreadsheet className="size-4" />
                {fileName} — {parse.totalRows.toLocaleString("ar-IQ")} صفّ
              </span>
              <Button variant="ghost" size="sm" onClick={() => setStep("file")}>
                تغيير الملف
              </Button>
            </div>

            {/* مطابقة الأعمدة */}
            <div className="rounded-md border p-2">
              <div className="mb-2 text-xs font-medium">مطابقة الأعمدة</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {parse.headers.map((h) => (
                  <label key={h} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-mono" title={h} dir="auto">
                      {h || "(فارغ)"}
                    </span>
                    <select
                      className={selectCls}
                      value={(mapping[h] as string) ?? ""}
                      onChange={(e) =>
                        setMapping((m) => ({
                          ...m,
                          [h]: (e.target.value || null) as (keyof TRow & string) | null,
                        }))
                      }
                    >
                      <option value="">— تجاهل —</option>
                      {fields.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>

            {unmappedRequired.length > 0 && (
              <div className="flex items-center gap-2 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">
                <AlertCircle className="size-4 shrink-0" />
                حقول مطلوبة غير مربوطة: {unmappedRequired.map((f) => f.label).join("، ")}
              </div>
            )}

            {/* المعاينة */}
            <div className="min-h-0 flex-1 overflow-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                  <tr className="text-right">
                    <th className="p-2 w-10">#</th>
                    {previewFields.map((f) => (
                      <th key={f.key} className="p-2 whitespace-nowrap">
                        {f.label}
                      </th>
                    ))}
                    <th className="p-2">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {built.slice(0, PREVIEW_LIMIT).map((r) => (
                    <tr
                      key={r.rowNumber}
                      className={`border-t ${r.errors.length ? "bg-rose-50/60" : ""}`}
                    >
                      <td className="p-2 text-muted-foreground">{r.rowNumber}</td>
                      {previewFields.map((f) => (
                        <td key={f.key} className="p-2 whitespace-nowrap" dir="auto">
                          {formatCell((r.values as Record<string, unknown>)[f.key])}
                        </td>
                      ))}
                      <td className="p-2">
                        {r.errors.length ? (
                          <span className="text-rose-700" title={r.errors.map((e) => e.message).join("\n")}>
                            {r.errors[0].message}
                            {r.errors.length > 1 ? ` (+${r.errors.length - 1})` : ""}
                          </span>
                        ) : (
                          <CheckCircle2 className="size-4 text-emerald-600" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {built.length > PREVIEW_LIMIT && (
                <div className="p-2 text-center text-xs text-muted-foreground">
                  عرض أوّل {PREVIEW_LIMIT} من {built.length.toLocaleString("ar-IQ")} صفّ (يُتحقَّق من الكل)
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-emerald-700">صحيح: {validRows.length.toLocaleString("ar-IQ")}</span>
              {invalidCount > 0 && (
                <span className="text-rose-700">به أخطاء: {invalidCount.toLocaleString("ar-IQ")}</span>
              )}
              {invalidCount > 0 && (
                <Button variant="ghost" size="sm" onClick={exportErrorLog}>
                  <Download className="size-4" />
                  تصدير سجلّ الأخطاء
                </Button>
              )}
            </div>
          </div>
        )}

        {/* الخطوة ٣: التنفيذ */}
        {step === "running" && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="size-8 animate-spin text-primary" />
            <div className="text-sm">جارٍ الاستيراد…</div>
            {progress && (
              <div className="w-64 space-y-1">
                <Progress value={progress.total ? (progress.done / progress.total) * 100 : 0} />
                <div className="text-center text-xs text-muted-foreground">
                  {progress.done.toLocaleString("ar-IQ")} / {progress.total.toLocaleString("ar-IQ")}
                </div>
              </div>
            )}
          </div>
        )}

        {/* الخطوة ٤: الملخّص */}
        {step === "done" && summary && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <SummaryPill label="مُنشأ" value={summary.created} cls="text-emerald-700 bg-emerald-50" />
              <SummaryPill label="محدَّث" value={summary.updated} cls="text-sky-700 bg-sky-50" />
              <SummaryPill label="متجاوَز" value={summary.skipped} cls="text-amber-700 bg-amber-50" />
              <SummaryPill label="فاشل" value={summary.failed} cls="text-rose-700 bg-rose-50" />
            </div>
            {!summary.committed && (
              <div className="flex items-center gap-2 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">
                <AlertCircle className="size-4 shrink-0" />
                لم تُكتب أي بيانات (الكل أو لا شيء) — صحّح الصفوف الفاشلة ثم أعد المحاولة.
              </div>
            )}
            {summary.rows.some((r) => r.status === "failed" || r.status === "skipped") && (
              <div className="max-h-56 overflow-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/80">
                    <tr className="text-right">
                      <th className="p-2 w-12">الصف</th>
                      <th className="p-2">الحالة</th>
                      <th className="p-2">السبب</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.rows
                      .filter((r) => r.status === "failed" || r.status === "skipped")
                      .map((r) => (
                        <tr key={r.rowNumber} className="border-t">
                          <td className="p-2 text-muted-foreground">{r.rowNumber}</td>
                          <td className="p-2">{r.status === "failed" ? "فاشل" : "متجاوَز"}</td>
                          <td className="p-2" dir="auto">{r.message ?? "—"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === "map" && (
            <Button
              onClick={() => void runImport()}
              disabled={!validRows.length || invalidCount > 0 || unmappedRequired.length > 0}
            >
              {invalidCount > 0
                ? `صحّح ${invalidCount.toLocaleString("ar-IQ")} صفّاً أولاً`
                : `استيراد ${validRows.length.toLocaleString("ar-IQ")} صفّاً`}
            </Button>
          )}
          {step === "done" && (
            <Button onClick={close} variant="outline">
              إغلاق
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryPill({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className={`rounded-md px-3 py-2 text-center ${cls}`}>
      <div className="text-lg font-bold tabular-nums">{value.toLocaleString("ar-IQ")}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "نعم" : "لا";
  return String(v);
}
