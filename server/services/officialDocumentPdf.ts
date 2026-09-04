/**
 * PDF المستندات الرسمية (فاتورة مبيعات / عرض سعر) — يُولَّد خادمياً للمشاركة عبر واتساب
 * والتسليم الإلكتروني. أُعيد بناؤه (٣/٨/٢٦) بعد ملاحظات المالك على النسخة الأولى:
 *  - الكمية كانت تُطبع خام «112.000» ⇒ الآن تنسيق بلا أصفار زائدة وبفواصل الآلاف.
 *  - «الخط السميك» كان زيفاً (bold=regular) ⇒ محاكاة سماكة بالرسم المزدوج للعربي +
 *    Helvetica-Bold حقيقي للأرقام اللاتينية، وأحجام أكبر عموماً.
 *  - لا معلومات تواصل ⇒ الترويسة والتذييل يحملان العنوان والهواتف من هوية الشركة الموحّدة.
 *  - لا QR ⇒ QR حقيقي قابل للمسح (بيانات المستند) أسفل يمين المستند.
 *  - تفقيط المبلغ + شريط إجمالي أخضر داكن + متبقٍّ بالأحمر — بمطابقة هوية قوالب المتصفح A4.
 *  - «الصنف» ⇒ «المنتج» (مسرد المصطلحات المعتمد).
 */
import fontkit from "@pdf-lib/fontkit";
import Decimal from "decimal.js";
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import { COMPANY_IDENTITY as CO } from "@shared/companyIdentity";
import { isDeadInvoiceStatus, invoiceStatusLabel } from "@shared/invoiceStatus";
import { formatArabicMoneyWords } from "@shared/tafqit";

export type OfficialDocumentKind = "INVOICE" | "QUOTATION";

export interface OfficialDocumentPdfData {
  kind: OfficialDocumentKind;
  number: string;
  date: string | Date | null;
  validUntil?: string | Date | null;
  customerName?: string | null;
  customerPhone?: string | null;
  subtotal: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
  total: string | number;
  paidAmount?: string | number | null;
  /**
   * حالة الفاتورة من `invoices.status` — تُحدِّد ما إذا كانت الفاتورة **ميّتة** (مُلغاة/مُرتجَعة
   * بالكامل/مُستبدَلة) فيُعرَض مستندٌ تاريخيٌّ لا مطالبة. غيابُها = fail-safe (نسخة تاريخية).
   * ⚠️ لا يُطبَّق منطق الحالات الميّتة على `QUOTATION` — عرضُ السعر ليس فاتورة.
   */
  status?: string | null;
  /**
   * مجموع المرتجَع من الفاتورة (`invoices.returnedTotal`). المطالبة الفعليّة = max(total − paid − returned, 0).
   * لا شارة «المتبقي» بالأحمر إن كانت الفاتورة ميّتة، ولا يجوز حساب المطالبة بـ`total−paid` وحدها
   * لأنّ المرتجع الجزئيّ لفاتورة حيّة يُنقص المطالبة كذلك (لا يمسّ `paidAmount` أبداً).
   */
  returnedTotal?: string | number | null;
  notes?: string | null;
  items: Array<{
    productName: string;
    variantName?: string | null;
    unitName?: string | null;
    quantity: string | number;
    unitPrice: string | number;
    total: string | number;
  }>;
}

/**
 * ملخّص المطالبة لفاتورة (نتيجة عقد ثلاثيّ الحالات): مصدر الحقيقة الوحيد لما يُرسَم في
 * منطقة الإجماليات. الراسم يستهلك هذه القيم فحسب — لا يُعيد الحساب ولا يُقرِّر العرض.
 *
 * لماذا دالّة نقيّة منفصلة عن الرسم:
 *  - قابليّة الاختبار: مصفوفة الحالات الميّتة تُختبَر مباشرةً بلا فكّ ترميز PDF.
 *  - مصدرٌ واحد: أيّ قناة تعيد استعمال هذه الحمولة (واتساب/التنزيل/…) ترى نفس القرار.
 *  - `decimal.js`: نحسب المطالبة مرّةً بدقّةٍ ثابتة (`total − paid − returned`) بدل تقريبٍ لكلّ حدٍّ منفصل.
 */
export interface InvoiceClaimSummary {
  /** الفاتورة ميّتة (`CANCELLED`/`RETURNED`/`SUPERSEDED`) ⇒ لا مطالبة مهما كانت الحسابات. */
  readonly isDead: boolean;
  /** التعريب العربيّ لحالة الفاتورة عبر `invoiceStatusLabel` — لعرضٍ آمن (لا رمز خام). */
  readonly statusLabel: string;
  /** المطالبة الحاليّة بالدينار العراقي (مُقرَّبةً لعددٍ صحيح): 0 للفواتير الميّتة. */
  readonly currentClaim: number;
  /** المدفوع (نصّاً كما وُرد). */
  readonly paidAmount: string;
  /** المرتجَع (نصّاً كما وُرد). */
  readonly returnedTotal: string;
  /** أظهر شريط «نسخة تاريخية» أعلى المستند. */
  readonly showHistoricalBanner: boolean;
  /** أظهر صفّ «المدفوع» في الإجماليات (فاتورة + قيمة معلومة). */
  readonly showPaidRow: boolean;
  /** أظهر صفّ «المرتجع» (فاتورة + returned > 0). */
  readonly showReturnedRow: boolean;
  /** أظهر شريط «المتبقي» الأحمر (فاتورة **حيّة** + مطالبة > 0). لا يشتعل على ميّتة أبداً. */
  readonly showRedOutstandingRow: boolean;
  /** أظهر صفّ «المطالبة الحاليّة» المحايد بقيمة 0 (فاتورة ميّتة فقط). */
  readonly showDeadZeroClaimRow: boolean;
  /** تسمية الشريط الأخضر الكبير: «الإجمالي المستحق» للحيّة/«الإجمالي الأصلي» للميّتة. */
  readonly grandBarLabel: string;
}

const HISTORICAL_BANNER_TEXT = "نسخة تاريخية — غير صالحة للمطالبة";

/**
 * يحسب ملخّص المطالبة والقرارات البصريّة. **نقيّة** — بلا آثار جانبيّة، بلا رسم.
 *
 * للفاتورة الحيّة: `currentClaim = max(total − paid − returned, 0)` بـ`decimal.js`
 * (لا تقريبٍ لكلّ حدٍّ منفصل: التقريبُ في نهاية الحساب مرّةً واحدة).
 *
 * للفاتورة الميّتة (`isDeadInvoiceStatus`): المطالبة **صفر** حتّى إن كان
 * `total − paid − returned > 0` (كالحالة الحرجة `CANCELLED` بلا مرتجع). القرار سياسيّ لا حسابيّ.
 *
 * للحالة `undefined`/غير معروفة: fail-safe = نسخة تاريخية بلا مطالبة (لا نطالب بمالٍ لا نعرف حالته).
 */
export function computeInvoiceClaim(data: OfficialDocumentPdfData): InvoiceClaimSummary {
  const paidRaw = data.paidAmount != null ? String(data.paidAmount) : "0";
  const returnedRaw = data.returnedTotal != null ? String(data.returnedTotal) : "0";

  if (data.kind !== "INVOICE") {
    return {
      isDead: false,
      statusLabel: "",
      currentClaim: 0,
      paidAmount: paidRaw,
      returnedTotal: returnedRaw,
      showHistoricalBanner: false,
      showPaidRow: false,
      showReturnedRow: false,
      showRedOutstandingRow: false,
      showDeadZeroClaimRow: false,
      grandBarLabel: "الإجمالي",
    };
  }

  const dead = isDeadInvoiceStatus(data.status);
  const unknownStatus = data.status == null || data.status === "";
  const historical = dead || unknownStatus;

  const total = new Decimal(data.total ?? 0);
  const paid = new Decimal(paidRaw || "0");
  const returned = new Decimal(returnedRaw || "0");
  const rawClaim = total.minus(paid).minus(returned);
  const claim = rawClaim.gt(0) ? rawClaim : new Decimal(0);
  const currentClaim = historical ? 0 : Math.round(claim.toNumber());
  const returnedPositive = returned.gt(0);
  const paidKnown = data.paidAmount != null;

  return {
    isDead: dead,
    statusLabel: unknownStatus ? "" : invoiceStatusLabel(data.status),
    currentClaim,
    paidAmount: paidRaw,
    returnedTotal: returnedRaw,
    showHistoricalBanner: historical,
    showPaidRow: paidKnown,
    showReturnedRow: returnedPositive,
    showRedOutstandingRow: !historical && currentClaim > 0,
    showDeadZeroClaimRow: historical,
    grandBarLabel: historical ? "الإجمالي الأصلي" : "الإجمالي المستحق",
  };
}

export { HISTORICAL_BANNER_TEXT };

// ─── هوية بصرية (تطابق BRAND في قوالب المتصفح) ──────────────────────────────
const GREEN = rgb(13 / 255, 107 / 255, 82 / 255);
const GREEN_DARK = rgb(13 / 255, 59 / 255, 46 / 255);
const GREEN_PALE = rgb(240 / 255, 249 / 255, 245 / 255);
const GREEN_ACCENT = rgb(207 / 255, 231 / 255, 222 / 255);
const BORDER = rgb(214 / 255, 214 / 255, 207 / 255);
const BORDER_DARK = rgb(107 / 255, 110 / 255, 102 / 255);
const LIGHT = rgb(250 / 255, 250 / 255, 247 / 255);
const ZEBRA = rgb(246 / 255, 246 / 255, 242 / 255);
const RED = rgb(138 / 255, 31 / 255, 17 / 255);
const RED_BG = rgb(253 / 255, 236 / 255, 234 / 255);
const INK = rgb(28 / 255, 31 / 255, 29 / 255);
const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 34;
const CONTENT_W = PAGE_W - MARGIN * 2;

/** مبالغ IQD بلا كسور (الفلوس لا تُتداول) وبفواصل آلاف. */
function money(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "0";
}

/** كميات — بلا أصفار عشرية زائدة (112.000 ⇒ 112، و1.5 تبقى 1.5) وبفواصل آلاف. */
function qtyText(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 3 }) : String(value ?? "");
}

function dateText(value: string | Date | null | undefined): string {
  if (!value) return "-";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toLocaleDateString("en-GB", { timeZone: "Asia/Baghdad" });
}

function safeFileNumber(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "document";
}

async function readCairoFont(): Promise<Uint8Array> {
  const filename = "Cairo-Variable.ttf";
  const candidates = [
    path.resolve(process.cwd(), "dist", "public", "fonts", filename),
    path.resolve(process.cwd(), "client", "public", "fonts", filename),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return new Uint8Array(await readFile(candidate));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`تعذّر تحميل خط Cairo: ${filename}`);
}

export function officialDocumentFilename(kind: OfficialDocumentKind, number: string): string {
  const prefix = kind === "INVOICE" ? "invoice" : "quotation";
  return `${prefix}-${safeFileNumber(number)}.pdf`;
}

type Rgb = ReturnType<typeof rgb>;
interface TextOpts { color?: Rgb; bold?: boolean }

export async function generateOfficialDocumentPdf(data: OfficialDocumentPdfData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const cairoBytes = await readCairoFont();
  const cairo = await pdf.embedFont(cairoBytes, { subset: true });
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const docLabel = data.kind === "INVOICE" ? "فاتورة مبيعات" : "عرض سعر";

  // QR حقيقي قابل للمسح — بيانات المستند نصاً (يطابق حمولة QR فاتورة المتصفح A4).
  let qrImage: PDFImage | null = null;
  try {
    const qrPayload = [
      CO.sub,
      `${docLabel}: ${data.number}`,
      `التاريخ: ${dateText(data.date)}`,
      `الإجمالي: ${money(data.total)} د.ع`,
    ].join("\n");
    const qrPng = await QRCode.toBuffer(qrPayload, {
      type: "png",
      width: 256,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    qrImage = await pdf.embedPng(qrPng);
  } catch {
    qrImage = null; // تدهور سلس: مستند بلا QR خير من فشل التوليد كله — ولا QR زائف أبداً.
  }

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  // ── مساعدات رسم ──────────────────────────────────────────────────────────
  /**
   * مقاطع LTR (أرقام/لاتيني، وقد تحوي فراغات وفواصل داخلية) ضمن نص عربي.
   * pdf-lib بلا محرك bidi: رسم «ورق A4 80غم» كسلسلة واحدة كان يعكس الأرقام (80 ⇒ 08).
   */
  // بلا مسافات داخل المقطع: المسافة بين مقطعين لاتينيين محايدة تتبع اتجاه الفقرة RTL
  // (يطابق UBA/المتصفح: «A4 80غم» ⇒ A4 يمين 80، و«07883000017 · 07838666999» يُقرأ الأول يميناً).
  const LTR_RUN = /[0-9A-Za-z][0-9A-Za-z+\-.,/%]*[0-9A-Za-z%]|[0-9A-Za-z]/g;

  /**
   * نص عربي RTL يُرسم منتهياً عند xRight، مع تفكيك مقاطع الأرقام/اللاتيني ورسمها LTR
   * في موضعها البصري الصحيح. bold = رسم مزدوج بإزاحة 0.32pt (الخط المتغيّر بلا وزن ثانٍ).
   */
  const drawAr = (pg: PDFPage, text: string, xRight: number, yy: number, size: number, opts: TextOpts = {}) => {
    const color = opts.color ?? BLACK;
    const put = (t: string, x: number) => {
      pg.drawText(t, { x, y: yy, font: cairo, size, color });
      if (opts.bold) pg.drawText(t, { x: x + 0.32, y: yy, font: cairo, size, color });
    };
    let cursor = xRight;
    const seg = (t: string) => {
      if (!t) return;
      const w = cairo.widthOfTextAtSize(t, size);
      put(t, cursor - w);
      cursor -= w;
    };
    let last = 0;
    for (const m of Array.from(text.matchAll(LTR_RUN))) {
      seg(text.slice(last, m.index));
      seg(m[0]);
      last = (m.index ?? 0) + m[0].length;
    }
    seg(text.slice(last));
  };
  const drawArCentered = (pg: PDFPage, text: string, cx: number, yy: number, size: number, opts: TextOpts = {}) => {
    const width = cairo.widthOfTextAtSize(text, size);
    drawAr(pg, text, cx + width / 2, yy, size, opts);
  };
  /** أرقام/لاتيني: Helvetica مع Bold حقيقي. يُرسم منتهياً عند xRight (محاذاة يمين للأعمدة المالية). */
  const drawNumRight = (pg: PDFPage, text: string, xRight: number, yy: number, size: number, opts: TextOpts = {}) => {
    const font = opts.bold ? helvBold : helv;
    const width = font.widthOfTextAtSize(text, size);
    pg.drawText(text, { x: xRight - width, y: yy, font, size, color: opts.color ?? BLACK });
  };
  const drawNumCentered = (pg: PDFPage, text: string, cx: number, yy: number, size: number, opts: TextOpts = {}) => {
    const font = opts.bold ? helvBold : helv;
    const width = font.widthOfTextAtSize(text, size);
    pg.drawText(text, { x: cx - width / 2, y: yy, font, size, color: opts.color ?? BLACK });
  };

  const fitAr = (text: string, size: number, maxWidth: number): string => {
    if (cairo.widthOfTextAtSize(text, size) <= maxWidth) return text;
    let out = text;
    while (out.length > 1 && cairo.widthOfTextAtSize(`${out}…`, size) > maxWidth) out = out.slice(0, -1);
    return `${out}…`;
  };

  /** لفّ نص عربي على أسطر بعرض أقصى (للشروط والملاحظات — القصّ الصامت كان يبتر النص). */
  const wrapAr = (text: string, size: number, maxWidth: number): string[] => {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (cairo.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  // ── ترويسة كل صفحة ───────────────────────────────────────────────────────
  const drawFrame = (pg: PDFPage) => {
    pg.drawRectangle({ x: 20, y: 20, width: PAGE_W - 40, height: PAGE_H - 40, borderColor: BORDER, borderWidth: 0.8 });
  };

  const drawHeader = () => {
    drawFrame(page);
    const bandTop = PAGE_H - MARGIN;
    const bandH = 86;
    page.drawRectangle({ x: MARGIN, y: bandTop - bandH, width: CONTENT_W, height: bandH, color: GREEN_PALE });
    // يمين: هوية الشركة + التواصل
    drawAr(page, CO.sub, PAGE_W - MARGIN - 14, bandTop - 30, 15, { color: GREEN_DARK, bold: true });
    drawAr(page, CO.name, PAGE_W - MARGIN - 14, bandTop - 48, 9.5, { color: BLACK });
    drawAr(page, `${CO.address}  ·  هاتف: ${CO.phones[0].n} - ${CO.phones[1].n}`, PAGE_W - MARGIN - 14, bandTop - 68, 8, { color: INK });
    // يسار: عنوان المستند بشريط أخضر داكن
    const titleSize = 13.5;
    const titleW = cairo.widthOfTextAtSize(docLabel, titleSize) + 34;
    page.drawRectangle({ x: MARGIN + 12, y: bandTop - 62, width: titleW, height: 34, color: GREEN_DARK });
    drawArCentered(page, docLabel, MARGIN + 12 + titleW / 2, bandTop - 50, titleSize, { color: WHITE, bold: true });
    // خط فاصل أسفل الترويسة
    page.drawLine({ start: { x: MARGIN, y: bandTop - bandH - 8 }, end: { x: PAGE_W - MARGIN, y: bandTop - bandH - 8 }, color: INK, thickness: 1.1 });
    y = bandTop - bandH - 20;
  };

  const addPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    drawHeader();
  };

  drawHeader();

  // ── حساب ملخّص المطالبة (يقرّر ما يُرسَم لاحقاً في الإجماليات + الشريط التاريخيّ) ──
  const claim = computeInvoiceClaim(data);

  // ── شريط «نسخة تاريخية» للفواتير الميّتة (أعلى المستند، أعلى بطاقة المعلومات) ──
  if (claim.showHistoricalBanner) {
    const bannerH = 30;
    page.drawRectangle({
      x: MARGIN,
      y: y - bannerH,
      width: CONTENT_W,
      height: bannerH,
      color: RED_BG,
      borderColor: RED,
      borderWidth: 0.9,
    });
    const primary = HISTORICAL_BANNER_TEXT;
    const secondary = claim.statusLabel ? `الحالة: ${claim.statusLabel}` : "";
    drawAr(page, primary, PAGE_W - MARGIN - 12, y - 20, 11.5, { color: RED, bold: true });
    if (secondary) drawAr(page, secondary, MARGIN + 12 + cairo.widthOfTextAtSize(secondary, 10), y - 19, 10, { color: RED, bold: true });
    y -= bannerH + 10;
  }

  // ── بطاقة معلومات المستند ────────────────────────────────────────────────
  const cardH = 78;
  page.drawRectangle({ x: MARGIN, y: y - cardH, width: CONTENT_W, height: cardH, color: LIGHT, borderColor: BORDER, borderWidth: 0.7 });
  page.drawRectangle({ x: PAGE_W - MARGIN - 3, y: y - cardH, width: 3, height: cardH, color: GREEN });

  const labelValue = (label: string, value: string, xRight: number, yy: number, latinValue = false) => {
    drawAr(page, label, xRight, yy + 16, 8.5, { color: GREEN, bold: true });
    if (latinValue) drawNumRight(page, value || "-", xRight, yy, 11, { bold: true });
    else drawAr(page, fitAr(value || "-", 11, 170), xRight, yy, 11, { bold: true });
  };

  labelValue("رقم المستند", data.number, PAGE_W - MARGIN - 16, y - 30, true);
  labelValue("التاريخ", dateText(data.date), PAGE_W - MARGIN - 205, y - 30, true);
  if (data.kind === "QUOTATION") {
    labelValue("صالح حتى", dateText(data.validUntil), PAGE_W - MARGIN - 330, y - 30, true);
  }
  labelValue("العميل", data.customerName || "عميل نقدي", PAGE_W - MARGIN - 16, y - 64);
  if (data.customerPhone) {
    labelValue("الهاتف", data.customerPhone, PAGE_W - MARGIN - 205, y - 64, true);
  }
  y -= cardH + 14;

  // ── جدول البنود ──────────────────────────────────────────────────────────
  // أعمدة من اليمين (RTL): م | المنتج | الوحدة | الكمية | السعر | الإجمالي
  const col = {
    idx:     { x: PAGE_W - MARGIN - 26, w: 26 },
    product: { x: PAGE_W - MARGIN - 26 - 215, w: 215 },
    unit:    { x: PAGE_W - MARGIN - 26 - 215 - 56, w: 56 },
    qty:     { x: PAGE_W - MARGIN - 26 - 215 - 56 - 62, w: 62 },
    price:   { x: MARGIN + 86, w: PAGE_W - MARGIN - 26 - 215 - 56 - 62 - (MARGIN + 86) },
    total:   { x: MARGIN, w: 86 },
  };
  const ROW_H = 26;
  const HEAD_H = 26;

  const colSeparators = (topY: number, h: number) => {
    for (const c of [col.product, col.unit, col.qty, col.price, col.total]) {
      const edge = c.x + c.w;
      page.drawLine({ start: { x: edge, y: topY }, end: { x: edge, y: topY - h }, color: BORDER, thickness: 0.4 });
    }
  };

  const drawTableHeader = () => {
    page.drawRectangle({ x: MARGIN, y: y - HEAD_H, width: CONTENT_W, height: HEAD_H, color: GREEN_DARK });
    const ty = y - 17.5;
    drawArCentered(page, "م", col.idx.x + col.idx.w / 2, ty, 9.5, { color: WHITE, bold: true });
    drawArCentered(page, "المنتج", col.product.x + col.product.w / 2, ty, 9.5, { color: WHITE, bold: true });
    drawArCentered(page, "الوحدة", col.unit.x + col.unit.w / 2, ty, 9.5, { color: WHITE, bold: true });
    drawArCentered(page, "الكمية", col.qty.x + col.qty.w / 2, ty, 9.5, { color: WHITE, bold: true });
    drawArCentered(page, "السعر", col.price.x + col.price.w / 2, ty, 9.5, { color: WHITE, bold: true });
    drawArCentered(page, "الإجمالي", col.total.x + col.total.w / 2, ty, 9.5, { color: WHITE, bold: true });
    y -= HEAD_H;
  };

  drawTableHeader();
  for (let index = 0; index < data.items.length; index += 1) {
    if (y - ROW_H < 170) {
      addPage();
      drawTableHeader();
    }
    const item = data.items[index];
    const rowY = y - ROW_H;
    page.drawRectangle({
      x: MARGIN,
      y: rowY,
      width: CONTENT_W,
      height: ROW_H,
      color: index % 2 ? ZEBRA : WHITE,
      borderColor: BORDER,
      borderWidth: 0.4,
    });
    colSeparators(y, ROW_H);
    const baseline = rowY + 9;
    const product = [item.productName, item.variantName].filter(Boolean).join(" — ");
    drawArCentered(page, String(index + 1), col.idx.x + col.idx.w / 2, baseline, 9);
    drawAr(page, fitAr(product, 9.5, col.product.w - 14), col.product.x + col.product.w - 7, baseline, 9.5);
    drawArCentered(page, item.unitName || "-", col.unit.x + col.unit.w / 2, baseline, 9);
    drawNumCentered(page, qtyText(item.quantity), col.qty.x + col.qty.w / 2, baseline, 9.5, { bold: true });
    drawNumRight(page, money(item.unitPrice), col.price.x + col.price.w - 8, baseline, 9.5);
    drawNumRight(page, money(item.total), col.total.x + col.total.w - 8, baseline, 9.5, { bold: true });
    y = rowY;
  }
  // حد سفلي أوضح لإغلاق الجدول
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, color: BORDER_DARK, thickness: 0.8 });

  // ── منطقة الإجماليات (صندوق يسار) + QR (يمين) ────────────────────────────
  y -= 16;
  const totals: Array<{ label: string; value: string; color?: Rgb; sign?: string }> = [
    { label: "المجموع الفرعي", value: money(data.subtotal) },
  ];
  if (Number(data.discountAmount ?? 0) > 0) totals.push({ label: "الخصم", value: money(data.discountAmount), sign: "-" });
  if (Number(data.taxAmount ?? 0) > 0) totals.push({ label: "الضريبة", value: money(data.taxAmount), sign: "+" });

  const grandBarLabel = data.kind === "INVOICE" ? claim.grandBarLabel : "الإجمالي";

  const LINE_H = 22;
  const GRAND_H = 32;
  const totalsBoxW = 250;
  const totalsBoxX = MARGIN;
  const extraLines =
    (claim.showPaidRow ? 1 : 0)
    + (claim.showReturnedRow ? 1 : 0)
    + (claim.showDeadZeroClaimRow ? 1 : 0);
  const outstandingBarH = claim.showRedOutstandingRow ? LINE_H + 4 : 0;
  const totalsH = totals.length * LINE_H + GRAND_H + extraLines * LINE_H + outstandingBarH;
  const qrSize = 74;
  const regionH = Math.max(totalsH, qrImage ? qrSize + 18 : 0);
  if (y - regionH < 120) addPage();

  let ty = y;
  for (const line of totals) {
    drawAr(page, line.label, totalsBoxX + totalsBoxW - 6, ty - 15, 10);
    const valueText = line.sign ? `${line.sign} ${line.value}` : line.value;
    drawNumRight(page, valueText, totalsBoxX + 104, ty - 15, 10.5, { bold: true, color: line.color });
    page.drawLine({ start: { x: totalsBoxX, y: ty - LINE_H }, end: { x: totalsBoxX + totalsBoxW, y: ty - LINE_H }, color: BORDER, thickness: 0.4 });
    ty -= LINE_H;
  }
  // شريط الإجمالي الأخضر الداكن — «الإجمالي المستحق» للحيّة، «الإجمالي الأصلي» للميّتة.
  page.drawRectangle({ x: totalsBoxX, y: ty - GRAND_H, width: totalsBoxW, height: GRAND_H, color: GREEN_DARK });
  drawAr(page, grandBarLabel, totalsBoxX + totalsBoxW - 10, ty - 21, 10.5, { color: GREEN_ACCENT, bold: true });
  drawAr(page, "د.ع", totalsBoxX + 42, ty - 21, 8.5, { color: GREEN_ACCENT });
  drawNumRight(page, money(data.total), totalsBoxX + 108 + 28, ty - 21.5, 13.5, { bold: true, color: WHITE });
  ty -= GRAND_H;
  if (claim.showPaidRow) {
    drawAr(page, "المدفوع", totalsBoxX + totalsBoxW - 6, ty - 16, 9.5);
    drawNumRight(page, money(claim.paidAmount), totalsBoxX + 104, ty - 16, 10, { bold: true });
    ty -= LINE_H;
  }
  if (claim.showReturnedRow) {
    drawAr(page, "المرتجَع", totalsBoxX + totalsBoxW - 6, ty - 16, 9.5);
    drawNumRight(page, `- ${money(claim.returnedTotal)}`, totalsBoxX + 104, ty - 16, 10, { bold: true });
    ty -= LINE_H;
  }
  if (claim.showRedOutstandingRow) {
    // شارة «المتبقي» الأحمر — للحيّة فقط + مطالبة > 0. لا تشتعل على الميّتة أبداً.
    page.drawRectangle({ x: totalsBoxX, y: ty - LINE_H, width: totalsBoxW, height: LINE_H, color: RED_BG, borderColor: RED, borderWidth: 0.5 });
    drawAr(page, "المتبقي", totalsBoxX + totalsBoxW - 8, ty - 15, 9.5, { color: RED, bold: true });
    drawNumRight(page, money(claim.currentClaim), totalsBoxX + 104, ty - 15, 10.5, { bold: true, color: RED });
    ty -= LINE_H + 4;
  } else if (claim.showDeadZeroClaimRow) {
    // «المطالبة الحاليّة: 0» محايدةً — لا شارة حمراء على مستندٍ لا يطالب بشيء.
    drawAr(page, "المطالبة الحاليّة", totalsBoxX + totalsBoxW - 6, ty - 16, 9.5, { bold: true });
    drawNumRight(page, "0", totalsBoxX + 104, ty - 16, 10.5, { bold: true });
    ty -= LINE_H;
  }

  // QR على يمين منطقة الإجماليات
  if (qrImage) {
    const qrX = PAGE_W - MARGIN - qrSize - 6;
    page.drawImage(qrImage, { x: qrX, y: y - qrSize, width: qrSize, height: qrSize });
    drawArCentered(page, "امسح للتحقق من بيانات المستند", qrX + qrSize / 2, y - qrSize - 12, 7, { color: INK });
  }
  y -= regionH + 14;

  // ── الشروط والملاحظات (ملفوفة لا مبتورة) ─────────────────────────────────
  if (data.notes) {
    const noteLines = wrapAr(data.notes, 9, CONTENT_W - 28).slice(0, 6);
    const notesH = 26 + noteLines.length * 14;
    if (y - notesH < 100) addPage();
    page.drawRectangle({ x: MARGIN, y: y - notesH, width: CONTENT_W, height: notesH, color: LIGHT, borderColor: BORDER, borderWidth: 0.7 });
    page.drawRectangle({ x: PAGE_W - MARGIN - 3, y: y - notesH, width: 3, height: notesH, color: GREEN });
    drawAr(page, "الشروط والملاحظات", PAGE_W - MARGIN - 14, y - 17, 9, { color: GREEN, bold: true });
    noteLines.forEach((line, i) => {
      drawAr(page, line, PAGE_W - MARGIN - 14, y - 33 - i * 14, 9, { color: BLACK });
    });
    y -= notesH + 12;
  }

  // ── التفقيط ──────────────────────────────────────────────────────────────
  {
    const tafqitH = 24;
    if (y - tafqitH < 90) addPage();
    page.drawRectangle({
      x: MARGIN, y: y - tafqitH, width: CONTENT_W, height: tafqitH,
      color: rgb(252 / 255, 252 / 255, 250 / 255),
      borderColor: rgb(201 / 255, 202 / 255, 194 / 255), borderWidth: 0.7, borderDashArray: [3, 2],
    });
    drawAr(page, `المبلغ كتابةً: ${formatArabicMoneyWords(data.total)}`, PAGE_W - MARGIN - 12, y - 16, 9.5, { bold: true });
    y -= tafqitH;
  }

  // ── تذييل كل صفحة: تواصل + شكر + ترقيم ───────────────────────────────────
  const totalPages = pdf.getPageCount();
  pdf.getPages().forEach((pdfPage, index) => {
    pdfPage.drawLine({ start: { x: MARGIN, y: 54 }, end: { x: PAGE_W - MARGIN, y: 54 }, color: BORDER, thickness: 0.6 });
    drawAr(pdfPage, CO.footer, PAGE_W - MARGIN, 40, 8.5, { color: GREEN_DARK, bold: true });
    drawAr(pdfPage, CO.footerLine, PAGE_W - MARGIN, 27, 7.5, { color: INK });
    pdfPage.drawText(`${index + 1} / ${totalPages}`, { x: MARGIN, y: 40, font: helv, size: 8, color: BLACK });
    pdfPage.drawText(`REF ${data.number}`, { x: MARGIN, y: 27, font: helv, size: 7, color: INK });
  });

  pdf.setTitle(`${data.kind === "INVOICE" ? "Invoice" : "Quotation"} ${data.number}`);
  pdf.setLanguage("ar");
  pdf.setCreator("Business Management System");
  pdf.setProducer("Business Management System");
  return pdf.save({ useObjectStreams: false });
}
