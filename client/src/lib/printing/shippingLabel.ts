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
import { code128Svg } from "./barcode";
import { qrCodeSvg } from "./qr";
import { CAIRO_FONT, CO, esc, fmt } from "./brand";
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
  customerName: string | null;
  customerPhone: string | null;
  governorate: string | null;
  addressText: string | null;
  /** مبلغ التحصيل عند الاستلام (COD) — إجمالي الطلب. */
  total: string;
  deliveryPartyName?: string | null;
  createdAt?: Date | string | null;
  items: ShippingLabelItem[];
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  try {
    const dt = typeof d === "string" ? new Date(d) : d;
    return dt.toLocaleDateString("en-GB");
  } catch {
    return "";
  }
}

/** يبني وثيقة HTML كاملة لملصق شحن بالقياس المطلوب (تُطبع تلقائياً بعد جهوز الخطّ). */
export async function shippingLabelHtml(
  o: ShippingLabelData,
  size: ShippingLabelSize = DEFAULT_SHIPPING_LABEL_SIZE,
): Promise<string> {
  // اللوحة المرجعية بعرض 100مم؛ نُحجّمها موحَّداً لعرض الملصق، والارتفاع الداخلي = h/s
  // بحيث يملأ الملصق كاملاً بعد التحجيم (المرونة الرأسية في شريط الباركود).
  const w = size.widthMm;
  const h = size.heightMm;
  const s = w / 100;
  const innerH = (h / s).toFixed(3);
  const govName = o.governorate ? governorateById(o.governorate)?.name ?? o.governorate : "";
  let barcode = "";
  try {
    barcode = code128Svg(o.orderNumber, { moduleWidth: 2, height: 80, showText: false, fitToBox: true }).svg;
  } catch {
    barcode = "";
  }
  let qr = "";
  try {
    qr = await qrCodeSvg(o.orderNumber, { margin: 0 });
  } catch {
    qr = "";
  }
  const itemCount = o.items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
  const contents = o.items
    .map((it) => `${it.productName}${it.unitName ? ` (${it.unitName})` : ""} ×${fmt(it.quantity)}`)
    .join(" · ");

  const addressLine = [govName, o.addressText].filter(Boolean).join(" — ");

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ملصق شحن ${esc(o.orderNumber)} (${w}×${h}مم)</title>
${CAIRO_FONT}
<style>
  html,body{margin:0;padding:0;background:#fff;color:#000}
  @page{size:${w}mm ${h}mm;margin:0}
  *{box-sizing:border-box;margin:0;padding:0;font-family:'Cairo',sans-serif}
  /* صفحة الملصق الفعلية: إطارٌ بقياس الطلب يحوي اللوحة المرجعية 100مم مُحجَّمة بمعامل ${s} */
  .pg{position:relative;width:${w}mm;height:${h}mm;overflow:hidden;background:#fff}
  .lb{position:absolute;top:0;right:0;transform:scale(${s});transform-origin:top right;
    width:100mm;height:${innerH}mm;padding:3mm;display:flex;flex-direction:column;color:#000;background:#fff;direction:rtl}
  .row{display:flex;align-items:center;justify-content:space-between;gap:2mm}
  /* ترويسة المُرسِل */
  .from{display:flex;align-items:flex-start;justify-content:space-between;gap:2mm;padding-bottom:1.5mm;border-bottom:2px solid #000}
  .from-co{font-weight:900;font-size:11pt;line-height:1.1}
  .from-sub{font-weight:600;font-size:7.5pt;line-height:1.25}
  .from-r{text-align:left;font-weight:800;font-size:7.5pt;line-height:1.3;white-space:nowrap}
  /* المستلِم */
  .to{padding:2mm 0;border-bottom:2px solid #000}
  .to-tag{display:inline-block;background:#000;color:#fff;font-weight:900;font-size:8pt;padding:0.4mm 2mm;border-radius:1mm;margin-bottom:1mm}
  .to-name{font-weight:900;font-size:17pt;line-height:1.1;word-break:break-word}
  .to-phone{font-weight:900;font-size:15pt;line-height:1.15;letter-spacing:0.5px;font-variant-numeric:tabular-nums;direction:ltr;text-align:right}
  .to-gov{font-weight:900;font-size:12pt;margin-top:0.5mm}
  .to-addr{font-weight:600;font-size:10.5pt;line-height:1.25;margin-top:0.5mm;
    display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
  /* صندوق COD */
  .cod{margin:2mm 0;border:3px solid #000;border-radius:1.5mm;padding:1.5mm 2mm;display:flex;align-items:center;justify-content:space-between;gap:2mm}
  .cod-l{font-weight:900;font-size:9.5pt;line-height:1.15}
  .cod-l small{display:block;font-weight:700;font-size:7pt}
  .cod-v{font-weight:900;font-size:26pt;line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums;direction:ltr}
  .cod-v u{text-decoration:none;font-size:12pt;font-weight:800;margin-inline-start:1mm}
  /* الباركود */
  .bc{flex:1 1 auto;display:flex;flex-direction:column;align-items:stretch;justify-content:center;min-height:0;gap:0.5mm}
  .bc-svg{flex:1 1 auto;min-height:12mm;display:flex;align-items:center;justify-content:center}
  .bc-svg svg{width:100%;height:100%;display:block}
  .bc-no{text-align:center;font-weight:900;font-size:14pt;letter-spacing:1px;font-variant-numeric:tabular-nums}
  /* التذييل: QR + بيانات + المحتويات */
  .ft{display:flex;align-items:stretch;gap:2mm;padding-top:1.5mm;border-top:2px solid #000}
  .ft-qr{width:18mm;height:18mm;flex:0 0 auto}
  .ft-qr svg{width:100%;height:100%;display:block}
  .ft-info{flex:1 1 auto;min-width:0;font-size:8pt;line-height:1.3}
  .ft-info b{font-weight:900}
  .ft-c{margin-top:0.8mm;font-weight:600;font-size:7.5pt;line-height:1.2;
    display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
</style></head>
<body>
  <div class="pg">
  <div class="lb">
    <div class="from">
      <div>
        <div class="from-co">${esc(CO.short)}</div>
        <div class="from-sub">${esc(CO.subtitle)} — ${esc(CO.address)}</div>
      </div>
      <div class="from-r">المُرسِل<br>${esc(CO.phones[1]?.n ?? CO.phones[0]?.n ?? "")}</div>
    </div>

    <div class="to">
      <span class="to-tag">المستلِم</span>
      <div class="row" style="align-items:flex-start">
        <div class="to-name" style="flex:1 1 auto">${esc(o.customerName ?? "زبون")}</div>
        ${o.customerPhone ? `<div class="to-phone">${esc(o.customerPhone)}</div>` : ""}
      </div>
      ${govName ? `<div class="to-gov">${esc(govName)}</div>` : ""}
      ${o.addressText ? `<div class="to-addr">${esc(o.addressText)}</div>` : ""}
    </div>

    <div class="cod">
      <div class="cod-l">الدفع عند الاستلام<small>COD — تُحصَّل نقداً</small></div>
      <div class="cod-v">${esc(fmt(o.total))}<u>د.ع</u></div>
    </div>

    <div class="bc">
      ${barcode ? `<div class="bc-svg">${barcode}</div>` : ""}
      <div class="bc-no">${esc(o.orderNumber)}</div>
    </div>

    <div class="ft">
      ${qr ? `<div class="ft-qr">${qr}</div>` : ""}
      <div class="ft-info">
        <div><b>التاريخ:</b> ${esc(fmtDate(o.createdAt))} &nbsp; <b>الأصناف:</b> ${itemCount}</div>
        ${o.deliveryPartyName ? `<div><b>المندوب:</b> ${esc(o.deliveryPartyName)}</div>` : ""}
        <div class="ft-c"><b>المحتويات:</b> ${esc(contents || "—")}</div>
      </div>
    </div>
  </div>
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
