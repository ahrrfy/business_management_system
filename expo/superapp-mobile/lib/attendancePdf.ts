import type { MobileAttendanceHistory } from "@/lib/secureTransportPayload";

type AttendancePdfInput = Readonly<{
  employeeName: string;
  history: MobileAttendanceHistory;
}>;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function time(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
        hour: "numeric",
        minute: "2-digit",
        // يبقى PDF متطابقاً مع يوم العمل الخادمي في بغداد، مهما كانت منطقة الجهاز.
        timeZone: "Asia/Baghdad",
      }).format(date);
}

function statusLabel(status: MobileAttendanceHistory["personal"]["entries"][number]["status"]): string {
  return ({ PRESENT: "حاضر", ABSENT: "غائب", LATE: "متأخر", LEAVE: "إجازة" })[status];
}

/**
 * Deliberately small, escaped, self-service attendance report. It does not
 * contain salary, rate, amount, notes, device source, branch, or employee ID.
 * Keeping HTML construction pure makes it testable without a native module.
 */
export function buildAttendancePdfHtml(input: AttendancePdfInput): string {
  const entries = input.history.personal.entries;
  const rows = entries.map((entry) => `
    <tr>
      <td>${escapeHtml(entry.date)}</td>
      <td>${escapeHtml(statusLabel(entry.status))}${entry.state === "NEEDS_REVIEW" ? " · يحتاج مراجعة" : ""}</td>
      <td dir="ltr">${escapeHtml(time(entry.checkIn))}</td>
      <td dir="ltr">${escapeHtml(time(entry.checkOut))}</td>
      <td>${escapeHtml(entry.hours ?? "—")}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8" />
<style>
  @page { margin: 18mm 14mm; }
  body { color: #1f2933; direction: rtl; font-family: Arial, sans-serif; font-size: 12px; line-height: 1.55; }
  h1 { color: #0f6a55; font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 10px; } table { border-collapse: collapse; margin-top: 16px; width: 100%; }
  th { background: #eaf4ef; color: #124f41; } th, td { border: 1px solid #ccd8d2; padding: 8px; text-align: right; }
  .notice { color: #5d6b65; font-size: 10px; margin-top: 18px; }
</style></head><body>
  <h1>كشف الحضور الشخصي</h1>
  <p><strong>الموظف:</strong> ${escapeHtml(input.employeeName)}</p>
  <p><strong>الفترة:</strong> ${escapeHtml(input.history.range.from)} إلى ${escapeHtml(input.history.range.to)}</p>
  <table><thead><tr><th>التاريخ</th><th>الحالة</th><th>الدخول</th><th>الانصراف</th><th>الساعات</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <p class="notice">هذا الكشف شخصي ومحدود بالفترة المعروضة. يُنشأ ويُشارك فقط بطلبك من تطبيق سوبر العربية.</p>
</body></html>`;
}
