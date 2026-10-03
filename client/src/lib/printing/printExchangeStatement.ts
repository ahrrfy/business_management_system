/**
 * قوالب طباعة وتقارير وحدة «الصيرفة» الرسمية (A4) — مطبوعات مكتبة العربية.
 * تتوافق مع معايير النظام (هوية الشركة + ترويسة رسمية + بطاقات وصفية + جداول منسقة + خانات توقيع + تذييل).
 * نافذة الطباعة توفر زري «طباعة» و«حفظ كـ PDF» متوافقين مع جميع المتصفحات.
 */
import {
  docTable,
  infoCards,
  pageBodyClose,
  pageBodyOpen,
  pageFooter,
  pageHeader,
  signaturesBlock,
  wrapA4Doc,
  type TableCol,
} from "./docHtml";
import { BRAND as B, esc, openPrintWindow } from "./brand";
import { D, fmtAr } from "@/lib/money";
import { fmtDate as formatDate } from "../date";

export interface ExchangeStatementPrintInput {
  houseName: string;
  housePhone?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  printedByName?: string | null;
  printRequestedAt?: string | null;
  summary: {
    currentBalanceIqd: string;
    currentBalanceUsd: string;
    currentControlCarryingIqd: string;
    totalDepositIqd: string;
    totalWithdrawIqd: string;
    totalDepositUsd: string;
    totalWithdrawUsd: string;
    totalUsdBought: string;
    totalSettledIqd: string;
    totalFeesIqd: string;
    totalFxDiff: string;
  };
  physicalUsdByBranch?: Array<{
    branchName: string;
    quantityUsd: string;
    carryingIqd: string;
    wavgRate: string;
  }>;
  transactions: Array<{
    createdAt: string;
    txnNumber: string;
    type: string;
    typeLabel: string;
    supplierName?: string | null;
    branchName?: string | null;
    createdByName?: string | null;
    iqdAmount: string;
    usdAmount: string;
    fxDiff: string;
    commissionIqd: string;
    balanceIqdAfter: string;
    balanceUsdAfter: string;
    status: string;
    statusLabel: string;
    notes?: string | null;
  }>;
}

/**
 * طباعة كشف حساب صيرفة كامل A4 أفقي (Landscape) — لضمان وضوح كامل الأعمدة المالية والأرصدة الجارية.
 */
export function printExchangeStatementDoc(d: ExchangeStatementPrintInput): boolean {
  const periodLabel = [d.fromDate, d.toDate].filter(Boolean).join(" — ") || "الكل (من البداية)";
  const header = pageHeader({
    title: "كشف حساب صيرفة",
    subtitle: `كشف الحركات المالية والأرصدة الجارية — ${d.houseName}`,
    fields: [
      { label: "رقم المستند", value: `STMT-${d.houseName}` },
      { label: "التاريخ", value: formatDate(new Date()) },
      { label: "الصيرفة", value: d.houseName },
      { label: "الفترة", value: periodLabel },
      { label: "طُبع بواسطة", value: d.printedByName || "المحاسب" },
    ],
  });

  const cards = infoCards([
    {
      title: "بيانات الصيرفة والفترة",
      fields: [
        { label: "الصيرفة", value: d.houseName },
        { label: "الهاتف", value: d.housePhone || "—" },
        { label: "الفترة", value: periodLabel },
        ...(d.printRequestedAt ? [{ label: "وقت الطباعة", value: d.printRequestedAt }] : []),
      ],
    },
    {
      title: "الأرصدة الحالية للشركة",
      fields: [
        {
          label: "رصيد الحساب (دينار)",
          value: `${fmtAr(d.summary.currentBalanceIqd)} د.ع ${D(d.summary.currentBalanceIqd).isNegative() ? "(علينا)" : "(لنا)"}`,
        },
        {
          label: "رصيد الحساب (دولار)",
          value: `${fmtAr(d.summary.currentBalanceUsd)} $ ${D(d.summary.currentBalanceUsd).isNegative() ? "(علينا)" : "(لنا)"}`,
        },
        {
          label: "قيمة control الدفترية",
          value: `${fmtAr(d.summary.currentControlCarryingIqd)} د.ع`,
        },
      ],
    },
    {
      title: "ملخص حركة الفترة",
      fields: [
        { label: "إيداعات (دينار)", value: `${fmtAr(d.summary.totalDepositIqd)} د.ع` },
        { label: "سحوبات (دينار)", value: `${fmtAr(d.summary.totalWithdrawIqd)} د.ع` },
        { label: "إيداعات (دولار)", value: `${fmtAr(d.summary.totalDepositUsd)} $` },
        { label: "سحوبات (دولار)", value: `${fmtAr(d.summary.totalWithdrawUsd)} $` },
        { label: "دولار مشترى", value: `${fmtAr(d.summary.totalUsdBought)} $` },
        { label: "تسديدات موردين", value: `${fmtAr(d.summary.totalSettledIqd)} د.ع` },
        { label: "عمولات مدفوعة", value: `${fmtAr(d.summary.totalFeesIqd)} د.ع` },
        { label: "صافي فروق الصرف", value: `${fmtAr(d.summary.totalFxDiff)} د.ع` },
      ],
    },
  ]);

  let physicalUsdSection = "";
  if (d.physicalUsdByBranch && d.physicalUsdByBranch.length > 0) {
    const physCols: TableCol[] = [
      { key: "branch", label: "الفرع", align: "right" },
      { key: "qty", label: "الكمية الفعلية ($)", align: "left" },
      { key: "carrying", label: "القيمة الدفترية (د.ع)", align: "left" },
      { key: "rate", label: "متوسط الكلفة للعرض", align: "left" },
    ];
    const physRows = d.physicalUsdByBranch.map((p) => ({
      branch: p.branchName,
      qty: `${fmtAr(p.quantityUsd)} $`,
      carrying: `${fmtAr(p.carryingIqd)} د.ع`,
      rate: fmtAr(p.wavgRate),
    }));
    physicalUsdSection = `
      <div style="margin: 14px 0 10px 0;">
        <div style="font-size: 11.5px; font-weight: 700; color: ${B.ink}; margin-bottom: 4px;">
          النقد الدولاري الفعلي حسب الفرع (حيازة فعلية مستقلة عن رصيد حساب الصيرفة)
        </div>
        ${docTable(physCols, physRows, false)}
      </div>
    `;
  }

  const txnCols: TableCol[] = [
    { key: "date", label: "التاريخ", align: "right", width: "105px" },
    { key: "num", label: "الرقم", align: "center", width: "90px" },
    { key: "type", label: "النوع", align: "center", width: "80px" },
    { key: "party", label: "المورد / الطرف", align: "right" },
    { key: "iqd", label: "مبلغ ديناري (د.ع)", align: "left", width: "100px" },
    { key: "usd", label: "دولار ($)", align: "left", width: "80px" },
    { key: "fx", label: "فرق الصرف", align: "left", width: "80px" },
    { key: "fee", label: "العمولة", align: "left", width: "70px" },
    { key: "balIqd", label: "رصيد دينار بعد", align: "left", width: "95px" },
    { key: "balUsd", label: "رصيد دولار بعد", align: "left", width: "85px" },
    { key: "status", label: "الحالة", align: "center", width: "70px" },
  ];

  const txnRows = d.transactions.map((t) => ({
    date: t.createdAt,
    num: t.txnNumber,
    type: t.typeLabel,
    party: t.supplierName ? `${t.supplierName}${t.branchName ? ` (${t.branchName})` : ""}` : (t.branchName ?? "—"),
    iqd: D(t.iqdAmount).isZero() ? "—" : fmtAr(t.iqdAmount),
    usd: D(t.usdAmount).isZero() ? "—" : `${fmtAr(t.usdAmount)} $`,
    fx: D(t.fxDiff).isZero() ? "—" : fmtAr(t.fxDiff),
    fee: D(t.commissionIqd).isZero() ? "—" : fmtAr(t.commissionIqd),
    balIqd: fmtAr(t.balanceIqdAfter),
    balUsd: fmtAr(t.balanceUsdAfter),
    status: t.statusLabel,
  }));

  const signatures = signaturesBlock({
    items: [
      { kind: "sig", label: d.printedByName ? `إعداد: ${d.printedByName}` : "إعداد المحاسب" },
      { kind: "sig", label: "تدقيق الحسابات" },
      { kind: "sig", label: "الإدارة المالية / الاعتماد" },
    ],
  });

  const body = [
    pageBodyOpen(),
    header,
    cards,
    physicalUsdSection,
    `<div style="margin: 14px 0 6px 0; font-size: 12px; font-weight: 700; color: ${B.ink};">سجل حركات كشف الحساب (${d.transactions.length} حركة)</div>`,
    docTable(txnCols, txnRows, true),
    signatures,
    pageBodyClose(),
    pageFooter(),
  ].join("");

  return openPrintWindow(wrapA4Doc(`كشف حساب صيرفة — ${d.houseName}`, body, { orientation: "landscape" }));
}

export interface ExchangeHousesListPrintInput {
  printedByName?: string | null;
  printRequestedAt?: string | null;
  totals: {
    count: number;
    iqd: string;
    usd: string;
    net: string;
  };
  houses: Array<{
    name: string;
    phone?: string | null;
    balanceIqd: string;
    balanceUsd: string;
    usdCostRate: string;
    netExposure: string;
    isActive: boolean;
  }>;
}

/**
 * طباعة تقرير أرصدة الصيرفات ومكاتب التحويل A4.
 */
export function printExchangeHousesListDoc(d: ExchangeHousesListPrintInput): boolean {
  const header = pageHeader({
    title: "أرصدة الصيرفات ومكاتب التحويل",
    subtitle: "تقرير شامل لأرصدة ومحافظ الصيرفة بالدينار والدولار وصافي التعرّض الموحّد",
    fields: [
      { label: "رقم التقرير", value: "REP-EXCHANGE-HOUSES" },
      { label: "التاريخ", value: formatDate(new Date()) },
      { label: "عدد الصيرفات", value: String(d.totals.count) },
      { label: "طُبع بواسطة", value: d.printedByName || "المحاسب" },
    ],
  });

  const cards = infoCards([
    {
      title: "إجماليات أرصدة الصيرفة",
      fields: [
        { label: "عدد الصيرفات المسجلة", value: String(d.totals.count) },
        {
          label: "صافي أرصدة الدينار",
          value: `${fmtAr(d.totals.iqd)} د.ع ${D(d.totals.iqd).isNegative() ? "(علينا)" : "(لنا)"}`,
        },
        {
          label: "صافي أرصدة الدولار",
          value: `${fmtAr(d.totals.usd)} $ ${D(d.totals.usd).isNegative() ? "(علينا)" : "(لنا)"}`,
        },
        {
          label: "صافي التعرّض الموحّد (دينار)",
          value: `${fmtAr(d.totals.net)} د.ع ${D(d.totals.net).isNegative() ? "(علينا)" : "(لنا)"}`,
        },
      ],
    },
  ]);

  const cols: TableCol[] = [
    { key: "name", label: "الصيرفة", align: "right" },
    { key: "phone", label: "الهاتف", align: "center", width: "110px" },
    { key: "balIqd", label: "رصيد الدينار (د.ع)", align: "left", width: "130px" },
    { key: "balUsd", label: "رصيد الدولار ($)", align: "left", width: "110px" },
    { key: "cost", label: "متوسط كلفة الدولار", align: "left", width: "110px" },
    { key: "net", label: "صافي التعرّض (د.ع)", align: "left", width: "130px" },
    { key: "status", label: "الحالة", align: "center", width: "80px" },
  ];

  const rows = d.houses.map((h) => ({
    name: h.name,
    phone: h.phone || "—",
    balIqd: `${fmtAr(h.balanceIqd)} ${D(h.balanceIqd).isNegative() ? "(علينا)" : "(لنا)"}`,
    balUsd: `${fmtAr(h.balanceUsd)} $ ${D(h.balanceUsd).isNegative() ? "(علينا)" : "(لنا)"}`,
    cost: D(h.usdCostRate).isZero() ? "—" : fmtAr(h.usdCostRate),
    net: `${fmtAr(h.netExposure)} ${D(h.netExposure).isNegative() ? "(علينا)" : "(لنا)"}`,
    status: h.isActive ? "فعّالة" : "معطَّلة",
  }));

  const signatures = signaturesBlock({
    items: [
      { kind: "sig", label: d.printedByName ? `إعداد: ${d.printedByName}` : "إعداد المحاسب" },
      { kind: "sig", label: "تدقيق الحسابات" },
      { kind: "sig", label: "اعتماد الإدارة" },
    ],
  });

  const body = [
    pageBodyOpen(),
    header,
    cards,
    `<div style="margin: 16px 0 6px 0; font-size: 12px; font-weight: 700; color: ${B.ink};">قائمة الصيرفات والأرصدة التفصيلية</div>`,
    docTable(cols, rows, true),
    signatures,
    pageBodyClose(),
    pageFooter(),
  ].join("");

  return openPrintWindow(wrapA4Doc("تقرير أرصدة الصيرفات", body, { orientation: "portrait" }));
}

export interface ExchangeReconcilePrintInput {
  houseName: string;
  asOfDate?: string | null;
  printedByName?: string | null;
  printRequestedAt?: string | null;
  ourBalanceIqd: string;
  statedBalanceIqd: string;
  diffIqd: string;
  ourBalanceUsd: string;
  statedBalanceUsd: string;
  diffUsd: string;
  matched: boolean;
  pending: Array<{
    txnNumber: string;
    typeLabel: string;
    iqdAmount: string;
    usdAmount: string;
    createdAt: string;
  }>;
}

/**
 * طباعة محضر مطابقة رصيد صيرفة A4 رسمي.
 */
export function printExchangeReconcileDoc(d: ExchangeReconcilePrintInput): boolean {
  const header = pageHeader({
    title: "محضر مطابقة رصيد صيرفة",
    subtitle: `مطابقة الرصيد الدفتري مع رصيد كشف الصيرفة — ${d.houseName}`,
    fields: [
      { label: "رقم المحضر", value: `REC-${d.houseName}` },
      { label: "التاريخ", value: formatDate(new Date()) },
      { label: "الصيرفة", value: d.houseName },
      { label: "حتى تاريخ القطع", value: d.asOfDate || "اليوم" },
      { label: "حالة المطابقة", value: d.matched ? "مطابقة تامة" : "يوجد فرق تدقيقي" },
    ],
  });

  const statusColor = d.matched ? B.green : "#dc2626";
  const statusBg = d.matched ? "rgba(13, 107, 82, 0.08)" : "rgba(220, 38, 38, 0.08)";
  const statusBorder = d.matched ? "rgba(13, 107, 82, 0.25)" : "rgba(220, 38, 38, 0.25)";

  const banner = `
    <div style="margin: 12px 0; padding: 10px 14px; border-radius: 6px; background: ${statusBg}; border: 1px solid ${statusBorder};">
      <div style="font-weight: 700; color: ${statusColor}; font-size: 12.5px;">
        ${d.matched ? "✓ نتيجة المطابقة: الأرصدة الدفترية مطابقة تماماً لكشف الصيرفة." : "⚠ نتيجة المطابقة: يوجد فرق بين رصيد الدفاتر وكشف الصيرفة — يرجى مراجعة البنود المعلّقة."}
      </div>
    </div>
  `;

  const comparisonCols: TableCol[] = [
    { key: "item", label: "البند والعملة", align: "right" },
    { key: "our", label: "رصيدنا الدفتري", align: "left" },
    { key: "stated", label: "رصيد كشف الصيرفة", align: "left" },
    { key: "diff", label: "الفرق (فارق المطابقة)", align: "left" },
    { key: "status", label: "النتيجة", align: "center", width: "90px" },
  ];

  const comparisonRows = [
    {
      item: "حساب الدينار العراقي (IQD)",
      our: `${fmtAr(d.ourBalanceIqd)} د.ع`,
      stated: `${fmtAr(d.statedBalanceIqd)} د.ع`,
      diff: `${fmtAr(d.diffIqd)} د.ع`,
      status: D(d.diffIqd).isZero() ? "مطابق" : "غير مطابق",
    },
    {
      item: "حساب الدولار الأمريكي (USD)",
      our: `${fmtAr(d.ourBalanceUsd)} $`,
      stated: `${fmtAr(d.statedBalanceUsd)} $`,
      diff: `${fmtAr(d.diffUsd)} $`,
      status: D(d.diffUsd).isZero() ? "مطابق" : "غير مطابق",
    },
  ];

  let pendingSection = "";
  if (d.pending && d.pending.length > 0) {
    const pCols: TableCol[] = [
      { key: "num", label: "رقم الحركة", align: "center", width: "110px" },
      { key: "type", label: "نوع العملية", align: "center", width: "100px" },
      { key: "iqd", label: "دينار (د.ع)", align: "left", width: "110px" },
      { key: "usd", label: "دولار ($)", align: "left", width: "90px" },
      { key: "date", label: "تاريخ العملية", align: "right" },
    ];
    const pRows = d.pending.map((p) => ({
      num: p.txnNumber,
      type: p.typeLabel,
      iqd: D(p.iqdAmount).isZero() ? "—" : fmtAr(p.iqdAmount),
      usd: D(p.usdAmount).isZero() ? "—" : `${fmtAr(p.usdAmount)} $`,
      date: p.createdAt,
    }));
    pendingSection = `
      <div style="margin: 16px 0 6px 0;">
        <div style="font-size: 12px; font-weight: 700; color: ${B.ink}; margin-bottom: 4px;">
          البنود المعلّقة بعد تاريخ القطع (${d.pending.length} بند — تفسر فروق التوقيت)
        </div>
        ${docTable(pCols, pRows, true)}
      </div>
    `;
  }

  const signatures = signaturesBlock({
    items: [
      { kind: "sig", label: d.printedByName ? `إعداد: ${d.printedByName}` : "المحاسب المسؤول" },
      { kind: "sig", label: "مدقق الحسابات" },
      { kind: "sig", label: "المدير المالي" },
    ],
  });

  const body = [
    pageBodyOpen(),
    header,
    banner,
    `<div style="margin: 12px 0 6px 0; font-size: 12px; font-weight: 700; color: ${B.ink};">جدول مقارنة الأرصدة الدفترية مع الكشف المعتمد</div>`,
    docTable(comparisonCols, comparisonRows, false),
    pendingSection,
    signatures,
    pageBodyClose(),
    pageFooter(),
  ].join("");

  return openPrintWindow(wrapA4Doc(`محضر مطابقة رصيد — ${d.houseName}`, body, { orientation: "portrait" }));
}

export interface PendingExchangeDepositsPrintInput {
  printedByName?: string | null;
  printRequestedAt?: string | null;
  count: number;
  totalUsdAmount: string;
  deposits: Array<{
    txnNumber: string;
    houseName: string;
    usdAmount: string;
    exchangeRate: string;
    notes?: string | null;
  }>;
}

/**
 * طباعة تقرير إيداعات الدولار المعلّقة A4 رسمي — بانتظار الاعتماد الثاني.
 */
export function printPendingExchangeDepositsDoc(d: PendingExchangeDepositsPrintInput): boolean {
  const header = pageHeader({
    title: "إيداعات الدولار المعلّقة",
    subtitle: "قائمة إيداعات الدولار بانتظار الاعتماد الثاني (فصل المهام والرقابة المالية)",
    fields: [
      { label: "رقم التقرير", value: "REP-PENDING-USD-DEP" },
      { label: "التاريخ", value: formatDate(new Date()) },
      { label: "العدد", value: String(d.count) },
      { label: "طُبع بواسطة", value: d.printedByName || "المحاسب" },
    ],
  });

  const cards = infoCards([
    {
      title: "ملخص الإيداعات المعلّقة",
      fields: [
        { label: "عدد العمليات المعلّقة", value: String(d.count) },
        { label: "إجمالي المبلغ المطلوب اعتماده", value: `${fmtAr(d.totalUsdAmount)} $` },
        ...(d.printRequestedAt ? [{ label: "وقت الطباعة", value: d.printRequestedAt }] : []),
      ],
    },
  ]);

  const banner = `
    <div style="margin: 12px 0; padding: 10px 14px; border-radius: 6px; background: rgba(217, 119, 6, 0.08); border: 1px solid rgba(217, 119, 6, 0.25);">
      <div style="font-weight: 700; color: #d97706; font-size: 12px;">
        تنبيه رقابي: هذه الإيداعات معلّقة ولا تصبح نافذة على رصيد الصيرفة إلا بعد اعتمادها من مدير ثانٍ (فصل المهام — لا يعتمدها المنشئ).
      </div>
    </div>
  `;

  const cols: TableCol[] = [
    { key: "num", label: "رقم الحركة", align: "center", width: "110px" },
    { key: "house", label: "الصيرفة", align: "right" },
    { key: "usd", label: "المبلغ ($)", align: "left", width: "120px" },
    { key: "rate", label: "السعر المرجعي", align: "left", width: "120px" },
    { key: "notes", label: "ملاحظات", align: "right" },
  ];

  const rows = d.deposits.map((p) => ({
    num: p.txnNumber,
    house: p.houseName,
    usd: `${fmtAr(p.usdAmount)} $`,
    rate: fmtAr(p.exchangeRate),
    notes: p.notes || "—",
  }));

  const signatures = signaturesBlock({
    items: [
      { kind: "sig", label: d.printedByName ? `إعداد: ${d.printedByName}` : "إعداد أمين الصندوق" },
      { kind: "sig", label: "تدقيق الحسابات" },
      { kind: "sig", label: "المدير المالي (الاعتماد الثاني)" },
    ],
  });

  const body = [
    pageBodyOpen(),
    header,
    banner,
    cards,
    `<div style="margin: 14px 0 6px 0; font-size: 12px; font-weight: 700; color: ${B.ink};">جدول إيداعات الدولار المعلقة</div>`,
    docTable(cols, rows, true),
    signatures,
    pageBodyClose(),
    pageFooter(),
  ].join("");

  return openPrintWindow(wrapA4Doc("إيداعات دولار معلقة — بانتظار الاعتماد", body, { orientation: "portrait" }));
}

