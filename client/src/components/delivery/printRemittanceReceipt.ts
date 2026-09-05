// إيصال تسوية توصيل حراريّ عند التوريد — استُخرج من client/src/pages/DeliveryHub.tsx (م١ PR-C) بلا تغيير.
import { fmtDateTime } from "@/lib/date";
import { fmt } from "@/lib/money";
import { printDoc } from "@/lib/printing/print";

/** إيصال تسوية توصيل حراري عند التوريد. */
export function printRemittanceReceipt(partyName: string, r: { remittanceNumber: string | null; collectedTotal: string; feesTotal: string; netRemitted: string; shortfallTotal: string; courierCommissionAmount?: string | null }) {
  if (!r.remittanceNumber) return; // كشف إثبات محض بلا سند توريد ⇒ لا إيصال.
  // Slice H (٢٩/٨/٢٦): سطرُ العمولة يظهر على الإيصال حين تكون للجهة قاعدةٌ فعّالة — إعلاميّ للمقارنة.
  const totals: Array<{ label: string; value: string }> = [
    { label: "إجمالي التحصيل", value: `${fmt(r.collectedTotal)} د.ع` },
    { label: "مستحقات الجهة (الأجور)", value: `${fmt(r.feesTotal)} د.ع` },
  ];
  if (r.courierCommissionAmount != null) {
    totals.push({ label: "عمولة القاعدة (تقديريّة)", value: `${fmt(r.courierCommissionAmount)} د.ع` });
  }
  totals.push(
    { label: "صافٍ للمكتبة", value: `${fmt(r.netRemitted)} د.ع` },
    { label: "عجز يبقى عهدة", value: `${fmt(r.shortfallTotal)} د.ع` },
  );
  void printDoc({
    kind: "zreport",
    title: "إيصال تسوية توصيل",
    subtitle: r.remittanceNumber,
    meta: [`الجهة: ${partyName}`, fmtDateTime(new Date())],
    totals,
    footer: "تسوية تحصيلات المندوب",
  });
}
