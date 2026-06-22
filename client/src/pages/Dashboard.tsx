import { createContext, useContext, useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { D, fmtAr } from "@/lib/money";
import { fmtTime } from "@/lib/date";
import { useMediaQuery } from "@/hooks/useMobile";
import { Link } from "wouter";

/* ═══════════ DARK-MODE HOOK ═══════════ */

function useDarkMode() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  );
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark"))
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

/* ═══════════ THEME PALETTES ═══════════ */

const LIGHT = {
  bg:          "oklch(0.963 0.012 75)",
  cardBg:      "oklch(1 0 0)",
  cardBord:    "oklch(0 0 0 / 0.09)",
  secLine:     "oklch(0 0 0 / 0.10)",
  secLabel:    "oklch(0.40 0.08 262)",
  text:        "oklch(0.18 0.014 65)",
  sub:         "oklch(0.48 0.012 65)",
  muted:       "oklch(0.62 0.010 65)",
  statBg:      "oklch(1 0 0)",
  statBord:    "oklch(0 0 0 / 0.08)",
  alertBg:     "oklch(0.62 0.24 22 / 0.08)",
  featuredBg:  "oklch(0.62 0.24 22 / 0.07)",
  featuredBd:  "oklch(0.62 0.24 22 / 0.35)",
  metricsBg:   "oklch(0.985 0.007 75)",
  metricsBord: "oklch(0 0 0 / 0.08)",
};

const DARK = {
  bg:          "oklch(0.14 0.010 65)",
  cardBg:      "oklch(0.20 0.012 65)",
  cardBord:    "oklch(1 0 0 / 0.10)",
  secLine:     "oklch(1 0 0 / 0.22)",
  secLabel:    "oklch(0.88 0.10 262)",
  text:        "oklch(1 0 0)",
  sub:         "oklch(0.90 0.005 75)",
  muted:       "oklch(0.80 0.005 75)",
  statBg:      "oklch(0.20 0.012 65)",
  statBord:    "oklch(1 0 0 / 0.10)",
  alertBg:     "oklch(0.62 0.24 22 / 0.14)",
  featuredBg:  "oklch(0.62 0.24 22 / 0.14)",
  featuredBd:  "oklch(0.62 0.24 22 / 0.50)",
  metricsBg:   "oklch(0.17 0.010 65)",
  metricsBord: "oklch(1 0 0 / 0.10)",
};

type Theme = typeof LIGHT;

/* ═══════════ THEME CONTEXT ═══════════ */

const ThemeCtx = createContext<Theme>(LIGHT);
const useT = () => useContext(ThemeCtx);

/* ═══════════ SECTIONS & MODULES ═══════════ */

const SECTIONS = [
  { id: 1, name: "المبيعات والتحصيل",  accent: "oklch(0.62 0.24 22)" },
  { id: 2, name: "المخزون والمشتريات", accent: "oklch(0.58 0.22 168)" },
  { id: 3, name: "المالية والحسابات",  accent: "oklch(0.58 0.20 178)" },
  { id: 4, name: "التشغيل",            accent: "oklch(0.65 0.20 128)" },
  { id: 5, name: "الإدارة والنظام",    accent: "oklch(0.58 0.18 262)" },
];

type ModuleDef = {
  id: string;
  href: string;
  name: string;
  desc: string;
  sec: number;
  color: string;
  featured?: boolean;
  adminOnly?: boolean;
};

const MODULES: ModuleDef[] = [
  { id: "pos",           href: "/pos",                 name: "نقطة البيع",       desc: "مبيعات وورديات",    sec: 1, color: "oklch(0.62 0.24 22)",  featured: true },
  { id: "sales",         href: "/invoices",            name: "المبيعات",          desc: "فواتير ومدفوعات",   sec: 1, color: "oklch(0.68 0.20 52)" },
  { id: "quotations",    href: "/quotations",          name: "عروض الأسعار",      desc: "تسعير وعروض",       sec: 1, color: "oklch(0.60 0.22 288)" },
  { id: "customers",     href: "/customers",           name: "العملاء",           desc: "إدارة العملاء",     sec: 1, color: "oklch(0.62 0.20 340)" },
  { id: "returns",       href: "/returns",             name: "المرتجعات",         desc: "تسجيل المرتجعات",   sec: 1, color: "oklch(0.58 0.20 14)" },
  { id: "products",      href: "/products",            name: "المنتجات",          desc: "منتجات وأسعار",      sec: 2, color: "oklch(0.58 0.22 168)" },
  { id: "purchases",     href: "/purchases",           name: "المشتريات",         desc: "أوامر وموردين",     sec: 2, color: "oklch(0.55 0.22 248)" },
  { id: "inventory",     href: "/inventory",           name: "المخزون والأرصدة",  desc: "أرصدة + تسوية",     sec: 2, color: "oklch(0.58 0.18 198)" },
  { id: "movements",     href: "/inventory-movements", name: "حركات المخزون",     desc: "وارد وصادر يدوي",   sec: 2, color: "oklch(0.55 0.20 208)" },
  { id: "transfers",     href: "/transfers",           name: "التحويلات",         desc: "نقل بين الفروع",    sec: 2, color: "oklch(0.60 0.18 218)" },
  { id: "barcode",       href: "/barcode-labels",      name: "الباركود",          desc: "طباعة الملصقات",    sec: 2, color: "oklch(0.55 0.14 278)" },
  { id: "suppliers",     href: "/suppliers",           name: "الموردون",          desc: "إدارة الموردين",    sec: 2, color: "oklch(0.62 0.18 46)" },
  { id: "purchaseReturns", href: "/purchase-returns",  name: "مرتجعات الشراء",    desc: "سجلّ المرتجعات",    sec: 2, color: "oklch(0.55 0.20 14)" },
  { id: "expenses",      href: "/expenses",            name: "المصروفات",         desc: "مصروفات يومية",     sec: 3, color: "oklch(0.65 0.18 72)" },
  { id: "vouchers",      href: "/vouchers",            name: "السندات",           desc: "قبض وصرف",          sec: 3, color: "oklch(0.62 0.18 160)" },
  { id: "shifts",        href: "/shifts",              name: "سجلّ الورديات",     desc: "إغلاقات وZ-report", sec: 3, color: "oklch(0.60 0.16 250)" },
  { id: "arAging",       href: "/ar-aging",            name: "الذمم المدينة",     desc: "أعمار ومتابعة",     sec: 3, color: "oklch(0.58 0.20 178)" },
  { id: "apAging",       href: "/ap-aging",            name: "الذمم الدائنة",     desc: "ذمم الموردين",      sec: 3, color: "oklch(0.58 0.22 148)" },
  { id: "custStatement", href: "/customers-statement", name: "كشف حساب عميل",     desc: "حسابات العملاء",    sec: 3, color: "oklch(0.60 0.18 322)" },
  { id: "suppStatement", href: "/suppliers-statement", name: "كشف حساب مورد",     desc: "حسابات الموردين",   sec: 3, color: "oklch(0.62 0.18 262)" },
  { id: "salesReport",   href: "/sales-report",        name: "تقرير المبيعات",    desc: "ملخّص وأرباح",      sec: 3, color: "oklch(0.60 0.20 215)" },
  { id: "workOrders",    href: "/work-orders",         name: "خدمة العملاء",      desc: "طلبات الطباعة والتخصيص",  sec: 4, color: "oklch(0.65 0.20 128)" },
  { id: "users",         href: "/users",               name: "المستخدمون",        desc: "صلاحيات وأدوار",    sec: 5, color: "oklch(0.58 0.18 262)", adminOnly: true },
  { id: "audit",         href: "/audit",               name: "سجلّ التدقيق",      desc: "مراقبة العمليات",   sec: 5, color: "oklch(0.56 0.16 300)", adminOnly: true },
  { id: "reconcile",     href: "/reconcile",           name: "تدقيق التوافق",     desc: "كشف الانحراف",      sec: 5, color: "oklch(0.55 0.20 25)",  adminOnly: true },
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
  sales:         [{ ic: "plus",    label: "بيع",    href: "/sales/new" },             { ic: "return",  label: "مرتجع",   href: "/sales-returns/new" },    { ic: "doc",  label: "تقرير", href: "/sales-report" }],
  quotations:    [{ ic: "plus",    label: "عرض",    href: "/quotations/new" },       { ic: "doc",     label: "فواتير",  href: "/invoices" }],
  customers:     [{ ic: "plus",    label: "عميل",   href: "/customers/new" },        { ic: "doc",     label: "كشف",     href: "/customers-statement" },  { ic: "coin", label: "ذمم",   href: "/ar-aging" }],
  returns:       [{ ic: "return",  label: "بيع",    href: "/sales-returns/new" },    { ic: "return",  label: "شراء",    href: "/purchase-returns/new" }, { ic: "doc",  label: "فواتير", href: "/invoices" }],
  products:      [{ ic: "plus",    label: "منتج",    href: "/products/new" },         { ic: "barcode", label: "باركود",  href: "/barcode-labels" },       { ic: "rows", label: "أرصدة", href: "/inventory" }],
  purchases:     [{ ic: "plus",    label: "أمر",    href: "/purchases/new" },        { ic: "return",  label: "إرجاع",   href: "/purchase-returns/new" }, { ic: "coin", label: "ذمم",   href: "/ap-aging" }],
  inventory:     [{ ic: "rows",    label: "حركة",   href: "/inventory-movements" },  { ic: "return",  label: "تحويل",   href: "/transfers" },            { ic: "plus", label: "منتج",   href: "/products/new" }],
  movements:     [{ ic: "rows",    label: "أرصدة",  href: "/inventory" },            { ic: "return",  label: "تحويل",   href: "/transfers" },            { ic: "barcode", label: "باركود", href: "/barcode-labels" }],
  transfers:     [{ ic: "rows",    label: "أرصدة",  href: "/inventory" },            { ic: "rows",    label: "حركة",    href: "/inventory-movements" }],
  barcode:       [{ ic: "plus",    label: "منتج",    href: "/products/new" },         { ic: "rows",    label: "منتجات",   href: "/products" }],
  suppliers:     [{ ic: "plus",    label: "مورد",   href: "/suppliers/new" },        { ic: "doc",     label: "كشف",     href: "/suppliers-statement" },  { ic: "coin", label: "ذمم",   href: "/ap-aging" }],
  purchaseReturns: [{ ic: "return", label: "إرجاع",  href: "/purchase-returns/new" }, { ic: "rows",    label: "موردون",  href: "/suppliers" }],
  expenses:      [{ ic: "plus",    label: "مصروف",  href: "/expenses/new" },         { ic: "coin",    label: "ذمم",     href: "/ap-aging" }],
  vouchers:      [{ ic: "coin",    label: "قبض",    href: "/vouchers/receipt/new" }, { ic: "export",  label: "صرف",     href: "/vouchers/payment/new" }],
  arAging:       [{ ic: "doc",     label: "كشف",    href: "/customers-statement" },  { ic: "rows",    label: "عملاء",   href: "/customers" },            { ic: "doc",  label: "تقرير", href: "/sales-report" }],
  apAging:       [{ ic: "doc",     label: "كشف",    href: "/suppliers-statement" },  { ic: "rows",    label: "موردون",  href: "/suppliers" },            { ic: "plus", label: "مصروف", href: "/expenses/new" }],
  custStatement: [{ ic: "coin",    label: "ذمم",    href: "/ar-aging" },             { ic: "rows",    label: "عملاء",   href: "/customers" }],
  suppStatement: [{ ic: "coin",    label: "ذمم",    href: "/ap-aging" },             { ic: "rows",    label: "موردون",  href: "/suppliers" }],
  salesReport:   [{ ic: "rows",    label: "فواتير", href: "/invoices" },             { ic: "coin",    label: "ذمم",     href: "/ar-aging" }],
  workOrders:    [{ ic: "plus",    label: "أمر",    href: "/work-orders/new" },      { ic: "plus",    label: "عرض",     href: "/quotations/new" },       { ic: "rows", label: "خامات", href: "/inventory" }],
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

function Shape({ id, color: c, size = 106 }: { id: string; color: string; size?: number }) {
  const sw = 1.5;
  const w = "white";

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
    workOrders: (
      <>
        <rect x="4" y="5" width="16" height="16" rx="2" stroke={w} strokeWidth={sw} />
        <path d="M9,3 H15 V7 H9 Z" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <line x1="8" y1="12" x2="16" y2="12" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <line x1="8" y1="15.5" x2="16" y2="15.5" stroke={w} strokeWidth={sw} strokeLinecap="round" />
        <path d="M8,19 L10,21 L15,16" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
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

  return (
    <svg style={{ width: size, height: size, display: "block", flexShrink: 0 }} viewBox="0 0 52 52" fill="none">
      <rect x="0" y="0" width="52" height="52" rx="14" fill={c} />
      <rect x="3" y="3" width="46" height="25" rx="11" fill="white" fillOpacity="0.16" />
      <rect x="0" y="34" width="52" height="18" fill="black" fillOpacity="0.05" />
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

function MetricsBar() {
  const T = useT();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  // المدير/الأدمن يريان الإجمالي عبر الفروع (branchId=undefined) — الموظفون الميدانيون مقيَّدون.
  const elevated = role === "admin" || role === "manager";
  const myBranch = me.data?.branchId ?? 1;
  const branchScope = elevated ? undefined : myBranch;
  const sales = trpc.sales.list.useQuery({ limit: 500 });
  const shift = trpc.shifts.current.useQuery({ branchId: myBranch });
  // مقاييس لوحة التحكم: مخزون منخفض + ذمم متأخّرة (الخلفية تُطبّق عزل الفرع).
  const metrics = trpc.reports.dashboardMetrics.useQuery({ branchId: branchScope });
  // جلسات جرد بانتظار المراجعة — للأدوار المخوّلة فقط (الخادم warehouseProcedure).
  const canSeeStocktakes = role === "admin" || role === "manager" || role === "warehouse";
  const stk = trpc.stocktakes.stats.useQuery(undefined, { enabled: canSeeStocktakes });

  const list = sales.data ?? [];
  // التوقيت المحلّي (en-CA = YYYY-MM-DD محلّياً) — لا UTC حتى لا تنتقل فواتير المساء لليوم التالي.
  const today = new Date().toLocaleDateString("en-CA");
  const todays = list.filter((i) => new Date(i.invoiceDate).toLocaleDateString("en-CA") === today);
  // جمع الأموال عبر decimal.js (قاعدة §٥: ممنوع parseFloat/Number على الأموال).
  const todaysTotalD = todays.reduce((acc, i) => acc.add(String(i.total)), D(0));
  const todaysTotal = todaysTotalD.toNumber();

  const shiftLabel = shift.data ? "مفتوحة" : "لا وردية";
  const shiftSince = shift.data ? `منذ ${fmtTime(shift.data.openedAt)}` : "";

  // قيم بطاقتَي التنبيه — "..." أثناء التحميل، الأرقام بعد النجاح.
  const lowStockValue = metrics.isLoading
    ? "..."
    : fmtAr(metrics.data?.lowStockCount ?? 0);
  const overdueCount = metrics.data?.overdueAR.count ?? 0;
  const overdueValue = metrics.isLoading ? "..." : fmtAr(overdueCount);
  // إجمالٌ مختصر بالدينار (بلا كسور — IQD).
  const overdueTotalShort = metrics.data
    ? fmtAr(Number(metrics.data.overdueAR.total))
    : "";
  const overdueUnit = metrics.isLoading
    ? "> 30 يوم"
    : overdueCount > 0
      ? `${overdueTotalShort} د.ع`
      : "> 30 يوم";

  const stats = [
    {
      label: "مبيعات اليوم",
      value: fmtAr(todaysTotal),
      unit: "د.ع",
      ico: <TrendIco color="oklch(0.60 0.22 155)" />,
      iBg: "oklch(0.60 0.22 155 / 0.15)",
    },
    {
      label: "فواتير اليوم",
      value: String(todays.length),
      unit: "فاتورة",
      ico: <TrendIco color="oklch(0.60 0.22 155)" />,
      iBg: "oklch(0.60 0.22 155 / 0.15)",
    },
    {
      label: "الوردية الحالية",
      value: shiftLabel,
      unit: shiftSince,
      ico: <ShiftIco color="oklch(0.62 0.22 200)" />,
      iBg: "oklch(0.62 0.22 200 / 0.15)",
    },
    {
      label: "مخزون منخفض",
      value: lowStockValue,
      unit: "منتج",
      ico: <WarnIco color="oklch(0.72 0.18 75)" />,
      iBg: "oklch(0.72 0.18 75 / 0.15)",
      isAlert: true,
      alertC: "oklch(0.60 0.18 75)",
      href: "/inventory",
    },
    {
      label: "ذمم متأخّرة",
      value: overdueValue,
      unit: overdueUnit,
      ico: <WarnIco color="oklch(0.62 0.24 22)" />,
      iBg: "oklch(0.62 0.24 22 / 0.12)",
      isAlert: true,
      alertC: "oklch(0.52 0.22 25)",
      href: "/ar-aging",
    },
    // بطاقة الجرد: تظهر للأدوار المخوّلة فقط، وتتحوّل تنبيهاً عند وجود جلسات بانتظار المراجعة.
    ...(canSeeStocktakes
      ? [
          {
            label: "جرد بانتظار المراجعة",
            value: stk.isLoading ? "..." : fmtAr(stk.data?.review ?? 0),
            unit: stk.data?.counting ? `${fmtAr(stk.data.counting)} قيد العدّ` : "جلسة",
            ico: <WarnIco color="oklch(0.55 0.2 264)" />,
            iBg: "oklch(0.55 0.2 264 / 0.12)",
            isAlert: (stk.data?.review ?? 0) > 0,
            alertC: "oklch(0.5 0.2 264)",
            href: "/stocktakes",
          },
        ]
      : []),
  ];

  return (
    <div
      style={{
        background: T.metricsBg,
        borderBottom: `1px solid ${T.metricsBord}`,
        padding: "10px 0",
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
      }}
    >
      {stats.map((s, i) => {
        const card = (
          <div
            key={i}
            style={{
              flex: 1,
              minWidth: 150,
              height: 50,
              borderRadius: 11,
              padding: "0 14px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: s.isAlert ? T.alertBg : T.statBg,
              border: `1px solid ${s.isAlert ? (s.alertC + "40") : T.statBord}`,
              boxShadow: "0 1px 4px oklch(0 0 0 / 0.04)",
              cursor: s.href ? "pointer" : "default",
              textDecoration: "none",
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                flexShrink: 0,
                background: s.iBg,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {s.ico}
            </div>
            <div>
              <div
                style={{
                  fontSize: 14.5,
                  fontWeight: 800,
                  lineHeight: 1.25,
                  color: s.isAlert ? s.alertC : T.text,
                }}
              >
                {s.value}
              </div>
              <div style={{ fontSize: 9.5, color: T.muted, lineHeight: 1.2 }}>{s.label}</div>
            </div>
            {s.unit && (
              <div style={{ marginRight: "auto", fontSize: 9.5, color: T.muted }}>{s.unit}</div>
            )}
          </div>
        );
        return s.href ? (
          <Link key={i} href={s.href} style={{ flex: 1, display: "flex", textDecoration: "none" }}>
            {card}
          </Link>
        ) : (
          card
        );
      })}
    </div>
  );
}

/* ═══════════ ACTION BUTTON (footer) ═══════════ */

function ActionButton({ a, primary, color }: { a: Action; primary: boolean; color: string }) {
  const T = useT();
  const tint = (op: number) => color.replace(")", ` / ${op})`);
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
          fontSize: 10,
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
  const cShadow = m.color.replace(")", " / 0.35)");
  const bord = m.featured ? T.featuredBd : T.cardBord;

  return (
    <div
      style={{
        aspectRatio: "1",
        borderRadius: 16,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        cursor: "pointer",
        background: m.featured ? T.featuredBg : T.cardBg,
        border: `1px solid ${bord}`,
        boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)",
        transition: "box-shadow 0.18s, transform 0.18s",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.boxShadow = `0 6px 24px ${cShadow}`;
        el.style.transform = "translateY(-2px)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.boxShadow = "0 2px 12px oklch(0 0 0 / 0.05)";
        el.style.transform = "none";
      }}
    >
      {/* المنطقة الرئيسية — رابط الوحدة */}
      <Link
        href={m.href}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 9,
          padding: "15px 12px 9px",
          textAlign: "center",
          textDecoration: "none",
        }}
      >
        <div
          style={{
            width: 94,
            height: 94,
            flexShrink: 0,
            filter: `drop-shadow(0 6px 14px ${cShadow})`,
          }}
        >
          <Shape id={m.id} color={m.color} size={94} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              lineHeight: 1.3,
              color: m.featured ? m.color : T.text,
              letterSpacing: "-0.01em",
            }}
          >
            {m.name}
          </div>
          <div style={{ fontSize: 10.5, color: T.sub, lineHeight: 1.4, fontWeight: 500 }}>
            {m.desc}
          </div>
        </div>
      </Link>

      {/* شريط الإجراءات السريعة — حد أقصى 3 أزرار */}
      {acts.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            height: 40,
            flexShrink: 0,
            borderTop: `1px solid ${bord}`,
            background: m.color.replace(")", " / 0.04)"),
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

/* ═══════════ PLACEHOLDER CARD ═══════════ */

function PlaceholderCard() {
  const T = useT();
  return (
    <div
      style={{
        aspectRatio: "1",
        borderRadius: 16,
        border: `1.5px dashed ${T.secLine}`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        opacity: 0.4,
      }}
    >
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke={T.muted} strokeWidth="1.4" strokeDasharray="3 2" />
        <line x1="12" y1="8" x2="12" y2="16" stroke={T.muted} strokeWidth="1.6" strokeLinecap="round" />
        <line x1="8" y1="12" x2="16" y2="12" stroke={T.muted} strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span style={{ fontSize: 9.5, color: T.muted, fontWeight: 500 }}>وحدة قادمة</span>
    </div>
  );
}

/* ═══════════ SECTION ROW ═══════════ */

function SectionRow({ sec }: { sec: (typeof SECTIONS)[number] }) {
  const T = useT();
  const me = trpc.auth.me.useQuery(); // مُخزَّن مؤقتاً (deduped) — لا طلب إضافي.
  const isAdmin = me.data?.role === "admin";
  // عدد الأعمدة متجاوب: ٦ على سطح المكتب (≥lg، بلا تغيير)، ٣ على اللوحي، ٢ على الأصغر.
  // (تُستدعى الـhooks قبل أي عودة مبكرة — قاعدة Hooks.)
  const isXNarrow = useMediaQuery("(max-width: 640px)");
  const isNarrow = useMediaQuery("(max-width: 1023px)");
  const cols = isXNarrow ? 2 : isNarrow ? 3 : 6;
  // البطاقات adminOnly تظهر للأدمن فقط (اتّساقاً مع مجموعة «الإدارة» المحجوبة في الشريط الجانبي).
  const mods = MODULES.filter((m) => m.sec === sec.id && (!m.adminOnly || isAdmin));
  // قسم بلا بطاقات مرئية للدور الحالي ⇒ يُخفى كاملاً (لا رأس ولا فراغات).
  if (mods.length === 0) return null;
  // يملأ بقية الصف الأخير فقط، وفق عدد الأعمدة الفعّال (يدعم 7+ وحدات في القسم الواحد).
  const placeholders = (cols - (mods.length % cols)) % cols;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <div style={{ width: 3, height: 14, borderRadius: 2, background: sec.accent, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: T.secLabel, letterSpacing: "0.06em" }}>
          {sec.name}
        </span>
        <div style={{ flex: 1, height: 1, background: T.secLine, opacity: 0.35 }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 14 }}>
        {mods.map((m) => (
          <ModuleCard key={m.id} m={m} />
        ))}
        {Array.from({ length: placeholders }).map((_, i) => (
          <PlaceholderCard key={`ph${i}`} />
        ))}
      </div>
    </div>
  );
}

/* ═══════════ DASHBOARD ═══════════ */

export default function Dashboard() {
  const dark = useDarkMode();
  const T = dark ? DARK : LIGHT;

  return (
    <ThemeCtx.Provider value={T}>
      <div
        style={{
          minHeight: "100vh",
          background: T.bg,
          direction: "rtl",
          fontFamily: "'Cairo', sans-serif",
          margin: "-24px",
        }}
      >
        <MetricsBar />
        <div
          style={{
            padding: "18px 24px 32px",
            display: "flex",
            flexDirection: "column",
            gap: 20,
          }}
        >
          {SECTIONS.map((sec) => (
            <SectionRow key={sec.id} sec={sec} />
          ))}
        </div>
      </div>
    </ThemeCtx.Provider>
  );
}
