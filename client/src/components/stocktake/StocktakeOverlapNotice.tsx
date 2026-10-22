import { fmtInt } from "@/lib/money";

export function StocktakeOverlapNotice({ barriers }: { barriers: { activeStocktakeOverlaps: number; interveningStocktakeCounts: number } }) {
  if (!barriers.activeStocktakeOverlaps && !barriers.interveningStocktakeCounts) return null;
  return <div role="alert" className="rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-4 py-3 text-sm text-[var(--sem-warn)]">
    <p className="font-bold">تداخل جرد يحجب الاعتماد</p>
    {barriers.activeStocktakeOverlaps > 0 && <p>يوجد {fmtInt(barriers.activeStocktakeOverlaps)} صنف في جرد نشط آخر. أكمل أو ألغِ الجرد الآخر أولاً.</p>}
    {barriers.interveningStocktakeCounts > 0 && <p>يوجد {fmtInt(barriers.interveningStocktakeCounts)} عدّ تخلله اعتماد جرد آخر. اطلب إعادة العدّ لهذه الأصناف ثم أعد المراجعة والتوقيع.</p>}
    <p>تظهر الجلسة المتداخلة في تفاصيل الصنف أدناه.</p>
  </div>;
}

export function StocktakeOverlapRow({ row }: { row: {
  activeStocktakeOverlap: { code: string } | null;
  interveningStocktake: { sessionId: number } | null;
} }) {
  return <>
    {row.activeStocktakeOverlap && <p className="text-xs text-[var(--sem-warn)]">جرد نشط متداخل: {row.activeStocktakeOverlap.code}</p>}
    {row.interveningStocktake && <p className="text-xs text-[var(--sem-warn)]">اعتُمد جرد آخر #{row.interveningStocktake.sessionId} بعد العدّ — يلزم إعادة العدّ</p>}
  </>;
}
