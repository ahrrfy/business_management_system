import Decimal from "decimal.js";
import { BRAND as B, esc, fmt, openPrintWindow } from "./brand";
import {
  docTableV2,
  infoCards,
  pageBodyClose,
  pageBodyOpen,
  pageFooter,
  pageHeader,
  wrapMultiA4Doc,
  type CompanySettings,
  type DocTableCol,
} from "./docHtml";
import {
  buildPurchaseInvoiceV2Body,
  buildPurchaseInvoiceV2Html,
  buildSalesInvoiceV2Body,
  buildSalesInvoiceV2Html,
  buildVoucherV2Body,
  buildVoucherV2Html,
  type PurchaseInvoiceV2Data,
  type SalesInvoiceV2Data,
  type VoucherV2Data,
} from "./printTemplatesV2";
import { voucherPrintToV2Data, type VoucherPrintData } from "./voucherPrint";
import { fmtDate } from "../date";
import { D } from "@/lib/money";
import { fmtQty } from "@shared/quantityFormat";
import { invoiceStatusLabel } from "@shared/invoiceStatus";
import { purchaseOrderStatusLabel } from "@shared/purchaseOrderEventType";
import { paymentMethodLabel } from "@/lib/paymentMethod";

export interface BatchInvoiceItem {
  id: number;
  documentNumber: string;
  date: string | Date;
  branchId?: number | null;
  branchName?: string | null;
  status?: string | null;
  paymentMethod?: string | null;
  currency?: string | null;
  agreedRate?: string | number | null;
  usdTotal?: string | number | null;
  subtotal: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
  total: string | number;
  paidAmount?: string | number | null;
  returnedTotal?: string | number | null;
  remainingAmount?: string | number | null;
  notes?: string | null;
  createdByName?: string | null;
  approvedByName?: string | null;
  items: Array<{
    id?: number;
    productName: string;
    unitName?: string | null;
    sku?: string | null;
    quantity: string | number;
    unitPrice: string | number;
    discount?: string | number | null;
    total: string | number;
  }>;
}

export interface BatchInvoicesPrintOptions {
  partyType: "CUSTOMER" | "SUPPLIER";
  partyName: string;
  partyPhone?: string | null;
  from?: string;
  to?: string;
  invoices: BatchInvoiceItem[];
  mode: "merged" | "split";
  detailLevel: "normal" | "detailed";
  selectedIds?: number[];
  printedByName?: string | null;
  settings?: CompanySettings;
}

export interface SplitPrintDocument {
  id: number;
  title: string;
  filename: string;
  html: string;
}

export interface BatchInvoicesPrintResult {
  ok: boolean;
  count: number;
  documents: SplitPrintDocument[];
}

function fmtMoneyVal(v: string | number | Decimal | null | undefined): string {
  const d = v instanceof Decimal ? v : D(v ?? 0);
  return fmt(d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2));
}

function buildInvoicesCoverBody(opts: BatchInvoicesPrintOptions, list: BatchInvoiceItem[]): string {
  const isCustomer = opts.partyType === "CUSTOMER";
  const periodLabel = [opts.from || "البداية", opts.to || "الآن"].join(" — ");

  let totalSum = D(0);
  let paidSum = D(0);
  let remainingSum = D(0);
  for (const inv of list) {
    totalSum = totalSum.plus(D(inv.total));
    paidSum = paidSum.plus(D(inv.paidAmount ?? 0));
    remainingSum = remainingSum.plus(D(inv.remainingAmount ?? 0));
  }

  const header = pageHeader(
    {
      title: isCustomer ? "فهرس فواتير العميل للفترة" : "فهرس فواتير المورد للفترة",
      subtitle: opts.detailLevel === "detailed" ? "مفصل بالبنود — مع الفواتير المستقلة في الصفحات التالية" : "ملخص الفواتير",
      fields: [
        { label: "الفترة", value: periodLabel },
        { label: "عدد الفواتير", value: String(list.length) },
        ...(opts.printedByName ? [{ label: "طالب الطباعة", value: opts.printedByName }] : []),
      ],
    },
    opts.settings,
  );

  const cards = infoCards([
    {
      title: isCustomer ? "العميل" : "المورد",
      variant: "green",
      fields: [
        { label: "الاسم", value: opts.partyName },
        ...(opts.partyPhone ? [{ label: "الهاتف", value: opts.partyPhone }] : []),
      ],
    },
    {
      title: "إجماليات الفترة المحددة",
      variant: "gray",
      fields: [
        { label: "إجمالي الفواتير", value: `${fmtMoneyVal(totalSum)} د.ع` },
        { label: "المدفوع", value: `${fmtMoneyVal(paidSum)} د.ع` },
        { label: "المتبقي", value: `${fmtMoneyVal(remainingSum)} د.ع` },
      ],
    },
  ]);

  const cols: DocTableCol[] = [
    { key: "number", label: "رقم الفاتورة", width: 105 },
    { key: "date", label: "التاريخ", width: 78 },
    { key: "status", label: "الحالة", width: 85 },
    { key: "total", label: "الإجمالي", width: 88 },
    { key: "paid", label: "المدفوع", width: 88, color: B.green },
    { key: "remaining", label: "المتبقي", width: 88, color: B.alert },
  ];

  const rows = list.map((inv) => ({
    number: inv.documentNumber,
    date: fmtDate(inv.date),
    status: inv.status ? (isCustomer ? invoiceStatusLabel(inv.status) : purchaseOrderStatusLabel(inv.status)) : "مكتملة",
    total: fmtMoneyVal(inv.total),
    paid: fmtMoneyVal(inv.paidAmount ?? 0),
    remaining: fmtMoneyVal(inv.remainingAmount ?? 0),
  }));

  const summaryTable = docTableV2(cols, rows, {
    totalsRow: {
      label: "الإجمالي",
      cells: [
        { key: "total", value: fmtMoneyVal(totalSum) },
        { key: "paid", value: fmtMoneyVal(paidSum), color: B.green },
        { key: "remaining", value: fmtMoneyVal(remainingSum), color: B.alert },
      ],
    },
  });

  const detailedItemsBlock =
    opts.detailLevel === "detailed"
      ? list
          .map((inv) => {
            if (!inv.items.length) return "";
            return `<div style="margin-top:8px;padding:6px 10px;border:1px solid ${B.border};border-radius:4px;font-size:9.5px;break-inside:avoid">
              <div style="font-weight:800;color:${B.greenDark};margin-bottom:3px">${esc(inv.documentNumber)} · ${esc(fmtDate(inv.date))}</div>
              <div style="display:flex;flex-wrap:wrap;gap:6px 14px;color:${B.ink}">
                ${inv.items
                  .map(
                    (it) =>
                      `<span>• ${esc(it.productName)}${it.unitName ? ` (${esc(it.unitName)})` : ""}: ${esc(fmtQty(it.quantity))} × ${esc(fmtMoneyVal(it.unitPrice))} = <strong>${esc(fmtMoneyVal(it.total))}</strong></span>`,
                  )
                  .join("")}
              </div>
            </div>`;
          })
          .join("")
      : "";

  return `${pageBodyOpen()}${header}${cards}${summaryTable}${detailedItemsBlock}${pageBodyClose()}${pageFooter(opts.settings, { rightText: `مجموع الفواتير: ${list.length}` })}`;
}

function toSalesV2Data(opts: BatchInvoicesPrintOptions, inv: BatchInvoiceItem): SalesInvoiceV2Data {
  return {
    invoiceNumber: inv.documentNumber,
    invoiceDate: inv.date,
    statusLabel: inv.status ? invoiceStatusLabel(inv.status) : null,
    status: inv.status ?? null,
    customerName: opts.partyName,
    customerPhone: opts.partyPhone ?? null,
    branchName: inv.branchName ?? null,
    paymentMethod: inv.paymentMethod ? paymentMethodLabel(inv.paymentMethod) : null,
    subtotal: inv.subtotal,
    discountAmount: inv.discountAmount ?? null,
    taxAmount: inv.taxAmount ?? null,
    total: inv.total,
    paidAmount: inv.paidAmount ?? null,
    returnedTotal: inv.returnedTotal ?? null,
    remainingAmount: inv.remainingAmount ?? null,
    items: inv.items.map((it) => ({
      productName: it.productName,
      unitName: it.unitName ?? null,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      total: it.total,
    })),
    settings: opts.settings,
  };
}

function toPurchaseV2Data(opts: BatchInvoicesPrintOptions, inv: BatchInvoiceItem): PurchaseInvoiceV2Data {
  return {
    invoiceNumber: inv.documentNumber,
    invoiceDate: inv.date,
    statusLabel: inv.status ? purchaseOrderStatusLabel(inv.status) : null,
    supplierName: opts.partyName,
    supplierPhone: opts.partyPhone ?? null,
    paymentMethod: inv.paymentMethod ? paymentMethodLabel(inv.paymentMethod) : null,
    createdByName: inv.createdByName ?? null,
    approvedByName: inv.approvedByName ?? null,
    agreedCurrency: inv.currency ?? null,
    agreedRate: inv.agreedRate ?? null,
    usdTotal: inv.usdTotal ?? null,
    subtotal: inv.subtotal,
    discountAmount: inv.discountAmount ?? null,
    taxAmount: inv.taxAmount ?? null,
    total: inv.total,
    paidAmount: inv.paidAmount ?? null,
    remainingAmount: inv.remainingAmount ?? null,
    items: inv.items.map((it) => ({
      productName: it.productName,
      unitName: it.unitName ?? null,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      total: it.total,
    })),
    settings: opts.settings,
  };
}

/**
 * طباعة فواتير فترة كاملة لعميل أو مورد:
 * - `merged`: ملف A4 واحد يجمع الفهرس + الفواتير المفصولة بفواصل صفحات.
 * - `split`: فتح/إعداد مستند مستقل لكل فاتورة مع إرجاع HTML المستندات للتنزيل أو الفتح الانتقائي.
 */
export function buildInvoicesBatchDocuments(opts: BatchInvoicesPrintOptions): SplitPrintDocument[] {
  const selectedSet = opts.selectedIds?.length ? new Set(opts.selectedIds) : null;
  const list = selectedSet ? opts.invoices.filter((i) => selectedSet.has(i.id)) : opts.invoices;
  return list.map((inv) => {
    const html =
      opts.partyType === "CUSTOMER"
        ? buildSalesInvoiceV2Html(toSalesV2Data(opts, inv))
        : buildPurchaseInvoiceV2Html(toPurchaseV2Data(opts, inv));
    return {
      id: inv.id,
      title: `${opts.partyType === "CUSTOMER" ? "فاتورة مبيعات" : "فاتورة مشتريات"} ${inv.documentNumber}`,
      filename: `${inv.documentNumber}.html`,
      html,
    };
  });
}

export async function printInvoicesBatch(opts: BatchInvoicesPrintOptions): Promise<BatchInvoicesPrintResult> {
  const selectedSet = opts.selectedIds?.length ? new Set(opts.selectedIds) : null;
  const list = selectedSet ? opts.invoices.filter((i) => selectedSet.has(i.id)) : opts.invoices;
  if (list.length === 0) return { ok: false, count: 0, documents: [] };

  const documents = buildInvoicesBatchDocuments(opts);

  if (opts.mode === "merged") {
    const coverBody = buildInvoicesCoverBody(opts, list);
    const invoiceBodies =
      opts.detailLevel === "normal" && list.length > 1
        ? [coverBody]
        : [
            coverBody,
            ...list.map((inv) =>
              opts.partyType === "CUSTOMER"
                ? buildSalesInvoiceV2Body(toSalesV2Data(opts, inv))
                : buildPurchaseInvoiceV2Body(toPurchaseV2Data(opts, inv)),
            ),
          ];
    const html = wrapMultiA4Doc(`فواتير ${opts.partyName}`, invoiceBodies, {
      badgeLabel: `مجمّع (${list.length} فاتورة)`,
    });
    const ok = openPrintWindow(html);
    return { ok, count: list.length, documents };
  }

  let openedAny = false;
  for (const doc of documents) {
    if (openPrintWindow(doc.html)) openedAny = true;
  }
  return { ok: openedAny, count: list.length, documents };
}

function isVoucherV2(v: VoucherPrintData | VoucherV2Data): v is VoucherV2Data {
  return !("paymentMethod" in v);
}

function downloadSplitDocHtml(doc: SplitPrintDocument): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return false;
  }
  const blob = new Blob([doc.html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = doc.filename;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

export function buildVouchersBatchDocuments(v2List: VoucherV2Data[]): SplitPrintDocument[] {
  return v2List.map((v, idx) => ({
    id: idx + 1,
    title: `${v.direction === "IN" ? "سند قبض" : "سند صرف"} ${v.voucherNumber}`,
    filename: `${v.voucherNumber}.html`,
    html: buildVoucherV2Html(v),
  }));
}

/**
 * طباعة السندات المجمّعة أو المجزّأة من شاشة السندات (`Vouchers.tsx`).
 */
export async function printVouchersBatch(opts: {
  vouchers: Array<VoucherPrintData | VoucherV2Data>;
  mode: "merged" | "split";
  detailLevel: "normal" | "detailed";
  title?: string;
  from?: string;
  to?: string;
  settings?: CompanySettings;
  onSplitDocuments?: (documents: SplitPrintDocument[]) => void;
}): Promise<boolean> {
  if (opts.vouchers.length === 0) return false;

  const v2List: VoucherV2Data[] = [];
  for (const v of opts.vouchers) {
    v2List.push(isVoucherV2(v) ? v : await voucherPrintToV2Data(v));
  }

  if (opts.mode === "split") {
    const documents = buildVouchersBatchDocuments(v2List);
    opts.onSplitDocuments?.(documents);
    let handledAny = false;
    for (const doc of documents) {
      if (openPrintWindow(doc.html)) {
        handledAny = true;
      } else if (downloadSplitDocHtml(doc)) {
        handledAny = true;
      }
    }
    return handledAny;
  }

  let totalIn = D(0);
  let totalOut = D(0);
  for (const v of v2List) {
    if (v.direction === "IN") totalIn = totalIn.plus(D(v.amount));
    else totalOut = totalOut.plus(D(v.amount));
  }

  const periodLabel = [opts.from || "البداية", opts.to || "الآن"].join(" — ");
  const header = pageHeader(
    {
      title: opts.title ?? "سجل سندات القبض والصرف",
      subtitle: opts.detailLevel === "detailed" ? "مفصّل — يتبع الفهرس كل سند بصفحة مستقلة" : "فهرس ملخّص السندات",
      fields: [
        { label: "الفترة", value: periodLabel },
        { label: "العدد", value: String(v2List.length) },
        { label: "إجمالي القبض", value: `${fmtMoneyVal(totalIn)} د.ع` },
        { label: "إجمالي الصرف", value: `${fmtMoneyVal(totalOut)} د.ع` },
      ],
    },
    opts.settings,
  );

  const cols: DocTableCol[] = [
    { key: "num", label: "رقم السند", width: 95 },
    { key: "date", label: "التاريخ", width: 72 },
    { key: "kind", label: "النوع", width: 65 },
    { key: "party", label: "الطرف" },
    { key: "method", label: "الطريقة", width: 78 },
    { key: "amount", label: "المبلغ", width: 88, color: B.greenDark },
  ];

  const rows = v2List.map((v) => ({
    num: v.voucherNumber,
    date: fmtDate(v.voucherDate),
    kind: v.direction === "IN" ? "قبض" : "صرف",
    party: `${v.partyTypeLabel}: ${v.partyName}`,
    method: v.paymentMethodLabel,
    amount: fmtMoneyVal(v.amount),
  }));

  const table = docTableV2(cols, rows);
  const indexBody = `${pageBodyOpen()}${header}${table}${pageBodyClose()}${pageFooter(opts.settings, { rightText: `إجمالي السندات: ${v2List.length}` })}`;

  const pages =
    opts.detailLevel === "normal" && v2List.length > 1
      ? [indexBody]
      : [indexBody, ...v2List.map((v) => buildVoucherV2Body(v))];

  const html = wrapMultiA4Doc(opts.title ?? "طباعة السندات", pages, {
    badgeLabel: `مجمّع (${v2List.length} سند)`,
  });
  return openPrintWindow(html);
}
