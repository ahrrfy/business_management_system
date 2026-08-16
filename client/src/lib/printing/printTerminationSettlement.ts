import { BRAND, CAIRO_FONT, CO, esc, logoUrl, openPrintWindow } from "./brand";
import { D, round2 } from "@/lib/money";

export interface TerminationSettlementPrintInput {
  id: number;
  employeeName: string;
  terminationType: string;
  lastDay: string;
  earnedGrossWages: string;
  wageReductions: string;
  advanceRecovery: string;
  incomeTax: string;
  employeeSocialSecurity: string;
  employerSocialSecurity: string;
  leaveCompensation: string;
  noticeCompensation: string;
  eosBenefit: string;
  otherSettlement: string;
  otherSettlementLabel?: string | null;
  evidenceNote: string;
  remainingAdvanceAtRecognition: string;
  total: string;
  paymentMethod: string;
  status: string;
  reason?: string | null;
  snapshotHash?: string | null;
}

const amount = (value: string) => {
  const [whole, fraction] = round2(D(value || "0")).toFixed(2).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction} د.ع`;
};

export function terminationSettlementHtml(
  input: TerminationSettlementPrintInput,
): string {
  const earnedNet = round2(
    D(input.earnedGrossWages)
      .minus(D(input.wageReductions))
      .minus(D(input.advanceRecovery))
      .minus(D(input.incomeTax))
      .minus(D(input.employeeSocialSecurity)),
  ).toFixed(2);
  const rows = [
    ["إجمالي الأجور المكتسبة حتى آخر يوم", input.earnedGrossWages],
    ["تخفيضات الأجر (تُخصم)", input.wageReductions],
    ["استرداد السلفة (يُخصم)", input.advanceRecovery],
    [
      "رصيد السلفة بعد هذه التسوية — لقطة الاعتماد",
      input.remainingAdvanceAtRecognition,
    ],
    ["ضريبة الدخل (تُخصم)", input.incomeTax],
    ["حصة الموظف من الضمان (تُخصم)", input.employeeSocialSecurity],
    ["صافي الأجور المكتسبة", earnedNet],
    ["حصة الشركة من الضمان — مصروف مستقل", input.employerSocialSecurity],
    ["تعويض رصيد الإجازات", input.leaveCompensation],
    ["بدل الإشعار", input.noticeCompensation],
    ["مكافأة نهاية الخدمة", input.eosBenefit],
    [input.otherSettlementLabel?.trim() || "مستحق آخر مصنّف", input.otherSettlement],
  ]
    .map(
      ([label, value]) =>
        `<tr><td>${esc(label)}</td><td class="num">${esc(amount(value))}</td></tr>`,
    )
    .join("");
  const fingerprint = input.snapshotHash
    ? `<div class="hash">بصمة لقطة الاعتماد: ${esc(input.snapshotHash)}</div>`
    : "";
  const draft = !input.snapshotHash;
  const documentState = draft
    ? `<div class="draft">مسودة غير معتمدة — لا تصلح سنداً للصرف</div>`
    : "";
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<title>بيان تسوية نهاية خدمة #${input.id}</title>${CAIRO_FONT}
<style>
*{box-sizing:border-box}body{margin:0;background:${BRAND.page};color:${BRAND.text};font-family:'Cairo',sans-serif;font-size:12px}.page{width:210mm;min-height:297mm;margin:auto;background:#fff;padding:15mm}.head{display:flex;align-items:center;gap:12px;border-bottom:2px solid ${BRAND.green};padding-bottom:9px}.head img{width:48px;height:48px;object-fit:contain}.company{font-size:16px;font-weight:800;color:${BRAND.green}}h1{text-align:center;font-size:19px;margin:16px 0 12px}.draft{border:2px solid #991b1b;color:#991b1b;text-align:center;font-weight:800;padding:6px;margin:0 0 12px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:7px 20px;border:1px solid ${BRAND.border};padding:10px;margin-bottom:12px}.meta b{color:${BRAND.green}}table{width:100%;border-collapse:collapse}th,td{border:1px solid ${BRAND.borderDk};padding:8px}th{background:${BRAND.greenPale}}.num{text-align:left;direction:ltr;font-weight:700}.total td{font-size:14px;font-weight:900;background:${BRAND.orangePale}}.note{margin-top:12px;border:1px solid ${BRAND.border};padding:9px;min-height:42px}.disclosure{margin-top:10px;padding:8px;background:${BRAND.greenPale};border-right:3px solid ${BRAND.green};line-height:1.8}.hash{margin-top:8px;direction:ltr;text-align:left;font:9px monospace;overflow-wrap:anywhere;color:${BRAND.textFaint}}.sign{display:grid;grid-template-columns:1fr 1fr;gap:45px;margin-top:35px}.sign div{border-top:1px solid #222;text-align:center;padding-top:6px}.footer{margin-top:22px;border-top:1px solid ${BRAND.border};padding-top:8px;text-align:center;color:${BRAND.textFaint};font-size:10px}@media print{body{background:#fff}.page{margin:0}@page{size:A4;margin:0}}
</style></head><body><div class="page">
<div class="head"><img src="${logoUrl()}" alt=""><div class="company">${esc(CO.name)}<div style="font-size:11px;color:${BRAND.text}">${esc(CO.sub)}</div></div></div>
<h1>بيان تفكيك تسوية نهاية الخدمة</h1>${documentState}
<div class="meta"><div><b>رقم الإجراء:</b> ${input.id}</div><div><b>الموظف:</b> ${esc(input.employeeName)}</div><div><b>نوع الإنهاء:</b> ${esc(input.terminationType)}</div><div><b>آخر يوم عمل:</b> ${esc(input.lastDay)}</div><div><b>طريقة الدفع المتوقعة:</b> ${esc(input.paymentMethod)}</div><div><b>الحالة:</b> ${esc(input.status)}</div></div>
<table><thead><tr><th>${draft ? "التصنيف المُدخل بانتظار الاعتماد" : "التصنيف المعتمد يدوياً"}</th><th>المبلغ</th></tr></thead><tbody>${rows}<tr class="total"><td>إجمالي التسوية المشتق</td><td class="num">${esc(amount(input.total))}</td></tr></tbody></table>
<div class="disclosure">هذه الوثيقة تفصيل إجمالي إلى صافي بإدخال واعتماد بشري. لا يطبّق النظام تلقائياً أي نسبة قانونية أو ضريبية، والقيم الصفرية مُقرّة صراحةً. رصيد السلفة الظاهر لقطة ثابتة لحظة إثبات التسوية ومغطّى ببصمتها؛ لا يتغيّر بسدادٍ لاحق. يُثبت الاستحقاق أولاً ثم يكون الصرف الفعلي باعتماد مالك مستقل.</div>
<div class="note"><b>مرجع المراجعة ومصدر القيم:</b> ${esc(input.evidenceNote)}</div>
<div class="note"><b>السبب / الملاحظات:</b> ${esc(input.reason?.trim() || "—")}</div>${fingerprint}
<div class="sign"><div>معدّ البيان</div><div>${draft ? "مساحة اعتماد المراجع" : "المراجع / المعتمد"}</div></div><div class="footer">${esc(CO.footerLine)}</div>
</div><script>window.onload=function(){setTimeout(function(){window.print()},300)}</script></body></html>`;
}

export function printTerminationSettlement(
  input: TerminationSettlementPrintInput,
): boolean {
  return openPrintWindow(terminationSettlementHtml(input));
}
