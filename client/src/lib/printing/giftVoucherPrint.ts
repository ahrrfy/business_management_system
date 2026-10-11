/**
 * محرك طباعة قسيمة الهدية الفورية وترضية الزبائن (Thermal Gift Voucher 80mm).
 * يولد مستنداً حرارياً أصولياً متدرجاً (جسر الخادم -> WebUSB -> نافذة المتصفح).
 */

import { fmtAr } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { printDoc } from "@/lib/printing/print";
import { isPaired } from "@/lib/printing/thermal";
import { reservePrintWindow, releaseReservedPrintWindow } from "@/lib/printing/brand";
import type { PrintDoc } from "@/lib/printing/render";

export interface GiftVoucherPrintData {
  code?: string;
  couponCode?: string;
  amount: string | number;
  discountPercent?: string | number | null;
  customerName: string;
  customerPhone?: string | null;
  reason?: string | null;
  validUntil?: string | null;
  terms?: string | null;
  discountScope?: "fixed_credit" | "per_unit";
  totalLabel?: string;
  itemDescription?: string;
}

/**
 * تحليل وتنسيق قيمة الخصم المئوي إن وُجدت، لمنع انهيار Decimal.js.
 */
function resolvePercentageDiscount(data: GiftVoucherPrintData): string | null {
  // 1. إذا تم تمرير discountPercent صراحة
  if (data.discountPercent != null && data.discountPercent !== "") {
    const pStr = String(data.discountPercent).trim();
    return pStr.includes("%") || pStr.includes("٪") ? pStr : `${pStr}%`;
  }

  // 2. إذا احتوت قيمة data.amount على رمز النسبة المئوية (% أو ٪)
  if (typeof data.amount === "string") {
    const trimmed = data.amount.trim();
    if (trimmed.includes("%") || trimmed.includes("٪")) {
      return trimmed;
    }
  }

  // 3. إذا كان المبلغ صفراً أو فارغاً وكان سبب الإهداء أو الشروط يذكر نسبة مئوية
  const isZeroOrEmpty =
    data.amount == null ||
    data.amount === "" ||
    data.amount === 0 ||
    data.amount === "0" ||
    (typeof data.amount === "string" && !Number.isNaN(Number(data.amount)) && Number(data.amount) === 0);

  if (isZeroOrEmpty) {
    const textToCheck = `${data.reason ?? ""} ${data.terms ?? ""}`.trim();
    if (textToCheck) {
      const match = textToCheck.match(/(\d+(?:\.\d+)?)\s*([%٪])/);
      if (match) {
        return `${match[1]}${match[2]}`;
      }
      if (
        textToCheck.includes("%") ||
        textToCheck.includes("٪") ||
        textToCheck.includes("نسبة") ||
        textToCheck.includes("مئوي")
      ) {
        return data.reason || "خصم مئوي";
      }
    }
  }

  return null;
}

function formatCurrencyAmount(amount: string | number | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  try {
    return fmtAr(amount);
  } catch {
    return String(amount);
  }
}

export function giftVoucherToPrintDoc(data: GiftVoucherPrintData): PrintDoc {
  const percentDiscount = resolvePercentageDiscount(data);
  const now = new Date();
  const code = data.code || data.couponCode || "GIFT";

  let itemBlockName = "رصيد هدية معتمد في المطبعة والقرطاسية";
  let itemPrice = "";
  let itemTotal = "";
  let totalLabel = "قيمة القسيمة";
  let totalValue = "";

  if (percentDiscount) {
    itemBlockName = "خصم معتمد في المطبعة والقرطاسية";
    itemPrice = `1 × ${percentDiscount}`;
    itemTotal = percentDiscount;
    totalLabel = "نسبة الخصم";
    totalValue = percentDiscount;
  } else if (data.discountScope === "per_unit") {
    const formattedAmount = formatCurrencyAmount(data.amount);
    itemBlockName = data.itemDescription || "خصم ترويجي لكل قطعة/وحدة مؤهلة";
    itemPrice = `1 × ${formattedAmount} د.ع`;
    itemTotal = `${formattedAmount} د.ع/وحدة`;
    totalLabel = data.totalLabel || "قيمة الخصم للوحدة";
    totalValue = `${formattedAmount} د.ع / وحدة`;
  } else {
    const formattedAmount = formatCurrencyAmount(data.amount);
    itemPrice = `1 × ${formattedAmount} د.ع`;
    itemTotal = `${formattedAmount} د.ع`;
    totalLabel = data.totalLabel || "قيمة القسيمة";
    totalValue = `${formattedAmount} د.ع`;
  }

  return {
    kind: "receipt",
    title: percentDiscount || data.discountScope === "per_unit" ? "قسيمة خصم ترويجي" : "قسيمة هدية وترضية",
    subtitle: "المكتبة العربية للطباعة والقرطاسية",
    meta: [
      `التاريخ: ${fmtDate(now)}`,
      `رمز الكوبون: ${code}`,
      `الزبون: ${data.customerName}`,
      ...(data.customerPhone ? [`الهاتف: ${data.customerPhone}`] : []),
      ...(data.reason ? [`نوع الإهداء: ${data.reason}`] : []),
      ...(data.validUntil ? [`صالحة لغاية: ${data.validUntil}`] : []),
    ],
    itemBlocks: [
      {
        name: itemBlockName,
        quantityPrice: itemPrice,
        total: itemTotal,
      },
    ],
    totals: [{ label: totalLabel, value: totalValue }],
    footer:
      data.terms ||
      "تُستخدم القسيمة لمرة واحدة عند المحاسبة • نعتز بثقتكم ونسعى لخدمتكم بأفضل معايير الجودة",
    includeBrandHeader: true,
  };
}

export async function printGiftVoucher(data: GiftVoucherPrintData) {
  const isPairedPrinter = isPaired();
  const reserved = !isPairedPrinter && reservePrintWindow("width=380,height=640");
  try {
    const doc = giftVoucherToPrintDoc(data);
    const res = await printDoc(doc);
    if (res.ok && res.via !== "browser") {
      releaseReservedPrintWindow();
    }
    return res;
  } catch (err) {
    if (reserved) releaseReservedPrintWindow();
    throw err;
  }
}

export const printGiftVoucherDoc = printGiftVoucher;
