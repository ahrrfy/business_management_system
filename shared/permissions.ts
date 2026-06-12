/**
 * shared/permissions.ts — نموذج الصلاحيات المشترك بين الخادم والعميل.
 *
 * الأدوار العشرة: admin / manager / accountant / cashier / warehouse /
 *                 purchasing / print_operator / sales_rep / auditor / user
 *
 * كل وحدة لها مستوى وصول: FULL / READ / NONE.
 * التخزين في DB هو فقط الانحرافات عن القالب (permissionsOverride).
 * الإنفاذ الحقيقي في الخادم عبر requireModule() في trpc.ts.
 */

export type AccessLevel = "FULL" | "READ" | "NONE";

export type RoleKey =
  | "admin"
  | "manager"
  | "accountant"
  | "cashier"
  | "warehouse"
  | "purchasing"
  | "print_operator"
  | "sales_rep"
  | "auditor"
  | "user";

export interface RoleInfo {
  key: RoleKey;
  label: string;
  description: string;
  /** هل يرى هذا الدور التكلفة وهامش الربح؟ */
  canSeeCost?: boolean;
}

export const ROLES: RoleInfo[] = [
  { key: "admin",          label: "مدير النظام",       description: "وصول كامل + إدارة المستخدمين والإعدادات", canSeeCost: true },
  { key: "manager",        label: "مدير فرع",           description: "إدارة العمليات والتقارير بدون تعديل المستخدمين", canSeeCost: true },
  { key: "accountant",     label: "محاسب",              description: "التقارير المالية، الذمم، المصروفات، كشوف الحساب", canSeeCost: true },
  { key: "cashier",        label: "كاشير",               description: "نقطة بيع + مبيعات (لا يرى التكلفة)" },
  { key: "warehouse",      label: "أمين مخزن",           description: "المخزون والمشتريات والاستلام" },
  { key: "purchasing",     label: "مسؤول مشتريات",       description: "أوامر شراء وموردون (منفصل عن المخزن)" },
  { key: "print_operator", label: "فني مطبعة",           description: "أوامر الشغل والطباعة فقط" },
  { key: "sales_rep",      label: "مندوب مبيعات",        description: "عروض أسعار ومتابعة عملاء بلا صندوق" },
  { key: "auditor",        label: "مدقّق / مراجع",       description: "قراءة كل شيء بلا كتابة — للمراجعة الخارجية" },
  { key: "user",           label: "مستخدم عام",          description: "قراءة فقط لمعظم الوحدات" },
];

export interface PermissionModule {
  key: string;
  label: string;
  description?: string;
}

export const PERMISSION_MODULES: PermissionModule[] = [
  { key: "pos",          label: "نقطة البيع",        description: "بيع نقدي/آجل، إصدار فواتير، طباعة إيصال" },
  { key: "sales",        label: "المبيعات والفواتير", description: "عرض/تعديل الفواتير، المرتجعات، الذمم" },
  { key: "purchases",    label: "المشتريات",         description: "أوامر شراء، استلام، دفعات موردين" },
  { key: "inventory",    label: "المخزون والأرصدة",  description: "حركات المخزون، التحويلات، الجرد" },
  { key: "workorders",   label: "أوامر الشغل",        description: "إنشاء/متابعة أوامر الطباعة والتخصيص" },
  { key: "customers",    label: "العملاء",            description: "إدارة العملاء وكشوف الحساب" },
  { key: "suppliers",    label: "الموردون",           description: "إدارة الموردين وكشوف الحساب" },
  { key: "products",     label: "المنتجات",           description: "إدارة المنتجات والأسعار والوحدات" },
  { key: "expenses",     label: "المصروفات",          description: "إدخال وتعديل المصروفات اليومية" },
  { key: "reports",      label: "التقارير",           description: "تقارير المبيعات، الأرباح، أعمار الذمم" },
  { key: "users",        label: "المستخدمون",         description: "إدارة المستخدمين والصلاحيات" },
  { key: "settings",     label: "الإعدادات",          description: "إعدادات النظام والفروع" },
];

export type PermissionMap = Record<string, AccessLevel>;

export const ROLE_TEMPLATES: Record<RoleKey, PermissionMap> = {
  admin: {
    pos: "FULL", sales: "FULL", purchases: "FULL", inventory: "FULL", workorders: "FULL",
    customers: "FULL", suppliers: "FULL", products: "FULL", expenses: "FULL", reports: "FULL",
    users: "FULL", settings: "FULL",
  },
  manager: {
    pos: "FULL", sales: "FULL", purchases: "FULL", inventory: "FULL", workorders: "FULL",
    customers: "FULL", suppliers: "FULL", products: "FULL", expenses: "FULL", reports: "FULL",
    users: "READ", settings: "READ",
  },
  accountant: {
    pos: "NONE", sales: "READ", purchases: "READ", inventory: "READ", workorders: "NONE",
    customers: "READ", suppliers: "READ", products: "NONE", expenses: "FULL", reports: "FULL",
    users: "NONE", settings: "NONE",
  },
  cashier: {
    pos: "FULL", sales: "FULL", purchases: "NONE", inventory: "READ", workorders: "READ",
    customers: "FULL", suppliers: "NONE", products: "READ", expenses: "FULL", reports: "NONE",
    users: "NONE", settings: "NONE",
  },
  warehouse: {
    pos: "NONE", sales: "READ", purchases: "FULL", inventory: "FULL", workorders: "READ",
    customers: "READ", suppliers: "FULL", products: "FULL", expenses: "NONE", reports: "READ",
    users: "NONE", settings: "NONE",
  },
  purchasing: {
    pos: "NONE", sales: "NONE", purchases: "FULL", inventory: "READ", workorders: "NONE",
    customers: "NONE", suppliers: "FULL", products: "READ", expenses: "NONE", reports: "READ",
    users: "NONE", settings: "NONE",
  },
  print_operator: {
    pos: "NONE", sales: "NONE", purchases: "NONE", inventory: "NONE", workorders: "FULL",
    customers: "READ", suppliers: "NONE", products: "READ", expenses: "NONE", reports: "NONE",
    users: "NONE", settings: "NONE",
  },
  sales_rep: {
    pos: "NONE", sales: "READ", purchases: "NONE", inventory: "NONE", workorders: "NONE",
    customers: "FULL", suppliers: "NONE", products: "READ", expenses: "NONE", reports: "NONE",
    users: "NONE", settings: "NONE",
  },
  auditor: {
    pos: "READ", sales: "READ", purchases: "READ", inventory: "READ", workorders: "READ",
    customers: "READ", suppliers: "READ", products: "READ", expenses: "READ", reports: "READ",
    users: "READ", settings: "READ",
  },
  user: {
    pos: "NONE", sales: "READ", purchases: "NONE", inventory: "READ", workorders: "READ",
    customers: "READ", suppliers: "READ", products: "READ", expenses: "NONE", reports: "READ",
    users: "NONE", settings: "NONE",
  },
};

export function resolvePermissions(
  role: RoleKey,
  override: PermissionMap | null | undefined
): PermissionMap {
  const base = ROLE_TEMPLATES[role] ?? ROLE_TEMPLATES.user;
  if (!override) return { ...base };
  const out: PermissionMap = { ...base };
  for (const m of PERMISSION_MODULES) {
    const v = override[m.key];
    if (v === "FULL" || v === "READ" || v === "NONE") out[m.key] = v;
  }
  return out;
}

export function diffFromTemplate(
  role: RoleKey,
  permissions: PermissionMap
): PermissionMap | null {
  const base = ROLE_TEMPLATES[role] ?? ROLE_TEMPLATES.user;
  const diff: PermissionMap = {};
  let changed = 0;
  for (const m of PERMISSION_MODULES) {
    const v = permissions[m.key];
    if (v && v !== base[m.key]) { diff[m.key] = v; changed++; }
  }
  return changed > 0 ? diff : null;
}

export function canSeeCost(role: string): boolean {
  const info = ROLES.find((r) => r.key === role);
  return info?.canSeeCost === true;
}

export function accessLabel(a: AccessLevel): string {
  return a === "FULL" ? "كامل" : a === "READ" ? "قراءة" : "لا وصول";
}

/** قائمة الأدوار المصرَّح بها (للتحقق في الخادم). */
export const ALL_ROLES: RoleKey[] = ROLES.map((r) => r.key);
