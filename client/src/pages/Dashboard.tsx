import { createContext, useContext, useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
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

const MODULES = [
  { id: "pos",           href: "/pos",                 name: "نقطة البيع",       desc: "مبيعات وورديات",    sec: 1, color: "oklch(0.62 0.24 22)",  featured: true },
  { id: "sales",         href: "/invoices",            name: "المبيعات",          desc: "فواتير ومدفوعات",   sec: 1, color: "oklch(0.68 0.20 52)" },
  { id: "quotations",    href: "/quotations",          name: "عروض الأسعار",      desc: "تسعير وعروض",       sec: 1, color: "oklch(0.60 0.22 288)" },
  { id: "customers",     href: "/customers",           name: "العملاء",           desc: "إدارة العملاء",     sec: 1, color: "oklch(0.62 0.20 340)" },
  { id: "returns",       href: "/returns",             name: "المرتجعات",         desc: "تسجيل الإرجاعات",   sec: 1, color: "oklch(0.58 0.20 14)" },
  { id: "products",      href: "/products",            name: "المنتجات",          desc: "أصناف وأسعار",      sec: 2, color: "oklch(0.58 0.22 168)" },
  { id: "purchases",     href: "/purchases",           name: "المشتريات",         desc: "أوامر وموردين",     sec: 2, color: "oklch(0.55 0.22 248)" },
  { id: "inventory",     href: "/inventory",           name: "حركات المخزون",     desc: "وارد وصادر",        sec: 2, color: "oklch(0.58 0.18 198)" },
  { id: "transfers",     href: "/transfers",           name: "التحويلات",         desc: "نقل بين الفروع",    sec: 2, color: "oklch(0.60 0.18 218)" },
  { id: "barcode",       href: "/barcode-labels",      name: "الباركود",          desc: "طباعة الملصقات",    sec: 2, color: "oklch(0.55 0.14 278)" },
  { id: "suppliers",     href: "/suppliers",           name: "الموردون",          desc: "إدارة الموردين",    sec: 2, color: "oklch(0.62 0.18 46)" },
  { id: "expenses",      href: "/expenses",            name: "المصروفات",         desc: "مصروفات يومية",     sec: 3, color: "oklch(0.65 0.18 72)" },
  { id: "arAging",       href: "/ar-aging",            name: "الذمم المدينة",     desc: "أعمار ومتابعة",     sec: 3, color: "oklch(0.58 0.20 178)" },
  { id: "apAging",       href: "/ap-aging",            name: "الذمم الدائنة",     desc: "ذمم الموردين",      sec: 3, color: "oklch(0.58 0.22 148)" },
  { id: "custStatement", href: "/customers-statement", name: "كشف حساب عميل",     desc: "حسابات العملاء",    sec: 3, color: "oklch(0.60 0.18 322)" },
  { id: "suppStatement", href: "/suppliers-statement", name: "كشف حساب مورد",     desc: "حسابات الموردين",   sec: 3, color: "oklch(0.62 0.18 262)" },
  { id: "workOrders",    href: "/work-orders",         name: "أوامر الشغل",       desc: "المطبعة والإنتاج",  sec: 4, color: "oklch(0.65 0.20 128)" },
  { id: "users",         href: "/users",               name: "المستخدمون",        desc: "صلاحيات وأدوار",    sec: 5, color: "oklch(0.58 0.18 262)" },
  { id: "audit",         href: "/audit",               name: "سجلّ التدقيق",      desc: "مراقبة العمليات",   sec: 5, color: "oklch(0.56 0.16 300)" },
];

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
    expenses: (
      <>
        <rect x="2" y="7" width="20" height="13" rx="2" stroke={w} strokeWidth={sw} />
        <path d="M7,7 L9,4 H15 L17,7" stroke={w} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="16.5" cy="13.5" r="2.2" stroke={w} strokeWidth={sw} fill={w} fillOpacity="0.22" />
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
  const branchId = me.data?.branchId ?? 1;
  const sales = trpc.sales.list.useQuery({ limit: 500 });
  const shift = trpc.shifts.current.useQuery({ branchId });

  const list = sales.data ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const todays = list.filter((i) => new Date(i.invoiceDate).toISOString().slice(0, 10) === today);
  const todaysTotal = todays.reduce((s, i) => s + Number(i.total), 0);
  const fmt = (n: number) => n.toLocaleString("ar-IQ", { maximumFractionDigits: 0 });

  const shiftLabel = shift.data ? "مفتوحة" : "لا وردية";
  const shiftSince = shift.data
    ? `منذ ${new Date(shift.data.openedAt).toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" })}`
    : "";

  const stats = [
    {
      label: "مبيعات اليوم",
      value: fmt(todaysTotal),
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
      value: "—",
      unit: "تعبئة",
      ico: <WarnIco color="oklch(0.72 0.18 75)" />,
      iBg: "oklch(0.72 0.18 75 / 0.15)",
      isAlert: true,
      alertC: "oklch(0.60 0.18 75)",
    },
    {
      label: "ذمم متأخّرة",
      value: "—",
      unit: "> 30 يوم",
      ico: <WarnIco color="oklch(0.62 0.24 22)" />,
      iBg: "oklch(0.62 0.24 22 / 0.12)",
      isAlert: true,
      alertC: "oklch(0.52 0.22 25)",
    },
  ];

  return (
    <div
      style={{
        background: T.metricsBg,
        borderBottom: `1px solid ${T.metricsBord}`,
        padding: "10px 0",
        display: "flex",
        gap: 12,
      }}
    >
      {stats.map((s, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: 50,
            borderRadius: 11,
            padding: "0 14px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: s.isAlert ? T.alertBg : T.statBg,
            border: `1px solid ${s.isAlert ? (s.alertC + "40") : T.statBord}`,
            boxShadow: "0 1px 4px oklch(0 0 0 / 0.04)",
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
      ))}
    </div>
  );
}

/* ═══════════ MODULE CARD ═══════════ */

function ModuleCard({ m }: { m: (typeof MODULES)[number] }) {
  const T = useT();
  const cShadow = m.color.replace(")", " / 0.35)");
  return (
    <Link href={m.href}>
      <div
        style={{
          aspectRatio: "1",
          borderRadius: 16,
          padding: "16px 12px 14px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          cursor: "pointer",
          textAlign: "center",
          background: m.featured ? T.featuredBg : T.cardBg,
          border: `1px solid ${m.featured ? T.featuredBd : T.cardBord}`,
          boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)",
          transition: "box-shadow 0.18s, transform 0.18s",
          textDecoration: "none",
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
        <div
          style={{
            width: 106,
            height: 106,
            flexShrink: 0,
            filter: `drop-shadow(0 6px 14px ${cShadow})`,
          }}
        >
          <Shape id={m.id} color={m.color} size={106} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
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
      </div>
    </Link>
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
  const mods = MODULES.filter((m) => m.sec === sec.id);
  const placeholders = Math.max(0, 6 - mods.length);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <div style={{ width: 3, height: 14, borderRadius: 2, background: sec.accent, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: T.secLabel, letterSpacing: "0.06em" }}>
          {sec.name}
        </span>
        <div style={{ flex: 1, height: 1, background: T.secLine, opacity: 0.35 }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 14 }}>
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
