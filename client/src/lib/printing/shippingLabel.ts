/**
 * ملصق شحن بقياسٍ يحدّده المستخدم (الافتراضي ٨٠×١٢٠مم) — يُلصَق على الطرد قبل تسليمه للمندوب.
 *
 * يُطبع على طابعة ملصقات (Zebra/Xprinter عبر تعريف Windows) أو أي طابعة/PDF عبر نافذة المتصفّح
 * (`@page{size:<w>mm <h>mm}`). تصميم متّجه مباشر (HTML + SVG، بلا نقطية) مبنيّ على لوحة مرجعية
 * بعرض 100مم تُحجَّم موحَّداً بمعامل `عرض/100` (transform: scale) ⇒ نفس التسلسل البصري بأي قياس
 * وبحدّة كاملة (المتجهات تُحجَّم بلا فقد). فرق نسبة الارتفاع يمتصّه شريط الباركود المرن (flex:1).
 *
 * التسلسل الهرميّ (فلسفة الملصق التجاريّ): **المستلِم** أبرز كتلة (المندوب يحتاجه)، ثم **مبلغ COD**
 * بصندوقٍ ضخم (الأهمّ ماليّاً)، ثم **باركود Code128 + QR** لرقم الطلب (مسحٌ ⇒ ربط الطرد بالطلب بلا
 * إدخال يدوي، Poka-Yoke). كلّه أسود على أبيض بخطوطٍ ثقيلة وحدودٍ سميكة (آمنٌ للطباعة الحرارية).
 */
import { governorateById } from "@shared/governorates";
import { fmtDate as formatDate } from "../date";
import { code128Svg } from "./barcode";
import { qrCodeSvg } from "./qr";
import { CAIRO_FONT, CO, esc, fmt, logoUrl } from "./brand";
import { fmtQty } from "@shared/quantityFormat";
import { formatArabicMoneyWords } from "./tafqit";
import {
  DEFAULT_SHIPPING_LABEL_SIZE,
  getSavedShippingLabelSize,
  type ShippingLabelSize,
} from "./shippingLabelSize";

export interface ShippingLabelItem {
  productName: string;
  unitName: string;
  quantity: string;
}

export interface ShippingLabelData {
  orderNumber: string;
  /** القيمة المرمَّزة بالباركود (إن غابت: orderNumber). */
  barcodeValue?: string | null;
  customerName: string | null;
  customerPhone: string | null;
  governorate: string | null;
  addressText: string | null;
  latitude?: string | null;
  longitude?: string | null;
  notes?: string | null;
  /** مبلغ التحصيل عند الاستلام (COD) — إجمالي الطلب. */
  total: string;
  /** إجمالي سعر المنتجات/الخدمات قبل رسوم التوصيل. */
  subtotal?: string | null;
  /** رسوم التوصيل (يُضاف للـCOD عند تحصيله من المستلم). */
  shippingFee?: string | null;
  /** المبلغ المدفوع مسبقاً (عربون/دفعة أولى). */
  paidAmount?: string | null;
  /** الفاتورة المدفوعة بالكامل تُوسَم مدفوعة ولا تطلب من المندوب تحصيل صفرٍ «نقداً». */
  paymentState?: "COD" | "PREPAID";
  deliveryPartyName?: string | null;
  /** رقم التتبع أو مرجع إيصال شركة التوصيل (اختياري). */
  externalTrackingRef?: string | null;
  createdAt?: Date | string | null;
  items: ShippingLabelItem[];
  /** رابط عام موقّع للملصق؛ عند المسح يفتح ملخص الطلب بدلاً من نص باركود غير مفيد. */
  qrUrl?: string | null;
  isReprint?: boolean;
}

export function resolveShippingLabelQrTarget(
  o: Pick<ShippingLabelData, "orderNumber" | "qrUrl" | "latitude" | "longitude">,
  origin = typeof window !== "undefined" ? window.location.origin : "",
): string | null {
  if (o.latitude && o.longitude) {
    return `https://maps.google.com/?q=${encodeURIComponent(`${o.latitude},${o.longitude}`)}`;
  }
  if (o.qrUrl?.trim()) return o.qrUrl.trim();
  // توليد رابط تلقائي من رقم الطلب — يضمن دائماً وجود QR قابل للمسح
  if (o.orderNumber && origin) {
    return `${origin}/verify?ref=${encodeURIComponent(o.orderNumber)}`;
  }
  return null;
}

function fmtDate(d: Date | string | null | undefined): string {
  return d ? formatDate(d) : "";
}

/** يبني وثيقة HTML كاملة لملصق شحن بالقياس المطلوب (تُطبع تلقائياً بعد جهوز الخطّ). */
export async function shippingLabelHtml(
  o: ShippingLabelData,
  size: ShippingLabelSize = DEFAULT_SHIPPING_LABEL_SIZE,
): Promise<string> {
  const w = size.widthMm;
  const h = size.heightMm;
  const s = w / 100;
  const innerH = (h / s).toFixed(3);
  const govName = o.governorate ? governorateById(o.governorate)?.name ?? o.governorate : "";
  let barcode = "";
  try {
    barcode = code128Svg(o.barcodeValue || o.orderNumber, { moduleWidth: 2, height: 45, showText: false, fitToBox: true }).svg;
  } catch {
    barcode = "";
  }
  let qr = "";
  const hasMap = Boolean(o.latitude && o.longitude);
  try {
    const targetPayload = resolveShippingLabelQrTarget(o);
    if (targetPayload) qr = await qrCodeSvg(targetPayload, { margin: 1 });
  } catch {
    qr = "";
  }

  const itemCount = o.items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
  const isPrepaid = o.paymentState === "PREPAID";
  const logo = logoUrl();
  const isCompact = h <= 60;
  const isLandscape = !isCompact && w > h;

  // حساب سعة الأصناف ديناميكياً حسب الارتفاع المتاح لمنع تجاوز صفحة واحدة
  let maxItems = 2;
  if (isLandscape) {
    maxItems = h >= 90 ? 4 : 2;
  } else if (h >= 140) {
    maxItems = 10;
  } else if (h >= 115) {
    maxItems = 6;
  } else if (h >= 95) {
    maxItems = 4;
  }

  const displayItems = o.items.slice(0, maxItems);
  const remainingCount = o.items.length - maxItems;

  const itemsRows = displayItems.map((it) => `
    <tr>
      <td style="border:1px solid #000;text-align:center;font-weight:900;font-size:7pt;padding:0.25mm 0.5mm;width:10%;">[ &nbsp; ]</td>
      <td style="border:1px solid #000;font-weight:800;padding:0.25mm 0.6mm;font-size:6.8pt;line-height:1.15;">${esc(it.productName)}${it.unitName ? ` (${esc(it.unitName)})` : ""}</td>
      <td style="border:1px solid #000;text-align:center;font-weight:900;padding:0.25mm 0.5mm;font-size:7pt;direction:ltr;width:18%;font-variant-numeric:tabular-nums;">×${fmtQty(it.quantity)}</td>
    </tr>
  `).join("") + (remainingCount > 0 ? `
    <tr>
      <td style="border:1px solid #000;text-align:center;font-weight:900;font-size:6.5pt;padding:0.2mm;">[ &nbsp; ]</td>
      <td style="border:1px solid #000;font-weight:800;padding:0.2mm 0.6mm;font-size:6.5pt;" colspan="2">+ ${remainingCount} صنف إضافي في الفاتورة المرفقة</td>
    </tr>
  ` : "");

  const sharedCss = `
    @page{size:${w}mm ${h}mm;margin:0mm !important}
    html,body{
      width:${w}mm;
      height:${h}mm;
      max-width:${w}mm;
      max-height:${h}mm;
      margin:0 !important;
      padding:0 !important;
      overflow:hidden !important;
      background:#fff;
      color:#000;
      direction:rtl;
      page-break-after:avoid !important;
      page-break-inside:avoid !important;
      break-after:avoid !important;
      break-inside:avoid !important;
    }
    *{box-sizing:border-box;margin:0;padding:0;font-family:'Cairo',sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .lbl-container{
      width:${w}mm;
      height:${h}mm;
      max-width:${w}mm;
      max-height:${h}mm;
      box-sizing:border-box;
      padding:1mm 1.2mm;
      display:flex;
      flex-direction:column;
      justify-content:flex-start;
      gap:0;
      overflow:hidden !important;
      background:#fff;
      color:#000;
      direction:rtl;
      page-break-after:avoid !important;
      page-break-inside:avoid !important;
      break-after:avoid !important;
      break-inside:avoid !important;
    }
    table.grid{width:100%;border-collapse:collapse;border:1.5px solid #000;margin:0;color:#000;background:#fff;page-break-inside:avoid !important;break-inside:avoid !important}
    table.grid th,table.grid td{border:1px solid #000;padding:0.5mm 0.8mm;vertical-align:middle;page-break-inside:avoid !important;break-inside:avoid !important}
    .mono-logo{width:7.5mm;height:7.5mm;object-fit:contain;filter:grayscale(100%) contrast(1000%)}
    .bc-svg svg{width:100%;height:7mm;max-height:7.5mm;display:block}
    .qr-svg svg{width:100%;height:100%;display:block}

    @media print{
      @page{size:${w}mm ${h}mm;margin:0mm !important}
      html,body{
        width:${w}mm !important;
        height:${h}mm !important;
        max-width:${w}mm !important;
        max-height:${h}mm !important;
        margin:0 !important;
        padding:0 !important;
        overflow:hidden !important;
        page-break-after:avoid !important;
        page-break-inside:avoid !important;
        break-after:avoid !important;
        break-inside:avoid !important;
      }
      .lbl-container{
        width:${w}mm !important;
        height:${h}mm !important;
        max-height:${h}mm !important;
        padding:1mm !important;
        overflow:hidden !important;
        page-break-after:avoid !important;
        page-break-inside:avoid !important;
        break-after:avoid !important;
        break-inside:avoid !important;
      }
      *{page-break-inside:avoid !important;break-inside:avoid !important}
    }
  `;

  // 1. تخطيط بوليصة الشحن الطولية القياسية (80×120 أو 100×150)
  const portraitHtml = `
    <!-- 1. ترويسة المُرسِل ومدينة الوجهة -->
    <table class="grid" style="border-bottom:2px solid #000;">
      <tr>
        <td style="width:58%;border-left:1.5px solid #000;padding:0.6mm 0.8mm;">
          <div style="display:flex;align-items:center;gap:1mm;">
            <img src="${logo}" class="mono-logo" alt="" onerror="this.style.display='none'">
            <div>
              <div style="font-weight:900;font-size:8.5pt;line-height:1.1;">${esc(CO.short)}</div>
              <div style="font-weight:700;font-size:6pt;line-height:1.15;">${esc(CO.address)}</div>
              <div style="font-weight:900;font-size:6.8pt;direction:ltr;text-align:right;">${esc(CO.phones[1]?.n ?? CO.phones[0]?.n ?? "")}</div>
            </div>
          </div>
        </td>
        <td style="width:42%;text-align:center;background:#000;color:#fff;padding:0.6mm 0.8mm;">
          <div style="font-size:6pt;font-weight:800;line-height:1;">وجهة الشحنة</div>
          <div style="font-size:13.5pt;font-weight:900;line-height:1.15;letter-spacing:0.5px;">${esc(govName || "بغداد")}</div>
        </td>
      </tr>
    </table>

    <!-- 2. بيانات المستلِم -->
    <table class="grid" style="border-top:none;border-bottom:2px solid #000;">
      <tr>
        <td style="padding:0.8mm 1mm;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="background:#000;color:#fff;font-weight:900;font-size:6.5pt;padding:0.2mm 1.2mm;">المستلِم</span>
            <span style="font-weight:900;font-size:7pt;font-variant-numeric:tabular-nums;">رقم الطلب: #${esc(o.orderNumber)}</span>
          </div>
          <div style="font-size:11pt;font-weight:900;line-height:1.2;margin-top:0.3mm;word-break:break-word;">
            ${esc(o.customerName ?? "عميل")}
          </div>
          ${o.customerPhone ? `
            <div style="font-size:14pt;font-weight:900;line-height:1.15;letter-spacing:0.5px;font-variant-numeric:tabular-nums;direction:ltr;text-align:right;margin:0.2mm 0;">
              ${esc(o.customerPhone)}
            </div>
          ` : ""}
          <div style="font-size:7.2pt;font-weight:800;line-height:1.2;max-height:2.8em;overflow:hidden;">
            <b>العنوان:</b> ${esc(o.addressText || "—")}
          </div>
          ${o.notes ? `
            <div style="font-size:6.8pt;font-weight:900;border:1px solid #000;padding:0.3mm 0.6mm;margin-top:0.3mm;max-height:2.5em;overflow:hidden;">
              <b>ملاحظة المندوب:</b> ${esc(o.notes)}
            </div>
          ` : ""}
        </td>
      </tr>
    </table>

    <!-- 3. صندوق التحصيل المالي COD مع التفقيط -->
    <table class="grid" style="border-top:none;border-bottom:2px solid #000;">
      <tr>
        <td style="width:58%;border-left:1.5px solid #000;padding:0.6mm 0.8mm;background:${isPrepaid ? "#000" : "#fff"};color:${isPrepaid ? "#fff" : "#000"};">
          <div style="font-size:7.5pt;font-weight:900;">${isPrepaid ? "شحنة مدفوعة مسبقاً (PREPAID)" : "الدفع عند الاستلام (COD)"}</div>
          <div style="font-size:6pt;font-weight:800;margin-top:0.2mm;">${isPrepaid ? "لا يُحصَّل أي مبلغ نقدي من المستلم" : "تحصيل نقدي إلزامي قبل تسليم الطرد"}</div>
          ${!isPrepaid ? `<div style="font-size:6.2pt;font-weight:900;margin-top:0.3mm;border-top:1px dashed #000;padding-top:0.2mm;">${formatArabicMoneyWords(o.total)}</div>` : ""}
        </td>
        <td style="width:42%;text-align:center;padding:0.6mm 0.8mm;vertical-align:middle;">
          <div style="font-size:6pt;font-weight:800;">المبلغ المطلوب</div>
          <div style="font-size:15pt;font-weight:900;direction:ltr;font-variant-numeric:tabular-nums;line-height:1;">
            ${isPrepaid ? "0" : fmt(o.total)} <span style="font-size:8pt;font-weight:900;">د.ع</span>
          </div>
        </td>
      </tr>
    </table>

    <!-- 4. جدول فحص الأصناف والتجهيز (Pick & Pack) -->
    <table class="grid" style="border-top:none;border-bottom:2px solid #000;">
      <thead>
        <tr style="background:#000;color:#fff;font-size:6pt;">
          <th style="width:10%;border:1px solid #000;padding:0.3mm;text-align:center;">فحص</th>
          <th style="border:1px solid #000;padding:0.3mm 0.6mm;text-align:right;">محتويات الطرد (${itemCount} قطعة)</th>
          <th style="width:18%;border:1px solid #000;padding:0.3mm;text-align:center;">الكمية</th>
        </tr>
      </thead>
      <tbody>
        ${itemsRows || `<tr><td colspan="3" style="text-align:center;font-size:6.8pt;padding:0.5mm;">—</td></tr>`}
      </tbody>
    </table>

    <!-- 5. باركود التتبع عالي الدقة -->
    <table class="grid" style="border-top:none;border-bottom:2px solid #000;">
      <tr>
        <td style="padding:0.6mm 0.8mm;text-align:center;">
          ${barcode ? `<div class="bc-svg">${barcode}</div>` : ""}
          <div style="font-size:8.5pt;font-weight:900;letter-spacing:1px;font-variant-numeric:tabular-nums;margin-top:0.2mm;">
            ${esc(o.orderNumber)}${o.isReprint ? " [ إعادة طباعة ]" : ""}
          </div>
        </td>
      </tr>
    </table>

    <!-- 6. كود QR للملاحة، بيانات الشحن، وتوقيع الاستلام -->
    <table class="grid" style="border-top:none;">
      <tr>
        <td style="width:16mm;border-left:1.5px solid #000;padding:0.5mm;text-align:center;vertical-align:middle;">
          ${qr ? `<div class="qr-svg" style="width:13mm;height:13mm;margin:0 auto;">${qr}</div>` : ""}
          <div style="font-size:5pt;font-weight:900;margin-top:0.2mm;">${hasMap ? "خرائط Google" : "تتبع الشحنة"}</div>
        </td>
        <td style="border-left:1.5px solid #000;padding:0.5mm 0.8mm;vertical-align:top;font-size:6.2pt;line-height:1.2;">
          <div><b>التاريخ:</b> ${esc(fmtDate(o.createdAt))}</div>
          <div><b>شركة الشحن:</b> ${esc(o.deliveryPartyName || "توصيل داخلي")}</div>
          ${o.externalTrackingRef ? `<div><b>المرجع:</b> <span dir="ltr" style="font-weight:900;font-family:monospace">${esc(o.externalTrackingRef)}</span></div>` : ""}
          ${hasMap ? `<div style="font-size:5.8pt;font-weight:800;margin-top:0.2mm;">إحداثيات: <span dir="ltr">${esc(String(o.latitude).slice(0, 8))},${esc(String(o.longitude).slice(0, 8))}</span></div>` : ""}
        </td>
        <td style="width:18mm;padding:0.5mm;text-align:center;vertical-align:top;font-size:5.8pt;">
          <div style="font-weight:900;margin-bottom:3.5mm;">توقيع المستلِم</div>
          <div style="border-top:1px solid #000;padding-top:0.2mm;font-weight:800;">الاستلام والتاريخ</div>
        </td>
      </tr>
    </table>
  `;

  // 2. تخطيط بوليصة الشحن العرضية (120×80) بتنظيم شبكي مزدوج
  const landscapeHtml = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.2mm;height:100%;">
      <!-- العمود الأيمن: الترويسة، المستلم، والتحصيل المالي -->
      <div style="display:flex;flex-direction:column;justify-content:space-between;">
        <table class="grid" style="border-bottom:2px solid #000;">
          <tr>
            <td style="width:58%;border-left:1.5px solid #000;padding:0.8mm;">
              <div style="display:flex;align-items:center;gap:1mm;">
                <img src="${logo}" class="mono-logo" alt="" onerror="this.style.display='none'">
                <div>
                  <div style="font-weight:900;font-size:8.5pt;line-height:1.1;">${esc(CO.short)}</div>
                  <div style="font-weight:700;font-size:6pt;line-height:1.15;">${esc(CO.address)}</div>
                </div>
              </div>
            </td>
            <td style="width:42%;text-align:center;background:#000;color:#fff;padding:0.8mm;">
              <div style="font-size:6pt;font-weight:800;">وجهة الشحنة</div>
              <div style="font-size:12pt;font-weight:900;line-height:1.1;">${esc(govName || "بغداد")}</div>
            </td>
          </tr>
        </table>

        <table class="grid" style="border-top:none;border-bottom:2px solid #000;margin-top:0.8mm;">
          <tr>
            <td style="padding:1mm;vertical-align:top;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span style="background:#000;color:#fff;font-weight:900;font-size:6.5pt;padding:0.2mm 1.2mm;">المستلِم</span>
                <span style="font-weight:900;font-size:7pt;">#${esc(o.orderNumber)}</span>
              </div>
              <div style="font-size:11pt;font-weight:900;line-height:1.15;margin-top:0.3mm;">
                ${esc(o.customerName ?? "عميل")}
              </div>
              ${o.customerPhone ? `
                <div style="font-size:13pt;font-weight:900;letter-spacing:0.5px;font-variant-numeric:tabular-nums;direction:ltr;text-align:right;margin:0.3mm 0;">
                  ${esc(o.customerPhone)}
                </div>
              ` : ""}
              <div style="font-size:7.5pt;font-weight:800;line-height:1.2;">
                <b>العنوان:</b> ${esc(o.addressText || "—")}
              </div>
              ${o.notes ? `
                <div style="font-size:6.8pt;font-weight:900;border:1px solid #000;padding:0.4mm 0.8mm;margin-top:0.3mm;">
                  <b>الملاحظة:</b> ${esc(o.notes)}
                </div>
              ` : ""}
            </td>
          </tr>
        </table>

        <table class="grid" style="border-top:none;margin-top:0.8mm;">
          <tr>
            <td style="width:55%;border-left:1.5px solid #000;padding:0.8mm;background:${isPrepaid ? "#000" : "#fff"};color:${isPrepaid ? "#fff" : "#000"};">
              <div style="font-size:7.5pt;font-weight:900;">${isPrepaid ? "مدفوع مسبقاً (PREPAID)" : "الدفع عند الاستلام (COD)"}</div>
              <div style="font-size:6pt;font-weight:800;">${isPrepaid ? "لا يُحصَّل أي مبلغ" : "تحصيل نقدي إلزامي"}</div>
              ${!isPrepaid ? `<div style="font-size:6.5pt;font-weight:900;margin-top:0.3mm;border-top:1px dashed #000;">${formatArabicMoneyWords(o.total)}</div>` : ""}
            </td>
            <td style="width:45%;text-align:center;padding:0.8mm;vertical-align:middle;">
              <div style="font-size:6.5pt;font-weight:800;">المبلغ المطلوب</div>
              <div style="font-size:15pt;font-weight:900;direction:ltr;font-variant-numeric:tabular-nums;line-height:1;">
                ${isPrepaid ? "0" : fmt(o.total)} <span style="font-size:8pt;">د.ع</span>
              </div>
            </td>
          </tr>
        </table>
      </div>

      <!-- العمود الأيسر: جدول الأصناف، الباركود، والكيو آر مع التوقيع -->
      <div style="display:flex;flex-direction:column;justify-content:space-between;">
        <table class="grid" style="border-bottom:2px solid #000;">
          <thead>
            <tr style="background:#000;color:#fff;font-size:6.5pt;">
              <th style="width:10%;border:1px solid #000;padding:0.4mm;text-align:center;">فحص</th>
              <th style="border:1px solid #000;padding:0.4mm 0.8mm;text-align:right;">الأصناف (${itemCount} قطعة)</th>
              <th style="width:18%;border:1px solid #000;padding:0.4mm;text-align:center;">الكمية</th>
            </tr>
          </thead>
          <tbody>
            ${itemsRows || `<tr><td colspan="3" style="text-align:center;font-size:7pt;padding:0.6mm;">—</td></tr>`}
          </tbody>
        </table>

        <table class="grid" style="border-top:none;border-bottom:2px solid #000;margin-top:0.8mm;">
          <tr>
            <td style="padding:0.6mm 0.8mm;text-align:center;">
              ${barcode ? `<div class="bc-svg">${barcode}</div>` : ""}
              <div style="font-size:8.5pt;font-weight:900;letter-spacing:1px;font-variant-numeric:tabular-nums;">
                ${esc(o.orderNumber)}${o.isReprint ? " [ إعادة طباعة ]" : ""}
              </div>
            </td>
          </tr>
        </table>

        <table class="grid" style="border-top:none;margin-top:0.8mm;">
          <tr>
            <td style="width:17mm;border-left:1.5px solid #000;padding:0.6mm;text-align:center;vertical-align:middle;">
              ${qr ? `<div class="qr-svg" style="width:14mm;height:14mm;margin:0 auto;">${qr}</div>` : ""}
              <div style="font-size:5.5pt;font-weight:900;">${hasMap ? "خرائط Google" : "تتبع الشحنة"}</div>
            </td>
            <td style="border-left:1.5px solid #000;padding:0.8mm;vertical-align:top;font-size:6.5pt;line-height:1.25;">
              <div><b>التاريخ:</b> ${esc(fmtDate(o.createdAt))}</div>
              <div><b>الشحن:</b> ${esc(o.deliveryPartyName || "توصيل")}</div>
              ${o.externalTrackingRef ? `<div><b>المرجع:</b> <span dir="ltr" style="font-weight:900;">${esc(o.externalTrackingRef)}</span></div>` : ""}
            </td>
            <td style="width:18mm;padding:0.6mm;text-align:center;vertical-align:top;font-size:6pt;">
              <div style="font-weight:900;margin-bottom:3.5mm;">استلام الزبون</div>
              <div style="border-top:1px solid #000;padding-top:0.2mm;font-weight:800;">التوقيع</div>
            </td>
          </tr>
        </table>
      </div>
    </div>
  `;

  // 3. تخطيط ملصق الطرود الصغير المدمج (80×50)
  const compactHtml = `
    <!-- الترويسة والمحافظة -->
    <table class="grid" style="border-bottom:1.5px solid #000;">
      <tr>
        <td style="width:62%;border-left:1.5px solid #000;padding:0.6mm 0.8mm;">
          <div style="display:flex;align-items:center;gap:1mm;">
            <img src="${logo}" class="mono-logo" alt="" style="width:6.5mm;height:6.5mm;" onerror="this.style.display='none'">
            <div>
              <div style="font-weight:900;font-size:8pt;line-height:1;">${esc(CO.short)}</div>
              <div style="font-weight:700;font-size:5.8pt;line-height:1.1;">${esc(CO.phones[1]?.n ?? CO.phones[0]?.n ?? "")}</div>
            </div>
          </div>
        </td>
        <td style="width:38%;text-align:center;background:#000;color:#fff;padding:0.6mm;">
          <div style="font-size:5.5pt;font-weight:800;line-height:1;">وجهة الشحنة</div>
          <div style="font-size:11pt;font-weight:900;line-height:1.1;">${esc(govName || "بغداد")}</div>
        </td>
      </tr>
    </table>

    <!-- المستلم والهاتف والعنوان -->
    <table class="grid" style="border-top:none;border-bottom:1.5px solid #000;">
      <tr>
        <td style="padding:0.8mm;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:900;font-size:9.5pt;">${esc(o.customerName ?? "عميل")}</span>
            <span style="font-weight:900;font-size:11pt;direction:ltr;font-variant-numeric:tabular-nums;">${esc(o.customerPhone || "")}</span>
          </div>
          <div style="font-size:6.8pt;font-weight:800;line-height:1.15;margin-top:0.2mm;">
            <b>العنوان:</b> ${esc(o.addressText || "—")}
          </div>
        </td>
      </tr>
    </table>

    <!-- المبلغ والباركود والكيو آر في شبكة ثلاثية -->
    <table class="grid" style="border-top:none;">
      <tr>
        <td style="width:36%;border-left:1.5px solid #000;padding:0.6mm 0.8mm;text-align:center;vertical-align:middle;background:${isPrepaid ? "#000" : "#fff"};color:${isPrepaid ? "#fff" : "#000"};">
          <div style="font-size:5.8pt;font-weight:800;">${isPrepaid ? "مدفوع مسبقاً" : "المطلوب عند الاستلام"}</div>
          <div style="font-size:12.5pt;font-weight:900;direction:ltr;font-variant-numeric:tabular-nums;line-height:1;">
            ${isPrepaid ? "0" : fmt(o.total)} <span style="font-size:7pt;">د.ع</span>
          </div>
          ${!isPrepaid ? `<div style="font-size:5.2pt;font-weight:900;margin-top:0.2mm;">${formatArabicMoneyWords(o.total)}</div>` : ""}
        </td>
        <td style="border-left:1.5px solid #000;padding:0.4mm 0.6mm;text-align:center;vertical-align:middle;">
          ${barcode ? `<div class="bc-svg" style="height:6.5mm;">${barcode}</div>` : ""}
          <div style="font-size:6.8pt;font-weight:900;letter-spacing:0.5px;">#${esc(o.orderNumber)}</div>
        </td>
        <td style="width:13mm;padding:0.4mm;text-align:center;vertical-align:middle;">
          ${qr ? `<div class="qr-svg" style="width:11mm;height:11mm;margin:0 auto;">${qr}</div>` : ""}
        </td>
      </tr>
    </table>
  `;

  const selectedBody = isCompact ? compactHtml : isLandscape ? landscapeHtml : portraitHtml;

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ملصق شحن ${esc(o.orderNumber)} (${w}×${h}مم)</title>
${CAIRO_FONT}
<style>${sharedCss}</style></head>
<body>
  <div class="lbl-container">
    ${selectedBody}
  </div>
  <script>
    window.addEventListener('load', function () {
      var ready = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
      ready.then(function () { setTimeout(function () { window.print(); }, 80); });
    });
    window.addEventListener('afterprint', function () { window.close(); });
  </script>
</body></html>`;
}

/** يفتح نافذة الملصق **متزامناً مع إيماءة النقر** (قبل أي await) بمحتوى انتظار مؤقّت —
 *  مانع النوافذ المنبثقة يسمح فقط بما فُتح داخل مكدّس نداء الإيماءة، وأيّ await قبله
 *  (طلب شبكة/توليد QR) يُفقده الإيماءة على Safari والمتصفّحات المتشدّدة (مراجعة Codex PR #185).
 *  مرّر الناتج لـ`printShippingLabel({ into })` ليُملأ بعد جهوز البيانات. */
export function preopenShippingLabelWindow(size?: ShippingLabelSize): Window | null {
  if (typeof window === "undefined") return null;
  const effective = size ?? getSavedShippingLabelSize();
  // نافذة المعاينة تحاكي نسبة الملصق (لا تؤثّر على @page الفعلية).
  const winH = Math.round(460 * (effective.heightMm / effective.widthMm)) + 120;
  const w = window.open("", "_blank", `width=460,height=${Math.min(winH, 900)}`);
  if (w) {
    try {
      w.document.write(
        `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ملصق الشحن</title></head>` +
        `<body style="font-family:sans-serif;padding:2rem;color:#444">جارٍ تجهيز ملصق الشحن…</body></html>`,
      );
    } catch { /* نافذة بلا وثيقة قابلة للكتابة — تُملأ لاحقاً */ }
  }
  return w;
}

/** يطبع ملصق شحن عبر نافذة المتصفّح (طابعة الملصقات بتعريف Windows أو PDF) بالقياس المُمرَّر،
 *  أو بالقياس المحفوظ في الإعداد المشترك (الافتراضي ٨٠×١٢٠مم) إن لم يُمرَّر.
 *  تُفتَح النافذة **قبل** بناء المحتوى (متزامنة مع إيماءة النقر عند النداء المباشر منها)؛
 *  وعند النداء بعد await (كتأكيد الإرسال) مرّر نافذةً سبق فتحها عبر `into` من `preopenShippingLabelWindow`.
 *  يعيد `{ ok }` — false إن حُجبت النافذة المنبثقة (ليُبلَّغ المستخدم). */
export async function printShippingLabel(
  o: ShippingLabelData,
  opts?: { size?: ShippingLabelSize; into?: Window | null },
): Promise<{ ok: boolean }> {
  const effective = opts?.size ?? getSavedShippingLabelSize();
  // `into` مُمرَّرة (ولو null = حُجبت عند الفتح المسبق) ⇒ لا نفتح ثانية؛ غيابها ⇒ افتح الآن فوراً.
  const win = opts && "into" in opts ? opts.into : preopenShippingLabelWindow(effective);
  const html = await shippingLabelHtml(o, effective);
  if (!win || win.closed) return { ok: false };
  try {
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
