/**
 * shared/hr.ts — ثوابت وحدة الموارد البشرية، مشتركة بين الخادم والعميل.
 * مصدر حقيقة واحد للأقسام/أيام الأسبوع/طرق الأجر/الحالات + تسمياتها العربية وحسابات الاسم.
 */

export const HR_DEPARTMENTS = [
  "الطباعة",
  "المبيعات والكاشير",
  "التصميم الجرافيكي",
  "المخزن",
  "المحاسبة",
  "الإدارة",
  "التوصيل",
] as const;

/** ترتيب أيام الأسبوع كما في getDay() (الأحد=0). */
export const WEEK_DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"] as const;

/** جدول سعر الساعة الافتراضي للشركة (IQD) — قابل للتخصيص لكل موظف ساعة. */
export const DAY_RATES_DEFAULT: Record<string, number> = {
  "الأحد": 5000, "الاثنين": 5000, "الثلاثاء": 5000,
  "الأربعاء": 5000, "الخميس": 5500, "الجمعة": 7500, "السبت": 6000,
};

export const PAY_TYPES = [
  { key: "monthly", label: "راتب شهري" },
  { key: "hourly", label: "بالساعة" },
] as const;
export type PayType = (typeof PAY_TYPES)[number]["key"];

export const EMPLOYMENT_STATUSES = [
  { key: "active", label: "على رأس العمل" },
  { key: "leave", label: "في إجازة" },
  { key: "terminated", label: "منتهي الخدمة" },
] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number]["key"];

export const GENDERS = ["ذكر", "أنثى"] as const;
export const MARITAL_STATUSES = ["أعزب", "متزوج", "مطلّق", "أرمل"] as const;
export const DEGREES = ["ابتدائية", "متوسطة", "إعدادية", "دبلوم", "بكالوريوس", "ماجستير", "دكتوراه"] as const;

export const payTypeLabel = (k: string): string => PAY_TYPES.find((p) => p.key === k)?.label ?? k;
export const employmentStatusLabel = (k: string): string => EMPLOYMENT_STATUSES.find((s) => s.key === k)?.label ?? k;

export const PAY_TYPE_KEYS = PAY_TYPES.map((p) => p.key) as [PayType, ...PayType[]];
export const EMPLOYMENT_STATUS_KEYS = EMPLOYMENT_STATUSES.map((s) => s.key) as [EmploymentStatus, ...EmploymentStatus[]];

export interface EmployeeEducation {
  degree: string;
  major?: string;
  school?: string;
  year?: number;
  gpa?: string;
}

/** الاسم الكامل (رباعي) من أجزائه: الأول + الأب + الجد + اللقب. */
export function fullEmployeeName(e: {
  firstName?: string | null;
  fatherName?: string | null;
  grandfatherName?: string | null;
  lastName?: string | null;
}): string {
  return [e.firstName, e.fatherName, e.grandfatherName, e.lastName]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/* ===== الرواتب ===== */
export const PAYROLL_STATUSES = [
  { key: "draft", label: "مسودة" },
  { key: "approved", label: "معتمد" },
  { key: "paid", label: "مدفوع" },
] as const;
export type PayrollStatus = (typeof PAYROLL_STATUSES)[number]["key"];
export const payrollStatusLabel = (k: string): string => PAYROLL_STATUSES.find((s) => s.key === k)?.label ?? k;

/* ===== الإجازات ===== أنواعها وما إن كانت مدفوعة (السنوية/المرضية/الأمومة مدفوعة؛ بدون راتب غير مدفوعة) */
export const LEAVE_TYPES = [
  { key: "سنوية", paid: true },
  { key: "مرضية", paid: true },
  { key: "أمومة", paid: true },
  { key: "بدون راتب", paid: false },
] as const;
export const leaveTypeIsPaid = (k: string): boolean => LEAVE_TYPES.find((t) => t.key === k)?.paid ?? true;
export const LEAVE_STATUSES = [
  { key: "pending", label: "قيد الموافقة" },
  { key: "approved", label: "موافق عليها" },
  { key: "rejected", label: "مرفوضة" },
] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number]["key"];
export const leaveStatusLabel = (k: string): string => LEAVE_STATUSES.find((s) => s.key === k)?.label ?? k;

/* ===== التوظيف ===== */
export const APPLICANT_SOURCES = [
  { key: "external", label: "رابط خارجي" },
  { key: "paper", label: "استمارة ورقية" },
  { key: "archive", label: "أرشيف" },
] as const;
export const APPLICANT_STAGES = [
  { key: "new", label: "جديد" },
  { key: "review", label: "قيد المراجعة" },
  { key: "interview", label: "مقابلة" },
  { key: "accepted", label: "مقبول" },
  { key: "rejected", label: "مرفوض" },
  { key: "archived", label: "أرشيف" },
] as const;
export type ApplicantStage = (typeof APPLICANT_STAGES)[number]["key"];
export const applicantStageLabel = (k: string): string => APPLICANT_STAGES.find((s) => s.key === k)?.label ?? k;
export const applicantSourceLabel = (k: string): string => APPLICANT_SOURCES.find((s) => s.key === k)?.label ?? k;
export const APPLICANT_STAGE_KEYS = APPLICANT_STAGES.map((s) => s.key) as [ApplicantStage, ...ApplicantStage[]];

/* ===== الوظائف الشاغرة (معرض التوظيف العام /apply) ===== */
/** أنواع التعاقد المعروضة في بطاقة الوظيفة. */
export const EMPLOYMENT_TYPES = [
  { key: "full_time", label: "دوام كامل" },
  { key: "part_time", label: "دوام جزئي" },
  { key: "contract", label: "عقد" },
  { key: "temporary", label: "مؤقّت" },
  { key: "internship", label: "تدريب" },
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number]["key"];
export const employmentTypeLabel = (k: string): string => EMPLOYMENT_TYPES.find((t) => t.key === k)?.label ?? k;
export const EMPLOYMENT_TYPE_KEYS = EMPLOYMENT_TYPES.map((t) => t.key) as [EmploymentType, ...EmploymentType[]];

/**
 * لوحة ألوان لبطاقات الوظائف على المعرض العام — لكل قسم لون مميّز ثابت،
 * تُستعمل خلفيةً متدرّجة حين لا تُرفع صورة للوظيفة (مصدر حقيقة واحد بين الخادم والعميل).
 */
export const VACANCY_ACCENTS: Record<string, { from: string; to: string }> = {
  "الطباعة": { from: "#7c3aed", to: "#4f46e5" },
  "المبيعات والكاشير": { from: "#0ea5e9", to: "#2563eb" },
  "التصميم الجرافيكي": { from: "#ec4899", to: "#8b5cf6" },
  "المخزن": { from: "#f59e0b", to: "#d97706" },
  "المحاسبة": { from: "#10b981", to: "#059669" },
  "الإدارة": { from: "#64748b", to: "#334155" },
  "التوصيل": { from: "#ef4444", to: "#b91c1c" },
};
export const DEFAULT_VACANCY_ACCENT = { from: "#3f46d6", to: "#6366f1" } as const;
export const vacancyAccent = (department?: string | null): { from: string; to: string } =>
  (department && VACANCY_ACCENTS[department]) || DEFAULT_VACANCY_ACCENT;

/* ===== أجهزة البصمة — وجهة الهجرة (خادم الرؤية المملوك، بدل المزوّد المدفوع) ===== */
export const HR_FINGERPRINT_TARGET = { host: "hr.alroya.iq", port: 7788, label: "خادم الرؤية العربية" } as const;

/* ===== الترقيات/إنهاء الخدمات ===== */
export const TERMINATION_TYPES = ["انتهاء عقد", "استقالة", "فصل", "تقاعد"] as const;

