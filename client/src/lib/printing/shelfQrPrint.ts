/**
 * مولّد ومُخرج طباعة ملصقات وبوسترات QR للرفوف الذكية.
 *
 * يدعم 4 قوالب قياسية لمعارض التجزئة:
 *  1. shelf-strip: ملصق حافة الرف الفردي (60×35 مم) — للطابعات الحرارية أو قص الملصقات.
 *  2. a4-sheet: شيت ملصقات A4 مجمّع (24 ملصق 3×8) للطباعة على ورق لاصق مقسّم.
 *  3. table-stand: بطاقة ستاند الأكريليك للطاولات والمنصات (A5).
 *  4. poster-a4: لافتة إرشادية جدارية لمداخل الممرات والأقسام (A4).
 *
 * خالي تماماً من الإيموجي ويستخدم خط Cairo المحلي والرموز الخطية النظيفة.
 */
import { BRAND, CO, CAIRO_FONT, esc, openPrintWindow } from "./brand";

export type ShelfQrTemplateType = "shelf-strip" | "a4-sheet" | "table-stand" | "poster-a4";

export interface ShelfQrPrintOptions {
  template: ShelfQrTemplateType;
  qrDataUrl: string;
  targetUrl: string;
  branchName?: string | null;
  title: string;
  subtitle: string;
  customNote?: string;
  sheetCount?: number; // عدد الملصقات لشيت A4 (الافتراضي 24)
}

/** أيقونة كاميرا/مسح خفيفة مدمجة كـ SVG */
const SCAN_SVG_MINI = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${BRAND.green}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;display:inline-block"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`;

const STORE_LOGO_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${BRAND.green}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/></svg>`;

function buildSingleStripHtml(opts: ShelfQrPrintOptions): string {
  const branchLabel = opts.branchName ? esc(opts.branchName) : "كافة الفروع";
  return `
  <div class="shelf-strip-card">
    <div class="strip-qr">
      <img src="${opts.qrDataUrl}" alt="QR" width="84" height="84" />
    </div>
    <div class="strip-info">
      <div class="strip-header">
        ${SCAN_SVG_MINI}
        <span class="strip-brand">${esc(opts.title || "الرؤية العربية")}</span>
      </div>
      <div class="strip-action">${esc(opts.subtitle || "امسح لمعرفة السعر")}</div>
      <div class="strip-footer">
        <span class="strip-chip">${branchLabel}</span>
        <span class="strip-sub">قارئ الرفوف</span>
      </div>
    </div>
  </div>`;
}

function buildA4SheetHtml(opts: ShelfQrPrintOptions): string {
  const count = Math.max(1, Math.min(opts.sheetCount ?? 24, 48));
  let itemsHtml = "";
  for (let i = 0; i < count; i++) {
    itemsHtml += buildSingleStripHtml(opts);
  }
  return `
  <div class="a4-sheet-container">
    <div class="a4-sheet-grid">
      ${itemsHtml}
    </div>
  </div>`;
}

function buildTableStandHtml(opts: ShelfQrPrintOptions): string {
  const branchLabel = opts.branchName ? `فرع: ${esc(opts.branchName)}` : "خدمة المعرض الذكي";
  return `
  <div class="stand-wrapper">
    <div class="stand-card">
      <div class="stand-header">
        <div class="stand-logo-box">${STORE_LOGO_SVG}</div>
        <div class="stand-company">${esc(CO.name)}</div>
        <div class="stand-branch">${branchLabel}</div>
      </div>

      <div class="stand-headline">
        <h2>${esc(opts.title || "قارئ الأسعار الذكي")}</h2>
        <p>${esc(opts.subtitle || "وجّه كاميرا هاتفك نحو باركود أي منتج لمعرفة السعر والعروض فوراً")}</p>
      </div>

      <div class="stand-qr-box">
        <div class="qr-target-frame">
          <img src="${opts.qrDataUrl}" alt="QR Code" width="180" height="180" />
        </div>
        <div class="qr-prompt">امسح الرمز بكاميرا هاتفك للبدء</div>
      </div>

      <div class="stand-steps">
        <div class="step-item">
          <span class="step-num">1</span>
          <span class="step-txt">امسح هذا الرمز بكاميرا الموبايل</span>
        </div>
        <div class="step-arrow">←</div>
        <div class="step-item">
          <span class="step-num">2</span>
          <span class="step-txt">وجّه الكاميرا لباركود السلعة</span>
        </div>
        <div class="step-arrow">←</div>
        <div class="step-item">
          <span class="step-num">3</span>
          <span class="step-txt">اطّلع على السعر والتخفيض فوراً</span>
        </div>
      </div>

      ${opts.customNote ? `<div class="stand-note">${esc(opts.customNote)}</div>` : ""}

      <div class="stand-footer">
        <span>بدون تنزيل تطبيقات — يعمل مباشرة في المتصفح</span>
        <span>${esc(opts.targetUrl.replace(/^https?:\/\//, ""))}</span>
      </div>
    </div>
  </div>`;
}

function buildPosterA4Html(opts: ShelfQrPrintOptions): string {
  const branchLabel = opts.branchName ? `فرع ${esc(opts.branchName)}` : "معرض الرؤية العربية";
  return `
  <div class="poster-page">
    <div class="poster-inner">
      <div class="poster-top">
        <div class="poster-tag">خدمة التسوّق الذكي</div>
        <h1 class="poster-title">${esc(opts.title || "قارئ الأسعار الفوري")}</h1>
        <p class="poster-subtitle">${esc(opts.subtitle || "وجّه كاميرا هاتفك نحو باركود أي سلعة أو كتاب لمعرفة سعره وعروضه")}</p>
      </div>

      <div class="poster-qr-section">
        <div class="poster-qr-card">
          <div class="qr-bracket top-right"></div>
          <div class="qr-bracket top-left"></div>
          <div class="qr-bracket bottom-right"></div>
          <div class="qr-bracket bottom-left"></div>
          <img src="${opts.qrDataUrl}" alt="QR Code" width="240" height="240" />
        </div>
        <div class="poster-qr-hint">امسح الرمز لفتح قارئ الأسعار على هاتفك</div>
      </div>

      <div class="poster-steps-grid">
        <div class="poster-step-card">
          <div class="p-num">1</div>
          <div class="p-title">امسح الرمز</div>
          <div class="p-desc">افتح كاميرا الهاتف واقرأ هذا الرمز بدون الحاجة لتثبيت أي تطبيق</div>
        </div>
        <div class="poster-step-card">
          <div class="p-num">2</div>
          <div class="p-title">امسح باركود المنتج</div>
          <div class="p-desc">وجّه كاميرا هاتفك نحو باركود السلعة على الرف بدقة وسرعة</div>
        </div>
        <div class="poster-step-card">
          <div class="p-num">3</div>
          <div class="p-title">اعرف السعر فوراً</div>
          <div class="p-desc">يظهر السعر الدقيق، العروض الترويجية، والخيارات المتاحة بالدينار العراقي</div>
        </div>
      </div>

      ${opts.customNote ? `<div class="poster-note-box">${esc(opts.customNote)}</div>` : ""}

      <div class="poster-bottom">
        <div class="poster-brand">${esc(CO.name)} — ${branchLabel}</div>
        <div class="poster-url">${esc(opts.targetUrl)}</div>
      </div>
    </div>
  </div>`;
}

function getStyleForTemplate(template: ShelfQrTemplateType): string {
  const common = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      font-family: 'Cairo', system-ui, -apple-system, sans-serif;
      direction: rtl;
      text-align: right;
      color: #111827;
      background: #ffffff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  `;

  if (template === "shelf-strip") {
    return `${common}
      @page {
        size: 60mm 35mm;
        margin: 2mm;
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 56mm;
        height: 31mm;
      }
      .shelf-strip-card {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        border: 1.5px solid #0D6B52;
        border-radius: 4px;
        padding: 2.5mm 3mm;
        gap: 3mm;
        background: #F0F9F5;
      }
      .strip-qr {
        display: flex;
        align-items: center;
        justify-content: center;
        background: #ffffff;
        border: 1px solid #D1D5DB;
        border-radius: 3px;
        padding: 1mm;
      }
      .strip-qr img {
        display: block;
        width: 25mm;
        height: 25mm;
      }
      .strip-info {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        height: 100%;
        overflow: hidden;
      }
      .strip-header {
        display: flex;
        align-items: center;
        gap: 1.5mm;
      }
      .strip-brand {
        font-size: 8pt;
        font-weight: 700;
        color: #0D6B52;
        white-space: nowrap;
      }
      .strip-action {
        font-size: 8.5pt;
        font-weight: 800;
        color: #000000;
        line-height: 1.25;
      }
      .strip-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1.5mm;
      }
      .strip-chip {
        font-size: 6.5pt;
        background: #0D6B52;
        color: #ffffff;
        padding: 0.5mm 1.5mm;
        border-radius: 2px;
        font-weight: 600;
        white-space: nowrap;
      }
      .strip-sub {
        font-size: 6pt;
        color: #6B7280;
      }
    `;
  }

  if (template === "a4-sheet") {
    return `${common}
      @page {
        size: A4 portrait;
        margin: 8mm 6mm;
      }
      .a4-sheet-container {
        width: 100%;
      }
      .a4-sheet-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 3mm;
      }
      .shelf-strip-card {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        border: 1px dashed #9CA3AF;
        border-radius: 4px;
        padding: 3mm;
        gap: 3mm;
        background: #FCFCFA;
        page-break-inside: avoid;
        height: 32mm;
      }
      .strip-qr {
        display: flex;
        align-items: center;
        justify-content: center;
        background: #ffffff;
        border: 1px solid #E5E7EB;
        border-radius: 3px;
        padding: 1mm;
      }
      .strip-qr img {
        display: block;
        width: 24mm;
        height: 24mm;
      }
      .strip-info {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        height: 100%;
      }
      .strip-header {
        display: flex;
        align-items: center;
        gap: 1.5mm;
      }
      .strip-brand {
        font-size: 8pt;
        font-weight: 700;
        color: #0D6B52;
      }
      .strip-action {
        font-size: 8.5pt;
        font-weight: 800;
        color: #111827;
        line-height: 1.25;
      }
      .strip-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .strip-chip {
        font-size: 6.5pt;
        background: #0D6B52;
        color: #ffffff;
        padding: 0.5mm 2mm;
        border-radius: 2px;
        font-weight: 600;
      }
      .strip-sub {
        font-size: 6pt;
        color: #6B7280;
      }
    `;
  }

  if (template === "table-stand") {
    return `${common}
      @page {
        size: A5 portrait;
        margin: 10mm;
      }
      .stand-wrapper {
        display: flex;
        justify-content: center;
        align-items: center;
        min-height: 98vh;
      }
      .stand-card {
        width: 100%;
        border: 2px solid #0D6B52;
        border-radius: 12px;
        padding: 10mm 8mm;
        text-align: center;
        background: linear-gradient(180deg, #F0F9F5 0%, #FFFFFF 30%);
        box-shadow: inset 0 0 0 1px #CFE7DE;
      }
      .stand-header {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2mm;
        margin-bottom: 5mm;
      }
      .stand-logo-box {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: #CFE7DE;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .stand-company {
        font-size: 13pt;
        font-weight: 800;
        color: #0D6B52;
      }
      .stand-branch {
        font-size: 9pt;
        font-weight: 600;
        color: #4B5563;
        background: #E5E7EB;
        padding: 1mm 4mm;
        border-radius: 12px;
      }
      .stand-headline h2 {
        font-size: 16pt;
        font-weight: 900;
        color: #111827;
        margin-bottom: 2mm;
      }
      .stand-headline p {
        font-size: 10pt;
        color: #4B5563;
        line-height: 1.4;
      }
      .stand-qr-box {
        margin: 7mm 0;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .qr-target-frame {
        padding: 3mm;
        background: #ffffff;
        border: 2px solid #0D6B52;
        border-radius: 10px;
        box-shadow: 0 4px 12px rgba(13, 107, 82, 0.1);
      }
      .qr-target-frame img {
        display: block;
      }
      .qr-prompt {
        margin-top: 3mm;
        font-size: 9pt;
        font-weight: 700;
        color: #0D6B52;
      }
      .stand-steps {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 2mm;
        margin: 6mm 0;
        padding: 4mm;
        background: #F9FAFB;
        border-radius: 8px;
        border: 1px solid #E5E7EB;
      }
      .step-item {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1.5mm;
        flex: 1;
      }
      .step-num {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: #0D6B52;
        color: #ffffff;
        font-size: 9pt;
        font-weight: 800;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .step-txt {
        font-size: 7.5pt;
        font-weight: 600;
        color: #374151;
        line-height: 1.25;
      }
      .step-arrow {
        font-size: 12pt;
        color: #9CA3AF;
      }
      .stand-note {
        margin-top: 3mm;
        font-size: 8.5pt;
        color: #92400E;
        background: #FEF3C7;
        padding: 2mm 4mm;
        border-radius: 4px;
        border: 1px solid #FDE68A;
      }
      .stand-footer {
        margin-top: 6mm;
        padding-top: 4mm;
        border-top: 1px dashed #D1D5DB;
        display: flex;
        justify-content: space-between;
        font-size: 8pt;
        color: #6B7280;
      }
    `;
  }

  // poster-a4
  return `${common}
    @page {
      size: A4 portrait;
      margin: 12mm 15mm;
    }
    .poster-page {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .poster-inner {
      border: 3px solid #0D6B52;
      border-radius: 16px;
      padding: 12mm;
      text-align: center;
      background: linear-gradient(180deg, #F0F9F5 0%, #FFFFFF 25%);
      position: relative;
    }
    .poster-tag {
      display: inline-block;
      font-size: 10pt;
      font-weight: 700;
      color: #0D6B52;
      background: #CFE7DE;
      padding: 1.5mm 6mm;
      border-radius: 20px;
      margin-bottom: 4mm;
    }
    .poster-title {
      font-size: 26pt;
      font-weight: 900;
      color: #0D3B2E;
      margin-bottom: 3mm;
      letter-spacing: -0.5px;
    }
    .poster-subtitle {
      font-size: 13pt;
      color: #4B5563;
      max-width: 520px;
      margin: 0 auto;
      line-height: 1.5;
    }
    .poster-qr-section {
      margin: 10mm auto;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .poster-qr-card {
      position: relative;
      padding: 6mm;
      background: #ffffff;
      border-radius: 14px;
      border: 2px solid #E5E7EB;
      box-shadow: 0 10px 25px rgba(0,0,0,0.06);
    }
    .poster-qr-card img {
      display: block;
    }
    .qr-bracket {
      position: absolute;
      width: 16px;
      height: 16px;
      border-color: #0D6B52;
      border-style: solid;
      border-width: 0;
    }
    .qr-bracket.top-right { top: 6px; right: 6px; border-top-width: 3px; border-right-width: 3px; border-top-right-radius: 4px; }
    .qr-bracket.top-left { top: 6px; left: 6px; border-top-width: 3px; border-left-width: 3px; border-top-left-radius: 4px; }
    .qr-bracket.bottom-right { bottom: 6px; right: 6px; border-bottom-width: 3px; border-right-width: 3px; border-bottom-right-radius: 4px; }
    .qr-bracket.bottom-left { bottom: 6px; left: 6px; border-bottom-width: 3px; border-left-width: 3px; border-bottom-left-radius: 4px; }
    .poster-qr-hint {
      margin-top: 4mm;
      font-size: 12pt;
      font-weight: 800;
      color: #0D6B52;
    }
    .poster-steps-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 5mm;
      margin: 8mm 0;
    }
    .poster-step-card {
      background: #F9FAFB;
      border: 1px solid #E5E7EB;
      border-radius: 10px;
      padding: 5mm 4mm;
      text-align: center;
    }
    .p-num {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #0D6B52;
      color: #ffffff;
      font-size: 13pt;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 3mm auto;
    }
    .p-title {
      font-size: 11pt;
      font-weight: 800;
      color: #111827;
      margin-bottom: 1.5mm;
    }
    .p-desc {
      font-size: 8.5pt;
      color: #4B5563;
      line-height: 1.4;
    }
    .poster-note-box {
      margin-top: 4mm;
      font-size: 10pt;
      color: #92400E;
      background: #FEF3C7;
      padding: 3mm 6mm;
      border-radius: 6px;
      border: 1px solid #FDE68A;
      display: inline-block;
    }
    .poster-bottom {
      margin-top: 8mm;
      padding-top: 5mm;
      border-top: 1px dashed #D1D5DB;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 9.5pt;
      color: #4B5563;
    }
    .poster-brand {
      font-weight: 700;
      color: #0D6B52;
    }
    .poster-url {
      font-family: monospace;
      color: #6B7280;
    }
  `;
}

/**
 * فتح نافذة الطباعة المنمقة لملصق أو شيت الـ QR.
 * متزامنة تماماً مع إيماءة النقر لضمان عدم حجب الـ popup.
 */
export function printShelfQrDocument(opts: ShelfQrPrintOptions): boolean {
  let bodyContent = "";
  if (opts.template === "shelf-strip") {
    bodyContent = buildSingleStripHtml(opts);
  } else if (opts.template === "a4-sheet") {
    bodyContent = buildA4SheetHtml(opts);
  } else if (opts.template === "table-stand") {
    bodyContent = buildTableStandHtml(opts);
  } else {
    bodyContent = buildPosterA4Html(opts);
  }

  const css = getStyleForTemplate(opts.template);

  const fullHtml = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>طباعة ملصقات الرفوف — ${esc(opts.title)}</title>
  ${CAIRO_FONT}
  <style>${css}</style>
</head>
<body>
  ${bodyContent}
  <script>
    window.addEventListener("load", function() {
      setTimeout(function() {
        window.print();
      }, 250);
    });
  </script>
</body>
</html>`;

  return openPrintWindow(fullHtml, "width=900,height=1000");
}
