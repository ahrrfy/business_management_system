import { useId, type Dispatch, type SetStateAction } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
} from "lucide-react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type {
  ColumnMapping,
  ImportField,
  ImportParseResult,
} from "@/lib/import";
import type { ImportPreview } from "./useImportPreview";
import { BATCH_SIZE, PREVIEW_LIMIT } from "./types";
export function ImportMappingStep<TRow>({
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
  changeFile,
  exportErrorLog,
}: {
  preview: ImportPreview<TRow>;
  fileName: string;
  parse: ImportParseResult;
  fields: ImportField<TRow>[];
  mapping: ColumnMapping<TRow>;
  setMapping: Dispatch<SetStateAction<ColumnMapping<TRow>>>;
  skipFailed: boolean;
  setSkipFailed: (value: boolean) => void;
  usdRate: string;
  setUsdRate: (value: string) => void;
  balanceSign: "asIs" | "invert";
  setBalanceSign: (value: "asIs" | "invert") => void;
  changeFile: () => void;
  exportErrorLog: () => void;
}) {
  const skipId = useId();
  const {
    checked,
    invalidCount,
    validRows,
    warningCount,
    unmappedRequired,
    balanceMapped,
    currencyField,
    currencyGuard,
    balancePreview,
    usdRateRequired,
    usdRateValid,
    plannedBatchCount,
    supportsOptions,
    effectiveMeta,
    previewFields,
  } = preview;
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1 text-muted-foreground">
          <FileSpreadsheet className="size-4" />
          {fileName} — {parse.totalRows.toLocaleString("ar-IQ-u-nu-latn")} صفّ
        </span>
        <Button variant="ghost" size="sm" onClick={changeFile}>
          تغيير الملف
        </Button>
      </div>

      {/* مطابقة الأعمدة */}
      <div className="rounded-md border p-2">
        <div className="mb-2 text-xs font-medium">مطابقة الأعمدة</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {parse.headers.map((h) => (
            <label
              key={h}
              className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs"
            >
              <span
                className="min-w-0 break-words font-mono"
                title={h}
                dir="auto"
              >
                {h || "(فارغ)"}
              </span>
              <AppSelect
                size="sm"
                className="w-48 max-w-full min-w-0 text-xs"
                aria-label={`ربط عمود ${h}`}
                value={(mapping[h] as string) ?? ""}
                onValueChange={(value) =>
                  setMapping((mapping) => ({
                    ...mapping,
                    [h]: (value || null) as (keyof TRow & string) | null,
                  }))
                }
              >
                <option value="">— تجاهل —</option>
                {fields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </AppSelect>
            </label>
          ))}
        </div>
      </div>

      {unmappedRequired.length > 0 && (
        <div className="flex items-center gap-2 rounded-md bg-[var(--sem-neg-bg)] px-3 py-2 text-xs text-[var(--sem-neg)]">
          <AlertCircle className="size-4 shrink-0" />
          حقول مطلوبة غير مربوطة:{" "}
          {unmappedRequired.map((f) => f.label).join("، ")}
        </div>
      )}

      {currencyGuard && (
        <div className="flex items-center gap-2 rounded-md border border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] px-3 py-2 text-xs font-medium text-[var(--sem-neg)]">
          <AlertCircle className="size-4 shrink-0" />
          ربطتَ الرصيد الافتتاحي بينما عمود «{currencyField?.label}» موجود في
          الملف وغير مربوط — اربطه أو افصل الرصيد، وإلا خُزّنت أرصدة USD كأنها
          دينار حرفياً.
        </div>
      )}

      {/* خيارات الاستيراد — تظهر دائماً: مفتاح «تجاوز الفاشلة» يعمل لكل الكيانات (تصفية في العميل) */}
      {
        <div className="space-y-2 rounded-md border p-2 text-xs">
          <div className="font-medium">خيارات الاستيراد</div>

          {usdRateRequired && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">سعر صرف الدولار*:</span>
              <Input
                dir="ltr"
                inputMode="decimal"
                className="h-8 w-32 text-xs"
                placeholder="1450"
                value={usdRate}
                onChange={(e) => setUsdRate(e.target.value)}
                aria-invalid={!usdRateValid}
              />
              <span className="text-muted-foreground">
                أرصدة USD ستُحوَّل إلى دينار بهذا السعر.
              </span>
              {!usdRateValid && usdRate.trim() !== "" && (
                <span className="text-[var(--sem-neg)]">
                  سعر صرف غير صالح (رقم موجب، منزلتان كحدّ أقصى).
                </span>
              )}
            </div>
          )}

          {supportsOptions && balanceMapped && (
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">اتجاه الرصيد:</span>
                <Button
                  type="button"
                  size="sm"
                  variant={balanceSign === "asIs" ? "default" : "outline"}
                  onClick={() => setBalanceSign("asIs")}
                >
                  كما في الملف
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={balanceSign === "invert" ? "default" : "outline"}
                  onClick={() => setBalanceSign("invert")}
                >
                  اعكس الإشارة
                </Button>
                {effectiveMeta?.balanceHints && (
                  <span className="text-muted-foreground">
                    موجب = {effectiveMeta.balanceHints.positive}
                  </span>
                )}
              </div>
              {balancePreview.length > 0 && (
                <ul className="space-y-0.5 rounded bg-muted/50 p-2">
                  {balancePreview.map((p) => (
                    <li key={p.rowNumber} dir="auto" className="tabular-nums">
                      صف {p.rowNumber.toLocaleString("ar-IQ-u-nu-latn")}: «
                      {p.rawText}» ⇐ {p.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Switch
              checked={skipFailed}
              onCheckedChange={setSkipFailed}
              id={skipId}
            />
            <label htmlFor={skipId} className="cursor-pointer font-medium">
              تجاوز الصفوف الفاشلة
            </label>
            <span className="text-muted-foreground">
              {skipFailed
                ? "يُستورَد الصحيح وتُتجاوَز الفاشلة (كرصيد سالب) مع تنبيه وسجلّ أخطاء قابل للتصدير."
                : "مطفأ: أي صف خاطئ يمنع الاستيراد كله (الكل أو لا شيء)."}
            </span>
          </div>

          {plannedBatchCount > 1 && (
            <div className="text-muted-foreground">
              سيُرسَل الملف على{" "}
              {plannedBatchCount.toLocaleString("ar-IQ-u-nu-latn")} دفعات (≤
              {BATCH_SIZE.toLocaleString("ar-IQ-u-nu-latn")} صفّ) — ضمانة
              «كل-أو-لا-شيء» لكل دفعة على حدة. تحقّق من البيانات المحفوظة قبل
              إعادة المحاولة؛ تخطّي الموجود يعتمد على نوع البيانات.
            </div>
          )}
        </div>
      }

      {/* المعاينة */}
      <div className="max-h-72 min-h-32 min-w-0 overflow-auto rounded-md border">
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
            {checked.slice(0, PREVIEW_LIMIT).map((r) => (
              <tr
                key={r.rowNumber}
                className={`border-t ${r.errors.length ? "bg-[var(--sem-neg-bg)]/60" : r.warnings.length ? "bg-[var(--sem-warn-bg)]/60" : ""}`}
              >
                <td className="p-2 text-muted-foreground">{r.rowNumber}</td>
                {previewFields.map((f) => (
                  <td key={f.key} className="p-2 whitespace-nowrap" dir="auto">
                    {formatCell((r.values as Record<string, unknown>)[f.key])}
                  </td>
                ))}
                <td className="p-2">
                  {r.errors.length ? (
                    <span
                      className="text-[var(--sem-neg)]"
                      title={r.errors.map((e) => e.message).join("\n")}
                    >
                      {r.errors[0].message}
                      {r.errors.length > 1 ? ` (+${r.errors.length - 1})` : ""}
                    </span>
                  ) : r.warnings.length ? (
                    <span
                      className="text-[var(--sem-warn)]"
                      title={r.warnings.map((w) => w.message).join("\n")}
                    >
                      {r.warnings[0].message}
                    </span>
                  ) : (
                    <CheckCircle2 className="size-4 text-[var(--sem-pos)]" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {checked.length > PREVIEW_LIMIT && (
          <div className="p-2 text-center text-xs text-muted-foreground">
            عرض أوّل {PREVIEW_LIMIT} من{" "}
            {checked.length.toLocaleString("ar-IQ-u-nu-latn")} صفّ (يُتحقَّق من
            الكل)
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--sem-pos)]">
          صحيح: {validRows.length.toLocaleString("ar-IQ-u-nu-latn")}
        </span>
        {warningCount > 0 && (
          <span className="text-[var(--sem-warn)]">
            بتحذيرات: {warningCount.toLocaleString("ar-IQ-u-nu-latn")}
          </span>
        )}
        {invalidCount > 0 && (
          <span className="text-[var(--sem-neg)]">
            به أخطاء: {invalidCount.toLocaleString("ar-IQ-u-nu-latn")}
          </span>
        )}
        {invalidCount > 0 && (
          <Button variant="ghost" size="sm" onClick={exportErrorLog}>
            <Download className="size-4" />
            تصدير سجلّ الأخطاء
          </Button>
        )}
      </div>
    </div>
  );
}
function formatCell(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "نعم" : "لا";
  return String(v);
}
