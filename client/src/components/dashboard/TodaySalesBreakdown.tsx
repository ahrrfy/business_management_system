import { trpc } from "@/lib/trpc";
import { fmtAr } from "@/lib/money";

/**
 * تركيب مبيعات اليوم — جسر «لماذا لا تساوي المبيعاتُ النقدَ في الدرج».
 *
 * يُعرَض تحت «مؤشرات اليوم» للأدوار المخوّلة برؤية التقارير فقط (الخادم يُصفّر لغيرهم).
 * الإجماليّ هنا == بطاقة «مبيعات اليوم» حرفياً (نفس getTodayNetSales)، ويتفكّك إلى
 * نقد (يدخل الدرج) + غير نقديّ (بطاقة/تحويل/محفظة، للبنك) + آجل (لم يُقبض) — والثلاثة
 * تجمع إلى الإجماليّ بالبناء. الغرض: إنهاء الالتباس «مبيعات ٧.٣م مقابل نقدٍ أقلّ».
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
  const cells = [
    { label: "نقداً — يدخل الدرج", value: d.cash, color: "var(--sem-pos)" },
    { label: "بطاقة/تحويل/محفظة — للبنك لا الدرج", value: d.nonCash, color: "var(--sem-info)" },
    { label: "آجل — لم يُقبض بعد", value: d.credit, color: "var(--sem-warn)" },
  ];
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
          الإجمالي {fmtAr(d.total)} د.ع = نقد + غير نقديّ + آجل
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
