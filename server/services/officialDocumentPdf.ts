import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { readFile } from "node:fs/promises";
import path from "node:path";

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

const GREEN = rgb(13 / 255, 107 / 255, 82 / 255);
const GREEN_DARK = rgb(13 / 255, 59 / 255, 46 / 255);
const GREEN_PALE = rgb(240 / 255, 249 / 255, 245 / 255);
const BORDER = rgb(214 / 255, 214 / 255, 207 / 255);
const LIGHT = rgb(250 / 255, 250 / 255, 247 / 255);
const RED = rgb(138 / 255, 31 / 255, 17 / 255);
const BLACK = rgb(0, 0, 0);
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 34;

function money(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "0";
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

function drawRtl(
  page: PDFPage,
  text: string,
  xRight: number,
  y: number,
  font: PDFFont,
  size: number,
  color = BLACK,
): void {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: xRight - width, y, font, size, color });
}

function fitText(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}...`, size) > maxWidth) out = out.slice(0, -1);
  return `${out}...`;
}

function drawLabelValue(
  page: PDFPage,
  label: string,
  value: string,
  xRight: number,
  y: number,
  regular: PDFFont,
  bold: PDFFont,
): void {
  drawRtl(page, label, xRight, y + 14, regular, 8, GREEN);
  drawRtl(page, value || "-", xRight, y, bold, 10, BLACK);
}

export function officialDocumentFilename(kind: OfficialDocumentKind, number: string): string {
  const prefix = kind === "INVOICE" ? "invoice" : "quotation";
  return `${prefix}-${safeFileNumber(number)}.pdf`;
}

export async function generateOfficialDocumentPdf(data: OfficialDocumentPdfData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const cairoBytes = await readCairoFont();
  const regular = await pdf.embedFont(cairoBytes, { subset: true });
  // The variable Cairo font is embedded once. Size, color and spacing provide
  // the visual emphasis without doubling every generated document's size.
  const bold = regular;
  const latin = await pdf.embedFont(StandardFonts.Helvetica);
  const latinBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const drawFrame = () => {
    page.drawRectangle({
      x: 20,
      y: 20,
      width: PAGE_W - 40,
      height: PAGE_H - 40,
      borderColor: BORDER,
      borderWidth: 0.8,
    });
  };

  const drawHeader = () => {
    drawFrame();
    page.drawRectangle({ x: MARGIN, y: PAGE_H - 112, width: PAGE_W - MARGIN * 2, height: 66, color: GREEN_PALE });
    drawRtl(page, "شركة الرؤية العربية للتجارة العامة", PAGE_W - MARGIN - 12, PAGE_H - 70, bold, 13, GREEN_DARK);
    drawRtl(page, "مكتبة العربية للطباعة والقرطاسية", PAGE_W - MARGIN - 12, PAGE_H - 89, regular, 9, BLACK);
    const title = data.kind === "INVOICE" ? "فاتورة مبيعات" : "عرض سعر";
    page.drawText(title, { x: MARGIN + 12, y: PAGE_H - 80, font: bold, size: 16, color: GREEN_DARK });
    y = PAGE_H - 132;
  };

  const addPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    drawHeader();
  };

  drawHeader();

  page.drawRectangle({ x: MARGIN, y: y - 70, width: PAGE_W - MARGIN * 2, height: 70, color: LIGHT, borderColor: BORDER, borderWidth: 0.7 });
  drawLabelValue(page, "رقم المستند", data.number, PAGE_W - MARGIN - 14, y - 28, regular, bold);
  drawLabelValue(page, "التاريخ", dateText(data.date), PAGE_W - MARGIN - 190, y - 28, regular, bold);
  drawLabelValue(page, "العميل", data.customerName || "عميل نقدي", PAGE_W - MARGIN - 350, y - 28, regular, bold);
  if (data.kind === "QUOTATION") {
    drawLabelValue(page, "صالح حتى", dateText(data.validUntil), PAGE_W - MARGIN - 190, y - 57, regular, bold);
  }
  if (data.customerPhone) {
    page.drawText(data.customerPhone, { x: MARGIN + 14, y: y - 57, font: latin, size: 8.5, color: BLACK });
  }
  y -= 88;

  const col = {
    total: { x: MARGIN, w: 90 },
    price: { x: MARGIN + 90, w: 90 },
    qty: { x: MARGIN + 180, w: 60 },
    unit: { x: MARGIN + 240, w: 70 },
    product: { x: MARGIN + 310, w: PAGE_W - MARGIN * 2 - 310 },
  };

  const drawTableHeader = () => {
    page.drawRectangle({ x: MARGIN, y: y - 24, width: PAGE_W - MARGIN * 2, height: 24, color: GREEN_DARK });
    drawRtl(page, "الصنف", col.product.x + col.product.w - 8, y - 16, bold, 8.5, rgb(1, 1, 1));
    drawRtl(page, "الوحدة", col.unit.x + col.unit.w - 6, y - 16, bold, 8.5, rgb(1, 1, 1));
    drawRtl(page, "الكمية", col.qty.x + col.qty.w - 6, y - 16, bold, 8.5, rgb(1, 1, 1));
    drawRtl(page, "السعر", col.price.x + col.price.w - 6, y - 16, bold, 8.5, rgb(1, 1, 1));
    drawRtl(page, "الإجمالي", col.total.x + col.total.w - 6, y - 16, bold, 8.5, rgb(1, 1, 1));
    y -= 24;
  };

  drawTableHeader();
  for (let index = 0; index < data.items.length; index += 1) {
    if (y < 150) {
      addPage();
      drawTableHeader();
    }
    const item = data.items[index];
    const rowY = y - 25;
    page.drawRectangle({
      x: MARGIN,
      y: rowY,
      width: PAGE_W - MARGIN * 2,
      height: 25,
      color: index % 2 ? LIGHT : rgb(1, 1, 1),
      borderColor: BORDER,
      borderWidth: 0.35,
    });
    const product = [item.productName, item.variantName].filter(Boolean).join(" - ");
    drawRtl(page, fitText(product, regular, 8.5, col.product.w - 14), col.product.x + col.product.w - 7, rowY + 8, regular, 8.5);
    drawRtl(page, item.unitName || "-", col.unit.x + col.unit.w - 6, rowY + 8, regular, 8);
    page.drawText(String(item.quantity), { x: col.qty.x + 12, y: rowY + 8, font: latin, size: 8 });
    page.drawText(money(item.unitPrice), { x: col.price.x + 8, y: rowY + 8, font: latin, size: 8 });
    page.drawText(money(item.total), { x: col.total.x + 7, y: rowY + 8, font: latinBold, size: 8 });
    y = rowY;
  }

  y -= 14;
  if (y < 190) addPage();
  const boxW = 230;
  const boxX = PAGE_W - MARGIN - boxW;
  const totals: Array<{ label: string; value: string; color?: ReturnType<typeof rgb> }> = [
    { label: "المجموع الفرعي", value: money(data.subtotal) },
  ];
  if (Number(data.discountAmount ?? 0) > 0) totals.push({ label: "الخصم", value: money(data.discountAmount) });
  if (Number(data.taxAmount ?? 0) > 0) totals.push({ label: "الضريبة", value: money(data.taxAmount) });
  if (data.kind === "INVOICE" && data.paidAmount != null) totals.push({ label: "المدفوع", value: money(data.paidAmount) });
  totals.push({ label: "الإجمالي", value: money(data.total), color: GREEN_DARK });

  const totalsH = totals.length * 25;
  page.drawRectangle({ x: boxX, y: y - totalsH, width: boxW, height: totalsH, color: LIGHT, borderColor: BORDER, borderWidth: 0.7 });
  totals.forEach((line, index) => {
    const lineY = y - 18 - index * 25;
    drawRtl(page, line.label, boxX + boxW - 10, lineY, index === totals.length - 1 ? bold : regular, 9, line.color ?? BLACK);
    page.drawText(line.value, { x: boxX + 10, y: lineY, font: index === totals.length - 1 ? latinBold : latin, size: 9, color: line.color ?? BLACK });
  });

  if (data.notes) {
    drawRtl(page, "الشروط والملاحظات", MARGIN + 245, y - 18, bold, 9, GREEN);
    drawRtl(page, fitText(data.notes, regular, 8, 225), MARGIN + 225, y - 38, regular, 8, BLACK);
  }

  const totalPages = pdf.getPageCount();
  pdf.getPages().forEach((pdfPage, index) => {
    pdfPage.drawLine({ start: { x: MARGIN, y: 50 }, end: { x: PAGE_W - MARGIN, y: 50 }, color: BORDER, thickness: 0.6 });
    drawRtl(pdfPage, "شكراً لتعاملكم معنا", PAGE_W - MARGIN, 34, regular, 8, GREEN_DARK);
    pdfPage.drawText(`${index + 1} / ${totalPages}`, { x: MARGIN, y: 34, font: latin, size: 8, color: BLACK });
  });

  pdf.setTitle(`${data.kind === "INVOICE" ? "Invoice" : "Quotation"} ${data.number}`);
  pdf.setCreator("Business Management System");
  pdf.setProducer("Business Management System");
  return pdf.save({ useObjectStreams: false });
}
