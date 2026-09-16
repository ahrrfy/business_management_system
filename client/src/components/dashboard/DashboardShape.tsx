import React from 'react';

export interface DashboardShapeProps {
  id: string;
  sec: number;
  isPos?: boolean;
  size?: number;
}

export function DashboardShape({ id, sec, isPos = false, size = 76 }: { id: string; sec: number; isPos?: boolean; size?: number }) {
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
