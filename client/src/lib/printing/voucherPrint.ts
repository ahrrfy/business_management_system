// vouchers-pro (٣٠/٦/٢٦): مَطبعة سندات القَبض/الصَرف — قالب مُخصّص يَعرض كل الحقول الجَديدة.
//
// مَساران:
//   • حَراري ٨٠مم (printVoucherReceipt) — يَستعمل printDoc العام بحُمولة meta/totals مُهيكَلة
//     ليَمُرّ بنفس سَلسلة الأولوية (جسر خادم → WebUSB → نافذة المتصفّح) ⇒ مَطبوع فوري للعميل.
//   • A4 (printVoucherA4) — صَفحة كاملة بهوية الشركة + توقيعَين (صاحب الصرف + المُستلم) +
//     شارة اعتماد + بَصمة مُختصَرة + QR للتَحقّق ⇒ مَلفّ تَدقيقي رَسمي.
import { printDoc } from "./print";
import { BRAND, CO } from "./brand";
import { printVoucherV2 } from "./printTemplatesV2";
import { qrCodeSvg } from "./qr";

export interface VoucherPrintData {
  voucherNumber: string;
  direction: "IN" | "OUT";
  voucherDate: string; // YYYY-MM-DD
  createdAt: string;   // ISO أو نص قَريب
  branchName?: string | null;
  amount: string;      // مُنسَّق سَلفاً (مَثلاً "50,000")
  paymentMethod: string;
  paymentMethodLabel: string; // عربي
  referenceNumber?: string | null;
  checkNumber?: string | null;
  cardLastFour?: string | null;
  partyTypeLabel: string;
  partyName: string;
  partyBalance?: string | null; // مُنسَّق مع علامة "لنا/علينا"
  categoryName?: string | null;
  description: string;
  counterpartyName?: string | null;
  approvalStatus: "APPROVED" | "PENDING_APPROVAL" | "REJECTED";
  approvedByName?: string | null;
  approvedAt?: string | null;
  createdByName?: string | null;
  cashBucket?: "DRAWER" | "TREASURY" | null;
  signatureHash?: string | null;
  attachmentUrl?: string | null;
  /** attachment-upload (٥/٧): رقم الفاتورة المرتبطة بسند العميل (اختياري). */
  relatedInvoiceNumber?: string | null;
}

const STATUS_LABEL: Record<VoucherPrintData["approvalStatus"], string> = {
  APPROVED: "مُعتمَد",
  PENDING_APPROVAL: "بانتظار الاعتماد",
  REJECTED: "مَرفوض",
};

function shortHash(h?: string | null): string {
  return h ? String(h).slice(0, 12).toUpperCase() : "—";
}

function bucketLabel(b?: "DRAWER" | "TREASURY" | null): string | null {
  if (b === "DRAWER") return "درج الكاشير";
  if (b === "TREASURY") return "الخزينة الإدارية";
  return null;
}

/** طباعة السند الحرارية (٨٠مم) — تَمُرّ بـprintDoc لتَستفيد من السَلسلة الكاملة. */
export async function printVoucherReceipt(d: VoucherPrintData): Promise<{ via: "server" | "thermal" | "browser" }> {
  const title = d.direction === "IN" ? "سَند قَبض" : "سَند صَرف";
  const subtitle = d.approvalStatus === "PENDING_APPROVAL" ? "⏳ بانتظار اعتماد مدير ثانٍ" : undefined;

  const meta: string[] = [
    `رقم السند: ${d.voucherNumber}`,
    `التاريخ: ${d.voucherDate}`,
  ];
  if (d.branchName) meta.push(`الفرع: ${d.branchName}`);
  if (d.categoryName) meta.push(`الفئة: ${d.categoryName}`);
  meta.push(`الطرف: ${d.partyTypeLabel} — ${d.partyName}`);
  if (d.partyBalance) meta.push(`رصيد الطرف: ${d.partyBalance}`);
  if (d.relatedInvoiceNumber) meta.push(`الفاتورة المرتبطة: ${d.relatedInvoiceNumber}`);
  if (d.counterpartyName && d.counterpartyName !== d.partyName) {
    meta.push(`اسم المُستفيد: ${d.counterpartyName}`);
  }
  meta.push(`الوصف: ${d.description}`);
  if (d.cashBucket) meta.push(`نَوع النَقد: ${bucketLabel(d.cashBucket)}`);
  if (d.createdByName) meta.push(`المُنشئ: ${d.createdByName}`);
  if (d.approvedByName) meta.push(`المُعتمِد: ${d.approvedByName}`);
  meta.push(`الحالة: ${STATUS_LABEL[d.approvalStatus]}`);

  const totals: { label: string; value: string }[] = [
    { label: "المبلغ (IQD)", value: d.amount },
    { label: "طريقة الدفع", value: d.paymentMethodLabel },
  ];
  if (d.referenceNumber) totals.push({ label: "الرقم المرجعي", value: d.referenceNumber });
  if (d.checkNumber) totals.push({ label: "رقم الصكّ", value: d.checkNumber });
  if (d.cardLastFour) totals.push({ label: "البطاقة xxxx", value: d.cardLastFour });
  if (d.signatureHash) totals.push({ label: "بَصمة #", value: shortHash(d.signatureHash) });

  // مَلاحظة: «opening» kind يَطبع meta+totals بلا columns ⇒ تَخطيط مُتسق لأنواع الإيصالات
  // غير-المُجدوَلة (z-report/سند). توقيع الكاشير/المُستلم يَنزل في footer.
  return printDoc({
    kind: "opening",
    title,
    subtitle: subtitle,
    meta,
    totals,
    footer: "توقيع المُحاسِب / المُستلم: ____________________",
  });
}

/**
 * بَناء HTML سندٍ بحَجم A4 (هوية الشركة كاملة) — يَفتح نافذة طباعة المتصفّح.
 * hifi-redesign (٥/٧/٢٦): يَحوَّل إلى printVoucherV2 (التصميم المرجعي: طرف بخطّ سميك يَحوي الرصيد
 * قبل السند بلُنا/علينا، شريط أخضر كبير للمبلغ، تفقيط، QR + ٣ توقيعات، تذييل بـHASH). المُرفَق
 * والحقول الإضافية (بَصمة/فئة/مُستفيد/رقم الفاتورة المرتبطة) تُضاف كسطور «الوصف/الغرض» لأن التصميم
 * الجديد يَحصر البطاقات في اثنتين فقط (طرف مقابل + تفاصيل دفع).
 */
export async function printVoucherA4(d: VoucherPrintData): Promise<boolean> {
  // الرقم المرجعي الظاهر ضمن «تفاصيل الدفع»: أولوية referenceNumber ← checkNumber ← البطاقة.
  const refNumber = d.referenceNumber
    || (d.checkNumber ? `CHQ-${d.checkNumber}` : null)
    || (d.cardLastFour ? `xxxx ${d.cardLastFour}` : null);

  // الوَصف المُوسَّع: الوصف الأصلي + الحقول التي كانت في البطاقة القديمة (فئة/مُستفيد/فاتورة مرتبطة/مُنشئ/معتمِد).
  const parts: string[] = [d.description];
  if (d.categoryName) parts.push(`الفئة: ${d.categoryName}`);
  if (d.counterpartyName && d.counterpartyName !== d.partyName) parts.push(`المُستفيد: ${d.counterpartyName}`);
  if (d.relatedInvoiceNumber) parts.push(`الفاتورة المرتبطة: ${d.relatedInvoiceNumber}`);
  if (d.cashBucket) parts.push(`نوع النقد: ${bucketLabel(d.cashBucket) ?? '—'}`);
  if (d.branchName) parts.push(`الفرع: ${d.branchName}`);
  if (d.createdByName) parts.push(`المُنشئ: ${d.createdByName}`);
  if (d.approvedByName) parts.push(`المُعتمِد: ${d.approvedByName}`);
  const description = parts.filter(Boolean).join(' · ');

  // شارة الحالة تُلوَّن حسب approvalStatus.
  const statusLabel = d.approvalStatus === 'APPROVED' ? '✓ معتمَد'
    : d.approvalStatus === 'PENDING_APPROVAL' ? '⏳ بانتظار الاعتماد'
    : '✗ مرفوض';
  const statusColor = d.approvalStatus === 'APPROVED' ? BRAND.green
    : d.approvalStatus === 'PENDING_APPROVAL' ? BRAND.orange
    : '#b91c1c';

  // رصيد الطرف قبل السند (المُمرَّر نصّاً «250,000 (لنا)») → نستخرج الجزء الرقمي فقط ليعرضه القالب الجديد بإشارة موحّدة.
  let balBefore: number | null = null;
  if (d.partyBalance) {
    const m = /-?[\d,]+/.exec(d.partyBalance);
    if (m) balBefore = Number(m[0].replace(/,/g, ''));
    // إذا احتوى النَص «(لنا)» / «(علينا)» فذلك يحدّد الاتجاه (لكن direction=IN/OUT يكفي لتحديده).
  }

  // QR: نستعمل رقم السند + بَصمة إن وُجدت (تدهور سَلِس عند الفشل).
  let qrSvg: string | null = null;
  try {
    const qrPayload = d.signatureHash
      ? `VCH:${d.voucherNumber}|H:${shortHash(d.signatureHash)}`
      : `VCH:${d.voucherNumber}`;
    qrSvg = await qrCodeSvg(qrPayload, { size: 90, margin: 1 });
  } catch { /* تَدهور سَلِس ⇒ placeholder افتراضي */ }

  return printVoucherV2({
    direction: d.direction,
    voucherNumber: d.voucherNumber,
    voucherDate: d.voucherDate,
    statusLabel,
    statusColor,
    partyName: d.partyName,
    partyTypeLabel: d.partyTypeLabel,
    partyBalanceBefore: balBefore,
    paymentMethodLabel: d.paymentMethodLabel,
    referenceNumber: refNumber,
    description,
    amount: d.amount.replace(/[^\d.-]/g, ''), // «50,000» ⇒ «50000» ⇒ يُنسَّق داخل V2 بلا كسور
    qrSvg,
    signatureShortHash: d.signatureHash ? shortHash(d.signatureHash) : null,
    settings: {
      taxId: CO.taxId,
      commercialRegistry: CO.commercialRegistry,
      chamberLicense: CO.chamberLicense,
    },
  });
}

/** اختيار المسار حسب الرَغبة: thermal (الافتراضي للمَنفذ) أو A4 (للأرشَفة). */
export async function printVoucherSmart(
  d: VoucherPrintData,
  mode: "thermal" | "a4" = "thermal",
): Promise<{ via: "server" | "thermal" | "browser" } | { ok: boolean }> {
  if (mode === "a4") return { ok: await printVoucherA4(d) };
  return printVoucherReceipt(d);
}
