// بضاعة الأمانة (٢٠/٧) — طباعة «اتفاقية إيداع بضاعة برسم البيع» A4.
// مستند مستقلّ على نمط قوالب V2 (نفس الترويسة/الخط/الفوتر). يولّده النظام من حقول بطاقة المودِع؛
// البنود الثابتة (ملكية البضاعة للمودِع حتى البيع، التلف على المكتبة) مطبوعة دائماً بقرار المالك.
// كل حقل حرّ يمرّ عبر esc() (اسم/هاتف/عنوان/ملاحظات) — سطح الطباعة يفتح نافذة بسياق التطبيق (منع XSS).
import { BRAND, CAIRO_FONT, CO, esc, logoUrl, openPrintWindow } from "./brand";

export interface ConsignmentAgreementInput {
  supplierName: string;
  phone?: string | null;
  address?: string | null;
  settlementCycle: string; // MONTHLY | WEEKLY | ON_DEMAND
  abandonedAfterMonths: number;
  agreementNotes?: string | null;
}

const CYCLE_AR: Record<string, string> = {
  MONTHLY: "شهرية (أول كل شهر)",
  WEEKLY: "أسبوعية",
  ON_DEMAND: "عند الطلب",
};

/** يبني بنود الاتفاقية المرقَّمة من حقول البطاقة + البنود الثابتة. */
function clauses(input: ConsignmentAgreementInput): string[] {
  const cycle = CYCLE_AR[input.settlementCycle] ?? "شهرية";
  return [
    "البضاعة المودَعة تبقى <b>ملكاً للمودِع</b> حتى لحظة بيعها للزبون؛ لا ينشأ أيّ دين على المكتبة عند الاستلام.",
    "تُحدَّد <b>حصة المودِع</b> من ثمن كل صنف صنفاً بصنف في سندات الإيداع الموقَّعة من الطرفين، وتستحقّ عند بيع القطعة.",
    "تعديل حصة أيّ صنف يسري على <b>المبيعات المقبلة فقط</b>؛ المبيعات السابقة محفوظة بقيمتها وقت البيع.",
    "<b>التلف أو الضياع</b> لبضاعة الأمانة أثناء وجودها لدى المكتبة على <b>المكتبة</b>، ويبقى حقّ المودِع في حصّته قائماً.",
    `تُجرى <b>تسوية دورية ${esc(cycle)}</b> بكشف تسوية موقَّع من الطرفين يُصرَف بموجبه المستحقّ للمودِع.`,
    "للمودِع <b>حقّ سحب أو استبدال</b> بضاعته في أيّ وقت بموجب سند سحب/استبدال موقَّع من الطرفين.",
    `البضاعة التي لم تُبَع ولم تُسحَب خلال <b>${input.abandonedAfterMonths} شهراً</b> من آخر حركة تُعدّ متروكةً؛ للمكتبة مطالبة المودِع بسحبها، وبعد إنذارين موثَّقين يُتصرَّف بها وفق هذه الاتفاقية.`,
  ];
}

export function printConsignmentAgreement(input: ConsignmentAgreementInput): boolean {
  const rows = clauses(input)
    .map((c, i) => `<li><span class="n">${i + 1}</span><span>${c}</span></li>`)
    .join("");
  const notes = (input.agreementNotes ?? "").trim();
  const notesBlock = notes
    ? `<div class="notes"><div class="notes-h">بنود/ملاحظات خاصّة</div><div>${esc(notes)}</div></div>`
    : "";

  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<title>اتفاقية إيداع بضاعة برسم البيع — ${esc(input.supplierName)}</title>
${CAIRO_FONT}
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Cairo',sans-serif;color:${BRAND.text};background:${BRAND.page};font-size:13px;line-height:1.9}
  .page{width:210mm;min-height:297mm;margin:0 auto;background:${BRAND.paper};padding:16mm 16mm 14mm}
  .hd{display:flex;align-items:center;gap:12px;border-bottom:2px solid ${BRAND.green};padding-bottom:10px}
  .hd img{height:52px;width:52px;object-fit:contain}
  .hd .co{font-weight:800;font-size:16px;color:${BRAND.green}}
  .hd .co small{display:block;font-weight:600;font-size:11px;color:${BRAND.text}}
  .title{margin:14px 0 4px;text-align:center;font-weight:900;font-size:19px}
  .title .band{display:inline-block;border:1.5px solid ${BRAND.orange};color:${BRAND.orange};border-radius:6px;padding:3px 14px}
  .meta{display:flex;justify-content:space-between;font-size:11px;color:${BRAND.textFaint};margin:6px 2px 12px}
  .parties{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
  .party{border:1px solid ${BRAND.borderDk};border-radius:8px;padding:9px 12px}
  .party h3{font-size:11px;color:${BRAND.green};margin-bottom:4px}
  .party .v{font-weight:700}
  .party .r{font-size:11px;color:${BRAND.text};font-weight:400}
  ol{list-style:none}
  ol li{display:flex;gap:8px;padding:5px 0;border-bottom:1px dashed ${BRAND.borderLight}}
  ol li .n{flex:0 0 22px;height:22px;border-radius:50%;background:${BRAND.greenPale};color:${BRAND.green};
    font-weight:800;font-size:11px;display:flex;align-items:center;justify-content:center}
  .notes{margin-top:12px;border:1px solid ${BRAND.orange};border-radius:8px;padding:9px 12px}
  .notes-h{font-size:11px;color:${BRAND.orange};font-weight:700;margin-bottom:3px}
  .sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:34px}
  .sign .box{border-top:1.5px solid ${BRAND.ink};padding-top:6px;text-align:center;font-size:12px;font-weight:700}
  .ft{margin-top:20px;border-top:1px solid ${BRAND.border};padding-top:8px;text-align:center;font-size:10.5px;color:${BRAND.textFaint}}
  @media print{body{background:#fff}.page{margin:0;box-shadow:none}@page{size:A4;margin:0}}
</style></head>
<body><div class="page">
  <div class="hd">
    <img src="${logoUrl()}" alt="">
    <div class="co">${esc(CO.name)}<small>${esc(CO.sub)}</small></div>
  </div>
  <div class="title"><span class="band">اتفاقية إيداع بضاعة برسم البيع</span></div>
  <div class="meta"><span>التاريخ: ……… / ……… / ٢٠……</span><span>رقم الاتفاقية: ……………</span></div>
  <div class="parties">
    <div class="party"><h3>الطرف الأول (المكتبة)</h3><div class="v">${esc(CO.name)}</div><div class="r">${esc(CO.address)}</div></div>
    <div class="party"><h3>الطرف الثاني (المودِع)</h3><div class="v">${esc(input.supplierName)}</div>
      <div class="r">${input.phone ? "هاتف: " + esc(input.phone) : ""}${input.address ? " · " + esc(input.address) : ""}</div></div>
  </div>
  <ol>${rows}</ol>
  ${notesBlock}
  <div class="sign">
    <div class="box">توقيع المكتبة</div>
    <div class="box">توقيع المودِع</div>
  </div>
  <div class="ft">${esc(CO.footerLine)}</div>
</div>
<script>window.onload=function(){setTimeout(function(){window.print()},300)}</script>
</body></html>`;

  return openPrintWindow(html);
}
