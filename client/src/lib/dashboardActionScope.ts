/**
 * فرع البنود القابلة للتنفيذ في لوحة التحكم.
 *
 * لا نستخدم النطاق المجمّع هنا: وجهة البطاقة (التذكيرات/المهام) تعمل ضمن فرع
 * محدّد، لذلك يجب أن يكون العدّ من النطاق نفسه. كما لا نخترع الفرع 1 إذا كان
 * حساب المستخدم غير مربوط بفرع.
 */
export function dashboardActionBranchId(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const branchId = Number(value);
  return Number.isInteger(branchId) && branchId > 0 ? branchId : undefined;
}
