/**
 * **درج تفصيل الإرسالية** (٢٢/٨) — الشاشة التي كانت مفقودة: «ماذا حدث لهذا الطرد؟».
 * `deliveryEvents` يكتب لكلّ انتقال إلزامياً، لكن لا مستهلكَ له في الواجهة قبل اليوم.
 *
 * يُفتح بالنقر على رقم الإرسالية في أيّ جدول (قيد التوصيل، تسوية، …) — سؤالٌ يوميّ («أين
 * طردي؟ من أخرجه؟ متى قُبل؟ لماذا فشل؟») بإجابةٍ واحدة: بيانات + خط زمن + قيود دفتر.
 */
import { AlertCircle, ExternalLink, FileText, Loader2, MapPin, MessageCircle, Package, Phone, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState } from "@/components/EmptyState";
import { trpc } from "@/lib/trpc";
import { fmt } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import { cn } from "@/lib/utils";
import {
  CONSIGNMENT_VIEW_AR,
  CONSIGNMENT_VIEW_CLS,
  deriveConsignmentView,
} from "@shared/consignmentView";

/** ترجمة أنواع الأحداث للعربية — قاموسٌ قصير مُختصَر يظهر على شارة كلّ حدث. */
const EVENT_TYPE_AR: Record<string, string> = {
  DISPATCHED: "أُسنِد",
  ASSIGNED: "أُسنِد",
  ACCEPTED: "قبل السائق",
  PICKED_UP: "التقط الطرد",
  OUT_FOR_DELIVERY: "خرج للتوصيل",
  DELIVERED: "سُلِّم",
  FAILED: "تعذّر التسليم",
  RETURNED: "استُلم مرتجعاً",
  CANCELLED: "أُلغي",
  RETURN_DECLARED: "أعلنت الشركة رجوعه",
  COUNTER_SETTLED: "سدّده الزبون بالكاونتر",
  STALE_ESCALATED: "متصعَّد لركوده",
  REMITTED: "وُرِّد للمكتبة",
  WRITTEN_OFF: "شُطب عجزه",
  RECOVERED: "استُرجع مشطوبه",
  FEE_PAID: "دُفعت أجرته",
};

/** مصدر السلطة كما يُوسم في payload.source — من أجرى الفعل فعلياً. */
const SOURCE_AR: Record<string, string> = {
  COURIER_PORTAL: "بوّابة المندوب",
  COMPANY_STATEMENT: "كشف الشركة",
  MANUAL_PROOF: "إثبات يدويّ (بموافقة مدير)",
  STAFF_HANDOVER: "تسليمُ الموظّف للسائق",
  STAFF: "قرار موظّف",
  COUNTER: "قبضٌ كاونتريّ",
  SYSTEM_STALE_SWEEP: "الكنّاس الدوريّ",
};

/** ترجمة نوع قيد دفتر التوصيل — مختصر. */
const LEDGER_ENTRY_AR: Record<string, string> = {
  COD_ASSIGNED: "تعرّض إسناد",
  COD_COLLECTED: "تحصيل نقد",
  COD_REMITTED: "توريدٌ للمكتبة",
  COD_RELEASED: "تحرير تعرّض",
  COD_WRITTEN_OFF: "شطب عجز",
  COD_RECOVERED: "استرداد مشطوب",
  FEE_EARNED: "استحقاق أجرة",
  FEE_PAID: "دفع أجرة",
  FEE_OFFSET: "خصم أجرة",
  FEE_REFUNDED: "ردّ أجرة",
};

/** إشارة القيد (± داخل ذمّة الجهة) — يوجّه اللون في السطر. */
const LEDGER_ENTRY_SIGN: Record<string, 1 | -1> = {
  COD_ASSIGNED: 1,
  COD_COLLECTED: 1,
  COD_REMITTED: -1,
  COD_RELEASED: -1,
  COD_WRITTEN_OFF: -1,
  COD_RECOVERED: 1,
  FEE_EARNED: -1,
  FEE_PAID: 1,
  FEE_OFFSET: 1,
  FEE_REFUNDED: -1,
};

/** لون النقطة الزمنية بحسب نوع الحدث — يقود العين للأخطر. */
function eventDot(eventType: string): string {
  if (eventType === "DELIVERED") return "bg-[var(--sem-pos)]";
  if (eventType === "FAILED" || eventType === "CANCELLED" || eventType === "STALE_ESCALATED")
    return "bg-[var(--sem-danger)]";
  if (eventType === "RETURN_DECLARED" || eventType === "RETURNED") return "bg-[var(--sem-warn)]";
  return "bg-[var(--sem-info)]";
}

export interface ConsignmentTimelineDrawerProps {
  /** `null` = مغلق. تمرير `id` ⇒ يفتح ويسحب البيانات. */
  consignmentId: number | null;
  onClose: () => void;
}

export function ConsignmentTimelineDrawer({ consignmentId, onClose }: ConsignmentTimelineDrawerProps) {
  const isOpen = consignmentId != null;
  const q = trpc.delivery.consignmentTimeline.useQuery(
    { consignmentId: consignmentId ?? 0 },
    { enabled: isOpen },
  );

  const cn_ = q.data?.consignment;
  const viewKey = cn_
    ? deriveConsignmentView({
        parcelStatus: cn_.parcelStatus,
        status: cn_.status,
        moneyStatus: cn_.moneyStatus,
        returnDeclaredAt: cn_.returnDeclaredAt,
        partyHasPortal: cn_.partyHasPortal,
      })
    : null;
  const phone = (cn_?.recipientPhone ?? "").trim();

  return (
    <Sheet open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto" dir="rtl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Package aria-hidden className="size-5 text-primary" />
            <span dir="ltr" className="tabular-nums">{cn_?.consignmentNumber ?? `#${consignmentId ?? ""}`}</span>
            {viewKey && (
              <span className={cn("rounded-md border px-2 py-0.5 text-[11px] font-extrabold", CONSIGNMENT_VIEW_CLS[viewKey])}>
                {CONSIGNMENT_VIEW_AR[viewKey]}
              </span>
            )}
          </SheetTitle>
          {cn_ && (
            <SheetDescription>
              {cn_.partyName ?? "بلا جهة"}
              {cn_.driverName ? ` — سائق: ${cn_.driverName}` : cn_.assignedUserId ? "" : " · بلا سائق مُسنَد"}
            </SheetDescription>
          )}
        </SheetHeader>

        {q.isLoading ? (
          <div className="flex items-center justify-center p-16 text-muted-foreground">
            <Loader2 aria-hidden className="me-2 size-6 animate-spin" />
            جارٍ تحميل الخطّ الزمنيّ…
          </div>
        ) : q.isError || !q.data || !cn_ ? (
          <div className="p-6">
            <EmptyState icon={AlertCircle} title="تعذّر التحميل" description="لم يُعثَر على الإرسالية أو حدث خطأ في القراءة." />
            <div className="mt-3 text-center">
              <Button variant="outline" size="sm" onClick={() => void q.refetch()}>إعادة المحاولة</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-6 px-4 pb-6">
            {/* بيانات المستلم والعنوان */}
            <section>
              <h3 className="mb-2 text-xs font-black text-muted-foreground">المستلم والعنوان</h3>
              <div className="grid gap-2 rounded-lg border bg-card/50 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <User aria-hidden className="size-3.5 text-muted-foreground" />
                  <span className="font-medium">{cn_.recipientName ?? cn_.customerName ?? "—"}</span>
                </div>
                {phone && (
                  <div className="flex items-center gap-2">
                    <Phone aria-hidden className="size-3.5 text-muted-foreground" />
                    <a href={`tel:${phone}`} dir="ltr" className="font-mono text-primary hover:underline">{phone}</a>
                    <Button asChild size="sm" variant="outline" className="ms-auto h-7 px-2">
                      <a href={`https://wa.me/${phone.replace(/[^\d]/g, "")}`} target="_blank" rel="noreferrer">
                        <MessageCircle aria-hidden className="size-3" />
                      </a>
                    </Button>
                  </div>
                )}
                {cn_.address && (
                  <div className="flex items-start gap-2">
                    <MapPin aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />
                    <span className="leading-relaxed text-muted-foreground">{cn_.address}</span>
                  </div>
                )}
              </div>
            </section>

            {/* المستند المصدر */}
            <section>
              <h3 className="mb-2 text-xs font-black text-muted-foreground">المستند المصدر</h3>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card/50 p-3 text-sm">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
                  {cn_.sourceType === "WORK_ORDER" ? "أمر شغل" : cn_.sourceType === "ONLINE_ORDER" ? "طلب متجر" : "فاتورة"}
                </span>
                {cn_.orderNumber && <span className="font-mono text-xs" dir="ltr">{cn_.orderNumber}</span>}
                {cn_.invoiceId && (
                  <a href={`/invoices/${cn_.invoiceId}`} className="ms-auto inline-flex items-center gap-1 text-primary hover:underline">
                    <FileText aria-hidden className="size-3.5" />
                    <span dir="ltr">{cn_.invoiceNumber ?? `#${cn_.invoiceId}`}</span>
                    <ExternalLink aria-hidden className="size-3" />
                  </a>
                )}
                {cn_.workOrderId && (
                  <a href={`/work-orders/${cn_.workOrderId}`} className={cn("inline-flex items-center gap-1 text-primary hover:underline", !cn_.invoiceId && "ms-auto")}>
                    <span>أمر شغل</span>
                    <ExternalLink aria-hidden className="size-3" />
                  </a>
                )}
              </div>
            </section>

            {/* المبالغ */}
            <section>
              <h3 className="mb-2 text-xs font-black text-muted-foreground">المبالغ</h3>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border bg-card/50 p-3 text-sm">
                <div className="flex justify-between border-b pb-1"><span className="text-muted-foreground">مبلغ COD</span><span dir="ltr" className="tabular-nums font-bold">{fmt(cn_.codAmount)}</span></div>
                <div className="flex justify-between border-b pb-1"><span className="text-muted-foreground">المُحصَّل</span><span dir="ltr" className="tabular-nums font-bold text-[var(--sem-pos)]">{fmt(cn_.collectedAmount)}</span></div>
                <div className="flex justify-between border-b pb-1"><span className="text-muted-foreground">سُدِّد بالكاونتر</span><span dir="ltr" className="tabular-nums font-bold text-sky-600">{fmt(cn_.counterSettledAmount ?? "0")}</span></div>
                <div className="flex justify-between border-b pb-1">
                  <span className="text-muted-foreground">الأجرة</span>
                  <span dir="ltr" className="tabular-nums font-bold">{fmt(cn_.deliveryFee)}</span>
                </div>
                <div className="col-span-2 flex justify-between text-[11px] text-muted-foreground">
                  <span>طريقة قبض الأجرة</span>
                  <span className="font-bold">
                    {cn_.feeCollection === "COURIER" ? "يقبضها المندوب من العميل" : cn_.feeCollection === "COUNTER" ? "قُبضت بالدرج أمانةً" : "على المكتبة"}
                  </span>
                </div>
              </div>
            </section>

            {/* الرجوع المُعلَن (لو موجود) */}
            {cn_.returnDeclaredAt != null && (
              <section>
                <div className="rounded-lg border border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] p-3 text-sm">
                  <div className="mb-1 flex items-center gap-2 font-black text-[var(--sem-warn)]">
                    <AlertCircle aria-hidden className="size-4" />
                    رجوع مُعلَن — بانتظار الاستلام
                  </div>
                  <div className="text-muted-foreground">
                    {cn_.returnDeclaredReason ?? "بلا سبب مُوَثَّق"} · {fmtDateTime(cn_.returnDeclaredAt as unknown as string)}
                  </div>
                </div>
              </section>
            )}

            {/* الخط الزمنيّ */}
            <section>
              <h3 className="mb-3 text-xs font-black text-muted-foreground">خط زمن الطرد ({q.data.events.length})</h3>
              {q.data.events.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">لا أحداث مُسجَّلة بعد.</div>
              ) : (
                <ol className="space-y-2 border-s ps-4">
                  {q.data.events.map((ev) => {
                    const source = (ev.payload as { source?: string } | null)?.source;
                    const reason = (ev.payload as { reason?: string } | null)?.reason;
                    return (
                      <li key={ev.id} className="relative">
                        <span className={cn("absolute -start-[21px] top-2 size-2.5 rounded-full ring-2 ring-background", eventDot(ev.eventType))} />
                        <div className="rounded-md border bg-card/50 p-2 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-black">{EVENT_TYPE_AR[ev.eventType] ?? ev.eventType}</span>
                            <span className="text-[10px] text-muted-foreground" dir="ltr">{fmtDateTime(ev.occurredAt as unknown as string)}</span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                            <span>الفاعل: {ev.actorName ?? "النظام"}</span>
                            {source && SOURCE_AR[source] && (
                              <span className="rounded bg-muted px-1.5 py-px font-bold">{SOURCE_AR[source]}</span>
                            )}
                            {ev.fromParcelStatus && ev.toParcelStatus && ev.fromParcelStatus !== ev.toParcelStatus && (
                              <span className="text-[10px]" dir="ltr">
                                {ev.fromParcelStatus} → {ev.toParcelStatus}
                              </span>
                            )}
                          </div>
                          {reason && (
                            <div className="mt-1 text-[11px] font-bold text-[var(--sem-danger)]">{reason}</div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            {/* قيود دفتر التوصيل */}
            {q.data.ledger.length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-black text-muted-foreground">قيود دفتر التوصيل ({q.data.ledger.length})</h3>
                <div className="rounded-lg border bg-card/50">
                  <table className="w-full text-xs">
                    <thead className="border-b bg-muted/40 text-[10px] text-muted-foreground">
                      <tr>
                        <th className="p-2 text-start">التاريخ</th>
                        <th className="p-2 text-start">النوع</th>
                        <th className="p-2 text-end">المبلغ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {q.data.ledger.map((l) => {
                        const sign = LEDGER_ENTRY_SIGN[l.entryType] ?? 1;
                        return (
                          <tr key={l.id} className="border-b last:border-0">
                            <td className="p-2 text-[10px] text-muted-foreground" dir="ltr">{fmtDateTime(l.occurredAt as unknown as string)}</td>
                            <td className="p-2 font-medium">{LEDGER_ENTRY_AR[l.entryType] ?? l.entryType}</td>
                            <td className={cn("p-2 text-end tabular-nums font-bold", sign > 0 ? "text-[var(--money-positive)]" : "text-[var(--money-negative)]")} dir="ltr">
                              {sign > 0 ? "+" : "−"}{fmt(l.amount)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
