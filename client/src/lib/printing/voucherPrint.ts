// vouchers-pro (٣٠/٦/٢٦): مَطبعة سندات القَبض/الصَرف — قالب مُخصّص يَعرض كل الحقول الجَديدة.
//
// مَساران:
//   • حَراري ٨٠مم (printVoucherReceipt) — يَستعمل printDoc العام بحُمولة meta/totals مُهيكَلة
//     ليَمُرّ بنفس سَلسلة الأولوية (جسر خادم → WebUSB → نافذة المتصفّح) ⇒ مَطبوع فوري للعميل.
//   • A4 (printVoucherA4) — صَفحة كاملة بهوية الشركة + توقيعَين (صاحب الصرف + المُستلم) +
//     شارة اعتماد + بَصمة مُختصَرة + QR للتَحقّق ⇒ مَلفّ تَدقيقي رَسمي.
import { printDoc } from "./print";
import { BRAND, CO } from "./brand";
import { printVoucherV2, type VoucherV2Data } from "./printTemplatesV2";
import { qrCodeSvg } from "./qr";
import type { DocHeaderBarcode } from "./docHtml";
import { D } from "@/lib/money";

export interface VoucherPrintData {
  voucherNumber: string;
  direction: "IN" | "OUT";
  partyType?: "SUPPLIER" | "CUSTOMER" | "DELIVERY_PARTY" | "OTHER" | null;
  voucherDate: string; // YYYY-MM-DD
  createdAt: string;   // ISO أو نص قَريب
  branchName?: string | null;
  amount: string;      // مُنسَّق سَلفاً (مَثلاً "50,000") أو رقم عشري
  paymentMethod: string;
  paymentMethodLabel: string; // عربي
  referenceNumber?: string | null;
  checkNumber?: string | null;
  cardLastFour?: string | null;
  partyTypeLabel: string;
  partyName: string;
  partyBalance?: string | null; // مُنسَّق مع علامة "لنا/علينا"
  partyBalanceBefore?: string | number | null;
  partyBalanceAfter?: string | number | null;
  categoryName?: string | null;
  description: string;
  counterpartyName?: string | null;
  approvalStatus: "APPROVED" | "PENDING_APPROVAL" | "REJECTED";
  status?: string | null;
  approvedByName?: string | null;
  approvedAt?: string | null;
  createdByName?: string | null;
  printedByName?: string | null;
  printRequestedAt?: string | null;
  cashBucket?: "DRAWER" | "TREASURY" | null;
  cashSourceLabel?: string | null;
  signatureHash?: string | null;
  attachmentUrl?: string | null;
  /** attachment-upload (٥/٧): رقم الفاتورة المرتبطة بسند العميل (اختياري). */
  relatedInvoiceNumber?: string | null;
  /** باركود رقم السند للطباعة الرسمية (اختياري). إما كائن DocHeaderBarcode أو نص القيمة أو true/false */
  barcode?: DocHeaderBarcode | string | boolean | null;
  /** موضع الباركود: بجانب الرقم أو تحته (الافتراضي "beside") */
  barcodePlacement?: 'beside' | 'below';
}

const STATUS_LABEL: Record<VoucherPrintData["approvalStatus"], string> = {
  APPROVED: "معتمد",
  PENDING_APPROVAL: "بانتظار الاعتماد",
  REJECTED: "مرفوض",
};

function shortHash(h?: string | null): string {
  return h ? String(h).slice(0, 12).toUpperCase() : "—";
}

function bucketLabel(b?: "DRAWER" | "TREASURY" | null): string | null {
  if (b === "DRAWER") return "درج الكاشير";
  if (b === "TREASURY") return "الخزينة الإدارية";
  return null;
}

function printRequestedAtLabel(value?: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString("ar-IQ-u-nu-latn", {
        dateStyle: "medium",
        timeStyle: "medium",
      });
}

function inferPartyTypeFromPrintData(d: VoucherPrintData): VoucherPrintData["partyType"] {
  if (d.partyType) return d.partyType;
  const lbl = d.partyTypeLabel ?? "";
  if (lbl.includes("مورد") || lbl.includes("مورّد")) return "SUPPLIER";
  if (lbl.includes("عميل") || lbl.includes("زبون")) return "CUSTOMER";
  if (lbl.includes("توصيل")) return "DELIVERY_PARTY";
  return undefined;
}

function parsePartyBalanceDecimal(d: VoucherPrintData): string | null {
  if (d.partyBalanceBefore != null && d.partyBalanceBefore !== "") {
    return D(d.partyBalanceBefore).toFixed(2);
  }
  if (!d.partyBalance) return null;
  const m = /-?[\d,]+(?:\.\d+)?/.exec(d.partyBalance);
  if (!m) return null;
  const mag = D(m[0].replace(/,/g, ""));
  const pt = inferPartyTypeFromPrintData(d);
  if (d.partyBalance.includes("علينا") && pt === "CUSTOMER") {
    return mag.abs().neg().toFixed(2);
  }
  if (d.partyBalance.includes("لنا") && pt === "SUPPLIER") {
    return mag.abs().neg().toFixed(2);
  }
  return mag.toFixed(2);
}

/** طباعة السند الحرارية (٨٠مم) — تَمُرّ بـprintDoc لتَستفيد من السَلسلة الكاملة. */
export async function printVoucherReceipt(d: VoucherPrintData): Promise<{ via: "server" | "thermal" | "browser" }> {
  const title = d.direction === "IN" ? "سند قبض" : "سند صرف";
  const subtitle = d.approvalStatus === "PENDING_APPROVAL" ? "بانتظار اعتماد مدير ثان" : undefined;

  const meta: string[] = [
    `رقم السند: ${d.voucherNumber}`,
    `التاريخ: ${d.voucherDate}`,
  ];
  if (d.branchName) meta.push(`الفرع: ${d.branchName}`);
  if (d.categoryName) meta.push(`الفئة: ${d.categoryName}`);
  meta.push(`الطرف: ${d.partyTypeLabel} — ${d.partyName}`);
  if (d.partyBalanceBefore != null) meta.push(`الرصيد قبل السند: ${String(d.partyBalanceBefore)}`);
  if (d.partyBalance && d.partyBalanceBefore == null && d.partyBalanceAfter == null) {
    meta.push(`رصيد الطرف: ${d.partyBalance}`);
  }
  if (d.partyBalanceAfter != null) meta.push(`الرصيد بعد السند: ${String(d.partyBalanceAfter)}`);
  if (d.relatedInvoiceNumber) meta.push(`الفاتورة المرتبطة: ${d.relatedInvoiceNumber}`);
  if (d.counterpartyName && d.counterpartyName !== d.partyName) {
    meta.push(`اسم المستفيد: ${d.counterpartyName}`);
  }
  meta.push(`الوصف: ${d.description}`);
  if (d.cashSourceLabel || d.cashBucket) {
    meta.push(`نوع النقد: ${d.cashSourceLabel ?? bucketLabel(d.cashBucket)}`);
  }
  if (d.createdByName) meta.push(`المنشئ: ${d.createdByName}`);
  if (d.approvedByName) meta.push(`المعتمد: ${d.approvedByName}`);
  meta.push(`الحالة: ${STATUS_LABEL[d.approvalStatus]}`);

  const totals: { label: string; value: string }[] = [
    { label: "المبلغ (IQD)", value: d.amount },
    { label: "طريقة الدفع", value: d.paymentMethodLabel },
  ];
  if (d.referenceNumber) totals.push({ label: "الرقم المرجعي", value: d.referenceNumber });
  if (d.checkNumber) totals.push({ label: "رقم الصك", value: d.checkNumber });
  if (d.cardLastFour) totals.push({ label: "البطاقة xxxx", value: d.cardLastFour });
  if (d.signatureHash) totals.push({ label: "بصمة #", value: shortHash(d.signatureHash) });

  return printDoc({
    kind: "opening",
    title,
    subtitle: subtitle,
    meta,
    totals,
    footer: "توقيع المحاسب / المستلم: ____________________",
  });
}

export async function voucherPrintToV2Data(d: VoucherPrintData): Promise<VoucherV2Data> {
  const refNumber = d.referenceNumber
    || (d.checkNumber ? `CHQ-${d.checkNumber}` : null)
    || (d.cardLastFour ? `xxxx ${d.cardLastFour}` : null);

  const isReversed = d.status === 'REVERSED';
  const isIncomplete = Boolean(d.status && d.status !== 'COMPLETED' && !isReversed);
  const statusLabel = isReversed ? 'ملغى / معكوس'
    : isIncomplete ? 'غير مكتمل'
    : d.approvalStatus === 'APPROVED' ? 'معتمد'
    : d.approvalStatus === 'PENDING_APPROVAL' ? 'بانتظار الاعتماد'
    : 'مرفوض';
  const statusColor = isReversed ? '#b91c1c'
    : isIncomplete ? BRAND.orange
    : d.approvalStatus === 'APPROVED' ? BRAND.green
    : d.approvalStatus === 'PENDING_APPROVAL' ? BRAND.orange
    : '#b91c1c';

  const balBefore = parsePartyBalanceDecimal(d);
  const printRequestedAt = printRequestedAtLabel(d.printRequestedAt);
  const amountClean = D(String(d.amount).replace(/[^\d.-]/g, '') || '0').toFixed(2);

  let qrSvg: string | null = null;
  try {
    const qrPayload = d.signatureHash
      ? `VCH:${d.voucherNumber}|H:${shortHash(d.signatureHash)}`
      : `VCH:${d.voucherNumber}`;
    qrSvg = await qrCodeSvg(qrPayload, { size: 90, margin: 1 });
  } catch { /* تدهور سلس */ }

  const attachmentImageUrl = d.attachmentUrl && /^data:image\//.test(d.attachmentUrl)
    ? d.attachmentUrl
    : null;

  return {
    direction: d.direction,
    partyType: inferPartyTypeFromPrintData(d),
    voucherNumber: d.voucherNumber,
    voucherDate: d.voucherDate,
    statusLabel,
    statusColor,
    partyName: d.partyName,
    partyTypeLabel: d.partyTypeLabel,
    partyBalanceBefore: balBefore,
    partyBalanceAfter: d.partyBalanceAfter ?? null,
    paymentMethodLabel: d.paymentMethodLabel,
    referenceNumber: refNumber,
    cashSourceLabel: d.cashSourceLabel ?? bucketLabel(d.cashBucket),
    branchName: d.branchName ?? null,
    categoryName: d.categoryName ?? null,
    relatedInvoiceNumber: d.relatedInvoiceNumber ?? null,
    counterpartyName: d.counterpartyName ?? null,
    createdByName: d.createdByName ?? null,
    approvedByName: d.approvedByName ?? null,
    printedByName: d.printedByName ?? null,
    printRequestedAt,
    description: d.description,
    amount: amountClean,
    qrSvg,
    signatureShortHash: d.signatureHash ? shortHash(d.signatureHash) : null,
    attachmentImageUrl,
    barcode: d.barcode,
    barcodePlacement: d.barcodePlacement,
    settings: {
      taxId: CO.taxId,
      commercialRegistry: CO.commercialRegistry,
      chamberLicense: CO.chamberLicense,
    },
  };
}

/** بناء HTML سند بحجم A4 (هوية الشركة كاملة) — يفتح نافذة طباعة المتصفّح. */
export async function printVoucherA4(d: VoucherPrintData): Promise<boolean> {
  return printVoucherV2(await voucherPrintToV2Data(d));
}

/** اختيار المسار حسب الرَغبة: thermal (الافتراضي للمَنفذ) أو A4 (للأرشَفة). */
export async function printVoucherSmart(
  d: VoucherPrintData,
  mode: "thermal" | "a4" = "thermal",
): Promise<{ via: "server" | "thermal" | "browser" } | { ok: boolean }> {
  if (mode === "a4") return { ok: await printVoucherA4(d) };
  return printVoucherReceipt(d);
}
