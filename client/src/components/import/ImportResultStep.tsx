import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { ImportSummary } from "@/lib/import";
export function ImportResultStep({
  summary,
  batchNote,
  writtenCount,
}: {
  summary: ImportSummary;
  batchNote: string | null;
  writtenCount: number;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryPill
          label="مُنشأ"
          value={summary.created}
          cls="text-[var(--sem-pos)] bg-[var(--sem-pos-bg)]"
        />
        <SummaryPill
          label="محدَّث"
          value={summary.updated}
          cls="text-[var(--sem-info)] bg-[var(--sem-info-bg)]"
        />
        <SummaryPill
          label="متجاوَز"
          value={summary.skipped}
          cls="text-[var(--sem-warn)] bg-[var(--sem-warn-bg)]"
        />
        <SummaryPill
          label="فاشل"
          value={summary.failed}
          cls="text-[var(--sem-neg)] bg-[var(--sem-neg-bg)]"
        />
      </div>
      {batchNote && (
        <div className="flex items-start gap-2 rounded-md bg-[var(--sem-warn-bg)] px-3 py-2 text-xs text-[var(--sem-warn)]">
          <AlertTriangle className="size-4 shrink-0" />
          {batchNote}
        </div>
      )}
      {/* صندوق الفشل الأحمر عند فشلٍ فعلي بلا أي كتابة ملتزمة — لا لمجرد committed=false:
                دفعة كلها «متجاوَز» (إعادة استيراد) ليست فشلاً ولا تستحق إنذاراً أحمر كاذباً. */}
      {summary.failed > 0 && writtenCount === 0 && !batchNote && (
        <div className="flex items-center gap-2 rounded-md bg-[var(--sem-neg-bg)] px-3 py-2 text-xs text-[var(--sem-neg)]">
          <AlertCircle className="size-4 shrink-0" />
          لم تُكتب أي بيانات (الكل أو لا شيء) — صحّح الصفوف الفاشلة ثم أعد
          المحاولة.
        </div>
      )}
      {summary.failed === 0 && writtenCount === 0 && !batchNote && (
        <div className="flex items-center gap-2 rounded-md bg-[var(--sem-info-bg)] px-3 py-2 text-xs text-[var(--sem-info)]">
          <CheckCircle2 className="size-4 shrink-0" />
          لا جديد — لم تُسجّل كتابة جديدة. راجِع تفاصيل الصفوف المتجاوزة.
        </div>
      )}
      {summary.rows.some(
        (r) => r.status === "failed" || r.status === "skipped",
      ) && (
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
                    <td className="p-2">
                      {r.status === "failed" ? "فاشل" : "متجاوَز"}
                    </td>
                    <td className="p-2" dir="auto">
                      {r.message ?? "—"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
function SummaryPill({
  label,
  value,
  cls,
}: {
  label: string;
  value: number;
  cls: string;
}) {
  return (
    <div className={`rounded-md px-3 py-2 text-center ${cls}`}>
      <div className="text-lg font-bold tabular-nums">
        {value.toLocaleString("ar-IQ-u-nu-latn")}
      </div>
      <div className="text-xs">{label}</div>
    </div>
  );
}
