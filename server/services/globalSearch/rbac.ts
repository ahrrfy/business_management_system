// RBAC البحث الشامل (يطابق trpc.ts): الأنواع المخفيّة عن الكاشير + حلّ صلاحية رؤية كل نوع.
import { resolvePermissions, type AccessLevel, type RoleKey } from "@shared/permissions";
import type { SearchEntityType } from "./types";

const MASTER_DATA_TYPES: ReadonlyArray<SearchEntityType> = ["PRODUCT", "CUSTOMER", "SUPPLIER"];

const BRANCH_SCOPED_TYPES: ReadonlyArray<SearchEntityType> = [
  "INVOICE",
  "QUOTATION",
  "PURCHASE_ORDER",
  "WORK_ORDER",
  "EXPENSE",
];

/** كيانات إدارية حسّاسة: الموظف (مدير/إدارة) والمستخدم (إدارة فقط). */
const ADMIN_TYPES: ReadonlyArray<SearchEntityType> = ["EMPLOYEE", "USER"];

/** الأنواع المخفيّة عن الكاشير (إدارة/مدير فأعلى). */
const MANAGER_ONLY_TYPES: ReadonlyArray<SearchEntityType> = ["SUPPLIER", "PURCHASE_ORDER", "EXPENSE"];

function isElevated(role: string) {
  return role === "admin" || role === "manager";
}

export function canSeeType(
  role: string,
  type: SearchEntityType,
  override?: Record<string, AccessLevel> | null,
): boolean {
  // الإدارة ترى كل شيء (يطابق اختصار requireModule للأدمن).
  if (role === "admin") return true;
  // إدارة المستخدمين بلا «وحدة صلاحيات» مستقلّة ⇒ للأدمن فقط (يطابق adminProcedure في userRouter).
  if (type === "USER") return false;
  // الموظفون: تُحكَم بخريطة صلاحيات HR المحسوبة (قالب الدور + override) لا باسم الدور الأساس،
  // كي تتطابق تماماً مع requireModule("hr","READ") على شاشات الموارد البشرية ⇒ لا تسريب PII
  // لدورٍ مخصّص أُلغِيت عنه وحدة hr، ولا حجبٌ خاطئ عن دور (auditor) يملك hr:READ.
  if (type === "EMPLOYEE") {
    const map = resolvePermissions(role as RoleKey, override ?? null);
    const lvl = map["hr"] ?? "NONE";
    return lvl === "FULL" || lvl === "READ";
  }
  if (isElevated(role) || role === "accountant") return true;
  return !MANAGER_ONLY_TYPES.includes(type);
}


export { isElevated, MASTER_DATA_TYPES, BRANCH_SCOPED_TYPES, ADMIN_TYPES };
