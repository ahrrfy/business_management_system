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
