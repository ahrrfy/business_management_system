/**
 * shared/permissions.ts — نموذج الصلاحيات المشترك بين الخادم والعميل.
 *
 * الأدوار الأحد عشر: admin / manager / accountant / cashier / warehouse /
 *                 purchasing / print_operator / sales_rep / auditor / courier / user
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
  | "courier"
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
  { key: "print_operator", label: "فني مطبعة",           description: "طلبات خدمة العملاء والطباعة فقط" },
  { key: "sales_rep",      label: "مندوب مبيعات",        description: "عروض أسعار ومتابعة عملاء بلا صندوق" },
  { key: "auditor",        label: "مدقّق / مراجع",       description: "قراءة كل شيء بلا كتابة — للمراجعة الخارجية" },
  { key: "courier",        label: "مندوب توصيل",         description: "توصيل طلبات المتجر وتحصيل COD — شاشة «توصيلاتي» فقط" },
  { key: "user",           label: "مستخدم عام",          description: "قراءة فقط لمعظم الوحدات" },
];

export interface PermissionModule {
  key: string;
  label: string;
  description?: string;
}

export const PERMISSION_MODULES: PermissionModule[] = [
  { key: "crm",          label: "إدارة علاقات العملاء", description: "الملف الموحد للعميل، المتابعات، المحادثات، عروض الأسعار والفرص" },
  { key: "campaigns",    label: "الحملات والعروض والكوبونات", description: "تخطيط الحملات واعتمادها وإدارة العروض والكوبونات وقياس نتائجها" },
  { key: "collections",  label: "التحصيل والذمم", description: "متابعة الاستحقاقات والوعود والتحصيل وربطها بحساب العميل" },
  { key: "pos",          label: "نقطة البيع",        description: "بيع نقدي/آجل، إصدار فواتير، طباعة إيصال" },
  { key: "sales",        label: "المبيعات والفواتير", description: "عرض/تعديل الفواتير، المرتجعات، الذمم" },
  { key: "purchases",    label: "المشتريات",         description: "أوامر شراء، استلام، دفعات موردين" },
  { key: "inventory",    label: "المخزون والأرصدة",  description: "حركات المخزون، التحويلات، الجرد" },
  { key: "workorders",   label: "خدمة العملاء",       description: "إنشاء ومتابعة طلبات خدمة العملاء (طباعة وتخصيص)" },
  { key: "channels",     label: "القنوات والوارد",     description: "صندوق الوارد الموحّد (واتساب/إنستغرام/المتجر) والمحادثات" },
  { key: "store",        label: "المتجر الإلكتروني",   description: "طلبات المتجر الإلكترونية: تثبيتها وطباعة الملصقات، والبنرات وإعدادات المتجر" },
  { key: "treasury",     label: "الخزينة والمدفوعات",  description: "لوحة الخزينة، السندات، التحويلات النقدية، الورديات" },
  { key: "suppliers",    label: "الموردون",           description: "إدارة الموردين وكشوف الحساب" },
  { key: "products",     label: "المنتجات",           description: "إدارة المنتجات والأسعار والوحدات" },
  { key: "expenses",     label: "المصروفات",          description: "إدخال وتعديل المصروفات اليومية" },
  { key: "reports",      label: "التقارير",           description: "تقارير المبيعات، الأرباح، أعمار الذمم" },
  { key: "assets",       label: "الأصول الثابتة",      description: "سجلّ الأصول، العهدة، الإهلاك، الصيانة، الاستبعاد" },
  { key: "hr",           label: "الموارد البشرية",     description: "الموظفون، الحضور، الرواتب، الإجازات، التوظيف" },
  { key: "commissions",  label: "الأهداف والعمولات",   description: "خطط العمولات، الأهداف الشهرية، احتساب واعتماد عمولات البائعين" },
  { key: "courier",      label: "توصيلاتي (المندوب)",  description: "شاشة المندوب الذاتية: طلباتي، تأكيد التسليم والتحصيل، عهدتي" },
  { key: "users",        label: "المستخدمون",         description: "إدارة المستخدمين والصلاحيات" },
  { key: "settings",     label: "الإعدادات",          description: "إعدادات النظام والفروع" },
];

export type PermissionMap = Record<string, AccessLevel>;

export const ROLE_TEMPLATES: Record<RoleKey, PermissionMap> = {
  admin: {
    crm: "FULL", campaigns: "FULL", collections: "FULL", store: "FULL",
    assets: "FULL",
    hr: "FULL",
    commissions: "FULL",
    pos: "FULL", sales: "FULL", purchases: "FULL", inventory: "FULL", workorders: "FULL", channels: "FULL", treasury: "FULL",
    customers: "FULL", suppliers: "FULL", products: "FULL", expenses: "FULL", reports: "FULL",
    users: "FULL", settings: "FULL",
  },
  manager: {
    crm: "FULL", campaigns: "FULL", collections: "FULL",
    store: "FULL",
    assets: "FULL",
    hr: "FULL",
    commissions: "FULL",
    pos: "FULL", sales: "FULL", purchases: "FULL", inventory: "FULL", workorders: "FULL", channels: "FULL", treasury: "FULL",
    customers: "FULL", suppliers: "FULL", products: "FULL", expenses: "FULL", reports: "FULL",
    users: "READ", settings: "READ",
  },
  accountant: {
    crm: "READ", campaigns: "READ", collections: "FULL",
    store: "READ",
    assets: "READ",
    hr: "READ",
    // READ: يراجع تشغيلات العمولة والأهداف بلا كتابة (الاحتساب/الاعتماد مديريان).
    commissions: "READ",
    pos: "NONE", sales: "READ", purchases: "READ", inventory: "READ", workorders: "NONE", channels: "NONE", treasury: "FULL",
    customers: "READ", suppliers: "READ", products: "NONE", expenses: "FULL", reports: "FULL",
    users: "NONE", settings: "NONE",
  },
  cashier: {
    crm: "FULL", campaigns: "READ", collections: "READ",
    store: "FULL",
    assets: "NONE",
    hr: "NONE",
    // NONE: الكاشير يرى أداءه الذاتي فقط عبر «أدائي» (protectedProcedure) لا عبر الوحدة.
    commissions: "NONE",
    // F2 (تدقيق ٢/٧): workorders READ→FULL — الكاشير ينشئ ويُسلّم أوامر الشغل فعلاً في نظام
    // الاستقبال الهجين (workOrders.create/deliver على cashierProcedure)؛ كان القالب READ سهواً
    // فبعد ربط requireModule("workorders","FULL") كان سيُحجب الكاشير القالبي عن سلوكه القائم.
    pos: "FULL", sales: "FULL", purchases: "NONE", inventory: "READ", workorders: "FULL", channels: "FULL", treasury: "READ",
    customers: "FULL", suppliers: "NONE", products: "READ", expenses: "FULL", reports: "NONE",
    users: "NONE", settings: "NONE",
  },
  warehouse: {
    crm: "READ", campaigns: "NONE", collections: "NONE",
    assets: "READ",
    hr: "NONE",
    commissions: "NONE",
    pos: "NONE", sales: "READ", purchases: "FULL", inventory: "FULL", workorders: "READ", channels: "NONE", treasury: "NONE",
    // products: READ لا FULL — كتابة الكتالوج «مدير فأعلى» (productsManagerProcedure)؛ كان القالب
    // يَعِد FULL بينما البوّابة تمنعها فتظهر الصلاحية في المصفوفة ثم تفشل كل كتابة (تدقيق التثبيت
    // #26). صدق القالب (قرار المالك: الخادم هو الحقيقة). أمين المخزن يقرأ المنتجات (مخزون/استلام)
    // ويبحثها للشراء (productsPurchaseProcedure #27) — لا يُنشئ/يُعدّل الكتالوج.
    customers: "READ", suppliers: "FULL", products: "READ", expenses: "NONE", reports: "READ",
    users: "NONE", settings: "NONE",
  },
  purchasing: {
    crm: "NONE", campaigns: "NONE", collections: "NONE",
    assets: "NONE",
    hr: "NONE",
    commissions: "NONE",
    pos: "NONE", sales: "NONE", purchases: "FULL", inventory: "READ", workorders: "NONE", channels: "NONE", treasury: "NONE",
    customers: "NONE", suppliers: "FULL", products: "READ", expenses: "NONE", reports: "READ",
    users: "NONE", settings: "NONE",
  },
  print_operator: {
    crm: "READ", campaigns: "READ", collections: "NONE",
    assets: "NONE",
    hr: "NONE",
    commissions: "NONE",
    pos: "NONE", sales: "NONE", purchases: "NONE", inventory: "NONE", workorders: "FULL", channels: "READ", treasury: "NONE",
    customers: "READ", suppliers: "NONE", products: "READ", expenses: "NONE", reports: "NONE",
    users: "NONE", settings: "NONE",
  },
  sales_rep: {
    crm: "FULL", campaigns: "READ", collections: "READ",
    store: "FULL",
    assets: "NONE",
    hr: "NONE",
    // NONE: كالكاشير — أداؤه الذاتي عبر «أدائي»؛ إدارة الخطط والأهداف مديرية.
    commissions: "NONE",
    pos: "NONE", sales: "READ", purchases: "NONE", inventory: "NONE", workorders: "NONE", channels: "READ", treasury: "NONE",
    customers: "FULL", suppliers: "NONE", products: "READ", expenses: "NONE", reports: "NONE",
    users: "NONE", settings: "NONE",
  },
  auditor: {
    crm: "READ", campaigns: "READ", collections: "READ",
    store: "READ",
    assets: "READ",
    hr: "READ",
    commissions: "READ",
    pos: "READ", sales: "READ", purchases: "READ", inventory: "READ", workorders: "READ", channels: "READ", treasury: "READ",
    customers: "READ", suppliers: "READ", products: "READ", expenses: "READ", reports: "READ",
    users: "READ", settings: "READ",
  },
  user: {
    crm: "READ", campaigns: "NONE", collections: "NONE",
    assets: "NONE",
    hr: "NONE",
    commissions: "NONE",
    pos: "NONE", sales: "READ", purchases: "NONE", inventory: "READ", workorders: "READ", channels: "NONE", treasury: "NONE",
    customers: "READ", suppliers: "READ", products: "READ", expenses: "NONE", reports: "READ",
    users: "NONE", settings: "NONE",
  },
  courier: {
    crm: "NONE", campaigns: "NONE", collections: "NONE",
    // مندوب توصيل ذاتي الخدمة: يرى «توصيلاتي» فقط (courier=FULL). كل الوحدات الأخرى NONE —
    // بياناته (اسم/هاتف/عنوان الزبون + COD) تأتي من نقاط courier الذاتية لا من وحدات العملاء/المبيعات.
    courier: "FULL",
    store: "NONE", assets: "NONE", hr: "NONE", commissions: "NONE",
    pos: "NONE", sales: "NONE", purchases: "NONE", inventory: "NONE", workorders: "NONE", channels: "NONE", treasury: "NONE",
    customers: "NONE", suppliers: "NONE", products: "NONE", expenses: "NONE", reports: "NONE",
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
  // ترحيل ناعم: أي تخصيص قديم لوحدة customers يظلّ حاكماً لـCRM إلى أن يُحفظ تخصيص CRM صريح.
  // بهذا لا تمنح الترقية وصولاً لعميل حُجب عنه العملاء سابقاً، مع إزالة الوحدة المكررة من المصفوفة.
  const legacyCustomer = override.customers;
  const explicitCrm = override.crm;
  if (!(explicitCrm === "FULL" || explicitCrm === "READ" || explicitCrm === "NONE") &&
      (legacyCustomer === "FULL" || legacyCustomer === "READ" || legacyCustomer === "NONE")) {
    out.crm = legacyCustomer;
  }
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

/** هل يحقّق مستوى محسوب المستوى الأدنى المطلوب؟ (FULL يشمل READ.) */
export function levelSatisfies(level: AccessLevel | undefined | null, minLevel: AccessLevel): boolean {
  if (level === "FULL") return minLevel === "FULL" || minLevel === "READ";
  if (level === "READ") return minLevel === "READ";
  return false;
}

/** فحص بخريطة الوحدة المحلولة (قالب + override) — يطابق دلالة requireModule في الخادم. */
export function hasModuleAccess(
  role: string,
  override: PermissionMap | null | undefined,
  moduleKey: string,
  minLevel: AccessLevel
): boolean {
  if (role === "admin") return true;
  const map = resolvePermissions(role as RoleKey, override);
  return levelSatisfies(map[moduleKey] ?? "NONE", minLevel);
}

/**
 * قاعدة البوّابة الموحّدة (خادم + واجهة) — إصلاح «فتحتُ صلاحيات لحساب ولم تُطبَّق»:
 *  - admin يمرّ دائماً.
 *  - دور ضمن قائمة البوّابة ⇒ يمرّ إن حقّقت **خريطته المحلولة** المستوى (إنفاذ F2:
 *    override مُقيِّد يُنفَّذ حتى على الأدوار المسموحة).
 *  - دور خارج القائمة ⇒ يمرّ فقط إن مُنح **صراحةً** (override فردي أو دور مخصّص)
 *    مستوى الوحدة المطلوب — القالب وحده لا يفتح بوّابة أضيق من وعده عمداً
 *    (توسيع القوالب قرار سياسة يُتّخذ بوّابةً-بوّابة لا هنا).
 */
export function moduleAccessAllowed(
  role: string,
  override: PermissionMap | null | undefined,
  moduleKey: string,
  minLevel: AccessLevel,
  allowedRoles: readonly string[]
): boolean {
  if (role === "admin") return true;
  if (allowedRoles.includes(role)) {
    return hasModuleAccess(role, override, moduleKey, minLevel);
  }
  return levelSatisfies(override?.[moduleKey], minLevel);
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
