/**
 * MyDeliveries — شاشة المندوب الذاتية «توصيلاتي» (دور courier، جوّال أولاً).
 *
 * المندوب يرى طلباته المُسنَدة (قيد التوصيل)، يتّصل/يراسل العميل، وعند التسليم يضغط «تم التسليم
 * والتحصيل» فتُسدَّد الفاتورة (ذمّة العميل↓) ويرتفع النقد بذمّته (عهدة) حتى يُورّده للمتجر.
 * عزل ذاتي خادمي: كل نقطة تحلّ المندوب من الجلسة (courier.myDeliveries/confirmDelivery).
 */
import { useEffect, useState } from "react";
import { AlertCircle, Banknote, CheckCircle2, Info, Loader2, MapPin, MessageCircle, PackageCheck, Phone, Truck, XCircle } from "lucide-react";
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
import { SHORTFALL_REASONS, SHORTFALL_REASON_LABEL_AR, type ShortfallReason } from "@shared/shortfallReason";

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
  const [partialTarget, setPartialTarget] = useState<DeliveryRow | null>(null);
  const [toDeliverFilter, setToDeliverFilter] = useState<"ALL" | "UNRECEIVED" | "IN_TRANSIT">("ALL");

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

  function doPartialConfirm(row: DeliveryRow, collectedAmount: string, reason?: string) {
    setConfirmingKey(rowKey(row));
    confirmCnM.mutate({
      consignmentId: row.id,
      collectedAmount,
      shortfallReason: (reason ?? "PARTIAL_REFUSAL") as any,
      clientRequestId: crypto.randomUUID(),
    });
    setPartialTarget(null);
  }

  if (q.isError) return <div className="p-6"><ErrorState onRetry={() => q.refetch()} /></div>;

  const data = q.data;
  const linked = data?.linked ?? false;
  const readOnly = data?.memberRole === "ACCOUNTANT";
  const ownScope = data?.memberRole === "DRIVER";

  const unreceivedRows = (data?.toDeliver ?? []).filter((r) => r.status === "ASSIGNED");
  const inTransitRows = (data?.toDeliver ?? []).filter((r) => r.status !== "ASSIGNED");
  const displayedToDeliver = toDeliverFilter === "UNRECEIVED"
    ? unreceivedRows
    : toDeliverFilter === "IN_TRANSIT"
    ? inTransitRows
    : (data?.toDeliver ?? []);

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
            <StatCard label="سُلّمت (بانتظار التحاسب)" value={data!.delivered.length} icon={PackageCheck} tone={data!.delivered.length > 0 ? "warning" : "positive"} />
          </div>

          {data!.financialSummary?.hasFinancialAnomaly && (
            <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs font-medium text-destructive">
              يوجد انحراف مالي يحتاج مراجعة المدير: أحد أرصدة العهدة أو الأجرة أصبح سالباً. أوقِف التسوية اليدوية حتى المطابقة.
            </p>
          )}

          {Number(data!.custodyBalance) > 0 && (
            <p className="rounded-xl border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-xs font-medium text-[var(--sem-warn)]">
              توجد عهدة COD مسجّلة بقيمة <b>{money(data!.custodyBalance)} د.ع</b> — راجع الطلبات وسلّم النقد المحصّل إلى المتجر لتسويتها.
            </p>
          )}

          {/* قيد التوصيل */}
          <section className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold text-muted-foreground">قيد التوصيل ({data!.toDeliver.length})</h2>
              {data!.toDeliver.length > 0 && (
                <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setToDeliverFilter("ALL")}
                    className={cn(
                      "rounded-md px-2.5 py-1 font-semibold transition",
                      toDeliverFilter === "ALL" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    الكل ({data!.toDeliver.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setToDeliverFilter("UNRECEIVED")}
                    className={cn(
                      "rounded-md px-2.5 py-1 font-semibold transition",
                      toDeliverFilter === "UNRECEIVED" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    غير مستلم ({unreceivedRows.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setToDeliverFilter("IN_TRANSIT")}
                    className={cn(
                      "rounded-md px-2.5 py-1 font-semibold transition",
                      toDeliverFilter === "IN_TRANSIT" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    مستلم / بالطريق ({inTransitRows.length})
                  </button>
                </div>
              )}
            </div>
            {data!.toDeliver.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">لا طلبات قيد التوصيل حالياً.</div>
            ) : displayedToDeliver.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">لا طلبات تطابق الفلتر المحدد.</div>
            ) : (
              displayedToDeliver.map((row) => (
                <DeliveryCard
                  key={rowKey(row)}
                  row={row}
                  busy={confirmingKey === rowKey(row) || confirmM.isPending || confirmCnM.isPending || failM.isPending}
                  onConfirm={() => doConfirm(row)}
                  onPartial={() => setPartialTarget(row)}
                  onFail={() => setFailTarget(row)}
                  readOnly={readOnly}
                />
              ))
            )}
          </section>

          {/* سُلّمت — بانتظار التحاسب */}
          {data!.delivered.length > 0 && (
            <section className="space-y-2">
              <h2 className="flex items-center gap-1.5 text-sm font-bold text-muted-foreground">
                سُلّمت — بانتظار التحاسب ({data!.delivered.length})
                <span title="الطلبات المُسلَّمة للزبائن والتي لم يتم التحاسب عليها أو توريد نقدها للمتجر بعد. تختفي تلقائياً بمجرد إثبات التوريد.">
                  <Info aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                </span>
              </h2>
              {data!.delivered.map((row) => {
                const isPartial = row.moneyStatus === "PARTIAL" || (Number(row.collectedAmount ?? 0) > 0 && Number(row.codDue) > 0);
                return (
                  <div
                    key={rowKey(row)}
                    className={cn(
                      "flex items-center justify-between rounded-xl border p-3 text-sm transition",
                      isPartial
                        ? "border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/40"
                        : "border-[var(--sem-pos)]/25 bg-[var(--sem-pos)]/5",
                    )}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      {isPartial ? (
                        <AlertCircle aria-hidden className="size-4 shrink-0 text-[var(--sem-warn)]" />
                      ) : (
                        <CheckCircle2 aria-hidden className="size-4 shrink-0 text-[var(--sem-pos)]" />
                      )}
                      <span dir="ltr" className="font-bold tracking-wider text-foreground">{row.orderNumber}</span>
                      <SourceTag kind={row.kind} />
                      {isPartial ? (
                        <span className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--sem-warn)]">
                          تسليم جزئي
                        </span>
                      ) : (
                        <span className="rounded-md border border-[var(--sem-pos)]/40 bg-[var(--sem-pos)]/10 px-1.5 py-0.5 text-[10px] font-bold text-[var(--sem-pos)]">
                          تسليم كامل
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">{row.customerName ?? ""}</span>
                    </span>

                    <span className="flex flex-col items-end">
                      {isPartial ? (
                        <>
                          <span className="tabular-nums font-bold text-foreground" dir="ltr">
                            مقبوض: {money(row.collectedAmount)} د.ع
                          </span>
                          <span className="tabular-nums text-[10px] font-bold text-[var(--sem-warn)]" dir="ltr">
                            عجز: {money(row.codDue)} د.ع
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="tabular-nums font-bold text-foreground" dir="ltr">
                            {money(row.orderTotal)} د.ع
                          </span>
                          <span className="text-[10px] text-muted-foreground">قبضته بالكامل عند الباب</span>
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </section>
          )}
        </>
      )}

      {partialTarget && (
        <PartialModal
          row={partialTarget}
          pending={confirmCnM.isPending}
          onCancel={() => !confirmCnM.isPending && setPartialTarget(null)}
          onConfirm={(amount, reason) => doPartialConfirm(partialTarget, amount, reason)}
        />
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

function DeliveryCard({ row, busy, onConfirm, onPartial, onFail, readOnly }: { row: DeliveryRow; busy: boolean; onConfirm: () => void; onPartial: () => void; onFail: () => void; readOnly: boolean }) {
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
            {row.externalTrackingRef && (
              <span className="rounded-md border border-muted-foreground/30 bg-muted/60 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground" dir="ltr" title="مرجع إيصال الشركة">
                {row.externalTrackingRef}
              </span>
            )}
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

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2.5">
        {/* أزرار التواصل (اتصال + واتساب) */}
        <div className="flex items-center gap-1.5">
          {phone && (
            <>
              <a
                href={`tel:${phone}`}
                className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-bold transition hover:bg-accent"
              >
                <Phone aria-hidden className="size-3.5" /> اتّصال
              </a>
              <button
                type="button"
                onClick={() => openWhatsApp(phone, waMsg)}
                className="flex items-center gap-1 rounded-lg border border-[var(--brand-whatsapp)]/40 bg-[var(--brand-whatsapp)]/10 px-2.5 py-1.5 text-xs font-bold text-[var(--brand-whatsapp)] transition hover:bg-[var(--brand-whatsapp)]/20"
              >
                <MessageCircle aria-hidden className="size-3.5" /> واتساب
              </button>
            </>
          )}
        </div>

        {/* أزرار الإجراء المباشرة الصريحة */}
        {!readOnly && (
          <div className="ms-auto flex flex-wrap items-center gap-1.5">
            {/* تعذّر التسليم */}
            {(row.kind === "online" || (row.kind === "consignment" && row.status !== "FAILED")) && (
              <button
                type="button"
                onClick={onFail}
                disabled={busy}
                className="flex items-center gap-1 rounded-lg border border-[var(--sem-neg)]/40 px-2.5 py-1.5 text-xs font-bold text-[var(--sem-neg)] transition hover:bg-[var(--sem-neg-bg)] disabled:opacity-50"
              >
                <XCircle aria-hidden className="size-3.5" /> تعذّر التسليم
              </button>
            )}

            {/* تسليم جزئي — متاح للإرساليات التي عليها مبلغ مطلوب */}
            {row.kind === "consignment" && Number(row.codDue) > 0 && (
              <button
                type="button"
                onClick={onPartial}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--sem-warn)]/50 bg-[var(--sem-warn-bg)] px-3 py-1.5 text-xs font-bold text-[var(--sem-warn)] transition hover:bg-[var(--sem-warn)]/20 disabled:opacity-50"
              >
                <AlertCircle aria-hidden className="size-3.5" /> تسليم جزئي
              </button>
            )}

            {/* تم التسليم بالكامل */}
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3.5 py-1.5 text-xs font-bold text-white transition hover:bg-teal-700 disabled:opacity-50"
            >
              {busy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <CheckCircle2 aria-hidden className="size-3.5" />}
              تم التسليم
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** حوار «تسليم جزئي»: إدخال المبلغ المقبوض فعلياً واختيار سبب العجز. z-[100]. */
function PartialModal({
  row,
  pending,
  onCancel,
  onConfirm,
}: {
  row: DeliveryRow;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (amount: string, reason?: ShortfallReason) => void;
}) {
  const due = Number(row.codDue ?? row.orderTotal ?? 0);
  const [amountStr, setAmountStr] = useState("");
  const [reason, setReason] = useState<ShortfallReason>("PARTIAL_REFUSAL");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, onCancel]);

  const numAmount = Number(amountStr);
  const isValidAmount =
    amountStr.trim() !== "" && !isNaN(numAmount) && numAmount >= 0 && numAmount < due;
  const shortage = isValidAmount ? Math.max(0, due - numAmount) : 0;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="تسليم جزئي"
      onClick={onCancel}
      dir="rtl"
    >
      <div
        className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2 text-base font-bold text-[var(--sem-warn)]">
          <AlertCircle aria-hidden className="size-5" />
          تسليم جزئي للطرد <span dir="ltr" className="tracking-wider">{row.orderNumber}</span>
        </div>

        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          أدخل المبلغ الفعلي الذي قبضته من العميل. سيُسجَّل الفرق كعجز تحصيل على الفاتورة وتتحول حالة الطرد إلى مُسلَّم.
        </p>

        <div className="mb-4 rounded-lg border border-border bg-muted/40 p-3 text-xs space-y-1">
          <div className="flex justify-between">
            <span className="text-muted-foreground">المبلغ المطلوب كاملاً:</span>
            <span className="font-bold tabular-nums" dir="ltr">{money(due)} د.ع</span>
          </div>
          {isValidAmount && (
            <>
              <div className="flex justify-between font-medium text-[var(--sem-pos)]">
                <span>المقبوض:</span>
                <span className="tabular-nums" dir="ltr">{money(numAmount)} د.ع</span>
              </div>
              <div className="flex justify-between font-bold text-[var(--sem-warn)]">
                <span>عجز التحصيل:</span>
                <span className="tabular-nums" dir="ltr">{money(shortage)} د.ع</span>
              </div>
            </>
          )}
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-bold text-foreground">
              المبلغ المقبوض فعلياً (د.ع) <span className="text-destructive">*</span>
            </label>
            <input
              type="number"
              min="0"
              max={Math.max(0, due - 1)}
              step="any"
              autoFocus
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              placeholder={`أقل من ${money(due)}`}
              className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            {numAmount >= due && amountStr !== "" && (
              <p className="mt-1 text-[11px] text-[var(--sem-neg)]">
                للتسليم بالمبلغ الكامل، استخدم زر «تم التسليم» المباشر بدلاً من الجزئي.
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              سبب العجز / النقص
            </label>
            <div className="flex flex-wrap gap-1.5">
              {SHORTFALL_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs font-medium transition",
                    reason === r
                      ? "bg-[var(--sem-warn)] text-background"
                      : "bg-muted text-muted-foreground hover:bg-accent",
                  )}
                >
                  {SHORTFALL_REASON_LABEL_AR[r]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent disabled:opacity-50"
          >
            تراجع
          </button>
          <button
            type="button"
            onClick={() => isValidAmount && onConfirm(amountStr.trim(), reason)}
            disabled={pending || !isValidAmount}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--sem-warn)] px-4 py-2 text-sm font-bold text-background transition hover:bg-[var(--sem-warn-hover)] disabled:opacity-50"
          >
            {pending ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <CheckCircle2 aria-hidden className="size-4" />
            )}
            تأكيد التسليم الجزئي
          </button>
        </div>
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
        <div className="mb-1 flex items-center gap-2 text-base font-bold text-[var(--sem-neg)]">
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
            <button key={r} type="button" onClick={() => setReason(r)} className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${reason === r ? "bg-[var(--sem-neg)] text-background" : "bg-muted text-muted-foreground hover:bg-accent"}`}>
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
            className="flex items-center gap-1.5 rounded-lg bg-[var(--sem-neg)] px-4 py-2 text-sm font-bold text-background transition hover:bg-[var(--sem-neg-hover)] disabled:opacity-50"
          >
            {pending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <XCircle aria-hidden className="size-4" />}
            تأكيد الإلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
