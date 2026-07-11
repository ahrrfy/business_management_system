/**
 * MyDeliveries — شاشة المندوب الذاتية «توصيلاتي» (دور courier، جوّال أولاً).
 *
 * المندوب يرى طلباته المُسنَدة (قيد التوصيل)، يتّصل/يراسل الزبون، وعند التسليم يضغط «تم التسليم
 * والتحصيل» فتُسدَّد الفاتورة (ذمّة العميل↓) ويرتفع النقد بذمّته (عهدة) حتى يُورّده للمتجر.
 * عزل ذاتي خادمي: كل نقطة تحلّ المندوب من الجلسة (courier.myDeliveries/confirmDelivery).
 */
import { useEffect, useState } from "react";
import { Banknote, CheckCircle2, Loader2, MapPin, MessageCircle, PackageCheck, Phone, Truck, XCircle } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fmtInt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { openWhatsApp } from "@/lib/whatsapp";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/PageState";

type MyDeliveries = RouterOutputs["courier"]["myDeliveries"];
type DeliveryRow = MyDeliveries["toDeliver"][number];

function money(v: string | number | null | undefined): string {
  return v == null || v === "" ? "0" : fmtInt(v);
}

export default function MyDeliveries() {
  const q = trpc.courier.myDeliveries.useQuery(undefined, { refetchInterval: 60_000 });
  const utils = trpc.useUtils();
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [failTarget, setFailTarget] = useState<DeliveryRow | null>(null);

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
    onSettled: () => setConfirmingId(null),
  });

  const failM = trpc.courier.failDelivery.useMutation({
    onSuccess: (res) => {
      notify.ok(`أُلغِي الطلب ${res.orderNumber}${res.reversed ? " وأُعيدت البضاعة للمخزون" : ""}`);
      setFailTarget(null);
      void utils.courier.myDeliveries.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  async function doConfirm(row: DeliveryRow) {
    const due = Number(row.codDue);
    const ok = await confirm({
      variant: due > 0 ? "warning" : "info",
      title: "تأكيد التسليم والتحصيل",
      description:
        due > 0
          ? `أكّد استلام الزبون للطلب ${row.orderNumber} وتحصيلك ${money(row.codDue)} د.ع نقداً. سيُضاف المبلغ إلى ما بذمّتك حتى تُورّده للمتجر.`
          : `أكّد استلام الزبون للطلب ${row.orderNumber} (مدفوع مسبقاً — لا تحصيل).`,
      confirmText: "تم التسليم",
    });
    if (!ok) return;
    setConfirmingId(row.id);
    confirmM.mutate({ onlineOrderId: row.id });
  }

  if (q.isError) return <div className="p-6"><ErrorState onRetry={() => q.refetch()} /></div>;

  const data = q.data;
  const linked = data?.linked ?? false;

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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard label="نقدٌ بذمّتي" value={`${money(data!.custodyBalance)} د.ع`} icon={Banknote} tone={Number(data!.custodyBalance) > 0 ? "warning" : "positive"} />
            <StatCard label="قيد التوصيل" value={data!.toDeliver.length} icon={Truck} tone="info" />
            <StatCard label="سُلّمت" value={data!.delivered.length} icon={PackageCheck} tone="positive" />
          </div>

          {Number(data!.custodyBalance) > 0 && (
            <p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              لديك <b>{money(data!.custodyBalance)} د.ع</b> بذمّتك — سلّمها إلى المتجر لتسوية عهدتك.
            </p>
          )}

          {/* قيد التوصيل */}
          <section className="space-y-2.5">
            <h2 className="text-sm font-bold text-muted-foreground">قيد التوصيل ({data!.toDeliver.length})</h2>
            {data!.toDeliver.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">لا طلبات قيد التوصيل حالياً.</div>
            ) : (
              data!.toDeliver.map((row) => (
                <DeliveryCard
                  key={row.id}
                  row={row}
                  busy={confirmingId === row.id || confirmM.isPending || failM.isPending}
                  onConfirm={() => doConfirm(row)}
                  onFail={() => setFailTarget(row)}
                />
              ))
            )}
          </section>

          {/* سُلّمت حديثاً */}
          {data!.delivered.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-bold text-muted-foreground">سُلّمت حديثاً ({data!.delivered.length})</h2>
              {data!.delivered.map((row) => (
                <div key={row.id} className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    <CheckCircle2 aria-hidden className="size-4 text-emerald-600" />
                    <span dir="ltr" className="tracking-wider">{row.orderNumber}</span>
                    <span className="text-muted-foreground">{row.customerName ?? ""}</span>
                  </span>
                  <span className="tabular-nums text-muted-foreground" dir="ltr">{money(row.orderTotal)} د.ع</span>
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
          onConfirm={(reason) => failM.mutate({ onlineOrderId: failTarget.id, reason })}
        />
      )}
    </div>
  );
}

function DeliveryCard({ row, busy, onConfirm, onFail }: { row: DeliveryRow; busy: boolean; onConfirm: () => void; onFail: () => void }) {
  const phone = row.customerPhone;
  const waMsg = `مرحباً${row.customerName ? " " + row.customerName : ""}، أنا مندوب توصيل الرؤية العربية بخصوص طلبك ${row.orderNumber}. أنا في الطريق إليك.`;
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-bold tracking-wider" dir="ltr">{row.orderNumber}</div>
          <div className="truncate text-sm text-muted-foreground">{row.customerName ?? "زبون"}</div>
        </div>
        <div className="shrink-0 text-left">
          <div className="text-[11px] text-muted-foreground">المطلوب تحصيله</div>
          <div className="text-lg font-extrabold tabular-nums text-teal-700 dark:text-teal-400" dir="ltr">{money(row.codDue)} د.ع</div>
        </div>
      </div>

      {(row.governorate || row.address) && (
        <div className="mb-3 flex items-start gap-1.5 text-xs text-muted-foreground">
          <MapPin aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="leading-relaxed">{[row.governorate, row.address].filter(Boolean).join(" — ")}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
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
        <button
          onClick={onFail}
          disabled={busy}
          className="ms-auto flex items-center gap-1 rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-600 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-500/30 dark:text-rose-400 dark:hover:bg-rose-500/10"
        >
          <XCircle aria-hidden className="size-3.5" /> تعذّر التسليم
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-teal-700 disabled:opacity-50"
        >
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <CheckCircle2 aria-hidden className="size-4" />}
          تم التسليم والتحصيل
        </button>
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
  const REASONS = ["رفض الزبون الاستلام", "الزبون غير متوفّر", "عنوان خاطئ", "تعذّر التواصل"];
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="تعذّر التسليم" onClick={onCancel} dir="rtl">
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2 text-base font-bold text-rose-600 dark:text-rose-400">
          <XCircle aria-hidden className="size-5" />
          تعذّر تسليم <span dir="ltr" className="tracking-wider">{row.orderNumber}</span>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          سيُلغى الطلب وتُعاد بضاعته للمخزون وتُصفّى ذمّة الزبون (لم يُحصَّل أيّ مبلغ). لا يمكن التراجع.
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
          className="mb-4 w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-rose-400"
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
