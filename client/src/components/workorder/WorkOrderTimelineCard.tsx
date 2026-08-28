/**
 * WorkOrderTimelineCard — الخطّ الزمنيّ الكامل لأمر شغلٍ محدَّد.
 *
 * يقرأ من `trpc.workOrders.timeline` (الذي يستعلم `auditLogs` عبر `workOrderRouter.timeline`).
 * يُعرَب الفعل عبر `workOrderTimelineLabel` — قاموسٌ محروسٌ باختبارٍ نصّيّ يفشل مغلقاً حين
 * يُضاف فعلٌ جديد بلا اسمٍ عربيّ (`shared/workOrderStatus.test.ts`).
 *
 * **لماذا مكوّنٌ مستقلّ:** كان الرندرُ مضمَّناً في `WorkOrders.tsx:770` (درج الأمر)
 * و`WorkOrderStation.tsx:188` بأنماطٍ مختلفة، بينما شاشة التفاصيل الأساسيّة
 * `WorkOrderDetail.tsx` (٨٨٦ سطر) بلا خطٍّ زمنيٍّ إطلاقاً — الفنّي/الكاشير يفتحان
 * صفحة تفاصيلٍ لا تُخبرهما بتاريخ الأمر. المكوّنُ الموحَّد يعالج الفجوة ويُتيح إعادة
 * الاستعمال لاحقاً على شاشات أُخرى (فاتورة/طلب متجر).
 *
 * الحقول من الخادم: `{ id, action, oldValue?, newValue?, createdAt, userName? }`.
 */
import { AlertCircle, Loader2, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { workOrderTimelineLabel, workOrderStatusHue } from "@shared/workOrderStatus";
import { fmtDateTime } from "@/lib/date";

interface Props {
  workOrderId: number;
  /** لون الفروع الأخيرة — إن مُرِّر يُطابق hue الحالة الحاليّة للأمر (تتناغم النقاط مع البطاقة). */
  statusHue?: number;
}

export function WorkOrderTimelineCard({ workOrderId, statusHue }: Props) {
  const q = trpc.workOrders.timeline.useQuery(
    { workOrderId },
    { enabled: Number.isFinite(workOrderId) && workOrderId > 0 },
  );

  const rows = q.data ?? [];
  // ترتيب تنازليّ: الأحدث أوّلاً (كما في WorkOrders.tsx:771). النقطةُ الأولى بلون الحالة، الباقي محايد.
  const items = [...rows].reverse();
  const accentHue = statusHue ?? workOrderStatusHue(null);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-bold">
          <Clock aria-hidden className="size-4 text-muted-foreground" />
          الخطّ الزمنيّ للأمر
        </CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            <span>جارٍ تحميل الأحداث…</span>
          </div>
        ) : q.isError ? (
          <div className="flex items-center gap-2 rounded-md border border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] p-3 text-sm text-[var(--sem-neg)]">
            <AlertCircle aria-hidden className="size-4 shrink-0" />
            <span>تعذّر تحميل الخطّ الزمنيّ. حاول مجدّداً لاحقاً.</span>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            لا أحداث مسجّلة بعد لهذا الأمر.
          </div>
        ) : (
          <ol className="relative space-y-3 border-s-2 border-border ps-4">
            {items.map((r, i) => {
              const isNewest = i === 0;
              const dotColor = isNewest ? `oklch(0.6 0.17 ${accentHue})` : "var(--border-strong)";
              return (
                <li key={r.id} className="relative">
                  <span
                    aria-hidden
                    className="absolute -start-[calc(0.5rem+1px)] top-1.5 size-2.5 rounded-full ring-2 ring-card"
                    style={{ background: dotColor }}
                  />
                  <div className="ps-3">
                    <div className="text-sm font-semibold">{workOrderTimelineLabel(r.action)}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span dir="ltr" className="tabular-nums">{fmtDateTime(r.createdAt)}</span>
                      {r.userName ? <span>— {r.userName as string}</span> : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
