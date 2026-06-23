/**
 * دالات تَنسيق النَسخ المُوَحَّدة — مَصدَر الحَقيقة لِكُل عَمَليّات «انسَخ كَنَصّ» في النِظام.
 *
 * المَبادِئ:
 *  - الأَموال عَبر lib/money.ts (round2/fmtAr) — لا parseFloat/Number مُباشَر.
 *  - التَوارِيخ عَبر lib/date.ts (fmtDate/fmtDateTime).
 *  - رَسائِل واتساب تَمُرّ عَبر sanitizeForWhatsApp ⇒ بِلا إيموجي مُطلَقاً.
 *  - بِنية RTL عَرَبية، أَسطُر بَسيطة قابِلة لِلَصق في واتساب/مُلاحَظة/Excel.
 *  - TSV لا يَسمَح بِالـtab/newline داخِل الخَلية ⇒ يُستَبدَل بِمَسافة.
 */

import { fmtAr, round2, D } from "@/lib/money";
import { fmtDate, fmtDateTime, type DateInput } from "@/lib/date";
import { sanitizeForWhatsApp } from "@/lib/whatsapp";

const COMPANY_NAME = "المكتبة العربية للطباعة والقرطاسية";
const SEP = "————————————————";

// ─────────────────────────────────────────────
// أَدوات داخِلية
// ─────────────────────────────────────────────

/** قيمة قابِلة لِلعَرض كَنَصّ نَظيف (يُزال undefined/null/فارِغ). */
function txt(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/** خَلية TSV آمِنة: tab/newline داخِلية → مَسافة. */
function tsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[\t\r\n]+/g, " ").trim();
}

/** تَنسيق رَقم بِلا فَواصِل أَلوف — جاهِز لِلَصق في Excel. */
export function formatNumberPlain(
  n: number | string | null | undefined,
  opts?: { decimals?: number },
): string {
  if (n === null || n === undefined || n === "") return "";
  const decimals = opts?.decimals;
  if (decimals !== undefined) {
    return round2(D(n)).toDecimalPlaces(decimals).toFixed(decimals);
  }
  // الافتراضي: قيمة decimal كَما هي بِلا فَواصِل
  return D(n).toString();
}

// ─────────────────────────────────────────────
// 1) فاتورة — واتساب
// ─────────────────────────────────────────────

export interface InvoiceCopyData {
  number: string;
  date?: DateInput;
  customer?: string | null;
  items: Array<{
    name: string;
    qty: string | number;
    unit?: string | null;
    price?: string | number | null;
    total: string | number;
  }>;
  subtotal?: string | number | null;
  discount?: string | number | null;
  tax?: string | number | null;
  total: string | number;
  paid?: string | number | null;
  remaining?: string | number | null;
}

export function formatInvoiceAsWhatsApp(inv: InvoiceCopyData): string {
  const L: string[] = [];
  L.push(`*فاتورة بَيع #${txt(inv.number)}*`);
  L.push(`التاريخ: ${fmtDate(inv.date) === "—" ? fmtDate(new Date()) : fmtDate(inv.date)}`);
  if (inv.customer) L.push(`العَميل: ${txt(inv.customer)}`);
  L.push(COMPANY_NAME);
  L.push(SEP);

  L.push("*البُنود:*");
  for (const it of inv.items) {
    const unit = it.unit ? ` ${txt(it.unit)}` : "";
    L.push(`- ${txt(it.name)} × ${fmtAr(it.qty)}${unit} = ${fmtAr(it.total)} د.ع`);
  }
  L.push(SEP);

  if (inv.subtotal !== null && inv.subtotal !== undefined) {
    L.push(`المَجموع: ${fmtAr(inv.subtotal)} د.ع`);
  }
  if (inv.discount && Number(inv.discount) > 0) {
    L.push(`الخَصم: ${fmtAr(inv.discount)} د.ع`);
  }
  if (inv.tax && Number(inv.tax) > 0) {
    L.push(`الضَريبة: ${fmtAr(inv.tax)} د.ع`);
  }
  L.push(`*الإجمالي: ${fmtAr(inv.total)} د.ع*`);

  if (inv.paid !== null && inv.paid !== undefined && Number(inv.paid) > 0) {
    L.push(`المَدفوع: ${fmtAr(inv.paid)} د.ع`);
  }
  const remaining =
    inv.remaining !== null && inv.remaining !== undefined
      ? Number(inv.remaining)
      : Number(inv.total) - Number(inv.paid ?? 0);
  if (remaining > 0) {
    L.push(`*المُتَبَقّي: ${fmtAr(remaining)} د.ع*`);
  } else if (Number(inv.paid ?? 0) > 0 && remaining <= 0) {
    L.push("*مَدفوعة بِالكامِل*");
  }

  L.push("");
  L.push(`شُكراً لِتَعامُلكُم — ${COMPANY_NAME}`);

  return sanitizeForWhatsApp(L.join("\n"));
}

// ─────────────────────────────────────────────
// 2) عَرض سِعر — واتساب
// ─────────────────────────────────────────────

export interface QuotationCopyData {
  number: string;
  date?: DateInput;
  validUntil?: DateInput;
  customer?: string | null;
  items: Array<{
    name: string;
    qty: string | number;
    unit?: string | null;
    price?: string | number | null;
    total: string | number;
  }>;
  subtotal?: string | number | null;
  discount?: string | number | null;
  tax?: string | number | null;
  total: string | number;
  notes?: string | null;
}

export function formatQuotationAsWhatsApp(q: QuotationCopyData): string {
  const L: string[] = [];
  L.push(`*عَرض سِعر #${txt(q.number)}*`);
  L.push(`التاريخ: ${fmtDate(q.date) === "—" ? fmtDate(new Date()) : fmtDate(q.date)}`);
  if (q.validUntil) L.push(`صالِح حَتّى: ${fmtDate(q.validUntil)}`);
  if (q.customer) L.push(`العَميل: ${txt(q.customer)}`);
  L.push(COMPANY_NAME);
  L.push(SEP);

  L.push("*البُنود:*");
  for (const it of q.items) {
    const unit = it.unit ? ` ${txt(it.unit)}` : "";
    L.push(`- ${txt(it.name)} × ${fmtAr(it.qty)}${unit} = ${fmtAr(it.total)} د.ع`);
  }
  L.push(SEP);

  if (q.subtotal !== null && q.subtotal !== undefined) {
    L.push(`المَجموع: ${fmtAr(q.subtotal)} د.ع`);
  }
  if (q.discount && Number(q.discount) > 0) {
    L.push(`الخَصم: ${fmtAr(q.discount)} د.ع`);
  }
  if (q.tax && Number(q.tax) > 0) {
    L.push(`الضَريبة: ${fmtAr(q.tax)} د.ع`);
  }
  L.push(`*الإجمالي: ${fmtAr(q.total)} د.ع*`);

  if (q.notes) {
    L.push("");
    L.push(`مُلاحَظة: ${txt(q.notes)}`);
  }

  L.push("");
  L.push("لِلتَأكيد أَو الاستِفسار تَواصَلوا مَعَنا.");
  L.push(COMPANY_NAME);

  return sanitizeForWhatsApp(L.join("\n"));
}

// ─────────────────────────────────────────────
// 3) كَشف حِساب — واتساب
// ─────────────────────────────────────────────

export interface StatementCopyData {
  entityName: string;
  entityType: "customer" | "supplier";
  lines: Array<{
    date: DateInput;
    doc: string;
    debit: string | number | null;
    credit: string | number | null;
    balance: string | number;
  }>;
  closingBalance: string | number;
  asOfDate?: DateInput;
}

export function formatStatementAsWhatsApp(s: StatementCopyData): string {
  const L: string[] = [];
  const isCustomer = s.entityType === "customer";

  L.push(`*كَشف حِساب — ${txt(s.entityName)}*`);
  L.push(`حَتّى: ${fmtDate(s.asOfDate) === "—" ? fmtDate(new Date()) : fmtDate(s.asOfDate)}`);
  L.push(COMPANY_NAME);
  L.push(SEP);

  if (s.lines.length === 0) {
    L.push("لا تَوجَد حَرَكات.");
  } else {
    L.push("*الحَرَكات:*");
    for (const ln of s.lines) {
      const dr = ln.debit && Number(ln.debit) !== 0 ? `مَدين ${fmtAr(ln.debit)}` : "";
      const cr = ln.credit && Number(ln.credit) !== 0 ? `دائِن ${fmtAr(ln.credit)}` : "";
      const drcr = [dr, cr].filter(Boolean).join(" | ");
      L.push(`- ${fmtDate(ln.date)} | ${txt(ln.doc)} | ${drcr} | الرَصيد ${fmtAr(ln.balance)}`);
    }
  }

  L.push(SEP);

  const bal = Number(s.closingBalance);
  const abs = fmtAr(Math.abs(bal));
  let closing: string;
  if (bal === 0) {
    closing = "*الحِساب مُسَوّى — لا رَصيد مُستَحَقّ.*";
  } else if (isCustomer) {
    closing = bal > 0
      ? `*الرَصيد الحالي (لَنا عَلَيكُم): ${abs} د.ع*`
      : `*الرَصيد الحالي (لَكُم عَلَينا): ${abs} د.ع*`;
  } else {
    closing = bal > 0
      ? `*الرَصيد الحالي (لَكُم عَلَينا): ${abs} د.ع*`
      : `*الرَصيد الحالي (لَنا عَلَيكُم): ${abs} د.ع*`;
  }
  L.push(closing);

  L.push("");
  L.push("لِلمُراجَعة والتَسوية تَواصَلوا مَعَنا.");
  L.push(COMPANY_NAME);

  return sanitizeForWhatsApp(L.join("\n"));
}

// ─────────────────────────────────────────────
// 4) أَمر شُغل — واتساب
// ─────────────────────────────────────────────

export interface WorkOrderCopyData {
  number: string;
  date?: DateInput;
  customer?: string | null;
  description?: string | null;
  status?: string | null;
  items?: Array<{
    name: string;
    qty: string | number;
    unit?: string | null;
    notes?: string | null;
  }>;
  deposit?: string | number | null;
  total?: string | number | null;
  remaining?: string | number | null;
  deliveryDate?: DateInput;
}

export function formatWorkOrderAsWhatsApp(wo: WorkOrderCopyData): string {
  const L: string[] = [];
  L.push(`*أَمر شُغل #${txt(wo.number)}*`);
  L.push(`التاريخ: ${fmtDate(wo.date) === "—" ? fmtDate(new Date()) : fmtDate(wo.date)}`);
  if (wo.customer) L.push(`العَميل: ${txt(wo.customer)}`);
  if (wo.status) L.push(`الحالة: ${txt(wo.status)}`);
  if (wo.deliveryDate) L.push(`مَوعِد التَسليم: ${fmtDate(wo.deliveryDate)}`);
  L.push(COMPANY_NAME);
  L.push(SEP);

  if (wo.description) {
    L.push("*الوَصف:*");
    L.push(txt(wo.description));
    L.push(SEP);
  }

  if (wo.items && wo.items.length > 0) {
    L.push("*البُنود:*");
    for (const it of wo.items) {
      const unit = it.unit ? ` ${txt(it.unit)}` : "";
      const notes = it.notes ? ` — ${txt(it.notes)}` : "";
      L.push(`- ${txt(it.name)} × ${fmtAr(it.qty)}${unit}${notes}`);
    }
    L.push(SEP);
  }

  if (wo.total !== null && wo.total !== undefined) {
    L.push(`*الإجمالي: ${fmtAr(wo.total)} د.ع*`);
  }
  if (wo.deposit !== null && wo.deposit !== undefined && Number(wo.deposit) > 0) {
    L.push(`العَربون: ${fmtAr(wo.deposit)} د.ع`);
  }
  if (wo.remaining !== null && wo.remaining !== undefined && Number(wo.remaining) > 0) {
    L.push(`*المُتَبَقّي: ${fmtAr(wo.remaining)} د.ع*`);
  }

  L.push("");
  L.push("سَنُبلِغكُم عِند الإنجاز.");
  L.push(COMPANY_NAME);

  return sanitizeForWhatsApp(L.join("\n"));
}

// ─────────────────────────────────────────────
// 5) كارت عَميل — نَصّ مُختَصَر
// ─────────────────────────────────────────────

export interface CustomerCardCopyData {
  name: string;
  phone?: string | null;
  balance?: string | number | null;
  lastInvoice?: {
    number?: string | null;
    date?: DateInput;
    total?: string | number | null;
  } | null;
  legacyCode?: string | null;
  email?: string | null;
}

export function formatCustomerCard(c: CustomerCardCopyData): string {
  const L: string[] = [];
  L.push(`الاسم: ${txt(c.name)}`);
  if (c.legacyCode) L.push(`الرَمز: ${txt(c.legacyCode)}`);
  if (c.phone) L.push(`الهاتِف: ${txt(c.phone)}`);
  if (c.email) L.push(`البَريد: ${txt(c.email)}`);

  if (c.balance !== null && c.balance !== undefined) {
    const bal = Number(c.balance);
    if (bal === 0) {
      L.push("الرَصيد الحالي: مُسَوّى");
    } else if (bal > 0) {
      L.push(`الرَصيد الحالي (لَنا عَلَيه): ${fmtAr(bal)} د.ع`);
    } else {
      L.push(`الرَصيد الحالي (لَه عَلَينا): ${fmtAr(Math.abs(bal))} د.ع`);
    }
  }

  if (c.lastInvoice) {
    const parts: string[] = [];
    if (c.lastInvoice.number) parts.push(`#${txt(c.lastInvoice.number)}`);
    if (c.lastInvoice.date) parts.push(fmtDate(c.lastInvoice.date));
    if (c.lastInvoice.total !== null && c.lastInvoice.total !== undefined) {
      parts.push(`${fmtAr(c.lastInvoice.total)} د.ع`);
    }
    if (parts.length > 0) L.push(`آخِر فاتورة: ${parts.join(" — ")}`);
  }

  return L.join("\n");
}

// ─────────────────────────────────────────────
// 6) صَفّ TSV واحِد
// ─────────────────────────────────────────────

export function formatRowAsTSV(
  headers: string[],
  values: (string | number | null | undefined)[],
): string {
  const head = headers.map(tsvCell).join("\t");
  const row = values.map(tsvCell).join("\t");
  return `${head}\n${row}`;
}

// ─────────────────────────────────────────────
// 7) جَدول TSV كامِل
// ─────────────────────────────────────────────

export function formatTableAsTSV(
  headers: string[],
  rows: Array<Record<string, unknown>>,
): string {
  const head = headers.map(tsvCell).join("\t");
  const body = rows
    .map((r) => headers.map((h) => tsvCell(r[h])).join("\t"))
    .join("\n");
  return body ? `${head}\n${body}` : head;
}

// ─────────────────────────────────────────────
// 9) تَقرير Z — نَصّ مُلَخَّص (لِلَصق في مُلاحَظة/واتساب الإدارة)
// ─────────────────────────────────────────────

export interface ZReportCopyData {
  shiftId: string | number;
  opened: DateInput;
  closed?: DateInput;
  openingFloat: string | number;
  cashIn: string | number;
  cashOut: string | number;
  expectedCash: string | number;
  countedCash?: string | number | null;
  variance?: string | number | null;
}

export function formatZReportAsText(z: ZReportCopyData): string {
  const L: string[] = [];
  L.push(`*تَقرير Z — وَردِية #${txt(z.shiftId)}*`);
  L.push(`الفَتح: ${fmtDateTime(z.opened)}`);
  if (z.closed) L.push(`الإغلاق: ${fmtDateTime(z.closed)}`);
  L.push(COMPANY_NAME);
  L.push(SEP);

  L.push(`الرَصيد الافتِتاحي: ${fmtAr(z.openingFloat)} د.ع`);
  L.push(`النَقد الداخِل: ${fmtAr(z.cashIn)} د.ع`);
  L.push(`النَقد الخارِج: ${fmtAr(z.cashOut)} د.ع`);
  L.push(`المُتَوَقَّع في الصُندوق: ${fmtAr(z.expectedCash)} د.ع`);

  if (z.countedCash !== null && z.countedCash !== undefined) {
    L.push(`المَعدود فِعلياً: ${fmtAr(z.countedCash)} د.ع`);
  }
  if (z.variance !== null && z.variance !== undefined) {
    const v = Number(z.variance);
    if (v === 0) {
      L.push("*الفَرق: مُطابِق*");
    } else if (v > 0) {
      L.push(`*الفَرق (زِيادة): ${fmtAr(v)} د.ع*`);
    } else {
      L.push(`*الفَرق (عَجز): ${fmtAr(Math.abs(v))} د.ع*`);
    }
  }

  return sanitizeForWhatsApp(L.join("\n"));
}
