/**
 * MyDeliveries — شاشة المندوب الذاتية «توصيلاتي» (دور courier، جوّال أولاً).
 *
 * المندوب يرى طلباته المُسنَدة (قيد التوصيل)، يتّصل/يراسل العميل، وعند التسليم يضغط «تم التسليم
 * والتحصيل» فتُسدَّد الفاتورة (ذمّة العميل↓) ويرتفع النقد بذمّته (عهدة) حتى يُورّده للمتجر.
 * عزل ذاتي خادمي: كل نقطة تحلّ المندوب من الجلسة (courier.myDeliveries/confirmDelivery).
 */
import { useEffect, useState } from "react";
import { Banknote, CheckCircle2, Info, Loader2, MapPin, MessageCircle, PackageCheck, Phone, Truck, XCircle } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fmtInt } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { openWhatsApp } from "@/lib/whatsapp";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CONSIGNMENT_VIEW_AR,
  CONSIGNMENT_VIEW_CLS,
  deriveConsignmentView,
} from "@shared/consignmentView";

type MyDeliveries = RouterOutputs["courier"]["myDeliveries"];
type DeliveryRow = MyDeliveries["toDeliver"][number];

function money(v: string | number | null | undefined): string {
  return v == null || v === "" ? "0" : fmtInt(v);
}

// مفتاح فريد يجمع المصدر مع المعرّف — معرّفات onlineOrders وdeliveryConsignments مستقلّة فقد
// تتصادم (طلبٌ id=5 وإرساليةٌ id=5)، فالمفتاح المركّب يمنع تصادم مفاتيح React واختلاط الحالة.
function rowKey(row: DeliveryRow): string {
  return `${row.kind}-${row.id}`;
}

export default function MyDeliveries() {
  const q = trpc.courier.myDeliveries.useQuery(undefined, { refetchInterval: 20_000, refetchOnWindowFocus: true });
  const utils = trpc.useUtils();
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [failTarget, setFailTarget] = useState<DeliveryRow | null>(null);

  // طلب متجر: يُحصّل COD ويرفع العهدة (confirmDelivery).
  const confirmM = trpc.courier.confirmDelivery.useMutation({
    onSuccess: (res) => {
      notify.ok(
        Number(res.collected) > 0
          ? `تم تسليم ${res.orderNumber} وتحصيل ${money(res.collected)} د.ع`
          : `تم تسليم ${res.orderNumber}`,
      );
      void utils.courier.myDeliveries.invalidate();
    },
    onError: (e) => notify.err(e),
    onSettled: () => setConfirmingKey(null),
  });

  // ختم التسليم يثبت التحصيل في عهدة الجهة؛ التوريد للدرج يتم لاحقاً عند الموظف.
  const confirmCnM = trpc.courier.confirmConsignmentDelivery.useMutation({
    onSuccess: (res) => {
      notify.ok(`تم تسجيل تسليم ${res.consignmentNumber}`);
      void utils.courier.myDeliveries.invalidate();
    },
    onError: (e) => notify.err(e),
    onSettled: () => setConfirmingKey(null),
  });

  const failM = trpc.courier.failDelivery.useMutation({
    onSuccess: (res) => {
      notify.ok(`أُلغِي الطلب ${res.orderNumber}${res.reversed ? " وأُعيدت البضاعة للمخزون" : ""}`);
      setFailTarget(null);
      void utils.courier.myDeliveries.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  const transitionM = trpc.courier.parcelTransition.useMutation({
    onSuccess: () => {
      notify.ok("تم تحديث حالة الطرد");
      setFailTarget(null);
      void utils.courier.myDeliveries.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  function transitionParcel(row: DeliveryRow, toStatus: "ASSIGNED" | "ACCEPTED" | "PICKED_UP" | "OUT_FOR_DELIVERY" | "FAILED", reason?: string) {
    transitionM.mutate({
      consignmentId: row.id,
      toStatus,
      reason: reason ?? null,
      clientRequestId: crypto.randomUUID(),
    });
  }

  async function doConfirm(row: DeliveryRow) {
    // التسليم يحوّل COD المحصّل إلى عهدة الجهة حتى توريده للمتجر.
    if (row.kind === "consignment") {
      const ok = await confirm({
        variant: "info",
        title: "تأكيد التسليم",
        description: `أكّد تسليم الإرسالية ${row.orderNumber} للزبون وتحصيل مبلغها. سيُسجَّل المبلغ في عهدة جهة التوصيل حتى توريده للمتجر.`,
        confirmText: "تم التسليم",
      });
      if (!ok) return;
      setConfirmingKey(rowKey(row));
      confirmCnM.mutate({ consignmentId: row.id, clientRequestId: crypto.randomUUID() });
      return;
    }
    // طلب متجر: تأكيد + تحصيل COD يرفع عهدتك.
    const due = Number(row.codDue);
    const fee = Number(row.courierFee ?? 0);
    const ok = await confirm({
      variant: due > 0 ? "warning" : "info",
      title: "تأكيد التسليم والتحصيل",
      description:
        due > 0
          ? `أكّد استلام العميل للطلب ${row.orderNumber} وتحصيلك ${money(row.codDue)} د.ع نقداً${fee > 0 ? ` (+ أجرتك ${money(row.courierFee)} د.ع تقبضها من الزبون وتبقى لك)` : ""}. سيُضاف مبلغ التوريد إلى ما بذمّتك حتى تُورّده للمتجر.`
          : `أكّد استلام العميل للطلب ${row.orderNumber} (مدفوع مسبقاً — لا تحصيل).`,
      confirmText: "تم التسليم",
    });
    if (!ok) return;
    setConfirmingKey(rowKey(row));
    confirmM.mutate({ onlineOrderId: row.id });
  }

  if (q.isError) return <div className="p-6"><ErrorState onRetry={() => q.refetch()} /></div>;

  const data = q.data;
  const linked = data?.linked ?? false;
  const readOnly = data?.memberRole === "ACCOUNTANT";
  const ownScope = data?.memberRole === "DRIVER";

  return (
    <div className="space-y-4 p-4 md:p-6" dir="rtl">
      <PageHeader
        title="توصيلاتي"
        description="طلباتك المُسنَدة للتوصيل — أكّد التسليم وحصّل المبلغ."
        icon={<Truck aria-hidden className="size-6 text-teal-600" />}
      />

      {q.isLoading ? (
        <div className="py-16 text-center text-muted-foreground"><Loader2 aria-hidden className="mx-auto size-7 animate-spin" /></div>
      ) : !linked ? (
        <EmptyState
          icon={Truck}
          title="حسابك غير مرتبط بمندوب توصيل"
          description="راجع المدير لربط حسابك بجهة توصيل حتى تظهر طلباتك هنا."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label={ownScope ? "نقد محصل بذمتي" : "نقد محصل بذمة الجهة"} value={`${money(data!.financialSummary?.cashInCustody ?? data!.custodyBalance)} د.ع`} icon={Banknote} tone={Number(data!.custodyBalance) > 0 ? "warning" : "positive"} />
            <StatCard label="مطلوب تحصيله" value={`${money(data!.financialSummary?.codOutstanding)} د.ع`} icon={Banknote} tone="info" />
            <StatCard label="أجرة مكتسبة" value={`${money(data!.financialSummary?.feeEarned)} د.ع`} icon={Banknote} tone="positive" />
            <StatCard label={ownScope ? "أجرة مستحقة لي" : "أجرة مستحقة للجهة"} value={`${money(data!.financialSummary?.feeDue)} د.ع`} icon={Banknote} tone={Number(data!.financialSummary?.feeDue ?? 0) > 0 ? "warning" : "positive"} />
            <StatCard label="قيد التوصيل" value={data!.toDeliver.length} icon={Truck} tone="info" />
            <StatCard label="سُلّمت" value={data!.delivered.length} icon={PackageCheck} tone="positive" />
          </div>

          {data!.financialSummary?.hasFinancialAnomaly && (
            <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs font-medium text-destructive">
              يوجد انحراف مالي يحتاج مراجعة المدير: أحد أرصدة العهدة أو الأجرة أصبح سالباً. أوقِف التسوية اليدوية حتى المطابقة.
            </p>
          )}

          {Number(data!.custodyBalance) > 0 && (
            <p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              توجد عهدة COD مسجّلة بقيمة <b>{money(data!.custodyBalance)} د.ع</b> — راجع الطلبات وسلّم النقد المحصّل إلى المتجر لتسويتها.
            </p>
          )}

          {/* قيد التوصيل */}
          <section className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold text-muted-foreground">قيد التوصيل ({data!.toDeliver.length})</h2>
              {/*
                ٢٢/٨ — أزرار جماعية للمندوب: كان لكل طرد تدرّج (٣ نقرات لكلٍّ قبل زر «تم التسليم»).
                شركةٌ بعشرة طرود يومياً = ٣٠ نقرة قبل التسليم — لن تُتبنّى البوّابة عملياً.
                Promise.allSettled: كل طرد مستقل، لا نوقف الجميع عند فشل واحد.
              */}
              {!readOnly && (() => {
                const assignedIds = data!.toDeliver.filter((r) => r.kind === "consignment" && r.status === "ASSIGNED").map((r) => r.id);
                const readyOutIds = data!.toDeliver.filter((r) => r.kind === "consignment" && (r.status === "ACCEPTED" || r.status === "PICKED_UP")).map((r) => r.id);
                const busy = transitionM.isPending;
                return (
                  <div className="ms-auto flex gap-2">
                    {assignedIds.length > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={async () => {
                          const results = await Promise.allSettled(
                            assignedIds.map((id) => transitionM.mutateAsync({
                              consignmentId: id,
                              toStatus: "ACCEPTED",
                              reason: null,
                              clientRequestId: crypto.randomUUID(),
                            })),
                          );
                          const ok = results.filter((r) => r.status === "fulfilled").length;
                          const err = results.length - ok;
                          if (err === 0) notify.ok(`قُبلت ${ok} طرداً`);
                          else notify.err(`نجح ${ok} وفشل ${err} — راجع الطرود الفاشلة يدوياً`);
                          void utils.courier.myDeliveries.invalidate();
                        }}
                      >
                        قبول الكل ({assignedIds.length})
                      </Button>
                    )}
                    {readyOutIds.length > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={async () => {
                          /**
                           * ٢٢/٨ (Codex P2 #3): آلة الحالة الخادميّة تفرض ACCEPTED → PICKED_UP →
                           * OUT_FOR_DELIVERY (خطوتان لا قفزة). كان الزرّ يقفز مباشرةً فيفشل كل
                           * الـACCEPTED. الآن كل صفٍّ ACCEPTED يمرّ بخطوتين متتاليتين قبل الخروج.
                           */
                          const rowByIdMap = new Map<number, DeliveryRow>();
                          for (const row of data!.toDeliver) rowByIdMap.set(row.id, row);
                          const stepFor = (id: number): Array<"PICKED_UP" | "OUT_FOR_DELIVERY"> => {
                            const st = rowByIdMap.get(id)?.status;
                            if (st === "ACCEPTED") return ["PICKED_UP", "OUT_FOR_DELIVERY"];
                            if (st === "PICKED_UP") return ["OUT_FOR_DELIVERY"];
                            return [];
                          };
                          const results = await Promise.allSettled(
                            readyOutIds.map(async (id) => {
                              const steps = stepFor(id);
                              for (const to of steps) {
                                await transitionM.mutateAsync({
                                  consignmentId: id,
                                  toStatus: to,
                                  reason: null,
                                  clientRequestId: crypto.randomUUID(),
                                });
                              }
                            }),
                          );
                          const ok = results.filter((r) => r.status === "fulfilled").length;
                          const err = results.length - ok;
                          if (err === 0) notify.ok(`خرج ${ok} طرداً للتوصيل`);
                          else notify.err(`نجح ${ok} وفشل ${err} — راجع الطرود الفاشلة يدوياً`);
                          void utils.courier.myDeliveries.invalidate();
                        }}
                      >
                        خرج الكل الآن ({readyOutIds.length})
                      </Button>
                    )}
                  </div>
                );
              })()}
            </div>
            {data!.toDeliver.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">لا طلبات قيد التوصيل حالياً.</div>
            ) : (
              data!.toDeliver.map((row) => (
                <DeliveryCard
                  key={rowKey(row)}
                  row={row}
                  busy={confirmingKey === rowKey(row) || confirmM.isPending || confirmCnM.isPending || failM.isPending || transitionM.isPending}
                  onConfirm={() => doConfirm(row)}
                  onFail={() => setFailTarget(row)}
                  onTransition={(status) => transitionParcel(row, status)}
                  readOnly={readOnly}
                />
              ))
            )}
          </section>

          {/* سُلّمت حديثاً */}
          {data!.delivered.length > 0 && (
            <section className="space-y-2">
              <h2 className="flex items-center gap-1.5 text-sm font-bold text-muted-foreground">
                سُلّمت حديثاً ({data!.delivered.length})
                {/* lucide-react لا يقبل title كمُعامِل SVG مباشر — نلفّه بـ<span title> (نمط Inbox.tsx). */}
                <span title="تُعرض آخر ٤٠ عملية تسليم مُسجَّلة لك ضمن أحدث ١٢٠ طلباً أُسنِد إليك — عدٌّ لا حدٌّ زمنيّ (قد تظهر تسليماتٌ أقدم من أيام لو قلّت طلباتك الحديثة).">
                  <Info aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                </span>
              </h2>
              {data!.delivered.map((row) => (
                <div key={rowKey(row)} className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    <CheckCircle2 aria-hidden className="size-4 text-emerald-600" />
                    <span dir="ltr" className="tracking-wider">{row.orderNumber}</span>
                    <SourceTag kind={row.kind} />
                    <span className="text-muted-foreground">{row.customerName ?? ""}</span>
                  </span>
                  {/* ١٠/٨: orderTotal = ما دفعه الزبون عند الباب (بضاعة + أجرتك) — نوسمه كي لا
                      يُقرأ رقماً مغايراً لما ورّدته (البضاعة وحدها). */}
                  <span className="flex flex-col items-end">
                    <span className="tabular-nums text-muted-foreground" dir="ltr">{money(row.orderTotal)} د.ع</span>
                    <span className="text-[10px] text-muted-foreground">قبضته من الزبون عند الباب</span>
                  </span>
                </div>
              ))}
            </section>
          )}
        </>
      )}

      {failTarget && (
        <FailModal
          row={failTarget}
          pending={failM.isPending}
          onCancel={() => !failM.isPending && setFailTarget(null)}
          onConfirm={(reason) => failTarget.kind === "consignment"
            ? transitionParcel(failTarget, "FAILED", reason)
            : failM.mutate({ onlineOrderId: failTarget.id, reason })}
        />
      )}
    </div>
  );
}

/** وسم المصدر: طلب متجر (onlineOrders) أو إرسالية استقبال (deliveryConsignments). */
function SourceTag({ kind }: { kind: DeliveryRow["kind"] }) {
  const isStore = kind === "online";
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
        isStore
          ? "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300"
          : "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
      }`}
    >
      {isStore ? "طلب متجر" : "استلام"}
    </span>
  );
}

/**
 * ٢٢/٨ — قاموس الحالة المحلّي حُذف واستُبدل بـ`@shared/consignmentView` (`deriveConsignmentView`
 * + `CONSIGNMENT_VIEW_AR` + `CONSIGNMENT_VIEW_CLS`) — لا شاشة تُعيد تعريف قاموس حالة بعد اليوم.
 * المندوب على البوّابة دائماً ⇒ نمرّر `partyHasPortal: 1`.
 */
function courierParcelBadge(parcelStatus: string | null | undefined) {
  const key = deriveConsignmentView({
    parcelStatus: parcelStatus ?? null,
    status: "DISPATCHED",
    moneyStatus: null,
    returnDeclaredAt: null,
    partyHasPortal: 1,
  });
  return { label: CONSIGNMENT_VIEW_AR[key], cls: CONSIGNMENT_VIEW_CLS[key] };
}

function DeliveryCard({ row, busy, onConfirm, onFail, onTransition, readOnly }: { row: DeliveryRow; busy: boolean; onConfirm: () => void; onFail: () => void; onTransition: (status: "ASSIGNED" | "ACCEPTED" | "PICKED_UP" | "OUT_FOR_DELIVERY") => void; readOnly: boolean }) {
  const phone = row.customerPhone;
  const waMsg = `مرحباً${row.customerName ? " " + row.customerName : ""}، أنا مندوب توصيل الرؤية العربية بخصوص طلبك ${row.orderNumber}. أنا في الطريق إليك.`;
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bold tracking-wider" dir="ltr">{row.orderNumber}</span>
            <SourceTag kind={row.kind} />
            {row.kind === "consignment" && (() => {
              const b = courierParcelBadge(row.status);
              return <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-extrabold", b.cls)}>{b.label}</span>;
            })()}
          </div>
          <div className="truncate text-sm text-muted-foreground">{row.customerName ?? "عميل"}</div>
        </div>
        <div className="shrink-0 text-left">
          <div className="text-[11px] text-muted-foreground">المطلوب تحصيله</div>
          <div className="text-lg font-extrabold tabular-nums text-teal-700 dark:text-teal-400" dir="ltr">{money(row.codDue)} د.ع</div>
          {/* ١٠/٨ (تمرير كامل): أجرة المندوب تُقبض من الزبون فوق المبلغ وتبقى له — لا تُورَّد. */}
          {Number(row.courierFee) > 0 && (
            <div className="text-[11px] font-bold text-muted-foreground" dir="rtl">+ أجرتك: <span dir="ltr" className="tabular-nums">{money(row.courierFee)}</span> (تبقى لك)</div>
          )}
        </div>
      </div>

      {(row.governorate || row.address || (row.latitude && row.longitude)) && (
        <div className="mb-3 flex items-start gap-1.5 text-xs text-muted-foreground">
          <MapPin aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <div className="leading-relaxed">
            {(row.governorate || row.address) && <div>{[row.governorate, row.address].filter(Boolean).join(" — ")}</div>}
            {row.latitude && row.longitude && (
              <a
                href={`https://www.google.com/maps?q=${encodeURIComponent(`${row.latitude},${row.longitude}`)}`}
                target="_blank"
                rel="noreferrer"
                className="font-bold text-primary hover:underline"
              >فتح الموقع على الخريطة</a>
            )}
          </div>
        </div>
      )}

      {row.kind === "consignment" && (row.acceptedAt || row.pickedUpAt || row.outForDeliveryAt || row.failureReason) && (
        <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {row.acceptedAt && <span>قُبل: {fmtDateTime(row.acceptedAt)}</span>}
          {row.pickedUpAt && <span>استُلم: {fmtDateTime(row.pickedUpAt)}</span>}
          {row.outForDeliveryAt && <span>خرج: {fmtDateTime(row.outForDeliveryAt)}</span>}
          {row.failureReason && <span className="text-destructive">السبب: {row.failureReason}</span>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!readOnly && row.kind === "consignment" && row.status === "ASSIGNED" && (
          <Button variant="outline" size="sm" onClick={() => onTransition("ACCEPTED")} disabled={busy}>قبول الطلب</Button>
        )}
        {!readOnly && row.kind === "consignment" && row.status === "ACCEPTED" && (
          <Button variant="outline" size="sm" onClick={() => onTransition("PICKED_UP")} disabled={busy}>استلمت الطرد</Button>
        )}
        {!readOnly && row.kind === "consignment" && row.status === "PICKED_UP" && (
          <Button variant="outline" size="sm" onClick={() => onTransition("OUT_FOR_DELIVERY")} disabled={busy}>خرج للتوصيل</Button>
        )}
        {!readOnly && row.kind === "consignment" && row.status === "FAILED" && (
          <Button variant="outline" size="sm" onClick={() => onTransition("ASSIGNED")} disabled={busy}>إعادة المحاولة</Button>
        )}
        {phone && (
          <>
            <a
              href={`tel:${phone}`}
              className="flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs font-bold transition hover:bg-accent"
            >
              <Phone aria-hidden className="size-3.5" /> اتّصال
            </a>
            <button
              onClick={() => openWhatsApp(phone, waMsg)}
              className="flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 transition hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-400"
            >
              <MessageCircle aria-hidden className="size-3.5" /> واتساب
            </button>
          </>
        )}
        {/* «تعذّر التسليم» يعكس بيع الطلب ⇒ لطلبات المتجر فقط (لها مسار عكسٍ خاصّ). إرساليات
            الاستقبال تُعالَج تعذُّراتها بيد الموظّف عبر إرجاع الإرسالية، فلا زرّ عكسٍ للمندوب هنا. */}
        {!readOnly && (row.kind === "online" || (row.kind === "consignment" && row.status !== "FAILED")) && (
          <button
            onClick={onFail}
            disabled={busy}
            className="ms-auto flex items-center gap-1 rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-600 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-500/30 dark:text-rose-400 dark:hover:bg-rose-500/10"
          >
            <XCircle aria-hidden className="size-3.5" /> تعذّر التسليم
          </button>
        )}
        {!readOnly && (row.kind !== "consignment" || row.status === "OUT_FOR_DELIVERY") && <button
          onClick={onConfirm}
          disabled={busy}
          className={`${row.kind === "consignment" ? "ms-auto " : ""}flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-teal-700 disabled:opacity-50`}
        >
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <CheckCircle2 aria-hidden className="size-4" />}
          {row.kind === "consignment" ? "تم التسليم" : "تم التسليم والتحصيل"}
        </button>}
      </div>
    </div>
  );
}

/** حوار «تعذّر التسليم»: سبب إلزامي ثم عكس بيع الطلب + إلغاؤه. z-[100]. */
function FailModal({ row, pending, onCancel, onConfirm }: { row: DeliveryRow; pending: boolean; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !pending) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, onCancel]);
  const REASONS = ["رفض العميل الاستلام", "العميل غير متوفّر", "عنوان خاطئ", "تعذّر التواصل"];
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="تعذّر التسليم" onClick={onCancel} dir="rtl">
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2 text-base font-bold text-rose-600 dark:text-rose-400">
          <XCircle aria-hidden className="size-5" />
          تعذّر تسليم <span dir="ltr" className="tracking-wider">{row.orderNumber}</span>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          {row.kind === "consignment"
            ? "سيُسجَّل تعذّر المحاولة مع السبب، ويبقى الطرد قابلاً لإعادة المحاولة أو الإرجاع من الإدارة. لن يُلغى البيع أو يتحرك المخزون الآن."
            : "سيُلغى طلب المتجر وتُعاد بضاعته للمخزون وتُصفّى ذمّة العميل. لا يمكن التراجع."}
        </p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {REASONS.map((r) => (
            <button key={r} type="button" onClick={() => setReason(r)} className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${reason === r ? "bg-rose-600 text-white" : "bg-muted text-muted-foreground hover:bg-accent"}`}>
              {r}
            </button>
          ))}
        </div>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="سبب تعذّر التسليم…"
          rows={2}
          className="mb-4 w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        <div className="flex items-center justify-end gap-2">
          <button onClick={onCancel} disabled={pending} className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent disabled:opacity-50">تراجع</button>
          <button
            onClick={() => reason.trim().length >= 2 && onConfirm(reason.trim())}
            disabled={pending || reason.trim().length < 2}
            className="flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-rose-700 disabled:opacity-50"
          >
            {pending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <XCircle aria-hidden className="size-4" />}
            تأكيد الإلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
