// ش٢ (§١٠) — تذكرة مسوّدة الطلب: قالبٌ **منفصل** عن قالب الإيصال عمداً.
// المسوّدة تحمل رقماً معلَناً للزبون (DRF-…) وإعادة استعمال قالب الإيصال كانت ستجعل أيّ
// طباعةٍ لها ورقةً لا يميّزها الزبون عن إيصال دفعٍ حقيقيّ. هنا: عبارة «طلبٌ غير محاسَب —
// ليس إيصال دفع» في الرأس والذيل، و**منعٌ بنيويّ** لسطرَي «مدفوع» و«الفكّة» (لا وجود لهما
// في الشكل أصلاً). printReceipt نفسه يرفض أرقام DRF- (الحارس المرافق).
import { printDoc } from "./print";

export interface DraftTicketData {
  draftNumber: string;
  date: string;
  contactName?: string | null;
  contactPhone?: string | null;
  items: Array<{ name: string; quantity: string | number; total: string }>;
  total: string;
  notes?: string | null;
}

/** ش٤ — سند قبض عربونٍ على طلبٍ محفوظ: إثبات الزبون قبل وجود فاتورة. يحمل رقم الطلب
 *  (DRF-) صراحةً ويسمّي نفسه «سند قبض عربون» — ليس فاتورةً ولا إيصال بيع. */
export interface DepositReceiptData {
  draftNumber: string;
  date: string;
  contactName?: string | null;
  amount: string;
  methodLabel: string;
  reference?: string | null;
  collectedTotal: string;
  orderTotal: string;
  cashierName?: string | null;
}

export async function printDepositReceipt(d: DepositReceiptData) {
  return printDoc({
    kind: "receipt",
    title: "سند قبض عربون",
    subtitle: `على الطلب المحفوظ ${d.draftNumber} — يُخصَم من قيمته عند التثبيت`,
    meta: [
      `التاريخ: ${d.date}`,
      ...(d.contactName ? [`الزبون: ${d.contactName}`] : []),
      `طريقة الدفع: ${d.methodLabel}`,
      ...(d.reference ? [`المرجع: ${d.reference}`] : []),
      ...(d.cashierName ? [`القابض: ${d.cashierName}`] : []),
    ],
    columns: ["البيان", "المبلغ"],
    rows: [["عربون مقبوض الآن", d.amount]],
    totals: [
      { label: "إجمالي المقبوض على الطلب", value: d.collectedTotal },
      { label: "قيمة الطلب التقديرية", value: d.orderTotal },
    ],
    footer: "يُستردّ العربون بطريقة قبضه حصراً وبهذا السند — احتفظ به حتى استلام الطلب.",
  });
}

export async function printDraftTicket(d: DraftTicketData) {
  return printDoc({
    kind: "receipt",
    title: "مسوّدة طلب — غير محاسَبة",
    subtitle: "ليس إيصال دفع — الطلب يُثبَّت ويُدفَع في المحطة",
    meta: [
      `رقم المسوّدة: ${d.draftNumber}`,
      `التاريخ: ${d.date}`,
      ...(d.contactName ? [`الزبون: ${d.contactName}`] : []),
      ...(d.contactPhone ? [`الهاتف: ${d.contactPhone}`] : []),
    ],
    columns: ["الصنف", "الكمية", "الإجمالي"],
    rows: d.items.map((it) => [it.name, String(it.quantity), it.total]),
    totals: [{ label: "الإجمالي التقديري", value: d.total }],
    footer: [
      d.notes?.trim() || null,
      "طلبٌ غير محاسَب — ليس إيصال دفع. الأسعار تقديرية حتى التثبيت.",
    ].filter(Boolean).join("\n"),
  });
}
