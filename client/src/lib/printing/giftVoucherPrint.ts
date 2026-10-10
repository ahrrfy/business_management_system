/**
 * محرك طباعة قسيمة الهدية الفورية وترضية الزبائن (Thermal Gift Voucher 80mm).
 * يولد مستنداً حرارياً أصولياً متدرجاً (جسر الخادم -> WebUSB -> نافذة المتصفح).
 */

import { fmtAr } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { printDoc } from "@/lib/printing/print";
import type { PrintDoc } from "@/lib/printing/render";

export interface GiftVoucherPrintData {
  code?: string;
  couponCode?: string;
  amount: string | number;
  customerName: string;
  customerPhone?: string | null;
  reason?: string | null;
  validUntil?: string | null;
  terms?: string | null;
}

export function giftVoucherToPrintDoc(data: GiftVoucherPrintData): PrintDoc {
  const formattedAmount = fmtAr(data.amount);
  const now = new Date();
  const code = data.code || data.couponCode || "GIFT";

  return {
    kind: "receipt",
    title: "قسيمة هدية وترضية",
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
        name: "رصيد هدية معتمد في المطبعة والقرطاسية",
        quantityPrice: `1 × ${formattedAmount} د.ع`,
        total: `${formattedAmount} د.ع`,
      },
    ],
    totals: [{ label: "قيمة القسيمة", value: `${formattedAmount} د.ع` }],
    footer:
      data.terms ||
      "تُستخدم القسيمة لمرة واحدة عند المحاسبة • نعتز بثقتكم ونسعى لخدمتكم بأفضل معايير الجودة",
    includeBrandHeader: true,
  };
}

export async function printGiftVoucher(data: GiftVoucherPrintData) {
  const doc = giftVoucherToPrintDoc(data);
  return printDoc(doc);
}

export const printGiftVoucherDoc = printGiftVoucher;
