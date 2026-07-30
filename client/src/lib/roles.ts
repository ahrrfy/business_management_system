/**
 * تسميات الأدوار المستخدمة في عناصر الواجهة الخفيفة.
 *
 * إبقاؤها خارج صفحة Users يمنع سحب شاشة إدارة المستخدمين كاملةً إلى الحزمة
 * الأساسية لمجرد عرض اسم الدور في الشريط الجانبي أو حقول النماذج.
 */
export const ROLE_OPTIONS = [
  { value: "admin", label: "مدير النظام" },
  { value: "manager", label: "مدير فرع" },
  { value: "accountant", label: "محاسب" },
  { value: "cashier", label: "كاشير" },
  { value: "warehouse", label: "أمين مخزن" },
  { value: "purchasing", label: "مسؤول مشتريات" },
  { value: "print_operator", label: "فني مطبعة" },
  { value: "sales_rep", label: "مندوب مبيعات" },
  { value: "auditor", label: "مدقّق" },
  { value: "courier", label: "مندوب توصيل" },
  { value: "user", label: "مستخدم عام" },
] as const;

export const ROLE_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  ROLE_OPTIONS.map((option) => [option.value, option.label]),
);
