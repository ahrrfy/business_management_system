import { D } from "@/lib/money";
import { invoicePrintAmounts } from "./receiptLayoutInvoiceAmounts";
import { fmt } from "./brand";
import { isCardPaymentMethod } from "./cardBrandLogos";
import type { ReceiptBrowserData } from "./printTemplates";
import type { ReceiptAssets } from "./receiptLayoutAssets";
import {
  RECEIPT_PAD as PAD,
  RECEIPT_WIDTH as W,
  receiptPair,
  receiptRule,
} from "./receiptLayout";
export function drawReceiptTotals(
  ctx: CanvasRenderingContext2D,
  d: ReceiptBrowserData,
  assets: ReceiptAssets,
  top: number,
): number {
  const facts = invoicePrintAmounts({
    total: d.total,
    paidAmount: d.paid,
    returnedTotal: d.returnedTotal,
    currentTotal: d.currentTotal,
    remainingAmount: d.remainingAmount ?? d.credit,
    status: d.status,
    paymentMode: d.paymentMode,
  });
  const revised =
    D(facts.returnedTotal).gt(0) || !D(facts.currentTotal).eq(D(d.total));
  let y = top;
  const totRow = (label: string, value: string, strong = false) => {
    y = receiptPair(ctx, y, label, value, strong);
  };
  totRow("المجموع:", fmt(d.subtotal));
  if (Number(d.discount ?? 0) > 0) totRow("الخصم:", `-${fmt(d.discount)}`);
  if (Number(d.tax ?? 0) > 0) totRow("الضريبة:", fmt(d.tax));
  // تقريب نقديّ IQD (٢٢/٨) — إفصاحٌ عن تعديل التقريب كي يطابق حساب الإيصال إجماليه المطبوع:
  // (المجموع − الخصم + الضريبة ± التقريب = الإجمالي). قبل هذا كان المطبوع 2,800 − 280 = 2,500
  // بينما الحساب 2,520، والفارقُ −20 مخفيّ. يظهر بإشارته (+/−) صراحةً.
  if (d.cashRounding != null && Number(d.cashRounding) !== 0) {
    const val = Number(d.cashRounding);
    totRow("تقريب نقديّ:", `${val > 0 ? "+" : ""}${fmt(d.cashRounding)}`);
  }

  if (D(facts.returnedTotal).gt(0))
    totRow("المرتجع:", fmt(facts.returnedTotal));
  if (revised) totRow("القيمة الحالية:", fmt(facts.currentTotal), true);
  if (facts.dead) totRow("الحالة:", facts.statusLabel, true);

  y += 2;
  receiptRule(ctx, y);
  y += 30;
  ctx.font = "900 32px Cairo, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(revised ? "الإجمالي الأصلي:" : "الإجمالي:", W - PAD, y);
  ctx.textAlign = "left";
  ctx.fillText(`${fmt(d.total)} د.ع`, PAD, y);
  y += 14;
  receiptRule(ctx, y);
  y += 26;

  const cardImg = assets.card;
  if (d.paymentMethod) {
    const displayMethod =
      d.paymentMethod.trim().toUpperCase() === "CARD"
        ? "بطاقة"
        : d.paymentMethod;
    if (isCardPaymentMethod(d.paymentMethod)) {
      ctx.font = "900 22px Cairo, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText("طريقة الدفع:", W - PAD, y);
      ctx.font = "900 22px Cairo, sans-serif";
      ctx.textAlign = "left";
      const logoW = 66;
      const logoH = 22;
      if (cardImg) {
        ctx.drawImage(cardImg, PAD, y - 18, logoW, logoH);
        ctx.fillText(displayMethod, PAD + logoW + 8, y);
      } else {
        ctx.fillText(displayMethod, PAD, y);
      }
      y += 30;
    } else {
      totRow("طريقة الدفع:", displayMethod, true);
    }
  }
  if (d.paymentLegs && d.paymentLegs.length > 1) {
    for (const leg of d.paymentLegs) {
      const legLabel = `  • ${leg.method}${leg.reference ? ` (${leg.reference})` : ""}:`;
      if (isCardPaymentMethod(leg.method) && cardImg) {
        const logoW = 54;
        const logoH = 18;
        ctx.font = "700 20px Cairo, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(legLabel, W - PAD - logoW - 6, y);
        ctx.drawImage(cardImg, W - PAD - logoW, y - 16, logoW, logoH);
        ctx.font = "800 22px Cairo, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(fmt(leg.amount), PAD, y);
        y += 30;
      } else {
        totRow(legLabel, fmt(leg.amount));
      }
    }
  }
  if (d.paid != null) totRow("المدفوع:", fmt(d.paid), true);
  if (d.change != null) totRow("الباقي:", fmt(d.change), true);
  if (Number(d.heldDeposits ?? 0) > 0)
    totRow("عربون محتجز:", fmt(d.heldDeposits), true);
  // G3: «متبقٍّ (آجل)» — سطرٌ خاصّ بارز مع خطٍّ متقطّع أعلاه، أكبر خطاً من بقيّة الإجماليات.
  if (D(facts.remainingAmount).gt(0)) {
    y += 4;
    receiptRule(ctx, y, true);
    y += 30;
    ctx.font = "900 26px Cairo, sans-serif";
    const creditLabel =
      d.paymentMode === "COD" ? "المطلوب عند الاستلام (COD):" : "متبقٍّ (آجل):";
    ctx.textAlign = "right";
    ctx.fillText(creditLabel, W - PAD, y);
    ctx.textAlign = "left";
    ctx.fillText(`${fmt(facts.remainingAmount)} د.ع`, PAD, y);
    y += 30;
  }

  // ٨/٨ — كتلة التوصيل: إفصاحٌ للزبون (الجهة/الأجرة/مَن يقبض/يدفع الزبون). الأجرة خارج `total`
  // دائماً (تمريرٌ لا إيراد) — «يدفع الزبون» = الإجمالي + الأجرة (إلا SHOP فمجّاني).
  if (d.delivery) {
    const dl = d.delivery;
    const fee = D(dl.fee || 0);
    const shop = dl.feeCollection === "SHOP";
    y += 4;
    receiptRule(ctx, y, true);
    y += 32;
    ctx.font = "800 24px Cairo, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("التوصيل", W / 2, y);
    y += 30;
    totRow("جهة التوصيل:", dl.partyName, true);
    if (dl.address) totRow("العنوان:", dl.address);
    const who =
      dl.feeCollection === "COUNTER"
        ? "مقبوضة الآن"
        : shop
          ? "على المكتبة"
          : "يقبضها المندوب";
    totRow(
      "أجرة التوصيل:",
      shop
        ? "مجاناً"
        : `${fmt(fee.toFixed(2))}${facts.dead ? "" : ` (${who})`}`,
      true,
    );

    const remainingMerchandise = D(facts.remainingAmount);
    const courierFee = dl.feeCollection === "COURIER" ? fee : D(0);
    const totalToCollect = remainingMerchandise.plus(courierFee);

    if (!facts.dead) {
      if (totalToCollect.isZero()) {
        ctx.font = "900 23px Cairo, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText("المطلوب من الزبون:", W - PAD, y);
        ctx.textAlign = "left";
        ctx.fillText("0 د.ع (مدفوع بالكامل)", PAD, y);
        y += 32;
      } else if (remainingMerchandise.isZero() && courierFee.gt(0)) {
        ctx.font = "900 23px Cairo, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText("يدفع الزبون (أجرة التوصيل فقط):", W - PAD, y);
        ctx.textAlign = "left";
        ctx.fillText(`${fmt(courierFee.toFixed(2))} د.ع`, PAD, y);
        y += 28;
        ctx.font = "700 17px Cairo, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("البضاعة مدفوعة مسبقاً بالكامل", W / 2, y);
        y += 26;
      } else if (courierFee.gt(0)) {
        ctx.font = "900 24px Cairo, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText("يدفع الزبون شاملاً التوصيل:", W - PAD, y);
        ctx.textAlign = "left";
        ctx.fillText(`${fmt(totalToCollect.toFixed(2))} د.ع`, PAD, y);
        y += 28;
        ctx.font = "700 16px Cairo, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
          `(متبقي البضاعة: ${fmt(remainingMerchandise.toFixed(2))} + أجرة التوصيل: ${fmt(courierFee.toFixed(2))})`,
          W / 2,
          y,
        );
        y += 26;
      } else {
        ctx.font = "900 24px Cairo, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText("يدفع الزبون (متبقي البضاعة):", W - PAD, y);
        ctx.textAlign = "left";
        ctx.fillText(`${fmt(remainingMerchandise.toFixed(2))} د.ع`, PAD, y);
        y += 32;
      }
    }
  }

  y += 2;
  receiptRule(ctx, y, true);
  y += 38;

  return y;
}
