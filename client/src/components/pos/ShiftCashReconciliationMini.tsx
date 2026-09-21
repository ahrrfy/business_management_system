// مكوّن تفصيل وبيان مصادر نقد الوردية ومطابقته (شاشات إغلاق الوردية POS و Reception).
// يُفكّك معادلة النقد المتوقع ويَفرز المبيعات النقدية عن تحصيل الديون والعرابين والمصاريف.

import { useState } from "react";
import { ChevronDown, ChevronUp, ArrowDownLeft, ArrowUpRight, Receipt, Info } from "lucide-react";
import { fmtTime } from "@/lib/date";
import { fmt } from "./posShared";
import { D } from "@/lib/money";

export interface CashTraceItem {
  receiptId?: number | null;
  documentType?: string | null;
  documentId?: string | number | null;
  invoiceNumber?: string | null;
  voucherNumber?: number | string | null;
  referenceNumber?: string | null;
  description?: string | null;
  amount: string | number;
  createdByName?: string | null;
  timestamp?: string | Date | null;
  direction?: "IN" | "OUT" | null;
  category?: string | null;
}

export interface CashReconciliationReportData {
  opening?: string | number | null;
  cashSales?: string | number | null;
  priorInvoiceCollections?: string | number | null;
  otherCashIn?: string | number | null;
  cashRefunds?: string | number | null;
  expenses?: string | number | null;
  cashDrops?: string | number | null;
  otherCashOut?: string | number | null;
  expectedCash?: string | number | null;
  breakdown?: {
    opening?: CashTraceItem[];
    cashSales?: CashTraceItem[];
    priorInvoiceCollections?: CashTraceItem[];
    otherCashIn?: CashTraceItem[];
    cashRefunds?: CashTraceItem[];
    expenses?: CashTraceItem[];
    cashDrops?: CashTraceItem[];
    otherCashOut?: CashTraceItem[];
  };
}

interface ShiftCashReconciliationMiniProps {
  cashReconciliation?: CashReconciliationReportData | null;
  invoiceCount?: number;
  salesTotal?: string | number;
  openingBalance?: string | number;
  expectedCash?: string | number;
  showExpected?: boolean;
}

function docLabel(item: CashTraceItem, category: string): { label: string; docNo: string; isIncome: boolean } {
  const isIncome = item.direction === "IN" || category === "priorInvoiceCollections" || category === "otherCashIn" || category === "cashSales";
  
  let label = "إيصال نقدي";
  if (category === "priorInvoiceCollections") {
    label = "سداد دين / فاتورة سابقة";
  } else if (category === "otherCashIn") {
    label = item.documentType === "WORK_ORDER" ? "عربون طلب عمل" : item.documentType === "RESERVATION" ? "عربون حجز" : "قبض نقدي وارد";
  } else if (category === "cashSales") {
    label = "مبيعات نقدية";
  } else if (category === "expenses") {
    label = "مصروف نقدي";
  } else if (category === "cashDrops") {
    label = "توريد نقد للخزينة";
  } else if (category === "cashRefunds") {
    label = "مرتجع نقدي";
  } else if (category === "otherCashOut") {
    label = "صرف نقدي خارج";
  }

  const docNo = item.invoiceNumber
    ? `فاتورة #${item.invoiceNumber}`
    : item.referenceNumber
      ? item.referenceNumber
      : item.voucherNumber
        ? `سند #${item.voucherNumber}`
        : item.documentId
          ? `#${item.documentId}`
          : item.receiptId
            ? `إيصال #${item.receiptId}`
            : "—";

  return { label, docNo, isIncome };
}

export function ShiftCashReconciliationMini({
  cashReconciliation,
  invoiceCount = 0,
  salesTotal = "0",
  openingBalance = 0,
  expectedCash = 0,
  showExpected = true,
}: ShiftCashReconciliationMiniProps) {
  const rec = cashReconciliation;
  const breakdown = rec?.breakdown;

  // استخراج جميع الحركات النقدية المفصلة (عدا سطر الافتتاح)
  const allItems: Array<{ item: CashTraceItem; category: string }> = [];
  if (breakdown) {
    const pushCategory = (cat: string, items?: CashTraceItem[]) => {
      if (items && Array.isArray(items)) {
        for (const it of items) {
          allItems.push({ item: it, category: cat });
        }
      }
    };
    pushCategory("priorInvoiceCollections", breakdown.priorInvoiceCollections);
    pushCategory("otherCashIn", breakdown.otherCashIn);
    pushCategory("cashSales", breakdown.cashSales);
    pushCategory("expenses", breakdown.expenses);
    pushCategory("cashRefunds", breakdown.cashRefunds);
    pushCategory("cashDrops", breakdown.cashDrops);
    pushCategory("otherCashOut", breakdown.otherCashOut);
  }

  const priorCollectionsD = D(rec?.priorInvoiceCollections ?? 0);
  const otherInD = D(rec?.otherCashIn ?? 0);
  const cashSalesD = D(rec?.cashSales ?? 0);
  const expensesD = D(rec?.expenses ?? 0);
  const refundsD = D(rec?.cashRefunds ?? 0);
  const dropsD = D(rec?.cashDrops ?? 0);
  const otherOutD = D(rec?.otherCashOut ?? 0);

  // إذا وُجدت مقبوضات واردة غير مرتبطة بمبيعات (مثل حالة سداد الديون أو العرابين عند 0 فواتير)، يُفتح التفصيل افتراضياً
  const hasSpecialInflow = priorCollectionsD.gt(0) || otherInD.gt(0) || (invoiceCount === 0 && allItems.length > 0);
  const [showDetails, setShowDetails] = useState(hasSpecialInflow);

  return (
    <div className="my-3 space-y-2 text-xs">
      {/* ملخص تفكيك معادلة النقد الصندوقي */}
      <div className="rounded-xl border border-border/70 bg-card/60 p-3 space-y-1.5">
        <div className="flex items-center justify-between pb-1.5 border-b border-border/50 text-[11.5px] font-semibold text-muted-foreground">
          <span>بيان مصادر نقد الصندوق (الدرج)</span>
          <span className="text-[10.5px]">المعادلة الحسابية</span>
        </div>

        {/* 1. الرصيد الافتتاحي */}
        <div className="flex items-center justify-between text-muted-foreground">
          <span>الرصيد الافتتاحي</span>
          <span className="font-semibold text-foreground" dir="ltr">{fmt(Number(openingBalance))} د.ع</span>
        </div>

        {/* 2. مبيعات نقدية للوردية */}
        <div className="flex items-center justify-between text-muted-foreground">
          <span>
            مبيعات نقدية (فواتير الوردية)
            {invoiceCount > 0 && <span className="mr-1 text-[11px] opacity-75">({invoiceCount} فاتورة)</span>}
          </span>
          <span className={`font-semibold ${cashSalesD.gt(0) ? "text-emerald-500 font-bold" : "text-foreground"}`} dir="ltr">
            {cashSalesD.gt(0) ? `+${fmt(cashSalesD.toNumber())}` : "0"} د.ع
          </span>
        </div>

        {/* 3. تحصيل فواتير/ديون سابقة لعملاء */}
        {priorCollectionsD.gt(0) && (
          <div className="flex items-center justify-between bg-emerald-500/10 dark:bg-emerald-950/30 px-2 py-1 rounded-md text-emerald-600 dark:text-emerald-400 font-medium">
            <span className="flex items-center gap-1">
              <ArrowDownLeft className="h-3.5 w-3.5 shrink-0" />
              تحصيل ديون / فواتير سابقة
            </span>
            <span className="font-bold" dir="ltr">+{fmt(priorCollectionsD.toNumber())} د.ع</span>
          </div>
        )}

        {/* 4. مقبوضات وعرابين نقدية أخرى */}
        {otherInD.gt(0) && (
          <div className="flex items-center justify-between bg-emerald-500/10 dark:bg-emerald-950/30 px-2 py-1 rounded-md text-emerald-600 dark:text-emerald-400 font-medium">
            <span className="flex items-center gap-1">
              <ArrowDownLeft className="h-3.5 w-3.5 shrink-0" />
              مقبوضات وعرابين نقدية واردة
            </span>
            <span className="font-bold" dir="ltr">+{fmt(otherInD.toNumber())} د.ع</span>
          </div>
        )}

        {/* 5. مصاريف نقدية */}
        {expensesD.gt(0) && (
          <div className="flex items-center justify-between bg-rose-500/10 dark:bg-rose-950/30 px-2 py-1 rounded-md text-rose-600 dark:text-rose-400">
            <span className="flex items-center gap-1">
              <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
              مصاريف نقدية من الدرج
            </span>
            <span className="font-bold" dir="ltr">−{fmt(expensesD.toNumber())} د.ع</span>
          </div>
        )}

        {/* 6. مرتجعات نقدية */}
        {refundsD.gt(0) && (
          <div className="flex items-center justify-between text-rose-600 dark:text-rose-400">
            <span className="flex items-center gap-1">
              <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
              مرتجعات نقدية للعملاء
            </span>
            <span className="font-bold" dir="ltr">−{fmt(refundsD.toNumber())} د.ع</span>
          </div>
        )}

        {/* 7. سحب نقد إلى الخزينة (Cash Drop) */}
        {dropsD.gt(0) && (
          <div className="flex items-center justify-between text-amber-600 dark:text-amber-400">
            <span className="flex items-center gap-1">
              <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
              توريد أمانات نقد للخزينة (Cash Drop)
            </span>
            <span className="font-bold" dir="ltr">−{fmt(dropsD.toNumber())} د.ع</span>
          </div>
        )}

        {/* 8. مدفوعات أخرى خارجة */}
        {otherOutD.gt(0) && (
          <div className="flex items-center justify-between text-rose-600 dark:text-rose-400">
            <span>مدفوعات نقدية أخرى</span>
            <span className="font-bold" dir="ltr">−{fmt(otherOutD.toNumber())} د.ع</span>
          </div>
        )}

        {/* النتيجة النهائية المتوقعة */}
        <div className="pt-2 mt-1 border-t border-border flex items-center justify-between font-bold text-sm">
          <span className="text-foreground">النقد المتوقع بالصندوق</span>
          {showExpected ? (
            <span className="text-primary text-base font-extrabold" dir="ltr">
              {fmt(Number(expectedCash))} د.ع
            </span>
          ) : (
            <span className="text-muted-foreground text-xs font-normal">
              (يظهر بعد إدخال النقد المعدود)
            </span>
          )}
        </div>
      </div>

      {/* تنبيه تعليمي في حال وجود مقبوضات نقدية دون مبيعات فواتير */}
      {showExpected && invoiceCount === 0 && (priorCollectionsD.gt(0) || otherInD.gt(0)) && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/25 p-2.5 text-[11.5px] text-amber-700 dark:text-amber-300 flex items-start gap-2">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <strong>توضيح المبلغ المتوقع:</strong> لم تصدر فواتير بيع في هذه الوردية، لكن وُجدت مقبوضات نقدية (مثل تحصيل ديون سابقة أو استلام عربين) دخلت الصندوق مباشرة وتُطلب مطابقتها.
          </div>
        </div>
      )}

      {/* زر وقائمة تفاصيل الحركات الفردية */}
      {showExpected && allItems.length > 0 && (
        <div className="rounded-xl border border-border/70 bg-card/40 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            className="w-full flex items-center justify-between p-2.5 bg-muted/40 hover:bg-muted/70 transition-colors text-right font-semibold text-foreground text-xs"
          >
            <span className="flex items-center gap-1.5">
              <Receipt className="h-3.5 w-3.5 text-primary" />
              تفاصيل الحركات النقدية بالصندوق ({allItems.length} حركة)
            </span>
            {showDetails ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>

          {showDetails && (
            <div className="p-2 space-y-1.5 max-h-56 overflow-y-auto divide-y divide-border/40">
              {allItems.map(({ item, category }, idx) => {
                const { label, docNo, isIncome } = docLabel(item, category);
                const amtNum = Number(item.amount);
                return (
                  <div key={item.receiptId ?? idx} className="pt-1.5 first:pt-0 flex items-start justify-between gap-2">
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          isIncome ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                        }`}>
                          {label}
                        </span>
                        <span className="text-[11px] font-mono text-muted-foreground">{docNo}</span>
                      </div>
                      {item.description && (
                        <div className="text-[11px] text-foreground font-medium truncate max-w-[240px]">
                          {item.description}
                        </div>
                      )}
                      <div className="text-[10px] text-muted-foreground">
                        {item.timestamp ? fmtTime(item.timestamp) : ""}
                        {item.createdByName ? ` · ${item.createdByName}` : ""}
                      </div>
                    </div>
                    <div className="text-left shrink-0">
                      <span className={`font-bold font-mono text-xs ${isIncome ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`} dir="ltr">
                        {isIncome ? "+" : "−"}{fmt(amtNum)} د.ع
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
