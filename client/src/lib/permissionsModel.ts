/**
 * نموذج الصلاحيات — قوالب الأدوار + مفاتيح الوحدات + تطبيق التخصيص.
 *
 * v3-add-screens:
 *  - الأدوار: admin / manager / cashier / warehouse / user.
 *  - كل وحدة لها مستوى وصول: FULL (كتابة) / READ (قراءة) / NONE.
 *  - المستخدم يبدأ من قالب دوره؛ يمكن أن يستلم `permissionsOverride` (JSON) يُخصّص
 *    وحدات بعينها ويُوسم بـ«مخصّص». التخزين في قاعدة البيانات هو فقط الخريطة المخصّصة
 *    (overrides) — الباقي يُحسب من القالب وقت العرض. هذا يُبقي قواعد الدور قابلة للتطوّر
 *    بلا الحاجة لتعديل سجلّات المستخدمين.
 *
 * ملاحظة: الإنفاذ الحقيقي في الخادم يبقى عبر procedures (managerProcedure إلخ.) — هذا
 * النموذج للواجهة (وتعطيل/إخفاء عناصر القائمة لاحقاً). الخادم لا يثق بالعميل.
 */

export type AccessLevel = "FULL" | "READ" | "NONE";

export type RoleKey = "admin" | "manager" | "cashier" | "warehouse" | "user";

export interface RoleInfo {
  key: RoleKey;
  label: string;
  description: string;
}

export const ROLES: RoleInfo[] = [
  { key: "admin",     label: "مدير النظام", description: "وصول كامل + إدارة المستخدمين والإعدادات" },
  { key: "manager",   label: "مدير فرع",    description: "إدارة العمليات والتقارير بدون تعديل المستخدمين" },
  { key: "cashier",   label: "كاشير",        description: "نقطة بيع + مبيعات (لا يرى التكلفة)" },
  { key: "warehouse", label: "مخزن",         description: "المخزون والمشتريات والاستلام" },
  { key: "user",      label: "مستخدم عام",   description: "قراءة فقط لمعظم الوحدات" },
];

export interface PermissionModule {
  key: string;
  label: string;
  description?: string;
}

/** الوحدات الواجهيّة الخاضعة للصلاحيات — مرتّبة بأولوية العرض. */
export const PERMISSION_MODULES: PermissionModule[] = [
  { key: "pos",          label: "نقطة البيع",       description: "بيع نقدي/آجل، إصدار فواتير، طباعة إيصال" },
  { key: "sales",        label: "المبيعات والفواتير", description: "عرض/تعديل الفواتير، المرتجعات، الذمم" },
  { key: "purchases",    label: "المشتريات",        description: "أوامر شراء، استلام، دفعات مورّدين" },
  { key: "inventory",    label: "المخزون والأرصدة",  description: "حركات المخزون، التحويلات، الجرد" },
  { key: "workorders",   label: "أوامر الشغل",       description: "إنشاء/متابعة أوامر الطباعة والتخصيص" },
  { key: "customers",    label: "العملاء",           description: "إدارة العملاء وكشوف الحساب" },
  { key: "suppliers",    label: "الموردون",          description: "إدارة الموردين وكشوف الحساب" },
  { key: "products",     label: "المنتجات",          description: "إدارة المنتجات والأسعار والوحدات" },
  { key: "expenses",     label: "المصروفات",         description: "إدخال وتعديل المصروفات اليومية" },
  { key: "reports",      label: "التقارير",          description: "تقارير المبيعات، الأرباح، أعمار الذمم" },
  { key: "users",        label: "المستخدمون",        description: "إدارة المستخدمين والصلاحيات (مدير فقط)" },
  { key: "settings",     label: "الإعدادات",         description: "إعدادات النظام والفروع" },
];

export type PermissionMap = Record<string, AccessLevel>;

/** قوالب الأدوار: مستوى وصول كل وحدة لكل دور. */
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
  user: {
    pos: "NONE", sales: "READ", purchases: "NONE", inventory: "READ", workorders: "READ",
    customers: "READ", suppliers: "READ", products: "READ", expenses: "NONE", reports: "READ",
    users: "NONE", settings: "NONE",
  },
};

/**
 * الصلاحيات الفعلية = قالب الدور مع تطبيق الـoverride لكل وحدة مخصّصة.
 * إن لم يكن للمستخدم override، يعود قالب الدور كما هو.
 */
export function resolvePermissions(role: RoleKey, override: PermissionMap | null | undefined): PermissionMap {
  const base = ROLE_TEMPLATES[role] || ROLE_TEMPLATES.user;
  if (!override) return { ...base };
  const out: PermissionMap = { ...base };
  for (const m of PERMISSION_MODULES) {
    const v = override[m.key];
    if (v === "FULL" || v === "READ" || v === "NONE") out[m.key] = v;
  }
  return out;
}

/** يستخرج فقط الوحدات التي تختلف عن قالب الدور (للتخزين المضغوط). */
export function diffFromTemplate(role: RoleKey, permissions: PermissionMap): PermissionMap | null {
  const base = ROLE_TEMPLATES[role] || ROLE_TEMPLATES.user;
  const diff: PermissionMap = {};
  let changed = 0;
  for (const m of PERMISSION_MODULES) {
    const v = permissions[m.key];
    if (v && v !== base[m.key]) {
      diff[m.key] = v;
      changed++;
    }
  }
  return changed > 0 ? diff : null;
}

export function accessLabel(a: AccessLevel): string {
  return a === "FULL" ? "كامل" : a === "READ" ? "قراءة" : "لا وصول";
}
