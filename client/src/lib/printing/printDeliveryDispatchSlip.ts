/**
 * بوليصة إسناد وتوصيل حرارية (80mm) — ترافق المندوب وتُسلَّم للزبون
 * تشمل تفاصيل الطلب، الباركود، المستلم، والمبلغ المطلوب تحصيله (COD) بدقة.
 */
import { BRAND as B, CO, esc, fmt, logoUrl, openPrintWindow } from "./brand";
import { wrapReceiptDoc } from "./docHtml";
import { code128Svg } from "./barcode";
import { qrCodeSvgSync } from "./qr";
import { fmtDateTime } from "../date";

export interface DispatchSlipData {
  consignmentNumber: string;
  orderNumber: string;
  orderKind?: "workOrder" | "invoice";
  partyName: string;
  recipientName: string;
  recipientPhone: string;
  deliveryAddress: string;
  governorate?: string | null;
  salePrice: string;
  deposit?: string | null;
  codAmount: string; // المبلغ الصافي المطلوب تحصيله من الزبون عند الباب
  deliveryFee?: string | null;
  feeCollection?: "COURIER" | "COUNTER" | "SHOP";
  title?: string | null;
  notes?: string | null;
  dispatchedAt?: Date | string;
}

export function printDeliveryDispatchSlip(d: DispatchSlipData): boolean {
  const logo = logoUrl();
  let barSvg = "";
  try {
    const bc = code128Svg(d.consignmentNumber, { moduleWidth: 1.35, height: 48, showText: true });
    barSvg = bc.svg;
  } catch {
    /* بلا باركود عند تعذر التوليد */
  }

  const qrPayload = d.consignmentNumber
    ? `https://alarabiya.online/track/${encodeURIComponent(d.consignmentNumber)}`
    : `ORD:${d.orderNumber}`;
  const qrSvg = qrCodeSvgSync(qrPayload, { size: 125, margin: 1 });

  const codNum = Number(d.codAmount || 0);
  const feeNum = Number(d.deliveryFee || 0);
  const shopFee = d.feeCollection === "SHOP";
  const courierFee = d.feeCollection === "COURIER";
  const counterFee = d.feeCollection === "COUNTER";

  // إجمالي ما يدفعه الزبون عند الباب:
  // إذا كانت الأجرة على المندوب (COURIER)، يقبض COD + الأجرة.
  // إذا كانت الأجرة مقبوضة مسبقاً (COUNTER) أو مجاناً على المحل (SHOP)، يدفع فقط COD.
  const totalToCollectFromCustomer = courierFee ? codNum + feeNum : codNum;

  const feeExplanation = shopFee
    ? "على المكتبة (مجاناً للزبون)"
    : counterFee
    ? "مقبوضة مسبقاً في المحل"
    : "يقبضها المندوب من الزبون";

  const body = `
  <div style="text-align:center;margin-bottom:2mm;">
    ${logo ? `<img src="${logo}" style="height:44px;margin-bottom:1.5mm;" onerror="this.style.display='none'">` : ""}
    <div style="font-size:15px;font-weight:900;color:#000;">${esc(CO.name)}</div>
    <div style="font-size:11px;font-weight:800;color:#000;">${esc(CO.sub)}</div>
  </div>

  <div style="border-top:2.5px solid #000;border-bottom:2.5px solid #000;padding:2mm 0;text-align:center;margin:2.5mm 0;background:#000;color:#fff;">
    <span style="font-size:14px;font-weight:900;letter-spacing:0.5px;">بوليصة إسناد وتوصيل</span>
  </div>

  ${barSvg ? `
  <div style="text-align:center;margin:3mm 0;overflow:hidden;">
    <div style="display:inline-block;max-width:100%;">${barSvg}</div>
  </div>` : ""}

  <div style="margin:2.5mm 0;font-size:11px;color:#000;">
    <div style="display:flex;justify-content:space-between;padding:1mm 0;border-bottom:1.5px dashed #000;">
      <span style="font-weight:800;">رقم الإرسالية:</span>
      <span style="font-weight:900;direction:ltr;font-size:12px;">${esc(d.consignmentNumber)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:1mm 0;border-bottom:1.5px dashed #000;">
      <span style="font-weight:800;">رقم ${d.orderKind === "invoice" ? "الفاتورة" : "الطلب"}:</span>
      <span style="font-weight:900;font-size:12px;">#${esc(d.orderNumber)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:1mm 0;border-bottom:1.5px dashed #000;">
      <span style="font-weight:800;">جهة التوصيل:</span>
      <span style="font-weight:900;">${esc(d.partyName)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:1mm 0;border-bottom:1.5px dashed #000;">
      <span style="font-weight:800;">تاريخ الإسناد:</span>
      <span style="font-weight:800;">${fmtDateTime(d.dispatchedAt ?? new Date())}</span>
    </div>
  </div>

  <!-- بيانات المستلم -->
  <div style="margin:3mm 0;border:2px solid #000;border-radius:5px;padding:2.5mm;background:#fff;color:#000;">
    <div style="text-align:center;font-weight:900;font-size:12px;margin-bottom:1.5mm;border-bottom:2px solid #000;padding-bottom:1mm;background:#f0f0f0;">
      بيانات المستلم
    </div>
    <div style="font-size:12px;font-weight:900;margin-bottom:1mm;">👤 ${esc(d.recipientName || "—")}</div>
    <div style="font-size:13px;font-weight:900;direction:ltr;text-align:right;margin-bottom:1.5mm;letter-spacing:0.3px;">
      📞 ${esc(d.recipientPhone || "—")}
    </div>
    <div style="font-size:11px;font-weight:800;color:#000;line-height:1.4;">
      📍 ${esc(d.deliveryAddress || "العنوان غير محدد")}
      ${d.governorate ? ` (${esc(d.governorate)})` : ""}
    </div>
  </div>

  <!-- الحسابات والمبالغ -->
  <div style="margin:3mm 0;border:2px solid #000;border-radius:5px;padding:2.5mm;background:#fff;color:#000;">
    <div style="display:flex;justify-content:space-between;font-size:11px;padding:0.8mm 0;">
      <span style="font-weight:800;">قيمة الطلب:</span>
      <span style="font-weight:900;">${fmt(d.salePrice)} د.ع</span>
    </div>
    ${Number(d.deposit || 0) > 0 ? `
    <div style="display:flex;justify-content:space-between;font-size:11px;padding:0.8mm 0;font-weight:900;">
      <span>المدفوع مسبقاً (عربون):</span>
      <span>- ${fmt(d.deposit!)} د.ع</span>
    </div>` : ""}

    <div style="display:flex;justify-content:space-between;font-size:11px;padding:0.8mm 0;border-top:1.5px dashed #000;margin-top:1mm;padding-top:1mm;">
      <span style="font-weight:800;">أجرة التوصيل:</span>
      <span style="font-weight:900;">${feeNum > 0 ? `${fmt(feeNum)} د.ع` : "مجاناً"}</span>
    </div>
    <div style="font-size:10px;font-weight:800;color:#000;text-align:left;margin-bottom:1.5mm;">(${feeExplanation})</div>

    <!-- المبلغ المطلوب عند الباب -->
    <div style="border-top:2.5px solid #000;margin-top:2mm;padding-top:2mm;text-align:center;background:#f5f5f5;border-radius:4px;padding-bottom:1.5mm;">
      <div style="font-size:11.5px;font-weight:900;color:#000;">المطلوب تحصيله من الزبون عند الاستلام</div>
      <div style="font-size:20px;font-weight:900;color:#000;margin-top:1mm;letter-spacing:0.5px;">
        ${fmt(totalToCollectFromCustomer)} د.ع
      </div>
    </div>
  </div>

  ${d.notes ? `
  <div style="margin:2.5mm 0;font-size:10.5px;font-weight:800;border:1.5px dashed #000;padding:2mm;border-radius:4px;background:#fafafa;">
    <b>ملاحظات التوصيل:</b> ${esc(d.notes)}
  </div>` : ""}

  <!-- رمز QR عريض وفائق الوضوح للتحقق والمسح السريع -->
  <div style="text-align:center;margin:3.5mm 0 2mm 0;border:2px solid #000;border-radius:5px;padding:2.5mm;background:#fff;">
    <div style="font-weight:900;font-size:11px;margin-bottom:1.5mm;color:#000;">
      رمز التحقق والتتبع السريع (QR)
    </div>
    <div style="display:inline-block;padding:2px;background:#fff;">
      ${qrSvg}
    </div>
    <div style="font-size:9.5px;font-weight:800;color:#000;margin-top:1.5mm;">
      امسح الرمز بكاميرا الهاتف لمتابعة حالة الطرد
    </div>
  </div>

  <!-- التواقيع -->
  <div style="margin-top:4mm;display:flex;justify-content:space-between;font-size:11px;font-weight:900;border-top:2px dashed #000;padding-top:2.5mm;">
    <div style="text-align:center;width:48%;">
      <div>توقيع واستلام المندوب</div>
      <div style="height:9mm;"></div>
      <div style="border-top:1.5px solid #000;margin:0 3mm;"></div>
    </div>
    <div style="text-align:center;width:48%;">
      <div>توقيع واستلام الزبون</div>
      <div style="height:9mm;"></div>
      <div style="border-top:1.5px solid #000;margin:0 3mm;"></div>
    </div>
  </div>

  <div style="margin-top:3.5mm;text-align:center;font-size:10px;font-weight:800;color:#000;border-top:1.5px solid #000;padding-top:2mm;line-height:1.4;">
    يرجى التأكد من محتويات الطرد ومطابقة المبلغ قبل الاستلام.<br>
    ${CO.phones.length > 0 ? `خدمة العملاء: ${CO.phones[0].n}` : ""}
  </div>
  `;

  const html = wrapReceiptDoc(`بوليصة ${d.consignmentNumber}`, body);
  return openPrintWindow(html);
}
