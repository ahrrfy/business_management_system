import * as React from "react";
import { Download, Loader2 } from "lucide-react";
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
  parseSheet,
  type ColumnMapping,
  type ImportParseResult,
} from "@/lib/import";
import { ImportFileStep } from "./ImportFileStep";
import { ImportMappingStep } from "./ImportMappingStep";
import { ImportResultStep } from "./ImportResultStep";
import { useImportPreview } from "./useImportPreview";
import { useImportExecution } from "./useImportExecution";
import type { ImportDialogProps } from "./types";

export function ImportSession<TRow>({
  open,
  onOpenChange,
  title,
  entityName,
  fields,
  onImport,
  onDone,
  maxBytes = 5 * 1024 * 1024,
  meta,
}: ImportDialogProps<TRow>) {
  const [step, setStep] = React.useState<"file" | "map">("file");
  const [reading, setReading] = React.useState(false);
  const [fileName, setFileName] = React.useState("");
  const [parse, setParse] = React.useState<ImportParseResult | null>(null);
  const [mapping, setMapping] = React.useState<ColumnMapping<TRow>>({});
  const [usdRate, setUsdRate] = React.useState("");
  const [skipFailed, setSkipFailed] = React.useState(true);
  const [balanceSign, setBalanceSign] = React.useState<"asIs" | "invert">(
    meta?.balanceSignDefault ?? "asIs",
  );
  const request = React.useRef(0);
  React.useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  const preview = useImportPreview({
    fields,
    meta,
    parse,
    mapping,
    skipFailed,
    usdRate,
    balanceSign,
  });
  const execution = useImportExecution({
    preview,
    onImport,
    onDone,
    usdRate,
    balanceSign,
    skipFailed,
  });
  const close = () => {
    if (!execution.lock.current) onOpenChange(false);
  };

  async function onFile(file?: File) {
    if (!file || execution.lock.current) return;
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      notify.err(new Error("الصيغة غير مدعومة — استخدم ملف .xlsx أو .csv"));
      return;
    }
    if (file.size > maxBytes) {
      notify.err(
        new Error(
          `الملف كبير جداً (الحدّ ${Math.round(maxBytes / 1024 / 1024)}MB).`,
        ),
      );
      return;
    }
    const token = ++request.current;
    setReading(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      const result = await parseSheet(file);
      if (token !== request.current) return;
      if (result.totalRows === 0) {
        notify.err(new Error("لا صفوف بيانات في الملف."));
        return;
      }
      setFileName(file.name);
      setParse(result);
      setMapping(autoMapColumns(result.headers, fields));
      setBalanceSign(preview.effectiveMeta?.balanceSignDefault ?? "asIs");
      setStep("map");
    } catch {
      if (token === request.current)
        notify.err(new Error("تعذّرت قراءة الملف — تأكّد أنه Excel/CSV سليم."));
    } finally {
      if (token === request.current) setReading(false);
    }
  }
  function downloadTemplate() {
    exportRows([{} as TRow], {
      filename: `قالب-${entityName}`,
      columns: fields.map((field) => ({
        key: field.key,
        header: field.required ? `${field.label}*` : field.label,
        map: () => field.example ?? "",
      })),
    });
  }
  const errorRows =
    execution.step === "done" && execution.summary
      ? execution.summary.rows
          .filter((row) => row.status === "failed" || row.status === "skipped")
          .map((row) => ({
            row: row.rowNumber,
            errors:
              row.message ?? (row.status === "failed" ? "فاشل" : "متجاوَز"),
          }))
      : preview.checked
          .filter((row) => row.errors.length > 0)
          .map((row) => ({
            row: row.rowNumber,
            errors: row.errors.map((error) => error.message).join(" • "),
          }));
  const exportErrorLog = () =>
    exportRows(errorRows, {
      filename: `أخطاء-استيراد-${entityName}`,
      columns: [
        { key: "row", header: "الصف" },
        { key: "errors", header: "الأخطاء" },
      ],
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <DialogContent
        dir="rtl"
        showCloseButton={!execution.busy}
        className="flex max-h-[88dvh] w-[calc(100vw-2rem)] min-w-0 flex-col overflow-hidden p-4 sm:w-[calc(100vw-2rem)] sm:max-w-[900px]"
      >
        <DialogHeader className="shrink-0 sm:text-right">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            ارفع ملف Excel/CSV وراجع المعاينة وخيار تجاوز الصفوف الفاشلة.
            الملفات الكبيرة تُرسل دفعات، كل دفعة ذرّية على حدة.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {execution.step === "running" ? (
            <div
              className="flex flex-col items-center gap-3 py-5"
              role="status"
              aria-live="polite"
              aria-busy="true"
            >
              <Loader2
                className="size-8 animate-spin text-primary"
                aria-hidden="true"
              />
              <div className="text-sm">
                {execution.phase === "dry"
                  ? "جولة فحص تمهيدية (بلا كتابة)…"
                  : "جارٍ الاستيراد… لا تُغلق النافذة"}
              </div>
              {execution.progress && (
                <div className="w-full max-w-64 space-y-1">
                  <Progress
                    value={
                      execution.progress.total
                        ? (execution.progress.done / execution.progress.total) *
                          100
                        : 0
                    }
                    aria-label="تقدّم الاستيراد"
                  />
                  <div className="text-center text-xs text-muted-foreground">
                    {execution.progress.done} / {execution.progress.total}
                  </div>
                </div>
              )}
            </div>
          ) : execution.step === "done" && execution.summary ? (
            <ImportResultStep
              summary={execution.summary}
              batchNote={execution.batchNote}
              writtenCount={execution.writtenCount}
            />
          ) : step === "map" && parse ? (
            <ImportMappingStep
              {...{
                preview,
                fileName,
                parse,
                fields,
                mapping,
                setMapping,
                skipFailed,
                setSkipFailed,
                usdRate,
                setUsdRate,
                balanceSign,
                setBalanceSign,
                exportErrorLog,
              }}
              changeFile={() => setStep("file")}
            />
          ) : (
            <ImportFileStep
              reading={reading}
              onFile={onFile}
              downloadTemplate={downloadTemplate}
            />
          )}
        </div>
        <DialogFooter className="shrink-0 flex-wrap">
          {execution.step === "idle" && step === "map" && (
            <Button
              className="h-auto min-h-9 whitespace-normal"
              onClick={() => void execution.run()}
              disabled={!preview.canRun}
            >
              {preview.invalidCount > 0 && !skipFailed
                ? `صحّح ${preview.invalidCount} صفّاً أولاً`
                : preview.invalidCount > 0
                  ? `استيراد ${preview.validRows.length} وتجاوز ${preview.invalidCount} فاشلاً`
                  : `استيراد ${preview.validRows.length} صفّاً`}
            </Button>
          )}
          {execution.step === "done" && (
            <>
              {errorRows.length > 0 && (
                <Button variant="outline" onClick={exportErrorLog}>
                  <Download className="size-4" />
                  تصدير سجلّ الأخطاء
                </Button>
              )}
              <Button
                onClick={close}
                disabled={execution.busy}
                variant="outline"
              >
                إغلاق
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
