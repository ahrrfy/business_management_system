// سند عملية صيرفة (إيداع/سحب/شراء دولار/تسديد مورد/رصيد افتتاحي) — نمط voucherPrint.ts:
//  • حراري ٨٠مم (printExchangeSlipReceipt) عبر printDoc العام (جسر خادم ← WebUSB ← نافذة متصفّح).
//  • A4 (printExchangeSlipA4) بهوية الشركة + توقيعين + QR، عبر أدوات docHtml.ts المشتركة.
// قالبٌ واحد لكل أنواع عمليات الصيرفة (بدل إقحامها في قالب سند القبض/الصرف العام غير المناسب دلالياً
// هنا — لا اتجاه IN/OUT ولا حالة اعتماد لعمليات الإيداع/السحب/الشراء).
import { printDoc } from "./print";
import {
  infoCards,
  pageBodyClose,
  pageBodyOpen,
  pageFooter,
  pageHeader,
  signaturesBlock,
  wrapA4Doc,
} from "./docHtml";
import { BRAND, openPrintWindow } from "./brand";
import { qrCodeSvg } from "./qr";
import { D, fmtAr } from "@/lib/money";

export type ExchangeSlipType = "DEPOSIT" | "WITHDRAW" | "FX_BUY" | "SETTLE" | "OPENING";
export type ExchangeSlipStatus = "ACTIVE" | "REVERSED" | "PENDING_APPROVAL";

export interface ExchangeSlipData {
  txnNumber: string;
  type: ExchangeSlipType;
  currency: "IQD" | "USD";
  status: ExchangeSlipStatus;
  createdAt: string; // مُنسَّق سَلفاً للعرض
  houseName: string;
  housePhone?: string | null;
  branchName?: string | null;
  createdByName?: string | null;
  iqdAmount: string;
  usdAmount: string;
  exchangeRate?: string | null;
  commission?: string | null;
  fxDiff?: string | null;
  supplierName?: string | null;
  voucherNumber?: string | null;
  balanceIqdAfter: string;
  balanceUsdAfter: string;
  notes?: string | null;
}

const TYPE_LABEL: Record<ExchangeSlipType, string> = {
  DEPOSIT: "إيداع",
  WITHDRAW: "سحب",
  FX_BUY: "شراء دولار",
  SETTLE: "تسديد مورد",
  OPENING: "رصيد افتتاحي",
};

const STATUS_META: Record<ExchangeSlipStatus, { label: string; color: string }> = {
  ACTIVE: { label: "نافذة", color: BRAND.green },
  PENDING_APPROVAL: { label: "بانتظار اعتماد مديرٍ ثانٍ", color: BRAND.orange },
  REVERSED: { label: "معكوسة", color: "#b91c1c" },
};

/** تسمية مبلغ الدينار/الدولار حسب نوع العملية (نفس الرقم يعني شيئاً مختلفاً في كل نوع). */
const AMOUNT_LABEL: Record<ExchangeSlipType, { iqd: string; usd: string }> = {
  DEPOSIT: { iqd: "مبلغ الإيداع", usd: "مبلغ الإيداع" },
  WITHDRAW: { iqd: "مبلغ السحب", usd: "مبلغ السحب" },
  FX_BUY: { iqd: "القيمة الدينارية المعادلة (سعر نشوء الدَّين)", usd: "الدولار المُستلَم من الصيرفة" },
  SETTLE: { iqd: "الدين المُسوّى (دينار)", usd: "الدولار الواصل للمورّد" },
  OPENING: { iqd: "الرصيد الافتتاحي (دينار)", usd: "الرصيد الافتتاحي (دولار)" },
};

function detailFields(d: ExchangeSlipData): { label: string; value: string }[] {
  const f: { label: string; value: string }[] = [];
  const lbl = AMOUNT_LABEL[d.type];
  if (d.supplierName) f.push({ label: "المورّد", value: d.supplierName });
  if (d.voucherNumber) f.push({ label: "سند الصرف المرتبط", value: d.voucherNumber });
  if (!D(d.iqdAmount).isZero()) f.push({ label: lbl.iqd, value: `${fmtAr(d.iqdAmount)} د.ع` });
  if (!D(d.usdAmount).isZero()) f.push({ label: lbl.usd, value: `${fmtAr(d.usdAmount)} $` });
  if (d.exchangeRate && D(d.exchangeRate).gt(0)) f.push({ label: "سعر الصرف", value: fmtAr(d.exchangeRate) });
  if (d.commission && D(d.commission).gt(0)) {
    f.push({ label: "العمولة", value: `${fmtAr(d.commission)} ${d.currency === "USD" ? "$" : "د.ع"}` });
  }
  if (d.fxDiff && !D(d.fxDiff).isZero()) {
    const gain = D(d.fxDiff).isPositive();
    f.push({ label: gain ? "مكسب صرف محقَّق" : "خسارة صرف محقَّقة", value: `${fmtAr(D(d.fxDiff).abs().toFixed(2))} د.ع` });
  }
  if (d.notes) f.push({ label: "ملاحظات", value: d.notes });
  if (d.createdByName) f.push({ label: "المُنشئ", value: d.createdByName });
  return f;
}

/** طباعة سند العملية الحرارية (٨٠مم) — تمرّ بـprintDoc لتستفيد من سلسلة الأولوية الكاملة. */
export async function printExchangeSlipReceipt(d: ExchangeSlipData): Promise<{ via: "server" | "thermal" | "browser" }> {
  const st = STATUS_META[d.status];
  const meta: string[] = [`رقم العملية: ${d.txnNumber}`, `التاريخ: ${d.createdAt}`];
  if (d.branchName) meta.push(`الفرع: ${d.branchName}`);
  meta.push(`الصيرفة: ${d.houseName}${d.housePhone ? ` — ${d.housePhone}` : ""}`);
  for (const f of detailFields(d)) meta.push(`${f.label}: ${f.value}`);
  meta.push(`الحالة: ${st.label}`);

  const totals: { label: string; value: string }[] = [
    { label: "الرصيد بعد العملية (دينار)", value: fmtAr(d.balanceIqdAfter) },
    { label: "الرصيد بعد العملية (دولار)", value: `${fmtAr(d.balanceUsdAfter)} $` },
  ];

  return printDoc({
    kind: "opening",
    title: `سند صيرفة — ${TYPE_LABEL[d.type]}`,
    subtitle: d.status !== "ACTIVE" ? st.label : undefined,
    meta,
    totals,
    footer: "توقيع المحاسب / المسؤول: ____________________",
  });
}

/** طباعة سند العملية A4 (هوية الشركة كاملة + توقيعان + QR) — نافذة طباعة المتصفّح. */
export async function printExchangeSlipA4(d: ExchangeSlipData): Promise<boolean> {
  const st = STATUS_META[d.status];

  const header = pageHeader({
    title: `سند صيرفة — ${TYPE_LABEL[d.type]}`,
    fields: [
      { label: "رقم العملية", value: d.txnNumber },
      { label: "التاريخ", value: d.createdAt },
      ...(d.branchName ? [{ label: "الفرع", value: d.branchName }] : []),
    ],
    badge: { label: st.label, color: st.color },
  });

  const cards = infoCards([
    {
      title: "الصيرفة",
      variant: "green",
      fields: [
        { label: "الاسم", value: d.houseName },
        ...(d.housePhone ? [{ label: "الهاتف", value: d.housePhone }] : []),
        { label: "الرصيد بعد العملية (دينار)", value: `${fmtAr(d.balanceIqdAfter)} د.ع` },
        { label: "الرصيد بعد العملية (دولار)", value: `${fmtAr(d.balanceUsdAfter)} $` },
      ],
    },
    {
      title: d.supplierName ? "تفاصيل التسديد" : "تفاصيل العملية",
      variant: "gray",
      fields: detailFields(d),
    },
  ]);

  let qrSvg: string | null = null;
  try {
    qrSvg = await qrCodeSvg(`EXTXN:${d.txnNumber}`, { size: 90, margin: 1 });
  } catch { /* تدهور سلس — بلا QR إن تعذّر */ }

  const signatures = signaturesBlock({
    items: [{ kind: "sig", label: "المحاسب" }, { kind: "sig", label: "المدير المُعتمِد" }],
    qrSvg: qrSvg ?? undefined,
    qrCaption: d.txnNumber,
    qrSize: 52,
    spaceHeight: 28,
  });

  const body = `${pageBodyOpen()}${header}${cards}${signatures}${pageBodyClose()}${pageFooter(undefined, { rightText: `REF ${d.txnNumber}` })}`;
  return openPrintWindow(wrapA4Doc(`سند صيرفة ${d.txnNumber}`, body));
}

/** اختيار المسار حسب الرغبة: thermal (الافتراضي لطابعة الكاشير) أو A4 (للأرشفة/التدقيق). */
export async function printExchangeSlipSmart(
  d: ExchangeSlipData,
  mode: "thermal" | "a4" = "thermal",
): Promise<{ via: "server" | "thermal" | "browser" } | { ok: boolean }> {
  if (mode === "a4") return { ok: await printExchangeSlipA4(d) };
  return printExchangeSlipReceipt(d);
}
