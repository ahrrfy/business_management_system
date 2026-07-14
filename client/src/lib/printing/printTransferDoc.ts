/* ============================================================================
 * مستند تحويل مخزني — A4 بالتصميم المرجعي V2 (تحويلات بخطوتين، ١٤/٧/٢٠٢٦).
 *
 * ملف مستقل (نمط printCommissionV2). يُستدعى من حوار السند في «سجلّ التحويلات»:
 *  - سند «بالطريق»: عمود «المستلَم فعلياً» خلايا فارغة للجرد اليدوي عند الوصول —
 *    الورقة ترافق السائق ويطابق عليها مستلم الفرع الوجهة قبل الإدخال في النظام.
 *  - سند مستلَم: يطبع نتيجة المطابقة (المستلَم/الفرق/الملاحظات) كمحضر نهائي.
 * ⚠️ openPrintWindow يجب أن يُستدعى متزامناً داخل إيماءة النقر (window.open يُحجب بعد await).
 * ========================================================================== */
import {
  docTableV2,
  infoCards,
  pageBodyClose,
  pageBodyOpen,
  pageFooter,
  pageHeader,
  wrapA4Doc,
  type CompanySettings,
} from "./docHtml";
import { esc, fmt, openPrintWindow } from "./brand";

export interface TransferDocLine {
  productName: string;
  variantName?: string | null;
  color?: string | null;
  sku: string;
  quantitySent: number;
  quantityReceived?: number | null;
  note?: string | null;
}

export interface TransferDocData {
  transferNumber: string;
  status: "IN_TRANSIT" | "RECEIVED" | "CANCELLED";
  fromBranchName: string;
  toBranchName: string;
  reasonLabel?: string | null;
  notes?: string | null;
  createdByName?: string | null;
  createdAt: string; // منسَّق للعرض
  receivedByName?: string | null;
  receivedAt?: string | null; // منسَّق للعرض
  receiveNotes?: string | null;
  lines: TransferDocLine[];
  settings?: CompanySettings;
}

const STATUS_META: Record<TransferDocData["status"], { label: string; color: string }> = {
  IN_TRANSIT: { label: "بالطريق — بانتظار الاستلام", color: "#B7791F" },
  RECEIVED: { label: "مستلَم", color: "#0D6B52" },
  CANCELLED: { label: "ملغى", color: "#667085" },
};

/** خلية جرد فارغة (مربّع كتابة يدوية) لسند بالطريق. */
const HAND_BOX = `<span style="display:inline-block;width:52px;height:16px;border:1px solid #98A2B3;border-radius:3px;vertical-align:middle"></span>`;

export function printTransferDoc(d: TransferDocData): boolean {
  const inTransit = d.status === "IN_TRANSIT";
  const totalSent = d.lines.reduce((a, l) => a + l.quantitySent, 0);
  const totalReceived = d.lines.reduce((a, l) => a + (l.quantityReceived ?? 0), 0);
  const totalDiff = totalSent - totalReceived;
  const st = STATUS_META[d.status];

  const header = pageHeader(
    {
      title: "مستند تحويل مخزني",
      subtitle: inTransit
        ? "يرافق البضاعة أثناء النقل — يجرد مستلمُ الفرع الوجهة الكمياتِ الواصلة فعلياً على هذا المستند ثم يوثّقها في النظام"
        : "محضر مطابقة نهائي — الكميات المستلَمة فعلياً والعجز الموثَّق كما أُقفل السند في النظام",
      fields: [
        { label: "رقم السند", value: d.transferNumber },
        { label: "تاريخ الإرسال", value: d.createdAt },
        ...(d.receivedAt ? [{ label: "تاريخ الاستلام", value: d.receivedAt }] : []),
      ],
      badge: { label: st.label, color: st.color },
    },
    d.settings,
  );

  const cards = infoCards([
    {
      title: "الفرع المرسل",
      variant: "gray",
      fields: [
        { label: "الفرع", value: d.fromBranchName },
        { label: "المسؤول", value: d.createdByName || "—" },
        { label: "سبب التحويل", value: d.reasonLabel || "—" },
      ],
    },
    {
      title: "الفرع الوجهة",
      variant: "green",
      fields: [
        { label: "الفرع", value: d.toBranchName },
        { label: "المستلم", value: d.receivedByName || (inTransit ? "يُحدَّد عند الاستلام" : "—") },
        { label: "ملاحظات الإرسال", value: d.notes || "—" },
      ],
    },
  ]);

  const table = docTableV2(
    [
      { key: "item", label: "الصنف", width: 210 },
      { key: "sku", label: "SKU", width: 90 },
      { key: "sent", label: "المرسَل", width: 70, emphasize: true },
      { key: "received", label: "المستلَم فعلياً", width: 90 },
      { key: "diff", label: "الفرق", width: 60 },
      { key: "note", label: "ملاحظة المطابقة", width: 150 },
    ],
    d.lines.map((l) => {
      const name = `${l.productName}${l.variantName ? ` — ${l.variantName}` : l.color ? ` — ${l.color}` : ""}`;
      const diff = l.quantityReceived == null ? null : l.quantitySent - Number(l.quantityReceived);
      return {
        item: name,
        sku: l.sku,
        sent: fmt(l.quantitySent),
        received: inTransit ? HAND_BOX : l.quantityReceived == null ? "—" : fmt(Number(l.quantityReceived)),
        diff: inTransit ? HAND_BOX : diff == null ? "—" : diff === 0 ? "مطابق" : `−${fmt(diff)}`,
        note: inTransit ? "" : l.note || "—",
      };
    }),
  );

  const totals = `<div style="margin-top:10px;display:flex;gap:14px;justify-content:flex-start;font-size:11.5px;font-weight:700">
      <div>إجمالي المرسَل: <span style="direction:ltr;unicode-bidi:isolate">${esc(fmt(totalSent))}</span> وحدة</div>
      ${
        inTransit
          ? ""
          : `<div>إجمالي المستلَم: <span style="direction:ltr;unicode-bidi:isolate">${esc(fmt(totalReceived))}</span></div>
             <div style="color:${totalDiff > 0 ? "#B42318" : "#0D6B52"}">${totalDiff > 0 ? `عجز موثَّق: ${esc(fmt(totalDiff))} وحدة` : "مطابقة كاملة"}</div>`
      }
    </div>`;

  const receiveNotes =
    !inTransit && d.receiveNotes
      ? `<div style="margin-top:8px;padding:6px 14px;border:1px dashed #98A2B3;border-radius:4px;font-size:10.75px"><b>ملاحظات الاستلام:</b> ${esc(d.receiveNotes)}</div>`
      : "";

  const signatures = `<div style="margin-top:34px;display:flex;justify-content:space-between;gap:24px">
    ${["أمين مخزن الفرع المرسل", "الناقل / السائق", "مستلم الفرع الوجهة"]
      .map(
        (l) => `<div style="flex:1;text-align:center">
          <div style="height:36px"></div>
          <div style="border-top:1px solid #0F1613;padding-top:5px;font-size:10.25px;color:#000;font-weight:600">${esc(l)}</div>
        </div>`,
      )
      .join("")}
  </div>
  <div style="margin-top:10px;font-size:9.75px;color:#8B8E89">${
    inTransit
      ? "البضاعة المذكورة خرجت من رصيد الفرع المرسل وهي بالطريق — لا تدخل رصيد الوجهة إلا بعد توثيق الاستلام في النظام."
      : "أُقفل هذا السند في النظام — أي عجز مذكور خُصم من المخزون ووُثّق محاسبياً بقيمة التكلفة."
  }</div>`;

  const body = `${pageBodyOpen()}${header}${cards}${table}${totals}${receiveNotes}${signatures}${pageBodyClose()}${pageFooter(d.settings, { rightText: `REF ${d.transferNumber}` })}`;
  return openPrintWindow(wrapA4Doc(`مستند تحويل ${d.transferNumber}`, body));
}
