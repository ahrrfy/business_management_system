// حفظ تفضيلات فلاتر التقارير (فرع/فترة) لكل تقرير في localStorage ⇒ لا يعيد المدير الاختيار كل مرة.
// مفتاح لكل تقرير (reportKey). يفشل بصمت (تصفّح خاص/ممتلئ) فلا يُعطّل التقرير.
const PREFIX = "report.prefs.";

export interface ReportPrefs {
  branchId?: number | "";
  from?: string;
  to?: string;
  /** معرّف نمط فترة (today/month/last30/mtd…) إن استُعمل منتقي معدّ مسبقاً. */
  preset?: string;
  /** شهر/سنة لحزمة المحاسب. */
  month?: number;
  year?: number;
}

export function loadReportPrefs(reportKey: string): ReportPrefs {
  try {
    const raw = localStorage.getItem(PREFIX + reportKey);
    if (raw) return JSON.parse(raw) as ReportPrefs;
  } catch { /* ignore */ }
  return {};
}

export function saveReportPrefs(reportKey: string, prefs: ReportPrefs): void {
  try {
    localStorage.setItem(PREFIX + reportKey, JSON.stringify(prefs));
  } catch { /* ignore */ }
}
