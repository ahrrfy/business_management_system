import { trpc } from "@/lib/trpc";
import { fmtAr } from "@/lib/money";
import { fmtDate, fmtTime } from "@/lib/date";
import { useMediaQuery } from "@/hooks/useMobile";
import { Link } from "wouter";
import { useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { AppSelect } from "@/components/ui/AppSelect";
import { canSeeGate, type RoleGate } from "@/lib/navVisibility";
import { dashboardActionBranchId } from "@/lib/dashboardActionScope";
import { APPLICATION_MODULES, type ApplicationModule } from "@/lib/moduleRegistry";
import { ROLE_LABEL } from "@/lib/roles";
import { hasModuleAccess, moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { Banknote, CalendarDays, MapPin, ReceiptText, RefreshCw, ShoppingCart } from "lucide-react";

/* ═══════════ THEME — CSS variables in tokens.css ═══════════
   مَربوطة بـ:root و.dark تِلقائياً ⇒ لا حاجة لـMutationObserver أو ThemeContext. */

const T = {
  bg:          "var(--dash-bg)",
  cardBg:      "var(--dash-card-bg)",
  cardBord:    "var(--dash-card-bord)",
  secLine:     "var(--dash-sec-line)",
  secLabel:    "var(--dash-sec-label)",
  text:        "var(--dash-text)",
  sub:         "var(--dash-sub)",
  muted:       "var(--dash-muted)",
  statBg:      "var(--dash-stat-bg)",
  statBord:    "var(--dash-stat-bord)",
  alertBg:     "var(--dash-alert-bg)",
  featuredBg:  "var(--dash-featured-bg)",
  featuredBd:  "var(--dash-featured-bd)",
  metricsBg:   "var(--dash-metrics-bg)",
  metricsBord: "var(--dash-metrics-bord)",
} as const;
const useT = () => T;

/* ═══════════ SECTIONS & MODULES ═══════════ */

const SECTIONS = [
  { id: 1, name: "المبيعات والتحصيل",  accent: "var(--sec1-ink)" },
  { id: 2, name: "المخزون والمشتريات", accent: "var(--sec2-ink)" },
  { id: 3, name: "المالية والحسابات",  accent: "var(--sec3-ink)" },
  { id: 4, name: "التشغيل والقنوات",   accent: "var(--sec4-ink)" },
  { id: 5, name: "الإدارة والنظام",    accent: "var(--sec5-ink)" },
];

type ModuleDef = RoleGate & {
  id: string;
  href: string;
  name: string;
  desc: string;
  sec: number;
  color: string;
  featured?: boolean;
  adminOnly?: boolean;
  icon?: ApplicationModule["icon"];
};

const CORE_MODULES: ModuleDef[] = [
  { id: "pos",           href: "/pos",                 name: "نقطة البيع",       desc: "مبيعات وورديات",    sec: 1, color: "var(--sec1-ink)",  featured: true },
  { id: "crm",           href: "/crm",                 name: "CRM والعلاقات",      desc: "عملاء ومحادثات وعروض", sec: 1, color: "var(--sec1-ink)", module: "crm" },
  { id: "sales",         href: "/invoices",            name: "المبيعات",          desc: "فواتير ومدفوعات",   sec: 1, color: "var(--sec1-ink)", module: "sales" },
  { id: "quotations",    href: "/quotations",          name: "عروض الأسعار",      desc: "تسعير وعروض",       sec: 1, color: "var(--sec1-ink)", module: "crm" },
  { id: "customers",     href: "/customers",           name: "العملاء",           desc: "إدارة العملاء",     sec: 1, color: "var(--sec1-ink)", module: "crm" },
  { id: "returns",       href: "/returns",             name: "المرتجعات",         desc: "تسجيل المرتجعات",   sec: 1, color: "var(--sec1-ink)", module: "sales" },
  { id: "products",      href: "/products",            name: "المنتجات",          desc: "منتجات وأسعار",      sec: 2, color: "var(--sec2-ink)", module: "products" },
  { id: "purchases",     href: "/purchases",           name: "المشتريات",         desc: "أوامر وموردين",     sec: 2, color: "var(--sec2-ink)", module: "purchases" },
  { id: "inventory",     href: "/inventory",           name: "المخزون والأرصدة",  desc: "أرصدة + تسوية",     sec: 2, color: "var(--sec2-ink)", module: "inventory" },
  { id: "stocktakes",    href: "/stocktakes",          name: "الجرد المخزني",     desc: "جلسات وعدّ ومراجعة", sec: 2, color: "var(--sec2-ink)", module: "inventory" },
  { id: "movements",     href: "/inventory-movements", name: "حركات المخزون",     desc: "وارد وصادر يدوي",   sec: 2, color: "var(--sec2-ink)", module: "inventory" },
  { id: "transfers",     href: "/transfers",           name: "التحويلات",         desc: "نقل بين الفروع",    sec: 2, color: "var(--sec2-ink)", module: "inventory" },
  { id: "barcode",       href: "/barcode-labels",      name: "الباركود",          desc: "طباعة الملصقات",    sec: 2, color: "var(--sec2-ink)", module: "inventory" },
  { id: "suppliers",     href: "/suppliers",           name: "الموردون",          desc: "إدارة الموردين",    sec: 2, color: "var(--sec2-ink)", module: "suppliers" },
  { id: "purchaseReturns", href: "/purchase-returns",  name: "مرتجعات الشراء",    desc: "سجلّ المرتجعات",    sec: 2, color: "var(--sec2-ink)", module: "purchases" },
  { id: "treasury",      href: "/treasury",            name: "الخزينة والمدفوعات", desc: "أرصدة وسندات وتحويلات", sec: 3, color: "var(--sec3-ink)", roles: ["admin", "manager", "accountant", "cashier", "auditor"], module: "treasury", featured: true },
  { id: "expenses",      href: "/expenses",            name: "المصروفات",         desc: "مصروفات يومية",     sec: 3, color: "var(--sec3-ink)", module: "expenses" },
  { id: "vouchers",      href: "/vouchers",            name: "السندات",           desc: "قبض وصرف",          sec: 3, color: "var(--sec3-ink)", module: "treasury" },
  { id: "shifts",        href: "/shifts",              name: "سجلّ الورديات",     desc: "إغلاقات وZ-report", sec: 3, color: "var(--sec3-ink)", module: "treasury" },
  { id: "arAging",       href: "/ar-aging",            name: "الذمم المدينة",     desc: "أعمار ومتابعة",     sec: 3, color: "var(--sec3-ink)", module: "collections" },
  { id: "apAging",       href: "/ap-aging",            name: "الذمم الدائنة",     desc: "ذمم الموردين",      sec: 3, color: "var(--sec3-ink)", module: "suppliers" },
  { id: "custStatement", href: "/customers-statement", name: "كشف حساب عميل",     desc: "حسابات العملاء",    sec: 3, color: "var(--sec3-ink)", module: "collections" },
  { id: "suppStatement", href: "/suppliers-statement", name: "كشف حساب مورد",     desc: "حسابات الموردين",   sec: 3, color: "var(--sec3-ink)", module: "suppliers" },
  { id: "salesReport",   href: "/sales-report",        name: "تقرير المبيعات",    desc: "ملخّص وأرباح",      sec: 3, color: "var(--sec3-ink)", module: "reports" },
  { id: "reports",       href: "/reports",             name: "التقارير والكشوفات", desc: "مالية وتشغيلية ورقابية", sec: 3, color: "var(--sec3-ink)", module: "reports" },
  { id: "cardAccount",   href: "/card-account",        name: "حساب البطاقة والبنك", desc: "أرصدة وتسويات البطاقة", sec: 3, color: "var(--sec3-ink)", roles: ["admin", "manager", "accountant", "auditor"], module: "reports" },
  { id: "exchange",      href: "/exchange",            name: "الصيرفة",           desc: "صرف وتسوية العملات", sec: 3, color: "var(--sec3-ink)", roles: ["admin", "manager", "accountant"], module: "treasury" },
  { id: "workOrders",    href: "/work-orders",         name: "المطبعة والإنتاج",  desc: "أوامر الشغل والتخصيص", sec: 4, color: "var(--sec4-ink)", module: "workorders" },
  { id: "tasks",         href: "/tasks",               name: "المهام والتذاكر",   desc: "إسناد ومتابعة وSLA", sec: 4, color: "var(--sec4-ink)", module: "tasks" },
  { id: "delivery",      href: "/delivery",            name: "التوصيل",           desc: "طلبات وشركات وتحصيل COD", sec: 4, color: "var(--sec4-ink)", roles: ["admin", "manager", "accountant", "cashier", "auditor"] },
  { id: "store",         href: "/store-admin",         name: "طلبات المتجر",      desc: "طلبات وبنرات وإعدادات", sec: 4, color: "var(--sec4-ink)", roles: ["admin", "manager", "cashier", "sales_rep", "accountant", "auditor"], module: "store" },
  { id: "assets",        href: "/assets",              name: "الأصول الثابتة",    desc: "سجلّ وإهلاك وعهدة", sec: 5, color: "var(--sec5-ink)", managerOnly: true },
  { id: "hr",            href: "/hr",                  name: "الموارد البشرية",   desc: "موظفون وحضور ورواتب", sec: 5, color: "var(--sec5-ink)", roles: ["admin", "manager", "accountant", "auditor"], module: "hr" },
  { id: "closing",       href: "/closing",             name: "الإقفال والرقابة",  desc: "فترات واعتمادات وتوافق", sec: 5, color: "var(--sec5-ink)", managerOnly: true },
  { id: "settings",      href: "/settings",            name: "الإدارة والإعدادات", desc: "فروع وأدوار وتكاملات", sec: 5, color: "var(--sec5-ink)", managerOnly: true },
  { id: "users",         href: "/users",               name: "المستخدمون",        desc: "صلاحيات وأدوار",    sec: 5, color: "var(--sec5-ink)", adminOnly: true },
  { id: "audit",         href: "/audit",               name: "سجلّ التدقيق",      desc: "مراقبة العمليات",   sec: 5, color: "var(--sec5-ink)", adminOnly: true },
  { id: "reconcile",     href: "/reconcile",           name: "تدقيق التوافق",     desc: "كشف الانحراف",      sec: 5, color: "var(--sec5-ink)",  adminOnly: true },
];

const registeredById = new Map(APPLICATION_MODULES.map((module) => [module.id, module]));
const coreModuleIds = new Set(CORE_MODULES.map((module) => module.id));
const fromRegistry = (module: ApplicationModule): ModuleDef => ({
  ...module,
  name: module.label,
  desc: module.description,
  sec: module.section,
  color: `var(--sec${module.section}-ink)`,
});

function withRegisteredGate(module: ModuleDef): ModuleDef {
  const registered = registeredById.get(module.id);
  if (!registered) return module;
  return {
    ...module,
    roles: registered.roles,
    module: registered.module,
    level: registered.level,
    managerOnly: registered.managerOnly,
    adminOnly: registered.adminOnly,
    anyOf: registered.anyOf,
    icon: registered.icon,
  };
}

/** بطاقات الرئيسية تُغذّى من سجلّ التنقّل؛ أي وحدة مستقبلية جديدة تظهر هنا تلقائياً. */
const MODULES: ModuleDef[] = [
  ...CORE_MODULES.map(withRegisteredGate),
  ...APPLICATION_MODULES.filter((module) => !coreModuleIds.has(module.id)).map(fromRegistry),
];

/* ═══════════ QUICK ACTIONS ═══════════
   شريط الإجراءات السريعة أسفل كل بطاقة — اختصار النقرات.
   كل إجراء يشير إلى مسار حقيقي موجود في App.tsx فقط.
   adminOnly: يظهر للمدير/الأدمن فقط.
   لإضافة/تعديل إجراء: أضف سطراً هنا بمعرّف الوحدة (id) ومسار صحيح.
═══════════════════════════════════════ */

type Action = { ic: string; label: string; href: string; adminOnly?: boolean };

const ACTIONS: Record<string, Action[]> = {
  pos:           [{ ic: "plus",    label: "فاتورة", href: "/sales/new" }],
  crm:           [{ ic: "plus",    label: "عميل", href: "/customers/new" }, { ic: "plus", label: "عرض", href: "/quotations/new" }, { ic: "rows", label: "الوارد", href: "/inbox" }],
  sales:         [{ ic: "plus",    label: "بيع",    href: "/sales/new" },             { ic: "return",  label: "مرتجع",   href: "/sales-returns/new" },    { ic: "doc",  label: "تقرير", href: "/sales-report" }],
  quotations:    [{ ic: "plus",    label: "عرض",    href: "/quotations/new" },       { ic: "doc",     label: "فواتير",  href: "/invoices" }],
  customers:     [{ ic: "plus",    label: "عميل",   href: "/customers/new" },        { ic: "doc",     label: "كشف",     href: "/customers-statement" },  { ic: "coin", label: "ذمم",   href: "/ar-aging" }],
  returns:       [{ ic: "return",  label: "بيع",    href: "/sales-returns/new" },    { ic: "return",  label: "شراء",    href: "/purchase-returns/new" }, { ic: "doc",  label: "فواتير", href: "/invoices" }],
  products:      [{ ic: "plus",    label: "منتج",    href: "/products/new" },         { ic: "barcode", label: "باركود",  href: "/barcode-labels" },       { ic: "rows", label: "أرصدة", href: "/inventory" }],
  purchases:     [{ ic: "plus",    label: "أمر",    href: "/purchases/new" },        { ic: "return",  label: "إرجاع",   href: "/purchase-returns/new" }, { ic: "coin", label: "ذمم",   href: "/ap-aging" }],
  inventory:     [{ ic: "rows",    label: "حركة",   href: "/inventory-movements" },  { ic: "return",  label: "تحويل",   href: "/transfers" },            { ic: "plus", label: "منتج",   href: "/products/new" }],
  stocktakes:    [{ ic: "plus",    label: "جرد", href: "/stocktakes/new" }, { ic: "rows", label: "أرصدة", href: "/inventory" }],
  movements:     [{ ic: "rows",    label: "أرصدة",  href: "/inventory" },            { ic: "return",  label: "تحويل",   href: "/transfers" },            { ic: "barcode", label: "باركود", href: "/barcode-labels" }],
  transfers:     [{ ic: "rows",    label: "أرصدة",  href: "/inventory" },            { ic: "rows",    label: "حركة",    href: "/inventory-movements" }],
  barcode:       [{ ic: "plus",    label: "منتج",    href: "/products/new" },         { ic: "rows",    label: "منتجات",   href: "/products" }],
  suppliers:     [{ ic: "plus",    label: "مورد",   href: "/suppliers/new" },        { ic: "doc",     label: "كشف",     href: "/suppliers-statement" },  { ic: "coin", label: "ذمم",   href: "/ap-aging" }],
  purchaseReturns: [{ ic: "return", label: "إرجاع",  href: "/purchase-returns/new" }, { ic: "rows",    label: "موردون",  href: "/suppliers" }],
  expenses:      [{ ic: "plus",    label: "مصروف",  href: "/expenses/new" },         { ic: "coin",    label: "ذمم",     href: "/ap-aging" }],
  vouchers:      [{ ic: "coin",    label: "قبض",    href: "/vouchers/receipt/new" }, { ic: "export",  label: "صرف",     href: "/vouchers/payment/new" }],
  treasury:      [{ ic: "coin",    label: "قبض", href: "/vouchers/receipt/new" }, { ic: "export", label: "صرف", href: "/vouchers/payment/new" }, { ic: "return", label: "تحويل", href: "/treasury/transfers" }],
  arAging:       [{ ic: "doc",     label: "كشف",    href: "/customers-statement" },  { ic: "rows",    label: "عملاء",   href: "/customers" },            { ic: "doc",  label: "تقرير", href: "/sales-report" }],
  apAging:       [{ ic: "doc",     label: "كشف",    href: "/suppliers-statement" },  { ic: "rows",    label: "موردون",  href: "/suppliers" },            { ic: "plus", label: "مصروف", href: "/expenses/new" }],
  custStatement: [{ ic: "coin",    label: "ذمم",    href: "/ar-aging" },             { ic: "rows",    label: "عملاء",   href: "/customers" }],
  suppStatement: [{ ic: "coin",    label: "ذمم",    href: "/ap-aging" },             { ic: "rows",    label: "موردون",  href: "/suppliers" }],
  salesReport:   [{ ic: "rows",    label: "فواتير", href: "/invoices" },             { ic: "coin",    label: "ذمم",     href: "/ar-aging" }],
  reports:       [{ ic: "doc",     label: "مبيعات", href: "/reports/sales-hub" }, { ic: "coin", label: "ذمم", href: "/reports/aging-hub" }, { ic: "rows", label: "تنفيذي", href: "/reports" }],
  cardAccount:   [{ ic: "doc",     label: "الخزينة", href: "/treasury" }],
  exchange:      [{ ic: "doc",     label: "الخزينة", href: "/treasury" }],
  workOrders:    [{ ic: "plus",    label: "استقبال", href: "/pos?mode=RECEPTION" }, { ic: "plus",    label: "عرض",     href: "/quotations/new" },       { ic: "rows", label: "خامات", href: "/inventory" }],
  tasks:         [{ ic: "rows",    label: "مهامي", href: "/tasks?tab=mine" }, { ic: "rows", label: "المتأخرة", href: "/tasks?tab=list&overdue=1" }],
  delivery:      [{ ic: "rows",    label: "الطلبات", href: "/delivery" }, { ic: "rows", label: "الشركات", href: "/delivery/parties" }],
  store:         [{ ic: "rows",    label: "الطلبات", href: "/store-admin" }, { ic: "eye", label: "المتجر", href: "/store" }],
  assets:        [{ ic: "plus",    label: "أصل", href: "/assets/new" }, { ic: "rows", label: "العهدة", href: "/assets/custody-report" }],
  hr:            [{ ic: "plus",    label: "موظف", href: "/hr/employees/new" }, { ic: "rows", label: "الحضور", href: "/hr/attendance" }, { ic: "coin", label: "الرواتب", href: "/hr/payroll" }],
  closing:       [{ ic: "shield",  label: "الفترات", href: "/period-lock" }, { ic: "eye", label: "التوافق", href: "/reconcile" }],
  settings:      [{ ic: "shield",  label: "الأدوار", href: "/roles" }, { ic: "rows", label: "المستخدمون", href: "/users" }, { ic: "eye", label: "التدقيق", href: "/audit" }],
  users:         [{ ic: "plus",    label: "مستخدم", href: "/users/new", adminOnly: true }, { ic: "eye", label: "تدقيق", href: "/audit", adminOnly: true }],
  audit:         [{ ic: "shield",  label: "مستخدمون", href: "/users", adminOnly: true }],
  reconcile:     [{ ic: "eye",     label: "تدقيق",   href: "/audit", adminOnly: true },   { ic: "coin", label: "ذمم", href: "/ar-aging", adminOnly: true }],
};

/* أيقونات الإجراءات — تستخدم currentColor لتتبع لون الزر (16×16). */
const ActIco: Record<string, (sz?: number) => React.JSX.Element> = {
  plus:   (sz = 13) => (<svg width={sz} height={sz} viewBox="0 0 16 16" fill="none"><line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /><line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>),
  search: (sz = 13) => (<svg width={sz} height={sz} viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.3" stroke="currentColor" strokeWidth="1.7" /><line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>),
  doc:    (sz = 13) => (<svg width={sz} height={sz} viewBox="0 0 16 16" fill="none"><path d="M3.5,2 H9 L12.5,5.5 V14 H3.5 Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M9,2 V5.5 H12.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><line x1="5.5" y1="8.5" x2="10.5" y2="8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="5.5" y1="11" x2="10.5" y2="11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>),
  print:  (sz = 13) => (<svg width={sz} height={sz} viewBox="0 0 16 16" fill="none"><path d="M5,6 V2.5 H11 V6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><rect x="2.5" y="6" width="11" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.5" /><rect x="5" y="10" width="6" height="3.5" rx="0.6" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>),
  return: (sz = 13) => (<svg width={sz} height={sz} viewBox="0 0 16 16" fill="none"><path d="M6.5,4 L3,7.5 L6.5,11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M3,7.5 H10 C12.2,7.5 13.2,8.8 13.2,10.6 V12.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>),
  barcode:(sz = 13) => (<svg width={sz} height={sz} viewBox="0 0 16 16" fill="none"><line x1="4" y1="3.5" x2="4" y2="12.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /><line x1="6.5" y1="3.5" x2="6.5" y2="12.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" /><line x1="8.5" y1="3.5" x2="8.5" y2="12.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><line x1="11" y1="3.5" x2="11" y2="12.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" /><line x1="12.8" y1="3.5" x2="12.8" y2="12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>),
  rows:   (sz = 13) => (<svg width={sz} height={sz} viewBox="0 0 16 16" fill="none"><line x1="3.5" y1="4.5" x2="12.5" y2="4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /><line x1="3.5" y1="8" x2="12.5" y2="8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /><line x1="3.5" y1="11.5" x2="12.5" y2="11.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>),
  shield: (sz = 13) => (<svg width={sz} height={sz} viewBox="0 0 16 16" fill="none"><path d="M8,2 L13,4 V8 C13,11 10.8,13 8,14 C5.2,13 3,11 3,8 V4 Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M5.8,8.2 L7.3,9.7 L10.2,6.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>),
  eye:    (sz = 13) => (<svg width={sz} height={sz} viewBox="0 0 16 16" fill="none"><path d="M1.6,8 C3.6,4.4 12.4,4.4 14.4,8 C12.4,11.6 3.6,11.6 1.6,8 Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.5" /></svg>),
  coin:   (sz = 13) => (<svg width={sz} height={sz} viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.6" /><path d="M8,4.6 V11.4 M6.3,6.2 H9 C9.9,6.2 9.9,8 9,8 H7 C6.1,8 6.1,9.8 7,9.8 H9.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>),
  export: (sz = 13) => (<svg width={sz} height={sz} viewBox="0 0 16 16" fill="none"><path d="M3,9.5 V12.5 H13 V9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M8,3 V10 M5.4,5.6 L8,3 L10.6,5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>),
};

/* ═══════════ SVG SHAPES ═══════════ */

function Shape({ id, sec, isPos = false, size = 76 }: { id: string; sec: number; isPos?: boolean; size?: number }) {
  const sw = 1.5;
  const w = "currentColor";

  type PathMap = Record<string, React.ReactNode>;
  const paths: PathMap = {
    pos: (
      <>
        <rect x="3" y="2" width="18" height="12" rx="2" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <rect x="5" y="4" width="14" height="7" rx="1" stroke={w} strokeWidth="1.2" fill={w} fillOpacity="0.22" strokeLinecap="round" />
        <line x1="7" y1="17" x2="17" y2="17" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <line x1="9" y1="20" x2="15" y2="20" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <line x1="10" y1="23" x2="14" y2="23" stroke={w} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
    sales: (
      <>
        <path d="M5,3 H16 L20,7 V21 H5 Z" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M16,3 V7 H20" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <line x1="8" y1="11" x2="16" y2="11" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <line x1="8" y1="14" x2="16" y2="14" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <line x1="8" y1="17" x2="12" y2="17" stroke={w} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
    quotations: (
      <>
        <path d="M4,3 H15 L20,8 V21 H4 Z" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M15,3 V8 H20" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <line x1="7" y1="12" x2="17" y2="12" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <line x1="7" y1="15" x2="17" y2="15" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <path d="M7,19.5 L9.5,22 L14.5,17" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    customers: (
      <>
        <circle cx="12" cy="8" r="4" stroke={w} strokeWidth={sw} />
        <path d="M3,21 C3,17 7,14.5 12,14.5 C17,14.5 21,17 21,21" stroke={w} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
    returns: (
      <>
        <path d="M8,6 L4,10 L8,14" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4,10 H15 C18.5,10 20,8.5 20,6 V5" stroke={w} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
    products: (
      <>
        <path d="M12,3 L21,7.5 V16.5 L12,21 L3,16.5 V7.5 Z" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M3,7.5 L12,12 L21,7.5" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <line x1="12" y1="12" x2="12" y2="21" stroke={w} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
    purchases: (
      <>
        <path d="M1,4 H4 L6,14 H20 L22,8 H6" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="9" cy="19" r="1.5" stroke={w} strokeWidth={sw} />
        <circle cx="17" cy="19" r="1.5" stroke={w} strokeWidth={sw} />
      </>
    ),
    inventory: (
      <>
        <rect x="2" y="3" width="20" height="5.5" rx="1.5" stroke={w} strokeWidth={sw} />
        <rect x="2" y="12" width="20" height="5.5" rx="1.5" stroke={w} strokeWidth={sw} />
        <line x1="2" y1="20.5" x2="22" y2="20.5" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <line x1="5" y1="17.5" x2="5" y2="21" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <line x1="19" y1="17.5" x2="19" y2="21" stroke={w} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
    movements: (
      <>
        <path d="M7,21 V5 M3.5,8.5 L7,5 L10.5,8.5" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M17,3 V19 M13.5,15.5 L17,19 L20.5,15.5" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    transfers: (
      <>
        <path d="M4,8 H20 M16,5 L20,8 L16,11" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M20,16 H4 M8,13 L4,16 L8,19" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    barcode: (
      <>
        <rect x="2" y="3" width="20" height="18" rx="1.5" stroke={w} strokeWidth={sw} />
        <line x1="6" y1="7" x2="6" y2="17" stroke={w} strokeWidth="2.5" strokeLinecap="round" />
        <line x1="9.5" y1="7" x2="9.5" y2="17" stroke={w} strokeWidth="1.2" strokeLinecap="round" />
        <line x1="12" y1="7" x2="12" y2="17" stroke={w} strokeWidth="3" strokeLinecap="round" />
        <line x1="14.5" y1="7" x2="14.5" y2="17" stroke={w} strokeWidth="1.2" strokeLinecap="round" />
        <line x1="18" y1="7" x2="18" y2="17" stroke={w} strokeWidth="2" strokeLinecap="round" />
      </>
    ),
    suppliers: (
      <>
        <rect x="1" y="9" width="13" height="9" rx="1.5" stroke={w} strokeWidth={sw} />
        <path d="M14,12 H18 L22,16 V18 H14 Z" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="5" cy="20" r="1.8" stroke={w} strokeWidth={sw} />
        <circle cx="17" cy="20" r="1.8" stroke={w} strokeWidth={sw} />
        <path d="M5,9 V5 H11 V9" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    purchaseReturns: (
      <>
        <path d="M3,9 H21 L19,20 H5 Z" stroke={w} strokeWidth={sw} strokeLinejoin="round" />
        <path d="M3,9 L5,5 H19 L21,9" stroke={w} strokeWidth={sw} strokeLinejoin="round" />
        <path d="M14,14 H9 M11,12 L9,14 L11,16" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    expenses: (
      <>
        <rect x="2" y="7" width="20" height="13" rx="2" stroke={w} strokeWidth={sw} />
        <path d="M7,7 L9,4 H15 L17,7" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="16.5" cy="13.5" r="2.2" stroke={w} strokeWidth={sw} fill={w} fillOpacity="0.22" />
      </>
    ),
    vouchers: (
      <>
        <rect x="5" y="3" width="14" height="18" rx="2" stroke={w} strokeWidth={sw} />
        <line x1="8.5" y1="7" x2="15.5" y2="7" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <path d="M9,17 V11 M6.8,14.2 L9,17 L11.2,14.2" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M15,11 V17 M12.8,13.8 L15,11 L17.2,13.8" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    arAging: (
      <>
        <circle cx="7.5" cy="7" r="3.5" stroke={w} strokeWidth={sw} />
        <path d="M1,20 C1,16.5 4,14.5 7.5,14.5" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <circle cx="17" cy="15.5" r="5.5" stroke={w} strokeWidth={sw} />
        <path d="M17,12.5 V15.5 L19,17" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    apAging: (
      <>
        <path d="M3,21 V10.5 L9,5 L15,10.5 V21" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <rect x="7.5" y="14" width="3" height="7" rx="0.5" stroke={w} strokeWidth="1.3" />
        <circle cx="18.5" cy="13.5" r="4.5" stroke={w} strokeWidth={sw} />
        <path d="M18.5,11 V13.5 L20,14.8" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    custStatement: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" stroke={w} strokeWidth={sw} />
        <circle cx="12" cy="9.5" r="3" stroke={w} strokeWidth={sw} />
        <path d="M7,18 C7,15.5 9.2,14 12,14 C14.8,14 17,15.5 17,18" stroke={w} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
    suppStatement: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" stroke={w} strokeWidth={sw} />
        <path d="M8,18 V12 L12,8 L16,12 V18" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <rect x="10.5" y="13" width="3" height="5" rx="0.5" stroke={w} strokeWidth="1.3" />
      </>
    ),
    salesReport: (
      <>
        <path d="M3,3 V21 H21" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <rect x="6.5" y="13" width="3" height="5" rx="0.6" stroke={w} strokeWidth={sw} strokeLinejoin="round" />
        <rect x="11.5" y="9" width="3" height="9" rx="0.6" stroke={w} strokeWidth={sw} strokeLinejoin="round" />
        <rect x="16.5" y="5.5" width="3" height="12.5" rx="0.6" stroke={w} strokeWidth={sw} strokeLinejoin="round" />
      </>
    ),
    crm: (
      <>
        <circle cx="8" cy="8" r="3.5" stroke={w} strokeWidth={sw} />
        <path d="M2.5,19 C2.5,15.5 5,13.5 8,13.5 C11,13.5 13.5,15.5 13.5,19" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <path d="M15,6 H21 V15 H18 L15,18 V6 Z" stroke={w} strokeWidth={sw} strokeLinejoin="round" />
      </>
    ),
    stocktakes: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" stroke={w} strokeWidth={sw} />
        <path d="M8,3.5 V6 H16 V3.5" stroke={w} strokeWidth={sw} strokeLinejoin="round" />
        <path d="M8,11 L10,13 L14,9 M8,17 H16" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    treasury: (
      <>
        <rect x="2.5" y="7" width="19" height="13" rx="2" stroke={w} strokeWidth={sw} />
        <path d="M6,7 L8,4 H16 L18,7 M2.5,11 H21.5" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <circle cx="17" cy="15.5" r="2" stroke={w} strokeWidth={sw} />
      </>
    ),
    reports: (
      <>
        <path d="M4,3 V21 H21" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M7,17 L11,12 L14,14 L20,7" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M16,7 H20 V11" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    cardAccount: (
      <>
        <rect x="2" y="5" width="20" height="14" rx="2" stroke={w} strokeWidth={sw} />
        <path d="M2,10 H22 M6,15 H11" stroke={w} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
    exchange: (
      <>
        <path d="M4,8 H19 M16,5 L19,8 L16,11" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M20,16 H5 M8,13 L5,16 L8,19" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    workOrders: (
      <>
        <rect x="4" y="5" width="16" height="16" rx="2" stroke={w} strokeWidth={sw} />
        <path d="M9,3 H15 V7 H9 Z" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <line x1="8" y1="12" x2="16" y2="12" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <line x1="8" y1="15.5" x2="16" y2="15.5" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <path d="M8,19 L10,21 L15,16" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    tasks: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" stroke={w} strokeWidth={sw} />
        <path d="M7,8 L8.5,9.5 L11,6.5 M13,8 H17 M7,14 L8.5,15.5 L11,12.5 M13,14 H17" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    delivery: (
      <>
        <path d="M2,7 H14 V18 H2 Z M14,11 H18 L22,15 V18 H14 Z" stroke={w} strokeWidth={sw} strokeLinejoin="round" />
        <circle cx="6" cy="19" r="2" stroke={w} strokeWidth={sw} />
        <circle cx="18" cy="19" r="2" stroke={w} strokeWidth={sw} />
      </>
    ),
    store: (
      <>
        <path d="M3,9 L5,4 H19 L21,9" stroke={w} strokeWidth={sw} strokeLinejoin="round" />
        <path d="M4,9 V21 H20 V9 M9,21 V14 H15 V21" stroke={w} strokeWidth={sw} strokeLinejoin="round" />
        <path d="M3,9 C3,11 6,11 6,9 C6,11 9,11 9,9 C9,11 12,11 12,9 C12,11 15,11 15,9 C15,11 18,11 18,9 C18,11 21,11 21,9" stroke={w} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
    assets: (
      <>
        <rect x="3" y="6" width="18" height="14" rx="2" stroke={w} strokeWidth={sw} />
        <path d="M8,6 V3 H16 V6 M3,11 H21 M9,11 V14 H15 V11" stroke={w} strokeWidth={sw} strokeLinejoin="round" />
      </>
    ),
    hr: (
      <>
        <circle cx="12" cy="7" r="4" stroke={w} strokeWidth={sw} />
        <path d="M4,21 C4,16.5 7.5,14 12,14 C16.5,14 20,16.5 20,21" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <path d="M18,3 V8 M15.5,5.5 H20.5" stroke={w} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
    closing: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" stroke={w} strokeWidth={sw} />
        <path d="M8,10 V7 C8,2.5 16,2.5 16,7 V10" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <circle cx="12" cy="15.5" r="1.5" stroke={w} strokeWidth={sw} />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3.5" stroke={w} strokeWidth={sw} />
        <path d="M12,2.5 V5 M12,19 V21.5 M2.5,12 H5 M19,12 H21.5 M5.3,5.3 L7.1,7.1 M16.9,16.9 L18.7,18.7 M18.7,5.3 L16.9,7.1 M7.1,16.9 L5.3,18.7" stroke={w} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
    users: (
      <>
        <circle cx="8.5" cy="7" r="3.5" stroke={w} strokeWidth={sw} />
        <path d="M1,20 C1,16.5 4.5,14.5 8.5,14.5" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <circle cx="16" cy="7" r="3" stroke={w} strokeWidth={sw} />
        <path d="M13.5,14.5 C17.5,14.5 22,16.5 22,20" stroke={w} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
    audit: (
      <>
        <path d="M12,3 L20,7 V13 C20,17.5 16.4,21 12,22 C7.6,21 4,17.5 4,13 V7 Z" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8.5,12.5 L11,15 L15.5,9.5" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    reconcile: (
      <>
        <line x1="12" y1="4.5" x2="12" y2="20" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <line x1="8" y1="20" x2="16" y2="20" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <line x1="4.5" y1="7.5" x2="19.5" y2="7.5" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <circle cx="12" cy="5" r="1.4" stroke={w} strokeWidth={sw} />
        <path d="M4.5,7.5 L2.5,12.5 H6.5 Z" stroke={w} strokeWidth={sw} strokeLinejoin="round" />
        <path d="M19.5,7.5 L17.5,12.5 H21.5 Z" stroke={w} strokeWidth={sw} strokeLinejoin="round" />
      </>
    ),
  };

  const icon = paths[id] ?? <circle cx="12" cy="12" r="9" stroke={w} strokeWidth={sw} />;

  // «صَفا»: رقاقة أيقونة ثنائية اللون (خلفية تِنت العائلة + غليف بحبر العائلة) بدل المربّع المُشبَع اللمّاع.
  // الغليف يرث لون العائلة عبر currentColor (color على الـsvg الخارجي).
  const chipBg = isPos ? "var(--dash-pos-chip)" : `var(--sec${sec}-chip)`;
  const chipBd = isPos ? "transparent" : `var(--sec${sec}-chipbd)`;
  const glyph = isPos ? "var(--dash-pos-glyph)" : `var(--sec${sec}-icon)`;

  return (
    <svg style={{ width: size, height: size, display: "block", flexShrink: 0, color: glyph }} viewBox="0 0 52 52" fill="none">
      <rect x="0.75" y="0.75" width="50.5" height="50.5" rx="15" fill={chipBg} stroke={chipBd} strokeWidth="1.5" />
      <svg x="10" y="10" width="32" height="32" viewBox="0 0 24 24" fill="none" overflow="visible">
        {icon}
      </svg>
    </svg>
  );
}
/* ═══════════ METRICS BAR ═══════════ */

const TrendIco = ({ color }: { color: string }) => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none">
    <polyline points="2,12 5,7 9,9 14,4" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <polyline points="10,4 14,4 14,8" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const WarnIco = ({ color }: { color: string }) => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none">
    <path d="M8,2 L14.5,13.5 H1.5 Z" stroke={color} strokeWidth="1.6" fill="none" strokeLinejoin="round" />
    <line x1="8" y1="7" x2="8" y2="10.5" stroke={color} strokeWidth="1.7" strokeLinecap="round" />
    <circle cx="8" cy="12.5" r="0.8" fill={color} />
  </svg>
);
const ShiftIco = ({ color }: { color: string }) => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="6.5" stroke={color} strokeWidth="1.7" />
    <polyline points="8,4.5 8,8.5 10.5,10.5" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ═══════════ CONTEXT HEADER ═══════════
   رأسٌ عمليّ للصفحة: مَن يعمل؟ في أي نطاق؟ وما أقصر المسارات اليومية؟
   الأزرار تُفلتر بنفس canSeeGate المستعمل في بطاقات الوحدات، فلا نصنع طريقاً بصرياً إلى 403. */

function DashboardHeader({
  branchScope,
  isAdmin,
  onBranchScopeChange,
}: {
  branchScope: number | undefined;
  isAdmin: boolean;
  onBranchScopeChange: (branchId: number | undefined) => void;
}) {
  const T = useT();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role;
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const branches = trpc.branches.list.useQuery(undefined, { enabled: Boolean(me.data) });
  const selectedBranch = branches.data?.find((branch) => branch.id === branchScope);
  const branchLabel = branchScope == null ? "كل الفروع" : (selectedBranch?.name ?? "الفرع المعيّن");
  const roleLabel = me.data?.isOwner ? "مالك النظام" : (me.data?.customRoleLabel ?? (role ? ROLE_LABEL[role] : undefined) ?? "مستخدم النظام");
  const dateLabel = new Intl.DateTimeFormat("ar-IQ", { weekday: "long", day: "numeric", month: "long", year: "numeric", numberingSystem: "latn" }).format(new Date());

  const salesModule = MODULES.find((module) => module.id === "sales")!;
  const treasuryModule = MODULES.find((module) => module.id === "treasury")!;
  const quickActions = [
    { href: "/pos", label: "نقطة البيع", icon: ShoppingCart, visible: true, primary: true },
    { href: "/sales/new", label: "فاتورة جديدة", icon: ReceiptText, visible: canSeeGate(salesModule, role, override), primary: false },
    { href: "/vouchers/receipt/new", label: "سند قبض", icon: Banknote, visible: canSeeGate(treasuryModule, role, override), primary: false },
  ].filter((action) => action.visible);

  return (
    <header style={{ background: T.cardBg, borderBottom: `1px solid ${T.cardBord}`, padding: "22px 24px 18px" }}>
      <div style={{ maxWidth: 1600, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "0.75rem", fontWeight: 700, color: T.secLabel, marginBottom: 5 }}>الشاشة الرئيسية</div>
          <h1 style={{ margin: 0, fontSize: "1.5rem", lineHeight: 1.35, fontWeight: 900, color: T.text }}>أهلاً {me.data?.name ?? "بك"}</h1>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 9, color: T.sub, fontSize: "0.75rem" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <CalendarDays aria-hidden size={14} />
              {dateLabel}
            </span>
            <span aria-hidden style={{ color: T.cardBord }}>
              •
            </span>
            <span style={{ fontWeight: 700 }}>{roleLabel}</span>
            <span aria-hidden style={{ color: T.cardBord }}>
              •
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <MapPin aria-hidden size={13} />
              {branchLabel}
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {isAdmin && (
            <div className="w-full sm:w-44">
              <AppSelect
                aria-label="نطاق فرع الشاشة الرئيسية"
                className="h-[42px] bg-background text-xs font-bold"
                value={branchScope == null ? "all" : String(branchScope)}
                onValueChange={(value) => onBranchScopeChange(value === "all" ? undefined : Number(value))}
              >
                <option value="all">كل الفروع</option>
                {(branches.data ?? []).map((branch) => (
                  <option key={branch.id} value={String(branch.id)}>{branch.name}</option>
                ))}
              </AppSelect>
            </div>
          )}
          <nav aria-label="إجراءات يومية سريعة" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {quickActions.map((action) => {
              const Icon = action.icon;
              return (
                <Link key={action.href} href={action.href} style={{ minHeight: 42, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "9px 13px", borderRadius: 9, border: `1px solid ${action.primary ? "var(--dash-pos-chip)" : T.cardBord}`, background: action.primary ? "var(--dash-pos-chip)" : T.statBg, color: action.primary ? "var(--dash-pos-glyph)" : T.text, fontSize: "0.75rem", fontWeight: 800, textDecoration: "none", boxShadow: action.primary ? "0 2px 6px oklch(0 0 0 / 0.10)" : "none" }}>
                  <Icon aria-hidden size={16} />
                  {action.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
    </header>
  );
}

function MetricsBar({ branchScope }: { branchScope: number | undefined }) {
  const T = useT();
  const me = trpc.auth.me.useQuery();
  const isXNarrow = useMediaQuery("(max-width: 640px)");
  const isNarrow = useMediaQuery("(max-width: 1023px)");
  const isCompactDesktop = useMediaQuery("(max-width: 1359px)");
  const metricCols = isXNarrow ? 2 : isNarrow ? 3 : isCompactDesktop ? 4 : 6;
  const role = me.data?.role ?? "";
  // رؤية الأرقام المالية (ذمم متأخّرة/نبض المبيعات) — نفس بوّابة reportViewerProcedure/الخادم عبر
  // moduleAccessAllowed (لا قائمة أدوار حرفية ⇒ لا تباعُد). الخادم يُصفّر هذه الحقول لغير المخوّل؛
  // هنا نُخفي البطاقة كي لا تُعرَض «٠ ذمم متأخّرة» مضلِّلة لكاشير/مخزن (تدقيق تسريب dashboardMetrics).
  const canViewReports =
    !!role &&
    moduleAccessAllowed(
      role as RoleKey,
      (me.data?.permissionsOverride ?? null) as PermissionMap | null,
      "reports",
      "READ",
      ["manager", "accountant", "auditor"],
    );
  const scopeReady = role === "admin" || branchScope !== undefined;
  const shift = trpc.shifts.current.useQuery(
    { branchId: branchScope ?? 0 },
    { enabled: branchScope !== undefined },
  );
  // مقاييس لوحة التحكم: مخزون منخفض + ذمم متأخّرة (الخلفية تُطبّق عزل الفرع).
  const metrics = trpc.reports.dashboardMetrics.useQuery(
    { branchId: branchScope, includeTodaySales: true },
    { enabled: Boolean(role) && scopeReady },
  );
  // جلسات جرد بانتظار المراجعة — للأدوار المخوّلة فقط (الخادم warehouseProcedure).
  const canSeeStocktakes = role === "admin" || role === "manager" || role === "warehouse";
  const stk = trpc.stocktakes.stats.useQuery(undefined, { enabled: canSeeStocktakes });

  const shiftLabel = shift.data ? "مفتوحة" : "لا وردية";
  const shiftSince = shift.data ? `منذ ${fmtTime(shift.data.openedAt)}` : "";

  const sourceErrors = metrics.data?.health.sourceErrors ?? [];
  const metricsUnavailable = metrics.isError;
  const todaySalesUnavailable = metricsUnavailable || sourceErrors.includes("todaySales");
  const pulseUnavailable = metricsUnavailable || sourceErrors.includes("salesPulse");
  const todaySales = metrics.data?.todaySales;
  const todaySalesValue = metrics.isLoading
    ? "—"
    : todaySalesUnavailable
      ? "غير متاح"
      : fmtAr(todaySales?.total ?? 0);
  const todayInvoicesValue = metrics.isLoading
    ? "—"
    : todaySalesUnavailable
      ? "غير متاح"
      : fmtAr(todaySales?.invoiceCount ?? 0);

  // قيم بطاقتَي التنبيه — حالة صريحة أثناء التحميل/التعذّر، والأرقام بعد النجاح.
  const lowStockValue = metrics.isLoading
    ? "—"
    : metricsUnavailable
      ? "غير متاح"
      : fmtAr(metrics.data?.lowStockCount ?? 0);
  const overdueCount = metrics.data?.overdueAR.count ?? 0;
  const overdueValue = metrics.isLoading ? "—" : metricsUnavailable ? "غير متاح" : fmtAr(overdueCount);
  // إجمالٌ مختصر بالدينار (بلا كسور — IQD).
  const overdueTotalShort = metrics.data
    ? fmtAr(Number(metrics.data.overdueAR.total))
    : "";
  const overdueUnit = metrics.isLoading
    ? "جارٍ التحديث"
    : metricsUnavailable
      ? "حاول مجدداً"
    : overdueCount > 0
      ? `${overdueTotalShort} د.ع`
      : "> 30 يوم";

  // نص النسخ موحَّد: «التسمية: القيمة الوحدة» — يفيد المالك عند لصق رقم في واتساب/مراسلة.
  // أثناء التحميل أو التعذّر والحالات النصّية بلا قيمة = لا نسخ (CopyButton يُعطَّل تلقائياً على الفارغ).
  // نبض المبيعات (خلفية) — مبيعات أمس مقابل معدّل ٧ أيام + اتجاه بلون/سهم.
  const pulse = metrics.data?.salesPulse;
  const pulseColor =
    pulse?.direction === "up" ? "var(--sem-pos)" // أخضر — أعلى من المعدّل
    : pulse?.direction === "down" ? "var(--sem-neg)" // أحمر — أدنى
    : "var(--dash-muted)"; // رمادي — قرب المعدّل
  const pulseArrow = pulse?.direction === "up" ? "↑" : pulse?.direction === "down" ? "↓" : "=";
  const hasBaseline = !!pulse && Number(pulse.avg7d) > 0;

  const stats = [
    ...(canViewReports
      ? [
          {
            label: "مبيعات اليوم",
            value: todaySalesValue,
            unit: metrics.isLoading ? "جارٍ التحديث" : todaySalesUnavailable ? "حاول مجدداً" : "د.ع",
            copyText: metrics.isLoading || todaySalesUnavailable
              ? ""
              : `مبيعات اليوم: ${fmtAr(todaySales?.total ?? 0)} د.ع`,
            ico: <TrendIco color="var(--sem-pos)" />,
            iBg: "var(--sem-pos-bg)",
          },
          {
            label: "فواتير اليوم",
            value: todayInvoicesValue,
            unit: metrics.isLoading ? "جارٍ التحديث" : todaySalesUnavailable ? "حاول مجدداً" : "فاتورة",
            copyText: metrics.isLoading || todaySalesUnavailable
              ? ""
              : `فواتير اليوم: ${fmtAr(todaySales?.invoiceCount ?? 0)} فاتورة`,
            ico: <TrendIco color="var(--sem-pos)" />,
            iBg: "var(--sem-pos-bg)",
          },
        ]
      : []),
    // بطاقة نبض المبيعات: بلا معدّل ٧ أيام (لا مبيعات سابقة) = لا نص حشو — تُخفى كاملاً
    // (تدقيق الفجوات ٥/٧، بند ١٢) — نفس اصطلاح إخفاء بطاقة الجرد أدناه عبر spread شرطي.
    ...(metrics.isLoading || pulseUnavailable || hasBaseline
      ? [
          {
            label: "مبيعات أمس مقابل المعدّل",
            value: metrics.isLoading ? "—" : pulseUnavailable ? "غير متاح" : fmtAr(Number(pulse?.yesterday ?? 0)),
            unit: metrics.isLoading
              ? "جارٍ التحديث"
              : pulseUnavailable
                ? "حاول مجدداً"
              : `${pulseArrow} ${fmtAr(Math.abs(pulse!.changePct))}٪ عن المعدّل`,
            copyText: metrics.isLoading || pulseUnavailable || !pulse
              ? ""
              : `مبيعات أمس: ${fmtAr(Number(pulse.yesterday))} د.ع (${pulseArrow}${fmtAr(Math.abs(pulse.changePct))}٪ عن معدّل ٧ أيام = ${fmtAr(Number(pulse.avg7d))} د.ع)`,
            ico: <TrendIco color={pulseColor} />,
            iBg: `color-mix(in oklch, ${pulseColor} 15%, transparent)`,
          },
        ]
      : []),
    ...(branchScope !== undefined
      ? [{
          label: "الوردية الحالية",
          value: shift.isLoading ? "—" : shift.isError ? "غير متاح" : shiftLabel,
          unit: shift.isLoading ? "جارٍ التحديث" : shift.isError ? "حاول مجدداً" : shiftSince,
          copyText: shift.isLoading || shift.isError
            ? ""
            : shift.data
              ? `الوردية الحالية: مفتوحة ${shiftSince}`.trim()
              : "الوردية الحالية: لا وردية",
          ico: <ShiftIco color="var(--sem-info)" />,
          iBg: "var(--sem-info-bg)",
        }]
      : []),
    {
      label: "مخزون منخفض",
      value: lowStockValue,
      unit: metrics.isLoading ? "جارٍ التحديث" : metricsUnavailable ? "حاول مجدداً" : "منتج",
      copyText: metrics.isLoading || metricsUnavailable
        ? ""
        : `مخزون منخفض: ${fmtAr(metrics.data?.lowStockCount ?? 0)} منتج`,
      ico: <WarnIco color="var(--sem-warn)" />,
      iBg: "var(--sem-warn-bg)",
      isAlert: true,
      alertC: "var(--sem-warn)",
      href: "/inventory",
    },
    // بطاقة الذمم المتأخّرة ماليّة ⇒ للمخوّلين برؤية التقارير فقط (الخادم يُصفّرها لغيرهم؛ نُخفيها
    // هنا كي لا يُعرَض صفرٌ مضلِّل لكاشير/مخزن). نفس بوّابة بطاقة «مبيعات أمس» أعلاه (تُخفى ذاتياً بالصفر).
    ...(canViewReports
      ? [
          {
            label: "ذمم متأخّرة",
            value: overdueValue,
            unit: overdueUnit,
            copyText: metrics.isLoading || metricsUnavailable
              ? ""
              : overdueCount > 0
                ? `ذمم متأخّرة: ${fmtAr(overdueCount)} عميل — ${overdueTotalShort} د.ع`
                : `ذمم متأخّرة: ${fmtAr(overdueCount)} عميل`,
            ico: <WarnIco color="var(--sem-neg)" />,
            iBg: "var(--sem-neg-bg)",
            isAlert: true,
            alertC: "var(--sem-neg)",
            href: "/ar-aging",
          },
        ]
      : []),
    // بطاقة الجرد: تظهر للأدوار المخوّلة فقط، وتتحوّل تنبيهاً عند وجود جلسات بانتظار المراجعة.
    ...(canSeeStocktakes
      ? [
          {
            label: "جرد بانتظار المراجعة",
            value: stk.isLoading ? "—" : stk.isError ? "غير متاح" : fmtAr(stk.data?.review ?? 0),
            unit: stk.isLoading ? "جارٍ التحديث" : stk.isError ? "حاول مجدداً" : stk.data?.counting ? `${fmtAr(stk.data.counting)} قيد العدّ` : "جلسة",
            copyText: stk.isLoading || stk.isError
              ? ""
              : `جرد بانتظار المراجعة: ${fmtAr(stk.data?.review ?? 0)} جلسة${
                  stk.data?.counting ? ` — ${fmtAr(stk.data.counting)} قيد العدّ` : ""
                }`,
            ico: <WarnIco color="var(--sem-info)" />,
            iBg: "var(--sem-info-bg)",
            isAlert: (stk.data?.review ?? 0) > 0,
            alertC: "var(--sem-info)",
            href: "/stocktakes",
          },
        ]
      : []),
  ];
  const hasRefreshIssue = metrics.isError || metrics.data?.health.status === "degraded" || (canSeeStocktakes && stk.isError);

  return (
    <section aria-label="مؤشرات اليوم" style={{ maxWidth: 1648, margin: "0 auto", padding: "16px 24px 4px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 9 }}>
        <h2 style={{ margin: 0, color: T.text, fontSize: "0.875rem", fontWeight: 900 }}>مؤشرات اليوم</h2>
        <span style={{ color: T.muted, fontSize: "0.6875rem" }}>تتحدث تلقائياً حسب صلاحياتك ونطاق فرعك</span>
      </div>
      {hasRefreshIssue && (
        <div role="status" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 10, padding: "9px 11px", border: "1px solid var(--sem-warn)", borderRadius: 9, background: "var(--sem-warn-bg)", color: T.text, fontSize: "0.75rem" }}>
          <span>تعذّر تحديث بعض المؤشرات؛ القيم المتاحة ما زالت معروضة.</span>
          <button type="button" onClick={() => { void metrics.refetch(); if (canSeeStocktakes) void stk.refetch(); }} style={{ display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${T.cardBord}`, borderRadius: 7, background: T.cardBg, color: T.text, padding: "6px 9px", font: "inherit", fontWeight: 800, cursor: "pointer" }}>
            <RefreshCw aria-hidden size={13} />
            إعادة المحاولة
          </button>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${metricCols}, minmax(0, 1fr))`, gap: 10 }}>
        {stats.map((s, i) => {
          // بطاقة تنبيه في «صَفا»: تِنت خفيف بلون حالتها (كل تنبيه بلونه لا أحمر موحّد) + حدّ ملوّن رقيق.
          const abg = s.isAlert ? `color-mix(in oklch, ${s.iBg} 62%, var(--dash-card-bg))` : T.statBg;
          const abd = s.isAlert ? `color-mix(in oklch, ${s.alertC} 42%, ${T.statBord})` : T.statBord;
          const card = (
            <div key={i} className="group" style={{ minWidth: 0, minHeight: 74, borderRadius: 11, padding: "11px 12px", display: "flex", alignItems: "center", gap: 10, background: abg, border: `1px solid ${abd}`, boxShadow: "0 1px 4px oklch(0 0 0 / 0.04)", cursor: s.href ? "pointer" : "default", textDecoration: "none" }}>
              <div style={{ width: 34, height: 34, borderRadius: 8, flexShrink: 0, background: s.iBg, display: "flex", alignItems: "center", justifyContent: "center" }}>{s.ico}</div>
              <div>
                <div style={{ fontSize: "1.0625rem", fontWeight: 800, lineHeight: 1.25, color: s.isAlert ? s.alertC : T.text }}>{s.value}</div>
                <div style={{ fontSize: "0.6875rem", color: T.muted, lineHeight: 1.3, marginTop: 2 }}>{s.label}</div>
              </div>
              {s.unit && <div style={{ marginRight: "auto", fontSize: "0.6875rem", color: T.muted, textAlign: "left" }}>{s.unit}</div>}
              {/* زِرّ نَسخ يَظهَر عِند الـhover — يَنسَخ «التَسمية: القيمة الوحدة»
                stopPropagation/preventDefault لمَنع تَفعيل رابط البِطاقة (href). */}
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                }}
                className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
                style={{ marginInlineStart: s.unit ? 4 : "auto", flexShrink: 0 }}
              >
                <CopyButton value={s.copyText} title={`نسخ ${s.label}`} successMessage={`نُسخت ${s.label}`} />
              </div>
            </div>
          );
          return s.href ? (
            <Link key={i} href={s.href} style={{ display: "block", minWidth: 0, textDecoration: "none" }}>
              {card}
            </Link>
          ) : (
            card
          );
        })}
      </div>
    </section>
  );
}

/* ═══════════ ACTION BUTTON (footer) ═══════════ */

function ActionButton({ a, primary, color }: { a: Action; primary: boolean; color: string }) {
  const T = useT();
  // color = رمز حبر العائلة var(--secN-ink) ⇒ التظليل عبر color-mix (لا string.replace على المتغيّر).
  const tint = (op: number) => `color-mix(in oklch, ${color} ${Math.round(op * 100)}%, transparent)`;
  const base = primary ? color : T.sub;
  return (
    <Link
      href={a.href}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        textDecoration: "none",
        borderInlineStart: primary ? undefined : `1px solid ${T.cardBord}`,
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
          fontSize: "0.75rem",
          fontWeight: primary ? 700 : 600,
          color: base,
          padding: "0 4px",
          transition: "background 0.15s, color 0.15s",
        }}
        onMouseEnter={(e) => {
          const el = e.currentTarget as HTMLDivElement;
          el.style.background = tint(primary ? 0.15 : 0.11);
          el.style.color = color;
        }}
        onMouseLeave={(e) => {
          const el = e.currentTarget as HTMLDivElement;
          el.style.background = "transparent";
          el.style.color = base;
        }}
      >
        {ActIco[a.ic]?.(13)}
        <span style={{ whiteSpace: "nowrap" }}>{a.label}</span>
      </div>
    </Link>
  );
}

/* ═══════════ MODULE CARD ═══════════ */

function ModuleCard({ m }: { m: (typeof MODULES)[number] }) {
  const T = useT();
  const me = trpc.auth.me.useQuery(); // مُخزَّن مؤقتاً (deduped) — لا طلب شبكة إضافي.
  const elevated = me.data?.role === "admin" || me.data?.role === "manager";
  const acts = (ACTIONS[m.id] ?? []).filter((a) => !a.adminOnly || elevated);
  const bord = m.featured ? T.featuredBd : T.cardBord;
  // «صَفا»: بطاقة محايدة دافئة (بلا لمعان ولا ظلٍّ ملوّن صارخ) — الهوية في رقاقة الأيقونة وشريط القسم.
  // ارتفاعٌ بظلٍّ محايد ناعم؛ عند التحويم يميل الحدّ نحو حبر العائلة (إشارة لطيفة).
  const restShadow = "0 1px 2px oklch(0 0 0 / 0.05), 0 1px 3px oklch(0 0 0 / 0.03)";
  const hoverShadow = "0 4px 16px oklch(0 0 0 / 0.08)";
  const hoverBord = `color-mix(in oklch, ${m.color} 32%, ${T.cardBord})`;
  const ModuleIcon = m.icon;

  return (
    <div
      style={{
        // minHeight + minWidth:0 (بِلا aspect-ratio) لِتَوحيد ارتِفاع الصَفّ ومَنع تَمَدُّد
        // العَرض فَوق مَسار 1fr الضَيّق ⇒ تَراكُب (شَكوى المالك ١٢/٧).
        minWidth: 0,
        minHeight: 136,
        borderRadius: 16,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        cursor: "pointer",
        background: m.featured ? T.featuredBg : T.cardBg,
        border: `${m.featured ? 2 : 1}px solid ${bord}`,
        boxShadow: restShadow,
        transition: "box-shadow 0.18s, transform 0.18s, border-color 0.18s",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.boxShadow = hoverShadow;
        el.style.transform = "translateY(-2px)";
        if (!m.featured) el.style.borderColor = hoverBord;
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.boxShadow = restShadow;
        el.style.transform = "none";
        if (!m.featured) el.style.borderColor = T.cardBord as string;
      }}
    >
      {/* المنطقة الرئيسية — رابط الوحدة */}
      <Link
        href={m.href}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          padding: "10px 9px 7px",
          textAlign: "center",
          textDecoration: "none",
        }}
      >
        {ModuleIcon ? (
          <span
            aria-hidden
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: m.color,
              background: `color-mix(in oklch, ${m.color} 12%, transparent)`,
            }}
          >
            <ModuleIcon size={24} strokeWidth={1.7} />
          </span>
        ) : <Shape id={m.id} sec={m.sec} isPos={m.id === "pos"} size={44} />}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div
            style={{
              fontSize: "0.8125rem",
              fontWeight: 700,
              lineHeight: 1.3,
              color: T.text,
              letterSpacing: "-0.01em",
            }}
          >
            {m.name}
          </div>
          <div style={{ fontSize: "0.6875rem", color: T.sub, lineHeight: 1.4, fontWeight: 500 }}>
            {m.desc}
          </div>
        </div>
      </Link>

      {/* شريط الإجراءات السريعة — حد أقصى 3 أزرار (خلفية محايدة، الإجراء الأساسي بحبر العائلة) */}
      {acts.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            height: 38,
            flexShrink: 0,
            borderTop: `1px solid ${T.cardBord}`,
          }}
        >
          {acts.slice(0, 3).map((a, i) => (
            <ActionButton key={a.href + i} a={a} primary={i === 0} color={m.color} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════ SECTION ROW ═══════════ */

function SectionRow({ sec }: { sec: (typeof SECTIONS)[number] }) {
  const T = useT();
  const me = trpc.auth.me.useQuery(); // مُخزَّن مؤقتاً (deduped) — لا طلب إضافي.
  const role = me.data?.role;
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  // عدد الأعمدة متجاوب — كَسر ذَكي يَحفَظ نِسبة البِطاقة قَريبة من المُربَّع:
  //   ≤640px      ⇒ 2 (مَوبايل)
  //   641-1023px  ⇒ 3 (لَوحي)
  //   1024-1359px ⇒ 4 (تَكبير ١٥٠٪ على FHD = ١٢٨٠؛ يمنع البطاقات الضيقة)
  //   ≥1360px     ⇒ 6 (ومنها ١٤٤٠ الشائعة؛ يمنع صف ٥+١ اليتيم في قسم المبيعات)
  // نتعمّد إسقاط حالة ٥ أعمدة: معظم الأقسام تضم ٦/٩ وحدات، فتنتظم ٦ أو ٤ أفضل بصرياً.
  // (تُستدعى الـhooks قبل أي عودة مبكرة — قاعدة Hooks.)
  const isXNarrow = useMediaQuery("(max-width: 640px)");
  const isNarrow = useMediaQuery("(max-width: 1023px)");
  const isCompactDesktop = useMediaQuery("(max-width: 1359px)");
  const cols = isXNarrow ? 2 : isNarrow ? 3 : isCompactDesktop ? 4 : 6;
  // نفس بوابة الشريط الجانبي: الدور القالبي + المنح الفردي/الدور المخصّص + مستوى الوحدة.
  // هكذا لا تظهر بطاقة تقود المستخدم إلى 403، وتظهر تلقائياً عند منحه الوحدة صراحةً.
  const mods = MODULES.filter((m) => m.sec === sec.id && canSeeGate(m, role, override));
  // قسم بلا بطاقات مرئية للدور الحالي ⇒ يُخفى كاملاً (لا رأس ولا فراغات).
  if (mods.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <div style={{ width: 3, height: 14, borderRadius: 2, background: sec.accent, flexShrink: 0 }} />
        <span style={{ fontSize: "0.75rem", fontWeight: 800, color: T.secLabel, letterSpacing: "0.04em" }}>
          {sec.name}
        </span>
        <span
          style={{
            minWidth: 22,
            height: 20,
            padding: "0 6px",
            borderRadius: 10,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: T.statBg,
            border: `1px solid ${T.statBord}`,
            color: T.muted,
            fontSize: "0.6875rem",
            fontWeight: 800,
          }}
        >
          {fmtAr(mods.length)}
        </span>
        <div style={{ flex: 1, height: 1, background: T.secLine, opacity: 0.35 }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 12 }}>
        {mods.map((m) => (
          <ModuleCard key={m.id} m={m} />
        ))}
      </div>
    </div>
  );
}

/* ═══════════ MORNING BRIEF ═══════════
   قسم «برنامج اليوم» فوق الوحدات: ٣ بطاقات فعل (تذكيرات AR + وعود اليوم + أوامر شغل متأخّرة).
   يظهر للمدير/الأدمن فقط (بيانات إشرافية عبر الفرع)؛ كاشير/موظف ميداني لا يحتاجه.
   عند «كل الأصفار» يختفي القسم كلياً (لا نُشتت الشاشة بلوحة فارغة). */

function BriefCard({
  href, label, count, sub, accent, iconBg, icon,
}: {
  href: string;
  label: string;
  count: number;
  sub: string;
  accent: string;
  iconBg: string;
  icon: React.ReactNode;
}) {
  const T = useT();
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        borderRadius: 10,
        background: T.cardBg,
        border: `1px solid ${T.cardBord}`,
        borderRight: `3px solid ${accent}`,
        cursor: "pointer",
        transition: "box-shadow 0.15s, transform 0.15s",
        color: T.text,
        textDecoration: "none",
        minWidth: 0,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.boxShadow = `0 4px 16px color-mix(in oklch, ${accent} 16%, transparent)`;
        (e.currentTarget as HTMLAnchorElement).style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.boxShadow = "none";
        (e.currentTarget as HTMLAnchorElement).style.transform = "none";
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          background: iconBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
        aria-hidden
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "0.75rem", color: T.sub, marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: "1.375rem", fontWeight: 900, color: accent, lineHeight: 1, marginBottom: 2 }}>
          <span dir="ltr" style={{ fontVariantNumeric: "tabular-nums" }}>{fmtAr(count)}</span>
        </div>
        <div style={{ fontSize: "0.75rem", color: T.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
      </div>
    </Link>
  );
}

function MorningBrief({ branchScope, isAdmin }: { branchScope: number | undefined; isAdmin: boolean }) {
  const T = useT();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const elevated = role === "admin" || role === "manager";
  // برنامج اليوم تنفيذيّ لا تجميعيّ: لا نختار أول فرع صامتاً للأدمن. المنتقي أعلى الشاشة هو
  // المصدر الواحد، والروابط تحمل الفرع نفسه إلى قائمة المتابعة.
  const metrics = trpc.reports.dashboardMetrics.useQuery(
    { branchId: branchScope, includeTodaySales: true },
    { enabled: elevated && branchScope !== undefined },
  );

  // القسم للمدير/الأدمن حصراً — الموظّف الميداني لا يحتاج نظرة إشرافية.
  if (!elevated) return null;
  if (isAdmin && branchScope === undefined) {
    return (
      <section aria-label="برنامج اليوم" style={{ maxWidth: 1648, margin: "0 auto", padding: "12px 24px 4px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", border: `1px solid ${T.cardBord}`, borderRadius: 9, background: T.statBg, color: T.sub, fontSize: "0.75rem" }}>
          <MapPin aria-hidden size={14} />
          اختر فرعاً من أعلى الشاشة لعرض برنامج اليوم القابل للتنفيذ.
        </div>
      </section>
    );
  }
  if (metrics.isLoading) {
    return (
      <section aria-label="برنامج اليوم" style={{ maxWidth: 1648, margin: "0 auto", padding: "12px 24px 4px", color: T.muted, fontSize: "0.75rem" }}>
        جارٍ تجهيز برنامج اليوم…
      </section>
    );
  }
  if (metrics.isError || !metrics.data) {
    return (
      <section aria-label="برنامج اليوم" style={{ maxWidth: 1648, margin: "0 auto", padding: "12px 24px 4px" }}>
        <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", border: "1px solid var(--sem-warn)", borderRadius: 9, background: "var(--sem-warn-bg)", color: T.text, fontSize: "0.75rem" }}>
          <span>تعذّر تحميل برنامج اليوم.</span>
          <button type="button" onClick={() => void metrics.refetch()} style={{ display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${T.cardBord}`, borderRadius: 7, background: T.cardBg, color: T.text, padding: "6px 9px", font: "inherit", fontWeight: 800, cursor: "pointer" }}>
            <RefreshCw aria-hidden size={13} />
            إعادة المحاولة
          </button>
        </div>
      </section>
    );
  }
  const brief = metrics.data.morningBrief;
  const remindersDegraded = metrics.data.health.sourceErrors.includes("receivableReminders");
  // promisedToday مجموعة جزئية من arRemindersDue؛ لا نعدّها مرّتين في إجمالي البنود.
  const total = brief.arRemindersDue + brief.overdueWorkOrders;
  // كل الأصفار ⇒ لا حاجة لبانر «برنامج اليوم» — تنظيف بصريّ حين لا شيء يستحقّ الفعل.
  if (total === 0 && !remindersDegraded) return null;

  const dt = new Date();
  const dateLabel = fmtDate(dt);

  return (
    <section
      style={{
        maxWidth: 1648,
        margin: "0 auto",
        padding: "16px 24px 4px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
      aria-label="برنامج اليوم"
    >
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: "0.9375rem", fontWeight: 800, color: T.text, margin: 0 }}>
            برنامج اليوم
          </h2>
          <div style={{ fontSize: "0.75rem", color: T.muted, marginTop: 2 }}>
            ضمن فرع التنفيذ — افتح كل بطاقة للوصول إلى قائمتها
          </div>
        </div>
        <span style={{ fontSize: "0.75rem", color: T.sub }}>{dateLabel} — {fmtAr(total)} بند{total === 1 ? "" : "ود"} للمتابعة</span>
      </header>
      {remindersDegraded && (
        <div role="status" style={{ padding: "9px 11px", border: "1px solid var(--sem-warn)", borderRadius: 9, background: "var(--sem-warn-bg)", color: T.text, fontSize: "0.75rem" }}>
          تعذّر تحديث تذكيرات الذمم؛ بنود التشغيل الأخرى ما زالت معروضة.
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 10,
        }}
      >
        {brief.promisedToday > 0 && (
          <BriefCard
            href={`/reports/ar-reminders?branch=${branchScope}`}
            label="عملاء موعودون اليوم"
            count={brief.promisedToday}
            sub="راجع الوعود المستحقّة قبل نهاية اليوم"
            accent="var(--sem-warn)"
            iconBg="var(--sem-warn-bg)"
            icon={<PromiseIco color="var(--sem-warn)" />}
          />
        )}
        {brief.arRemindersDue > 0 && (
          <BriefCard
            href={`/reports/ar-reminders?branch=${branchScope}`}
            label="تذكيرات ذمم مستحقّة"
            count={brief.arRemindersDue}
            sub="افتح قائمة العملاء ثم أرسل أو سجّل قرار المتابعة"
            accent="var(--sem-info)"
            iconBg="var(--sem-info-bg)"
            icon={<ARIco color="var(--sem-info)" />}
          />
        )}
        {brief.overdueWorkOrders > 0 && (
          <BriefCard
            href={`/work-orders?branch=${branchScope}`}
            label="أوامر شغل متأخّرة"
            count={brief.overdueWorkOrders}
            sub="تجاوزت التاريخ المتوقّع للتسليم"
            accent="var(--sem-neg)"
            iconBg="var(--sem-neg-bg)"
            icon={<WOIco color="var(--sem-neg)" />}
          />
        )}
      </div>
    </section>
  );
}

const PromiseIco = ({ color }: { color: string }) => (
  <svg width={20} height={20} viewBox="0 0 20 20" fill="none">
    <rect x="3" y="4" width="14" height="13" rx="2" stroke={color} strokeWidth="1.6" />
    <path d="M3 8h14" stroke={color} strokeWidth="1.6" />
    <path d="M7 2v3M13 2v3" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    <path d="M7.5 12.5l1.5 1.5 3.5-3.5" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ARIco = ({ color }: { color: string }) => (
  <svg width={20} height={20} viewBox="0 0 20 20" fill="none">
    <path d="M2.5 10c0-4 3.5-7 7.5-7s7.5 3 7.5 7-3.5 7-7.5 7c-1.4 0-2.7-.3-3.8-.9l-3.7 1 1-3.5C2.8 12.6 2.5 11.3 2.5 10z" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    <circle cx="7" cy="10" r="0.9" fill={color} />
    <circle cx="10" cy="10" r="0.9" fill={color} />
    <circle cx="13" cy="10" r="0.9" fill={color} />
  </svg>
);

const WOIco = ({ color }: { color: string }) => (
  <svg width={20} height={20} viewBox="0 0 20 20" fill="none">
    <path d="M5 2h7l4 4v11a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M12 2v4h4" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M7.5 11.5l1.5 1.5 3.5-3.5" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TasksIco = ({ color }: { color: string }) => (
  <svg width={20} height={20} viewBox="0 0 20 20" fill="none">
    <rect x="3" y="3" width="14" height="14" rx="2.5" stroke={color} strokeWidth="1.6" />
    <path d="M6.5 7.5h7M6.5 10.5h7M6.5 13.5h4" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/* ═══════════ المهام والتذاكر (نظام المهام الموحّد S2/T2.3) ═══════════
   بطاقتان: «مهامي المفتوحة» (شخصيّ — assignedTo=أنا، لا RESOLVED/CANCELLED) و«مهام متأخّرة»
   (تشغيليّ — نطاق فرع المستخدم نفسه المُستعمَل في MetricsBar/MorningBrief). يظهر لأي دور يملك
   tasks≥READ (أوسع من MorningBrief المُقتصر على المدير/الأدمن — طابور شخصي يهمّ الكاشير/الفنّي
   أيضاً)، ويختفي كلياً عند صفرَين (لا بانر فارغ).
   myOpenTasks يُحسب خادمياً بلا حدّ صفحات، والراوتر يمرّر هوية المستخدم المصادَق حصراً. */
function TasksBrief({ branchScope }: { branchScope: number | undefined }) {
  const T = useT();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;

  // بوّابة رؤية — مرآة hasModuleAccess (القالب فقط، بلا استثناء أدوار خارج القائمة) مطابقةً تماماً
  // لبوّابة الخادم tasksReadProcedure (requireModule("tasks","READ")، بلا قائمة أدوار صريحة هناك أيضاً).
  const canSeeTasks = !!role && hasModuleAccess(role, override, "tasks", "READ");

  // overdueTasks تشغيليّ — نفس مفتاح استعلام dashboardMetrics المُستهلَك أصلاً في MetricsBar/
  // MorningBrief (branchId مطابق) ⇒ react-query يُدَدِّب الطلب، لا شبكة إضافية.
  const metrics = trpc.reports.dashboardMetrics.useQuery(
    { branchId: branchScope, includeTodaySales: true },
    { enabled: canSeeTasks },
  );
  const overdueTasks = metrics.data?.morningBrief.overdueTasks ?? 0;
  const myOpenTasks = metrics.data?.morningBrief.myOpenTasks ?? 0;

  if (!canSeeTasks) return null;
  if (metrics.isLoading) {
    return (
      <section aria-label="المهام والتذاكر" style={{ maxWidth: 1648, margin: "0 auto", padding: "8px 24px 4px", color: T.muted, fontSize: "0.75rem" }}>
        جارٍ تحديث المهام…
      </section>
    );
  }
  if (metrics.isError) {
    return (
      <section aria-label="المهام والتذاكر" style={{ maxWidth: 1648, margin: "0 auto", padding: "8px 24px 4px" }}>
        <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", border: "1px solid var(--sem-warn)", borderRadius: 9, background: "var(--sem-warn-bg)", color: T.text, fontSize: "0.75rem" }}>
          <span>تعذّر تحديث المهام.</span>
          <button type="button" onClick={() => void metrics.refetch()} style={{ display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${T.cardBord}`, borderRadius: 7, background: T.cardBg, color: T.text, padding: "6px 9px", font: "inherit", fontWeight: 800, cursor: "pointer" }}>
            <RefreshCw aria-hidden size={13} />
            إعادة المحاولة
          </button>
        </div>
      </section>
    );
  }
  if (myOpenTasks === 0 && overdueTasks === 0) return null;

  return (
    <section
      style={{ maxWidth: 1648, margin: "0 auto", padding: "8px 24px 4px", display: "flex", flexDirection: "column", gap: 10 }}
      aria-label="المهام والتذاكر"
    >
      <h2 style={{ fontSize: "0.8125rem", fontWeight: 800, color: T.text, margin: 0, letterSpacing: "0.01em" }}>
        المهام والتذاكر
      </h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
        {myOpenTasks > 0 && (
          <BriefCard
            href="/tasks?tab=mine"
            label="مهامي المفتوحة"
            count={myOpenTasks}
            sub="مهام مُسنَدة إليك بانتظار المتابعة"
            accent="var(--sem-info)"
            iconBg="var(--sem-info-bg)"
            icon={<TasksIco color="var(--sem-info)" />}
          />
        )}
        {overdueTasks > 0 && (
          <BriefCard
            href="/tasks?tab=list&overdue=1"
            label="مهام متأخّرة"
            count={overdueTasks}
            sub="تجاوزت الاستحقاق الفعلي — تحتاج متابعة"
            accent="var(--sem-neg)"
            iconBg="var(--sem-neg-bg)"
            icon={<TasksIco color="var(--sem-neg)" />}
          />
        )}
      </div>
    </section>
  );
}

/* ═══════════ مساحة عمل الكاشير المركّزة (٢٤/٧، قرار المالك) ═══════════
   موظف الوردية عمله: فتح وردية ← بيع ← إغلاق وتسليم. رئيسيته «محطة عمل» بأدوات منضدته فقط —
   لا شبكة وحدات النظام (تلك تبقى للأدوار الإدارية). البنود الثانوية محكومة بصلاحيات دوره
   الفعلية (hasModuleAccess — نفس مرآة الشريط الجانبي) فإطفاء وحدةٍ يُسقط بطاقتها فوراً.
   العزل الحقيقي خادميّ كما هو؛ هذه طبقة تركيز UX خالصة. */

function CashierHome() {
  const T = useT();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const roleLabel = me.data?.customRoleLabel ?? "كاشير";
  const branchId = me.data?.branchId ?? null;

  const can = (mod: string, lvl: "READ" | "FULL" = "READ") =>
    !!role && hasModuleAccess(role, override, mod, lvl);
  // محطّة الاستقبال بوّابتها وحدة `workorders` (POS_STATION_GATES) — من لا يملكها لا يرى لوحاتها.
  const isReception = can("workorders", "FULL");

  // عدّادان فقط — وهما اللذان يغيّران ترتيب اليوم: كم طلباً ينتظر صاحبه، وكم رسالةً لم تُقرأ.
  const woCounts = trpc.workOrders.counts.useQuery(
    { branchId: branchId ?? 0 },
    { enabled: isReception && branchId != null, staleTime: 30_000 },
  );
  const convs = trpc.conversations.list.useQuery(
    { branchId: branchId ?? 0, limit: 50 },
    { enabled: isReception && can("channels") && branchId != null, staleTime: 30_000 },
  );
  const unread = (convs.data?.rows ?? []).reduce((n, c) => n + (c.unreadCount ?? 0), 0);

  /**
   * ١٩/٨ (طلب المالك) — **مركز الإطلاق**: اللوحات الخمس خرجت من رأس شاشة الكاشير إلى هنا.
   * كان الرأس صفّاً واحداً من ثمانية أزرارٍ متساوية الوزن يفيض أفقياً بشريط تمرير، يختلط فيه
   * ما يُفتَح مرّةً في اليوم بما يُضغَط كل دقيقة. والتجميع هنا يحمل الفرق: مجموعةٌ لِما يفتحه
   * الموظّف **داخل محطّته**، وأخرى لأدواته العامّة.
   */
  const stationTiles: Tile[] = isReception
    ? [
        {
          // ⛔ **شاشةٌ حقيقية لا عودةٌ إلى الكاشير** (طلب المالك ١٩/٨): البطاقة التي تُعيدك إلى
          // الشاشة الرئيسية ليست فصلاً — تُضيف طبقةَ تكرارٍ ثالثة فتفشل المعالجة.
          href: "/reception/orders",
          name: "طلبات محطّتي",
          desc: "طابور التسليم والإسناد — ما جهُز بانتظار صاحبه",
          badge: woCounts.data?.ready ?? 0,
          badgeHint: "جاهز بانتظار العميل",
        },
        {
          href: "/reception/invoices",
          name: "فواتير للتحصيل",
          desc: "ما عليه مبلغٌ متبقٍّ — اقبضه من الصفّ",
        },
        ...(can("channels")
          ? [{
              href: "/crm?tab=inbox",
              name: "رسائل العملاء",
              desc: "واتساب واتصالات — وافتح طلباً من المحادثة",
              badge: unread,
              badgeHint: "رسالة لم تُقرأ",
            }]
          : []),
        ...(can("reservations")
          ? [{
              href: "/reservations",
              name: "الحجوزات",
              desc: "حجز صنف لعميل حتى موعد الاستلام",
            }]
          : []),
        ...(can("store")
          ? [{
              href: "/store-admin?tab=orders",
              name: "طلبات الموقع",
              desc: "طلبات المتجر الإلكتروني — ثبّتها وأسنِدها",
            }]
          : []),
      ]
    : [];

  const toolTiles: Tile[] = [
    // ش٦: سطحُ «ما ينتظره منّي العمل» — خلفيّتُه مبنيّةٌ ومختبَرةٌ وكانت بلا مستهلكٍ ويبّ.
    { href: "/my-work", name: "مطلوب منّي الآن", desc: "قراراتٌ تنتظر موافقتك وما يخصّك من عمل" },
    { href: "/price-checker", name: "قارئ الأسعار", desc: "فحص سعر أي منتج بالباركود" },
    ...(isReception ? [{ href: "/work-orders", name: "لوحة الإنتاج", desc: "كانبان الطلبات ومراحل التنفيذ" }] : []),
    ...(can("sales") ? [{ href: "/invoices", name: "كل فواتيري", desc: "بحثٌ وفلترةٌ وإعادة طباعة" }] : []),
    ...(can("tasks") ? [{ href: "/tasks", name: "المهام والتذاكر", desc: "طلبات العملاء المُسنَدة إليك" }] : []),
    { href: "/account", name: "حسابي", desc: "بياناتك وكلمة المرور وجلساتك" },
  ];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: T.bg,
        direction: "rtl",
        fontFamily: "'Cairo', sans-serif",
        margin: "-24px",
        // مساحاتٌ مفتوحة (طلب المالك): حشوةٌ أوسع وسقفُ عرضٍ مقروء بدل مدٍّ لا نهائيّ.
        padding: "clamp(24px, 4vw, 44px) clamp(20px, 4vw, 48px) 56px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 32,
      }}
    >
      <div style={{ width: "100%", maxWidth: 1180, display: "flex", flexDirection: "column", gap: 32 }}>
        <div>
          <h1 style={{ fontSize: "clamp(22px, 2.4vw, 30px)", fontWeight: 800, color: T.text, margin: 0, letterSpacing: "-0.01em" }}>
            أهلاً {me.data?.name ?? ""}
          </h1>
          <p style={{ fontSize: "0.875rem", color: T.sub, margin: "8px 0 0", lineHeight: 1.7 }}>
            {roleLabel} · محطة عملك: افتح ورديتك، استقبل طلبات عملائك، أغلق وسلّم الصندوق.
          </p>
        </div>

        <Link
          href={isReception ? "/pos?mode=RECEPTION" : "/pos"}
          style={{
            display: "block",
            background: T.featuredBg,
            border: `2px solid ${T.featuredBd}`,
            borderRadius: 18,
            padding: "clamp(28px, 3.5vw, 40px) clamp(24px, 3vw, 36px)",
            textDecoration: "none",
          }}
        >
          <div style={{ fontSize: "clamp(24px, 2.6vw, 32px)", fontWeight: 800, color: T.text, letterSpacing: "-0.01em" }}>
            {isReception ? "محطة خدمة العملاء" : "نقطة البيع"}
          </div>
          <div style={{ fontSize: "0.875rem", color: T.sub, marginTop: 10, lineHeight: 1.7, maxWidth: "62ch" }}>
            {isReception
              ? "افتح الوردية واستقبل الطلب — السلّة والعميل والدفع في شاشة واحدة، وعند نهاية عملك أغلقها وسلّم المبلغ من الشاشة نفسها."
              : "افتح الوردية وابدأ البيع — وعند نهاية عملك أغلقها وسلّم المبلغ من الشاشة نفسها."}
          </div>
        </Link>

        {stationTiles.length > 0 && (
          <TileGroup T={T} label="لوحات محطّتي" hint="تفتح داخل شاشة عملك" tiles={stationTiles} />
        )}
        <TileGroup T={T} label="أدوات" tiles={toolTiles} />
      </div>

      {/* طابور مهامه الشخصي (إن وُجد وسمحت صلاحيته) — نفس مكوّن اللوحة العامة */}
      <div style={{ width: "100%", maxWidth: 1180 }}>
        <TasksBrief branchScope={dashboardActionBranchId(me.data?.branchId)} />
      </div>
    </div>
  );
}

interface Tile {
  href: string;
  name: string;
  desc: string;
  /** عدّادٌ يستحقّ نظرةً قبل فتح البطاقة (صفرٌ ⇒ لا يُعرَض — لا ضوضاءَ بلا خبر). */
  badge?: number;
  badgeHint?: string;
}

/** مجموعةُ بطاقاتٍ بعنوانٍ — الفاصلُ بينها هو ما يُنهي «صفَّ أزرارٍ متساوية الوزن». */
function TileGroup({
  T: Tk,
  label,
  hint,
  tiles,
}: {
  T: typeof T;
  label: string;
  hint?: string;
  tiles: Tile[];
}) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 14 }} aria-label={label}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <h2 style={{ fontSize: "0.8125rem", fontWeight: 800, color: Tk.secLabel, margin: 0, letterSpacing: "0.04em" }}>
          {label}
        </h2>
        {hint && <span style={{ fontSize: "0.75rem", color: Tk.muted }}>{hint}</span>}
        <div style={{ flex: 1, height: 1, background: Tk.secLine }} aria-hidden />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(264px, 1fr))", gap: 14 }}>
        {tiles.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            style={{
              position: "relative",
              background: Tk.cardBg,
              border: `1px solid ${Tk.cardBord}`,
              borderRadius: 14,
              padding: "20px 18px",
              textDecoration: "none",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              minHeight: 92,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "1rem", fontWeight: 700, color: Tk.text }}>{t.name}</span>
              {!!t.badge && t.badge > 0 && (
                <span
                  title={t.badgeHint}
                  style={{
                    minWidth: 22,
                    padding: "1px 7px",
                    borderRadius: 999,
                    background: "var(--sem-warn-bg)",
                    color: "var(--sem-warn)",
                    fontSize: "0.75rem",
                    fontWeight: 800,
                    textAlign: "center",
                  }}
                >
                  {t.badge}
                </span>
              )}
            </div>
            <div style={{ fontSize: "0.8125rem", color: Tk.muted, lineHeight: 1.6 }}>{t.desc}</div>
          </Link>
        ))}
      </div>
    </section>
  );
}

/* ═══════════ DASHBOARD ═══════════ */

export default function Dashboard() {
  const me = trpc.auth.me.useQuery();
  const [adminBranchScope, setAdminBranchScope] = useState<number | undefined>(undefined);
  // فئة الكاشير (القالبي + المخصّص المشتق «كاشير تجزئة/طباعة») ⇒ محطة عمل مركّزة لا شبكة الوحدات.
  if (me.data?.role === "cashier") return <CashierHome />;
  const isAdmin = me.data?.role === "admin";
  const branchScope = isAdmin
    ? adminBranchScope
    : dashboardActionBranchId(me.data?.branchId);
  return (
    <div style={{ minHeight: "100vh", background: T.bg, direction: "rtl", fontFamily: "'Cairo', sans-serif", margin: "-24px" }}>
      <DashboardHeader branchScope={branchScope} isAdmin={isAdmin} onBranchScopeChange={setAdminBranchScope} />
      <MetricsBar branchScope={branchScope} />
      <MorningBrief branchScope={branchScope} isAdmin={isAdmin} />
      <TasksBrief branchScope={branchScope} />
      <div style={{ maxWidth: 1648, margin: "0 auto", padding: "18px 24px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
        <header>
          <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 900, color: T.text }}>وحدات النظام</h2>
          <p style={{ margin: "3px 0 0", fontSize: "0.75rem", color: T.muted }}>اختر الوحدة المطلوبة، أو استخدم الإجراءات المباشرة أسفل كل بطاقة.</p>
        </header>
        {SECTIONS.map((sec) => (
          <SectionRow key={sec.id} sec={sec} />
        ))}
      </div>
    </div>
  );
}
