/* ============================================================================
 * سند هدية مجّانية — طباعة A4 بالتصميم المرجعي V2 (وحدة الهدايا، G-م٣).
 *
 * وارد (IN): استلام بضاعة مجّانية من مورّد. صادر (OUT): منح هدية للعميل.
 * **لا يعرض التكلفة إطلاقاً** — الهدية بلا قيمة بيع/شراء على الورقة (وسم «هدية مجانية»).
 * يُبنى من مساعدات docHtml المشتركة (نمط printCommissionV2) + QR للتحقّق.
 * ========================================================================== */
import {
  docTableV2,
  infoCards,
  pageBodyClose,
  pageBodyOpen,
  pageFooter,
  pageHeader,
  signaturesBlock,
  wrapA4Doc,
  type CompanySettings,
} from "./docHtml";
import { esc, openPrintWindow } from "./brand";
import { qrCodeSvg } from "./qr";

export interface GiftVoucherLineForPrint {
  productName: string;
  sku?: string | null;
  unit: string;
  quantity: number; // بالوحدة المختارة
}
export interface GiftVoucherPrintData {
  giftNumber: string;
  direction: "IN" | "OUT";
  createdAt: string; // YYYY-MM-DD
  giftType?: string | null;
  reason?: string | null;
  partyName?: string | null; // المورّد المانح (وارد) أو العميل المستفيد (صادر)
  lines: GiftVoucherLineForPrint[];
  settings?: CompanySettings;
}

export async function printGiftVoucherA4(d: GiftVoucherPrintData): Promise<boolean> {
  const isIn = d.direction === "IN";

  // QR للتحقّق (تدهور سلِس عند فشل التوليد).
  let qrSvg = "";
  try {
    qrSvg = await qrCodeSvg(`GIFT:${d.giftNumber}`, { size: 52, margin: 1 });
  } catch {
    /* بلا QR — يُستعمل placeholder داخل signaturesBlock */
  }

  const header = pageHeader(
    {
      title: "سند هدية مجّانية",
      subtitle: isIn ? "استلام بضاعة مجّانية من مورّد — بلا قيمة شرائية ولا دَين" : "منح هدية للعميل — بلا قيمة بيع ولا استحقاق",
      fields: [
        { label: "رقم السند", value: d.giftNumber },
        { label: "التاريخ", value: d.createdAt },
        { label: "الاتجاه", value: isIn ? "وارد" : "صادر" },
      ],
      badge: { label: "هدية مجانية", color: "#0D6B52" },
    },
    d.settings,
  );

  const cards = infoCards([
    {
      title: isIn ? "المورّد المانح" : "العميل المستفيد",
      variant: "green",
      bigLine: { primary: d.partyName || "—", secondary: d.giftType ? `النوع: ${d.giftType}` : undefined },
      fields: d.reason ? [{ label: "السبب", value: d.reason }] : [],
    },
  ]);

  const table = docTableV2(
    [
      { key: "name", label: "المنتج", width: 250 },
      { key: "sku", label: "SKU", width: 120 },
      { key: "unit", label: "الوحدة", width: 90 },
      { key: "qty", label: "الكمية", width: 90, emphasize: true },
    ],
    d.lines.map((l) => ({ name: l.productName, sku: l.sku || "—", unit: l.unit, qty: String(l.quantity) })),
    {},
  );

  const note = `<div style="margin-top:10px;padding:8px 14px;border:1px dashed #0D6B52;border-radius:4px;background:#F0FAF6">
    <span style="font-size:11px;font-weight:800;color:#0D6B52">هدية مجانية — لا تُحتسب قيمةً بيعيةً ولا يترتّب عليها أيّ دفع.</span></div>`;

  const sig = signaturesBlock({
    qrSvg: qrSvg || true,
    qrCaption: "للتحقّق من صحّة السند",
    qrSize: 52,
    items: isIn
      ? [
          { kind: "sig", label: "المورّد / المُسلِّم", width: 150 },
          { kind: "sig", label: "أمين المخزن / المُستلِم", width: 150 },
        ]
      : [
          { kind: "sig", label: "المُسلِّم (المكتبة)", width: 150 },
          { kind: "sig", label: "العميل / المُستلِم", width: 150 },
        ],
  });

  const body = `${pageBodyOpen()}${header}${cards}${table}${note}${sig}${pageBodyClose()}${pageFooter(d.settings, { rightText: `REF ${esc(d.giftNumber)}` })}`;
  return openPrintWindow(wrapA4Doc(`سند هدية ${d.giftNumber}`, body));
}
