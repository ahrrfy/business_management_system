import { trpc } from "@/lib/trpc";
import { fmtAr } from "@/lib/money";

/**
 * تركيب مبيعات اليوم — جسر «لماذا لا تساوي المبيعاتُ النقدَ في الدرج».
 *
 * يُعرَض تحت «مؤشرات اليوم» للأدوار المخوّلة برؤية التقارير فقط (الخادم يُصفّر لغيرهم).
 * الإجماليّ هنا == بطاقة «مبيعات اليوم» حرفياً (نفس getTodayNetSales)، ويتفكّك إلى
 * نقد الدرج + نقد الخزينة + غير نقديّ (بطاقة/تحويل/محفظة، للبنك) + آجل (لم يُقبض)، مع طرح
 * ما يستحقّه العميل من ردٍّ معلّق؛ فتطابق الأجزاء الإجماليّ بالبناء. الغرض: إنهاء الالتباس
 * «مبيعات ٧.٣م مقابل نقدٍ أقلّ» من دون خلط خزينة الإدارة بدرج الكاشير.
 */
export function TodaySalesBreakdown({
  branchScope,
  canView,
  ready,
}: {
  branchScope: number | undefined;
  canView: boolean;
  ready: boolean;
}) {
  const q = trpc.reports.todaySalesComposition.useQuery(
    { branchId: branchScope },
    { enabled: canView && ready },
  );
  if (!canView || q.isError || !q.data) return null;
  const d = q.data;
  // بندٌ غير صفريّ: وجودُ رقمٍ غير صفر (فحصُ عرضٍ، بلا حسابٍ على المال).
  const hasVal = (v: string) => /[1-9]/.test(v);
  const cells: { label: string; value: string; color: string }[] = [
    { label: "نقداً — يدخل الدرج", value: d.cash, color: "var(--sem-pos)" },
  ];
  // نقد الخزينة (ردٌّ/قبضٌ عبر الخزينة الإدارية) يظهر فقط حين يوجد — لا يُخلط بنقد الدرج.
  if (hasVal(d.treasuryCash)) {
    cells.push({ label: "نقد الخزينة — لا الدرج", value: d.treasuryCash, color: "var(--sem-info)" });
  }
  cells.push({ label: "بطاقة/تحويل/محفظة — للبنك لا الدرج", value: d.nonCash, color: "var(--sem-info)" });
  cells.push({ label: "آجل — لم يُقبض بعد", value: d.credit, color: "var(--sem-warn)" });
  // ردٌّ معلّق: مالٌ يُردّ للعميل (مرتجعُ اليوم بردٍّ غير مكتمل) — يُخصم، لا دينٌ عليه؛ يظهر عند وجوده.
  if (hasVal(d.pendingRefund)) {
    cells.push({ label: "ردٌّ معلّق للعميل — يُخصم", value: d.pendingRefund, color: "var(--sem-neg)" });
  }
  return (
    <div
      style={{
        marginTop: 10,
        borderRadius: 11,
        padding: "11px 12px",
        background: "var(--dash-stat-bg)",
        border: "1px solid var(--dash-stat-bord)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: "0.8125rem", fontWeight: 800, color: "var(--dash-text)" }}>
          تحصيل مبيعات اليوم
        </span>
        <span style={{ fontSize: "0.6875rem", color: "var(--dash-muted)" }}>
          الإجمالي {fmtAr(d.total)} د.ع
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
        {cells.map((c) => (
          <div
            key={c.label}
            style={{
              borderRadius: 8,
              padding: "8px 9px",
              background: "var(--dash-card-bg)",
              border: "1px solid var(--dash-card-bord)",
            }}
          >
            <div dir="ltr" style={{ textAlign: "right", fontSize: "1rem", fontWeight: 800, color: c.color }}>
              {fmtAr(c.value)}
            </div>
            <div style={{ fontSize: "0.625rem", color: "var(--dash-muted)", marginTop: 2, lineHeight: 1.35 }}>
              {c.label}
            </div>
          </div>
        ))}
      </div>
      <p style={{ margin: "8px 0 0", fontSize: "0.625rem", color: "var(--dash-muted)", lineHeight: 1.5 }}>
        النقد وحده قد يصل درجك؛ البطاقة/التحويل تذهب للبنك، والآجل دينٌ لم يُقبض — لذا لا تساوي
        مبيعاتُ اليوم النقدَ في الدرج. لتفصيل حركة النقد: تقرير الخزينة.
      </p>
    </div>
  );
}
