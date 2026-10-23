import { fmt } from "../money";

type StocktakePrintState = {
  status: string;
  sessionType?: "NORMAL" | "OPENING";
  code: string;
  thresholdPct?: string | number | null;
  thresholdValue?: string | number | null;
};

/** The report endpoint also returns previews: only APPROVED certifies posted movements. */
export function stocktakePrintState(d: StocktakePrintState) {
  const approved = d.status === "APPROVED";
  const opening = d.sessionType === "OPENING";
  const cancelled = d.status === "CANCELLED";
  const notice = approved ? "" : cancelled
    ? "الجلسة ملغاة — هذه معاينة غير معتمدة، ولا تثبت تنفيذ تسوية أو ترحيل قيد."
    : "مسوّدة معاينة قبل الاعتماد النهائي — لم تُنفّذ التسوية ولم تُرحّل القيود المعروضة.";
  const execution = !approved
    ? cancelled ? "لا يُنفّذ أي تغيير من هذه الجلسة الملغاة."
      : opening
        ? `سيُثبّت الرصيد الافتتاحي بحركات OPENING عند الاعتماد النهائي بمرجع ${d.code}، بلا قيد عجز/زيادة أو أثر على الأرباح أو النقد.`
        : `ستُنفّذ التسوية بحركات ADJUST وتُحدّث الأرصدة عند الاعتماد النهائي بمرجع ${d.code}. القيد والمبالغ المعروضة تقديرية حتى الاعتماد.`
    : opening
      ? `ثُبتت الأرصدة الافتتاحية بحركات OPENING ذرّية بمرجع ${d.code}، بلا قيد عجز/زيادة أو أثر على الأرباح أو النقد.`
      : `نُفّذت التسوية بحركات ADJUST ذرّية بمرجع ${d.code} في سجلّ حركات المخزون، وحُدِّثت الأرصدة لحظة الاعتماد. الحدّ المعتمد للتسوية المباشرة: ${fmt(d.thresholdPct)}٪ أو ${fmt(d.thresholdValue)} د.ع.`;
  return {
    approved, notice, execution,
    ledgerTitle: approved ? "القيد المحاسبي الآلي" : "القيد المحاسبي المتوقع — غير مُرحّل",
    adjustedTitle: opening
      ? approved ? "التغييرات الافتتاحية المثبتة" : "التغييرات الافتتاحية المقترحة"
      : approved ? "الفروقات المُسوّاة" : "الفروقات المقترحة للتسوية",
    openingEffect: approved
      ? "ثُبتت الكميات بحركات OPENING فقط؛ لا قيد عجز/زيادة، ولا قبض أو صرف أو أثر صندوق أو مصرف أو ذمم. مؤشر IRA والانكماش غير مطبقين على التأسيس الافتتاحي."
      : "هذه معاينة للكميات المقترحة فقط؛ لم تُثبّت بحركات OPENING. عند الاعتماد لا ينشأ قيد عجز/زيادة أو أثر نقدي. مؤشر IRA والانكماش غير مطبقين على التأسيس الافتتاحي.",
  };
}
