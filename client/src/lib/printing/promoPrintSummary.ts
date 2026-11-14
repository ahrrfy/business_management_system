import { isDeadInvoice } from "@shared/predicates";
import { D, moneyInput, round2 } from "@/lib/money";
import { BRAND as B, esc, fmt } from "./brand";

export interface PromoPrintSummary {
  /** أسماء العروض أو القسائم الترويجية المطبّقة على الفاتورة */
  offerNames?: string[];
  /** إجمالي توفير الزبون من عروض الأصناف (2dp string أو رقم) */
  merchandiseSavings?: string | number | null;
  /** خصم إضافي على رأس الفاتورة ضمن سلّة ترويجية */
  invoiceDiscount?: string | number | null;
  /** هل شملت الفاتورة عرض توصيل مجاني للعميل؟ */
  freeShipping?: boolean;
  /** قيمة أجرة التوصيل المُعفاة / المُهداة للعميل */
  waivedDeliveryAmount?: string | number | null;
  /** إجمالي ما وفّره العميل في هذه الفاتورة (أصناف + فاتورة + توصيل مُهدى) */
  totalSavings?: string | number | null;
}

export interface InvoicePromoDerivationSource {
  status?: string | null;
  discountAmount?: string | number | null;
  deliveryFree?: boolean | null;
  deliveryWaivedAmount?: string | number | null;
  courierFee?: string | number | null;
  courierFeeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
  consignmentStatus?: string | null;
  items?: Array<{
    promotionId?: number | null;
    promotionDiscount?: string | number | null;
    promotionName?: string | null;
  }> | null;
}

/**
 * يشتقّ ملخّص التوفير الترويجي من الفاتورة المحفوظة لعرضه بشكل تسويقي في الإيصال الحراري وفاتورة A4.
 * يعيد `null` للفواتير الملغاة/المرتجعة أو الفواتير العادية التي لا تحمل أي عرض ترويجي أو توصيل مجاني مُعلَن.
 */
export function deriveInvoicePromoSummary(
  src: InvoicePromoDerivationSource,
): PromoPrintSummary | null {
  if (isDeadInvoice(src.status)) return null;

  let merchD = D(0);
  const namesSet = new Set<string>();
  for (const it of src.items ?? []) {
    const lineDisc = moneyInput(it.promotionDiscount);
    if (lineDisc.gt(0)) {
      merchD = merchD.plus(lineDisc);
    }
    const trimmedName = it.promotionName?.trim();
    if (trimmedName && (lineDisc.gt(0) || it.promotionId != null)) {
      namesSet.add(trimmedName);
    }
  }

  const isFreeDelivery = Boolean(src.deliveryFree);
  const offerNames = Array.from(namesSet);

  if (merchD.lte(0) && !isFreeDelivery && offerNames.length === 0) {
    return null;
  }

  let waivedD = D(0);
  if (isFreeDelivery) {
    const explicitWaived = moneyInput(src.deliveryWaivedAmount);
    if (explicitWaived.gt(0)) {
      waivedD = explicitWaived;
    } else if (
      src.courierFeeCollection === "SHOP" &&
      src.consignmentStatus !== "CANCELLED" &&
      moneyInput(src.courierFee).gt(0)
    ) {
      waivedD = moneyInput(src.courierFee);
    }
  }

  const invDiscD = moneyInput(src.discountAmount);
  const totalSavingsD = round2(merchD.plus(invDiscD).plus(waivedD));

  return {
    offerNames,
    merchandiseSavings: merchD.gt(0) ? round2(merchD).toFixed(2) : null,
    invoiceDiscount: invDiscD.gt(0) ? round2(invDiscD).toFixed(2) : null,
    freeShipping: isFreeDelivery,
    waivedDeliveryAmount: waivedD.gt(0) ? round2(waivedD).toFixed(2) : null,
    totalSavings: totalSavingsD.gt(0) ? totalSavingsD.toFixed(2) : null,
  };
}

export function hasActivePromoSummary(
  summary: PromoPrintSummary | null | undefined,
): boolean {
  if (!summary) return false;
  return (
    Boolean(summary.freeShipping) ||
    moneyInput(summary.totalSavings).gt(0) ||
    moneyInput(summary.merchandiseSavings).gt(0) ||
    Boolean(summary.offerNames && summary.offerNames.length > 0)
  );
}

/**
 * بطاقة تسويقية عالية التباين للإيصال الحراري 80mm (أبيض وأسود خالص آمن للطابعات الحرارية).
 */
export function renderReceiptPromoBoxHtml(
  summary: PromoPrintSummary | null | undefined,
  isDead: boolean,
): string {
  if (isDead || !hasActivePromoSummary(summary) || !summary) return "";

  const merchD = moneyInput(summary.merchandiseSavings);
  const invDiscD = moneyInput(summary.invoiceDiscount);
  const waivedD = moneyInput(summary.waivedDeliveryAmount);
  const totalD = round2(
    moneyInput(summary.totalSavings).gt(0)
      ? moneyInput(summary.totalSavings)
      : merchD.plus(invDiscD).plus(waivedD),
  );
  const offerNames = (summary.offerNames ?? []).map((n) => n.trim()).filter(Boolean);

  return `
  <table data-testid="receipt-promo-marketing-box" style="width:100%;font-size:10.8px;border-collapse:collapse;border:2px solid #000;margin:2mm 0;color:#000;background:#fff;">
    <thead>
      <tr style="background:#000;color:#fff;">
        <th colspan="2" style="padding:1.2mm 1.5mm;font-weight:900;font-size:11.5px;text-align:center;border:1px solid #000;">
          مزايا العروض وتوفيرك في هذه الفاتورة
        </th>
      </tr>
    </thead>
    <tbody>
      ${
        offerNames.length > 0
          ? `<tr>
        <td colspan="2" style="padding:1mm 1.5mm;font-weight:900;font-size:10.5px;text-align:center;border:1px solid #000;background:#f4f4f4;">
          العروض المشمولة: ${offerNames.map((n) => esc(n)).join(" • ")}
        </td>
      </tr>`
          : ""
      }
      ${
        merchD.gt(0)
          ? `<tr>
        <td style="width:58%;font-weight:800;padding:0.9mm 1.5mm;border:1px solid #000;">توفيرك من عروض المواد</td>
        <td style="font-weight:900;padding:0.9mm 1.5mm;border:1px solid #000;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(merchD.toFixed(2))} د.ع</td>
      </tr>`
          : ""
      }
      ${
        invDiscD.gt(0)
          ? `<tr>
        <td style="width:58%;font-weight:800;padding:0.9mm 1.5mm;border:1px solid #000;">خصم إضافي على الفاتورة</td>
        <td style="font-weight:900;padding:0.9mm 1.5mm;border:1px solid #000;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(invDiscD.toFixed(2))} د.ع</td>
      </tr>`
          : ""
      }
      ${
        summary.freeShipping
          ? `<tr>
        <td style="width:58%;font-weight:900;padding:1mm 1.5mm;border:1px solid #000;">هدية التوصيل المجاني</td>
        <td style="font-weight:900;padding:1mm 1.5mm;border:1px solid #000;text-align:left;">${
          waivedD.gt(0)
            ? `مجاناً على المكتبة (وفّرت ${fmt(waivedD.toFixed(2))} د.ع)`
            : "مجاناً على حساب المكتبة"
        }</td>
      </tr>`
          : ""
      }
      ${
        totalD.gt(0)
          ? `<tr style="background:#000;color:#fff;font-weight:900;">
        <td style="padding:1.2mm 1.5mm;border:1px solid #000;font-size:11.5px;">مجموع توفيرك اليوم</td>
        <td style="padding:1.2mm 1.5mm;border:1px solid #000;direction:ltr;text-align:left;font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap;">${fmt(totalD.toFixed(2))} د.ع</td>
      </tr>`
          : summary.freeShipping
            ? `<tr style="background:#000;color:#fff;font-weight:900;">
        <td colspan="2" style="padding:1.1mm 1.5mm;border:1px solid #000;text-align:center;font-size:11px;">طلبك مشمول بعرض التوصيل المجاني على حساب المكتبة</td>
      </tr>`
            : ""
      }
    </tbody>
  </table>`;
}

/**
 * شريط ترويجي رسمي لفاتورة المبيعات A4 متناغم مع هوية مكتبة الرؤية العربية.
 */
export function renderA4PromoBannerHtml(
  summary: PromoPrintSummary | null | undefined,
  fmtMoney: (v: string | number | null | undefined) => string,
  isDead = false,
): string {
  if (isDead || !hasActivePromoSummary(summary) || !summary) return "";

  const merchD = moneyInput(summary.merchandiseSavings);
  const invDiscD = moneyInput(summary.invoiceDiscount);
  const waivedD = moneyInput(summary.waivedDeliveryAmount);
  const totalD = round2(
    moneyInput(summary.totalSavings).gt(0)
      ? moneyInput(summary.totalSavings)
      : merchD.plus(invDiscD).plus(waivedD),
  );
  const offerNames = (summary.offerNames ?? []).map((n) => n.trim()).filter(Boolean);

  const detailPills: string[] = [];
  if (merchD.gt(0)) {
    detailPills.push(`خصم العروض على المواد: ${fmtMoney(merchD.toFixed(2))} د.ع`);
  }
  if (invDiscD.gt(0)) {
    detailPills.push(`خصم إضافي على الفاتورة: ${fmtMoney(invDiscD.toFixed(2))} د.ع`);
  }
  if (summary.freeShipping) {
    detailPills.push(
      waivedD.gt(0)
        ? `هدية التوصيل المجاني: مجاناً على المكتبة (قيمته ${fmtMoney(waivedD.toFixed(2))} د.ع)`
        : "هدية التوصيل المجاني: التوصيل مجاناً على حساب المكتبة",
    );
  }

  return `<div data-testid="a4-promo-marketing-banner" style="margin:8px 0 10px;border:1.5px solid ${B.green};border-right:5px solid ${B.greenDark};border-radius:6px;background:${B.greenPale};padding:8px 12px;display:flex;align-items:center;justify-content:space-between;gap:12px;page-break-inside:avoid;break-inside:avoid;">
    <div style="flex:1;min-width:0;">
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;">
        <span style="background:${B.greenDark};color:#fff;font-size:9.5px;font-weight:800;padding:2px 8px;border-radius:4px;letter-spacing:0.2px;">مزايا العروض الترويجية</span>
        ${
          offerNames.length > 0
            ? `<span style="font-size:11px;font-weight:900;color:#000;">${offerNames.map((n) => esc(n)).join(" • ")}</span>`
            : `<span style="font-size:10.5px;font-weight:800;color:#000;">توفير خاص مفعّل على هذه الفاتورة</span>`
        }
      </div>
      ${
        detailPills.length > 0
          ? `<div style="margin-top:4px;font-size:9.8px;font-weight:700;color:#000;line-height:1.45;">${detailPills.map((p) => esc(p)).join("  •  ")}</div>`
          : ""
      }
    </div>
    <div style="background:#fff;border:1.5px solid ${B.green};border-radius:5px;padding:4px 10px;text-align:center;min-width:138px;flex-shrink:0;">
      <div style="font-size:8.5px;font-weight:800;color:${B.green};line-height:1.2;">${totalD.gt(0) ? "إجمالي توفير العميل" : "امتياز الشحن"}</div>
      <div style="font-size:13px;font-weight:900;color:#000;line-height:1.3;margin-top:1px;${totalD.gt(0) ? "direction:ltr;font-variant-numeric:tabular-nums;" : ""}">
        ${totalD.gt(0) ? `${fmtMoney(totalD.toFixed(2))} د.ع` : "توصيل مجاني"}
      </div>
    </div>
  </div>`;
}
