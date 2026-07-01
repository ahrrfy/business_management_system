// أدوات مشتركة بين تقارير الذمم المدينة والدائنة: فترة الكشف + حساب الفرق الموجب.
import { money } from "../money";

/** فترة كشف الحساب — نصوص YYYY-MM-DD اختيارية. النطاق على المستندات [from، to+يوم). */
export interface StatementPeriod {
  from?: string;
  to?: string;
  /** عزل الفرع (RPT-01/02): مدير الفرع يرى فواتير فرعه فقط؛ admin بلا قيد. */
  branchId?: number;
}

/** اليوم التالي YYYY-MM-DD — حدّ أعلى **حصري** على أعمدة timestamp يشمل كامل يوم `to`
 *  بلا حِيَل 23:59:59.999. الحساب بـUTC ⇒ لا انزياح منطقة زمنية. */
function nextDayStr(ymd: string): string {
  return new Date(new Date(`${ymd}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

/** فرق موجب بين قيمتين ماليتين (لا يقلّ عن صفر) بدقّة decimal. */
function positiveDiff(total: unknown, paid: unknown) {
  const d = money((total as string) ?? 0).sub(money((paid as string) ?? 0));
  return d.isNegative() ? money(0) : d;
}


export { nextDayStr, positiveDiff };
