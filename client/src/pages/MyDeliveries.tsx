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

// مفتاح فريد يجمع المصدر مع المعرّف — معرّفات onlineOrders وdeliveryConsignments مستقلّة فقد
// تتصادم (طلبٌ id=5 وإرساليةٌ id=5)، فالمفتاح المركّب يمنع تصادم مفاتيح React واختلاط الحالة.
function rowKey(row: DeliveryRow): string {
  return `${row.kind}-${row.id}`;
}

export default function MyDeliveries() {
  const q = trpc.courier.myDeliveries.useQuery(undefined, { refetchInterval: 60_000 });
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

  // إرسالية استقبال: ختمٌ تشغيليّ بحت (لا مال) — التسوية عند توريدك للمتجر.
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

  async function doConfirm(row: DeliveryRow) {
    // إرسالية استقبال: ختمٌ تشغيليّ فقط — النقد يُسوَّى عند توريدك للمتجر، لا هنا.
    if (row.kind === "consignment") {
      const ok = await confirm({
        variant: "info",
        title: "تأكيد التسليم",
        description: `أكّد تسليم الإرسالية ${row.orderNumber} للزبون. سيُسجَّل أنك سلّمتها؛ تسوية المبلغ تبقى عند توريدك للمتجر.`,
        confirmText: "تم التسليم",
      });
      if (!ok) return;
      setConfirmingKey(rowKey(row));
      confirmCnM.mutate({ consignmentId: row.id });
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
                  key={rowKey(row)}
                  row={row}
                  busy={confirmingKey === rowKey(row) || confirmM.isPending || confirmCnM.isPending || failM.isPending}
                  onConfirm={() => doConfirm(row)}
                  onFail={() => setFailTarget(row)}
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
          onConfirm={(reason) => failM.mutate({ onlineOrderId: failTarget.id, reason })}
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

function DeliveryCard({ row, busy, onConfirm, onFail }: { row: DeliveryRow; busy: boolean; onConfirm: () => void; onFail: () => void }) {
  const phone = row.customerPhone;
  const waMsg = `مرحباً${row.customerName ? " " + row.customerName : ""}، أنا مندوب توصيل الرؤية العربية بخصوص طلبك ${row.orderNumber}. أنا في الطريق إليك.`;
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bold tracking-wider" dir="ltr">{row.orderNumber}</span>
            <SourceTag kind={row.kind} />
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
        {/* «تعذّر التسليم» يعكس بيع الطلب ⇒ لطلبات المتجر فقط (لها مسار عكسٍ خاصّ). إرساليات
            الاستقبال تُعالَج تعذُّراتها بيد الموظّف عبر إرجاع الإرسالية، فلا زرّ عكسٍ للمندوب هنا. */}
        {row.kind === "online" && (
          <button
            onClick={onFail}
            disabled={busy}
            className="ms-auto flex items-center gap-1 rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-600 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-500/30 dark:text-rose-400 dark:hover:bg-rose-500/10"
          >
            <XCircle aria-hidden className="size-3.5" /> تعذّر التسليم
          </button>
        )}
        <button
          onClick={onConfirm}
          disabled={busy}
          className={`${row.kind === "consignment" ? "ms-auto " : ""}flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-teal-700 disabled:opacity-50`}
        >
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <CheckCircle2 aria-hidden className="size-4" />}
          {row.kind === "consignment" ? "تم التسليم" : "تم التسليم والتحصيل"}
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
  const REASONS = ["رفض العميل الاستلام", "العميل غير متوفّر", "عنوان خاطئ", "تعذّر التواصل"];
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="تعذّر التسليم" onClick={onCancel} dir="rtl">
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2 text-base font-bold text-rose-600 dark:text-rose-400">
          <XCircle aria-hidden className="size-5" />
          تعذّر تسليم <span dir="ltr" className="tracking-wider">{row.orderNumber}</span>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          سيُلغى الطلب وتُعاد بضاعته للمخزون وتُصفّى ذمّة العميل (لم يُحصَّل أيّ مبلغ). لا يمكن التراجع.
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
