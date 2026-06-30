// vouchers-pro (٣٠/٦/٢٦): مَطبعة سندات القَبض/الصَرف — قالب مُخصّص يَعرض كل الحقول الجَديدة.
//
// مَساران:
//   • حَراري ٨٠مم (printVoucherReceipt) — يَستعمل printDoc العام بحُمولة meta/totals مُهيكَلة
//     ليَمُرّ بنفس سَلسلة الأولوية (جسر خادم → WebUSB → نافذة المتصفّح) ⇒ مَطبوع فوري للعميل.
//   • A4 (printVoucherA4) — صَفحة كاملة بهوية الشركة + توقيعَين (صاحب الصرف + المُستلم) +
//     شارة اعتماد + بَصمة مُختصَرة + QR للتَحقّق ⇒ مَلفّ تَدقيقي رَسمي.
import { printDoc } from "./print";
import { openPrintWindow, BRAND, CO, esc, logoUrl } from "./brand";
import { wrapA4Doc, docHeader, docFooter, docSummary, type SummaryItem } from "./docHtml";
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

/** بَناء HTML سندٍ بحَجم A4 (هوية الشركة كاملة) — يَفتح نافذة طباعة المتصفّح. */
export async function printVoucherA4(d: VoucherPrintData): Promise<boolean> {
  const titleAr = d.direction === "IN" ? "سَند قَبض" : "سَند صَرف";
  const headerExtra = [
    { label: "تاريخ السند:", value: d.voucherDate },
    ...(d.branchName ? [{ label: "الفرع:", value: d.branchName }] : []),
    ...(d.cashBucket ? [{ label: "نَوع النَقد:", value: bucketLabel(d.cashBucket) ?? "—" }] : []),
  ];
  const head = docHeader(titleAr, d.voucherNumber, d.voucherDate, headerExtra);

  // شارة الحالة (لون حسب الحالة)
  const statusColor = d.approvalStatus === "APPROVED" ? BRAND.green
    : d.approvalStatus === "PENDING_APPROVAL" ? BRAND.orange
    : "#b91c1c";
  const statusBg = d.approvalStatus === "APPROVED" ? BRAND.greenPale
    : d.approvalStatus === "PENDING_APPROVAL" ? BRAND.orangePale
    : "#fef2f2";

  const statusBadge = `
    <div style="display:flex;justify-content:space-between;align-items:center;
      margin:0 0 5mm 0;padding:3mm 4mm;background:${statusBg};
      border:1.5px solid ${statusColor};border-radius:6px;">
      <div>
        <span style="font-size:13px;font-weight:900;color:${statusColor};">${esc(STATUS_LABEL[d.approvalStatus])}</span>
        ${d.approvedByName ? `<span style="font-size:9px;color:${BRAND.textMuted};margin-right:3mm;">
          (اعتمده: ${esc(d.approvedByName)}${d.approvedAt ? ` — ${esc(d.approvedAt)}` : ""})</span>` : ""}
      </div>
      ${d.signatureHash ? `<div style="font-size:9px;color:${BRAND.textMuted};">
        بَصمة: <span style="font-family:monospace;color:#000;font-weight:700;">${esc(shortHash(d.signatureHash))}</span></div>` : ""}
    </div>`;

  // بطاقة طَرف + بطاقة دَفع جنباً إلى جنب
  const partyCard = `
    <div style="background:${BRAND.greenPale};border:1px solid ${BRAND.greenLight};
      border-radius:6px;padding:3mm 4mm;border-right:3px solid ${BRAND.green};">
      <div style="font-size:9px;color:${BRAND.greenDark};font-weight:700;margin-bottom:1mm;">الطرف المُقابل</div>
      <div style="font-size:13px;font-weight:900;color:#000;line-height:1.5;">${esc(d.partyName)}</div>
      <div style="font-size:9.5px;color:${BRAND.textMuted};margin-top:1mm;">
        ${esc(d.partyTypeLabel)}${d.partyBalance ? ` — رصيد: ${esc(d.partyBalance)}` : ""}
      </div>
      ${d.counterpartyName && d.counterpartyName !== d.partyName ? `
        <div style="font-size:9.5px;color:${BRAND.textMuted};margin-top:1mm;">
          المُستفيد: <span style="color:#000;font-weight:700;">${esc(d.counterpartyName)}</span>
        </div>` : ""}
      ${d.categoryName ? `
        <div style="font-size:9.5px;color:${BRAND.textMuted};margin-top:1mm;">
          الفئة: <span style="color:#000;font-weight:700;">${esc(d.categoryName)}</span>
        </div>` : ""}
    </div>`;

  const paymentLines: string[] = [
    `<div><span style="color:${BRAND.textMuted};">الطريقة:</span> <strong>${esc(d.paymentMethodLabel)}</strong></div>`,
  ];
  if (d.referenceNumber) paymentLines.push(`<div><span style="color:${BRAND.textMuted};">الرقم المرجعي:</span> <strong style="font-family:monospace;">${esc(d.referenceNumber)}</strong></div>`);
  if (d.checkNumber) paymentLines.push(`<div><span style="color:${BRAND.textMuted};">رقم الصكّ:</span> <strong style="font-family:monospace;">${esc(d.checkNumber)}</strong></div>`);
  if (d.cardLastFour) paymentLines.push(`<div><span style="color:${BRAND.textMuted};">البطاقة:</span> <strong style="font-family:monospace;">xxxx ${esc(d.cardLastFour)}</strong></div>`);

  const paymentCard = `
    <div style="background:${BRAND.orangePale};border:1px solid ${BRAND.orangeLight};
      border-radius:6px;padding:3mm 4mm;border-right:3px solid ${BRAND.orange};">
      <div style="font-size:9px;color:${BRAND.orangeDark};font-weight:700;margin-bottom:1mm;">تفاصيل الدفع</div>
      <div style="font-size:10px;line-height:1.8;color:#000;">${paymentLines.join("")}</div>
    </div>`;

  const twoCards = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4mm;margin-bottom:5mm;">
    ${partyCard}${paymentCard}</div>`;

  // الوصف بصندوق واضح
  const descBox = `<div style="margin-bottom:5mm;padding:3mm 4mm;background:#fafafa;
    border:1px solid ${BRAND.border};border-radius:6px;">
    <div style="font-size:9px;color:${BRAND.textMuted};font-weight:700;margin-bottom:1mm;">الوَصف / الغَرض</div>
    <div style="font-size:11px;line-height:1.7;color:#000;">${esc(d.description)}</div>
  </div>`;

  // صندوق الملخّص (المبلغ كبير)
  const summary: SummaryItem[] = [
    { label: "طريقة الدفع", value: d.paymentMethodLabel },
    { label: d.direction === "IN" ? "المبلغ المَستلَم" : "المبلغ المَدفوع", value: `${d.amount} د.ع`, large: true, bold: true },
  ];
  const summaryHtml = docSummary(summary);

  // مَنطقة التوقيعات
  const sigBlock = `<div class="signatures-box" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6mm;
    margin-top:8mm;padding:5mm 0;border-top:1px dashed ${BRAND.border};">
    <div style="text-align:center;">
      <div style="font-size:9px;color:${BRAND.textMuted};margin-bottom:8mm;">المُنشِئ / المُحاسب</div>
      <div style="border-top:1px solid #000;padding-top:1mm;font-size:9px;color:${BRAND.textMuted};">
        ${esc(d.createdByName ?? "—")}
      </div>
    </div>
    <div style="text-align:center;">
      <div style="font-size:9px;color:${BRAND.textMuted};margin-bottom:8mm;">المُعتمِد</div>
      <div style="border-top:1px solid #000;padding-top:1mm;font-size:9px;color:${BRAND.textMuted};">
        ${esc(d.approvedByName ?? (d.approvalStatus === "APPROVED" ? "—" : "(بانتظار الاعتماد)"))}
      </div>
    </div>
    <div style="text-align:center;">
      <div style="font-size:9px;color:${BRAND.textMuted};margin-bottom:8mm;">
        ${d.direction === "IN" ? "المُستلم نقداً" : "المُستلم المُستفيد"}
      </div>
      <div style="border-top:1px solid #000;padding-top:1mm;font-size:9px;color:${BRAND.textMuted};">
        ${esc(d.counterpartyName ?? d.partyName)}
      </div>
    </div>
  </div>`;

  // QR للتَحقّق (يَحوي رقم السند + بَصمة)
  let qrBlock = "";
  try {
    if (d.signatureHash) {
      const qrPayload = `VCH:${d.voucherNumber}|H:${shortHash(d.signatureHash)}`;
      const qr = await qrCodeSvg(qrPayload, { size: 90, margin: 1 });
      qrBlock = `<div style="position:absolute;left:14mm;bottom:18mm;text-align:center;">
        <div style="display:inline-block;padding:2mm;background:#fff;border:1px solid ${BRAND.border};border-radius:4px;">${qr}</div>
        <div style="font-size:7.5px;color:${BRAND.textMuted};margin-top:1mm;font-family:monospace;">${esc(shortHash(d.signatureHash))}</div>
      </div>`;
    }
  } catch { /* تَدهور سَلِس */ }

  const customFooterNotes = `<div style="margin-top:3mm;padding:2mm 3mm;background:${BRAND.bg};
    border:1px dashed ${BRAND.border};border-radius:4px;font-size:8px;color:${BRAND.textMuted};text-align:center;line-height:1.5;">
    هذا السند مُتولَّد آلياً من نظام إدارة أعمال ${esc(CO.name)} — بَصمة SHA-256 مَختومة لمَنع التَلاعب.
    ${d.attachmentUrl ? `<br>مُرفَق: ${esc(d.attachmentUrl)}` : ""}
  </div>`;
  const footer = customFooterNotes + docFooter();

  const body = `${head}${statusBadge}${twoCards}${descBox}${summaryHtml}${sigBlock}${qrBlock}${footer}`;
  const html = wrapA4Doc(titleAr + " " + d.voucherNumber, body);
  return openPrintWindow(html);
}

/** اختيار المسار حسب الرَغبة: thermal (الافتراضي للمَنفذ) أو A4 (للأرشَفة). */
export async function printVoucherSmart(
  d: VoucherPrintData,
  mode: "thermal" | "a4" = "thermal",
): Promise<{ via: "server" | "thermal" | "browser" } | { ok: boolean }> {
  if (mode === "a4") return { ok: await printVoucherA4(d) };
  return printVoucherReceipt(d);
}
