import { D } from "@/lib/money";
import { invoicePrintAmounts } from "./receiptLayoutInvoiceAmounts";
import { esc, fmt } from "./brand";
import { fmtQty } from "@shared/quantityFormat";
import { code128Svg } from "./barcode";
import { formatArabicMoneyWords } from "./tafqit";
import { formatPaymentMethodPrintHtml } from "./cardBrandLogos";
import { buildDigitalBlocks } from "./digitalReceiptLines";
import { wrapReceiptDoc } from "./docHtml";
import type { ReceiptBrowserData } from "./printTemplates";
import { receiptHeaderHtml } from "./receiptLayoutHtmlHeader";
import { receiptFooterHtml } from "./receiptLayoutHtmlFooter";

export function buildBrowserReceiptHtml(d: ReceiptBrowserData): string {
  const facts = invoicePrintAmounts({
    total: d.total,
    paidAmount: d.paid,
    returnedTotal: d.returnedTotal,
    currentTotal: d.currentTotal,
    remainingAmount: d.remainingAmount ?? d.credit,
    status: d.status,
    paymentMode: d.paymentMode,
  });
  const revised =
    D(facts.returnedTotal).gt(0) || !D(facts.currentTotal).eq(D(d.total));
  let barSvg = "";
  try {
    const bc = code128Svg(d.receiptNumber, {
      moduleWidth: 0.8,
      height: 26.5,
      showText: false,
    });
    barSvg = bc.svg;
  } catch {
    /* ignore */
  }

  const itemRows = d.items
    .map(
      (it) => `
    <tr>
      <td style="padding:0.75mm 1mm;font-weight:900;font-size:11.5px;color:#000;line-height:1.25;border:1px solid #000;">${esc(it.name)}</td>
      <td style="text-align:center;padding:0.75mm 1mm;font-weight:900;font-size:12px;color:#000;white-space:nowrap;font-variant-numeric:tabular-nums;border:1px solid #000;direction:ltr;">${fmtQty(it.quantity)}</td>
      <td style="text-align:left;padding:0.75mm 1mm;font-weight:800;font-size:11.5px;color:#000;direction:ltr;white-space:nowrap;font-variant-numeric:tabular-nums;border:1px solid #000;">${fmt(it.price)}</td>
      <td style="text-align:left;padding:0.75mm 1mm;font-weight:900;font-size:12px;color:#000;direction:ltr;white-space:nowrap;font-variant-numeric:tabular-nums;border:1px solid #000;">${fmt(it.total)}</td>
    </tr>
  `,
    )
    .join("");

  // البطاقات الرقمية
  const digitalBlocks = buildDigitalBlocks(d.digitalDetails, {
    maskPhones: d.maskPhones,
  });
  const digitalHtml = digitalBlocks.length
    ? `<table style="width:100%;font-size:10.5px;border-collapse:collapse;border:1.5px solid #000;margin:2mm 0;color:#000;">
        <thead><tr style="background:#000;color:#fff;"><th colspan="2" style="padding:1mm;font-weight:900;border:1px solid #000;text-align:right;">بيانات الشحن الرقمي</th></tr></thead>
        <tbody>` +
      digitalBlocks
        .map(
          (b) => `
        <tr><td colspan="2" style="font-weight:900;padding:1mm 1.5mm;background:#000;color:#fff;border:1px solid #000;">${esc(b.lineName)}</td></tr>
        ${b.rows
          .map(
            (r) => `<tr>
          <td style="width:38%;font-weight:800;padding:1mm 1.5mm;border:1px solid #000;">${esc(r.label)}</td>
          <td style="font-weight:900;padding:1mm 1.5mm;direction:${/هاتف|رقم|ID/.test(r.label) ? "ltr" : "rtl"};text-align:${/هاتف|رقم|ID/.test(r.label) ? "left" : "right"};border:1px solid #000;">${esc(r.value)}</td>
        </tr>`,
          )
          .join("")}
      `,
        )
        .join("") +
      `</tbody></table>`
    : "";

  // كتلة التوصيل
  const deliveryHtml = d.delivery
    ? (() => {
        const dl = d.delivery!;
        const fee = D(dl.fee || 0);
        const shop = dl.feeCollection === "SHOP";
        const who =
          dl.feeCollection === "COUNTER"
            ? "مقبوضة في الاستقبال"
            : shop
              ? "على المكتبة — مجاناً للزبون"
              : "يقبضها المندوب من الزبون";
        const remainingMerchandise = D(facts.remainingAmount);
        const courierFee = dl.feeCollection === "COURIER" ? fee : D(0);
        const totalToCollect = remainingMerchandise.plus(courierFee);

        let customerDueRow = "";
        if (facts.dead) {
          customerDueRow = "";
        } else if (totalToCollect.isZero()) {
          customerDueRow = `
        <tr style="background:#000;color:#fff;font-weight:900;">
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;">المطلوب من الزبون</td>
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">0 د.ع (مدفوع بالكامل)</td>
        </tr>`;
        } else if (remainingMerchandise.isZero() && courierFee.gt(0)) {
          customerDueRow = `
        <tr style="background:#000;color:#fff;font-weight:900;">
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;">يدفع الزبون (أجرة التوصيل فقط)</td>
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(courierFee.toFixed(2))} د.ع</td>
        </tr>
        <tr>
          <td colspan="2" style="border:1px solid #000;padding:1mm 1.5mm;text-align:center;font-weight:800;font-size:10px;background:#f5f5f5;">
            البضاعة مدفوعة مسبقاً بالكامل
          </td>
        </tr>`;
        } else if (courierFee.gt(0)) {
          customerDueRow = `
        <tr style="background:#000;color:#fff;font-weight:900;">
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;">يدفع الزبون شاملاً التوصيل</td>
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(totalToCollect.toFixed(2))} د.ع</td>
        </tr>
        <tr>
          <td colspan="2" style="border:1px solid #000;padding:0.8mm 1.5mm;text-align:center;font-weight:700;font-size:9.5px;color:#333;">
            (متبقي البضاعة: ${fmt(remainingMerchandise.toFixed(2))} + أجرة التوصيل: ${fmt(courierFee.toFixed(2))})
          </td>
        </tr>`;
        } else {
          customerDueRow = `
        <tr style="background:#000;color:#fff;font-weight:900;">
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;">يدفع الزبون (متبقي البضاعة)</td>
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(remainingMerchandise.toFixed(2))} د.ع</td>
        </tr>`;
        }

        return `
    <table style="width:100%;font-size:11px;border-collapse:collapse;border:1.5px solid #000;margin:2mm 0;color:#000;">
      <thead><tr style="background:#000;color:#fff;"><th colspan="2" style="padding:1.2mm;font-weight:900;border:1px solid #000;">بيانات التوصيل</th></tr></thead>
      <tbody>
        <tr><td style="width:35%;font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">الجهة</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">${esc(dl.partyName)}</td></tr>
        ${dl.address ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">العنوان</td><td style="font-weight:800;border:1px solid #000;padding:1mm 1.5mm;">${esc(dl.address)}</td></tr>` : ""}
        <tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">أجرة التوصيل</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">${shop ? "مجاناً" : fmt(fee.toFixed(2))}${facts.dead ? "" : ` (${who})`}</td></tr>
        ${customerDueRow}
      </tbody>
    </table>`;
      })()
    : "";

  const body = `<div class="compact-receipt" style="width:72mm;max-width:100%;margin:0 auto;overflow-wrap:anywhere">

  ${receiptHeaderHtml(d, barSvg)}
  ${
    d.revision
      ? `
  <table style="width:100%;border-collapse:collapse;border:2px solid #000;margin:2mm 0;font-size:10.5px;color:#000;">
    <thead><tr style="background:#000;color:#fff;"><th colspan="2" style="padding:1mm;font-weight:900;">فاتورة معدلة — بديلة عن: ${esc(d.revision.originalReceiptNumber)}</th></tr></thead>
    <tbody>
      <tr><td style="width:35%;font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">طلب التعديل</td><td style="font-weight:800;border:1px solid #000;padding:1mm 1.5mm;">${esc(d.revision.revisedByName)} — ${esc(d.revision.revisedAt)}</td></tr>
      ${d.revision.approvedByName ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">الاعتماد</td><td style="font-weight:800;border:1px solid #000;padding:1mm 1.5mm;">${esc(d.revision.approvedByName)}${d.revision.approvedAt ? ` — ${esc(d.revision.approvedAt)}` : ""}</td></tr>` : ""}
    </tbody>
  </table>`
      : ""
  }

  <table style="width:100%;font-size:11px;border-collapse:collapse;color:#000;table-layout:fixed;border:1.5px solid #000;margin:2mm 0;">
    <thead><tr style="background:#000;color:#fff;">
      <th style="text-align:right;padding:0.75mm 1mm;font-weight:900;font-size:11.5px;border:1px solid #000;">المنتج</th>
      <th style="text-align:center;padding:0.75mm 1mm;font-weight:900;font-size:11.5px;border:1px solid #000;width:9mm;">عدد</th>
      <th style="text-align:left;padding:0.75mm 1mm;font-weight:900;font-size:11.5px;border:1px solid #000;width:16mm;">السعر</th>
      <th style="text-align:left;padding:0.75mm 1mm;font-weight:900;font-size:11.5px;border:1px solid #000;width:18mm;">المبلغ</th>
    </tr></thead>
    <tbody>${itemRows}</tbody>
  </table>

  ${digitalHtml}

  ${facts.dead ? `<div style="font-weight:900">الحالة: ${esc(facts.statusLabel)}</div>` : ""}
  <!-- جدول الإجماليات والتفقيط -->
  <table style="width:100%;font-size:11px;border-collapse:collapse;border:1.5px solid #000;margin:2mm 0;color:#000;">
    <tbody>
      <tr><td style="width:55%;font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">المجموع</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(d.subtotal)}</td></tr>
      ${Number(d.discount ?? 0) > 0 ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">الخصم</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">-${fmt(d.discount)}</td></tr>` : ""}
      ${Number(d.tax ?? 0) > 0 ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">الضريبة</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(d.tax)}</td></tr>` : ""}
      ${d.cashRounding != null && Number(d.cashRounding) !== 0 ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">تقريب نقدي</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${Number(d.cashRounding) > 0 ? "+" : ""}${fmt(d.cashRounding)}</td></tr>` : ""}
      ${D(facts.returnedTotal).gt(0) ? `<tr><td style="border:1px solid #000;padding:1mm 1.5mm;">المرتجع</td><td dir="ltr" style="border:1px solid #000;padding:1mm 1.5mm;">${fmt(facts.returnedTotal)}</td></tr>` : ""}
      ${revised ? `<tr><td style="border:1px solid #000;padding:1mm 1.5mm;">القيمة الحالية للفاتورة</td><td dir="ltr" style="border:1px solid #000;padding:1mm 1.5mm;">${fmt(facts.currentTotal)}</td></tr>` : ""}
      <tr style="background:#000;color:#fff;font-weight:900;">
        <td style="border:1px solid #000;padding:1.5mm;font-size:13px;">${revised ? "الإجمالي الأصلي" : "الإجمالي النهائي"}</td>
        <td style="border:1px solid #000;padding:1.5mm;direction:ltr;text-align:left;font-size:15px;font-variant-numeric:tabular-nums;white-space:nowrap;">${fmt(d.total)} د.ع</td>
      </tr>
      <tr>
        <td colspan="2" style="text-align:center;font-weight:900;font-size:10px;padding:1.2mm;border:1px solid #000;">
          ${formatArabicMoneyWords(d.total)}
        </td>
      </tr>
      ${d.paymentMethod ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">طريقة الدفع</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">${formatPaymentMethodPrintHtml(d.paymentMethod, esc, { heightPx: 14 })}</td></tr>` : ""}
      ${d.paymentLegs && d.paymentLegs.length > 1 ? d.paymentLegs.map((leg) => `<tr><td style="font-weight:800;border:1px solid #000;padding:0.8mm 1.5mm;font-size:10.5px;">• ${formatPaymentMethodPrintHtml(`${leg.method}${leg.reference ? ` (${leg.reference})` : ""}`, esc, { heightPx: 12 })}</td><td style="font-weight:900;border:1px solid #000;padding:0.8mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;font-size:10.5px;">${fmt(leg.amount)}</td></tr>`).join("") : ""}
      ${d.paid != null ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">المبلغ المدفوع</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(d.paid)}</td></tr>` : ""}
      ${d.change != null ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">المبلغ المتبقي (الفكة)</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(d.change)}</td></tr>` : ""}
      ${Number(d.heldDeposits ?? 0) > 0 ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">عربون محتجز</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(d.heldDeposits)}</td></tr>` : ""}
      ${D(facts.remainingAmount).gt(0) ? `<tr style="border:2px solid #000;"><td style="font-weight:900;border:1px solid #000;padding:1.2mm 1.5mm;">${d.paymentMode === "COD" ? "المطلوب عند الاستلام (COD)" : "متبقٍّ (حساب آجل)"}</td><td style="font-weight:900;border:1px solid #000;padding:1.2mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(facts.remainingAmount)} د.ع</td></tr>` : ""}
    </tbody>
  </table>

  ${deliveryHtml}

  ${receiptFooterHtml(d)}</div>`;

  return wrapReceiptDoc(`إيصال ${d.receiptNumber}`, body);
}
