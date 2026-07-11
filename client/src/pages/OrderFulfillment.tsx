/**
 * OrderFulfillment — الجهة الإدارية لطلبات المتجر الإلكترونية (لوحة تنفيذ بنمط Kanban خفيف).
 *
 * الموظف: يرى الطلبات الواردة (وارد) ← يثبّتها ← يطبع ملصق الطلب على طابعة الملصقات (بضغطة،
 * صفر إدخال يدوي = منع الخطأ) ← يسلّمها للمندوب ← تُسلَّم. عزل الفرع خادمياً (storeReadProcedure).
 * بلا أثر مالي هنا (تحويل الطلب لفاتورة/إرسالية شريحة لاحقة).
 */
import { useState } from "react";
import { Check, ClipboardList, Loader2, MessageCircle, Package, Printer, Store, Truck, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmtInt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { buildOnlineOrderFollowupMessage, openWhatsApp } from "@/lib/whatsapp";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { printOrderLabelDoc } from "@/lib/printing/orderLabel";

type Status = "PENDING" | "CONFIRMED" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED";

const STATUS_META: Record<Status, { label: string; pill: string }> = {
  PENDING: { label: "وارد", pill: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" },
  CONFIRMED: { label: "مثبَّت", pill: "bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300" },
  PROCESSING: { label: "قيد التجهيز", pill: "bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300" },
  SHIPPED: { label: "مع المندوب", pill: "bg-teal-100 text-teal-800 dark:bg-teal-500/15 dark:text-teal-300" },
  DELIVERED: { label: "سُلّم", pill: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" },
  CANCELLED: { label: "ملغى", pill: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400" },
};

/** الخطوة الأمامية الطبيعية لكل حالة (زر «التالي»). */
const NEXT_STEP: Partial<Record<Status, { to: Status; label: string }>> = {
  PENDING: { to: "CONFIRMED", label: "تثبيت الطلب" },
  CONFIRMED: { to: "SHIPPED", label: "تسليم للمندوب" },
  PROCESSING: { to: "SHIPPED", label: "تسليم للمندوب" },
  SHIPPED: { to: "DELIVERED", label: "تم التسليم" },
};

const FILTERS: { value: Status | null; label: string }[] = [
  { value: null, label: "الكل" },
  { value: "PENDING", label: "وارد" },
  { value: "CONFIRMED", label: "مثبَّت" },
  { value: "SHIPPED", label: "مع المندوب" },
  { value: "DELIVERED", label: "سُلّم" },
];

function money(v: string | number | null): string {
  return v == null || v === "" ? "0" : fmtInt(v);
}

export default function OrderFulfillment() {
  const [filter, setFilter] = useState<Status | null>(null);
  const [printingId, setPrintingId] = useState<number | null>(null);
  const utils = trpc.useUtils();

  const countsQ = trpc.storeAdmin.orders.counts.useQuery();
  const listQ = trpc.storeAdmin.orders.list.useQuery({ status: filter, limit: 200 });
  const setStatusM = trpc.storeAdmin.orders.setStatus.useMutation({
    onSuccess: (res) => {
      notify.ok(`تم تحديث الطلب إلى «${STATUS_META[res.to].label}»`);
      void utils.storeAdmin.orders.list.invalidate();
      void utils.storeAdmin.orders.counts.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  const counts = countsQ.data ?? {};
  const orders = listQ.data ?? [];

  async function advance(id: number, to: Status, label: string) {
    const ok = await confirm({ title: `${label}؟`, description: `الطلب رقم ${id}` });
    if (ok) setStatusM.mutate({ id, status: to });
  }
  async function cancel(id: number) {
    const ok = await confirm({ title: "إلغاء الطلب؟", description: `الطلب رقم ${id} — لا يمكن التراجع` });
    if (ok) setStatusM.mutate({ id, status: "CANCELLED" });
  }
  async function printLabel(id: number) {
    setPrintingId(id);
    try {
      const d = await utils.storeAdmin.orders.detail.fetch({ id });
      if (!d) {
        notify.err("تعذّر جلب تفاصيل الطلب");
        return;
      }
      const res = await printOrderLabelDoc({
        orderNumber: d.orderNumber,
        customerName: d.customerName,
        customerPhone: d.customerPhone,
        governorate: d.governorate,
        addressText: d.addressText,
        subtotal: d.subtotal,
        deliveryFee: d.deliveryFee,
        total: d.total,
        createdAt: d.createdAt,
        items: d.items.map((it) => ({ productName: it.productName, unitName: it.unitName, quantity: it.quantity })),
      });
      notify.ok(res.via === "browser" ? "فُتحت نافذة الطباعة" : "أُرسل الملصق إلى الطابعة");
    } catch (e) {
      notify.err(e);
    } finally {
      setPrintingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="طلبات المتجر الإلكتروني" description="تثبيت الطلبات الواردة وطباعة ملصق التوصيل" icon={<Store aria-hidden className="size-5" />} />

      {/* بطاقات الحالة */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <StatCard label="وارد" value={counts.PENDING ?? 0} icon={ClipboardList} tone="warning" onClick={() => setFilter("PENDING")} />
        <StatCard label="مثبَّت" value={counts.CONFIRMED ?? 0} icon={Check} tone="info" onClick={() => setFilter("CONFIRMED")} />
        <StatCard label="قيد التجهيز" value={counts.PROCESSING ?? 0} icon={Package} />
        <StatCard label="مع المندوب" value={counts.SHIPPED ?? 0} icon={Truck} onClick={() => setFilter("SHIPPED")} />
        <StatCard label="سُلّم" value={counts.DELIVERED ?? 0} icon={Check} tone="positive" onClick={() => setFilter("DELIVERED")} />
      </div>

      {/* فلاتر */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.value)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
              filter === f.value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* الجدول */}
      <ScrollTableShell>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right">
              <th className="p-2 font-bold">رقم الطلب</th>
              <th className="p-2 font-bold">الزبون</th>
              <th className="p-2 font-bold">الهاتف</th>
              <th className="p-2 font-bold">المحافظة</th>
              <th className="p-2 text-center font-bold">أصناف</th>
              <th className="p-2 font-bold">الإجمالي (COD)</th>
              <th className="p-2 font-bold">الحالة</th>
              <th className="p-2 font-bold">الإجراءات</th>
            </tr>
          </thead>
          <tbody>
            {listQ.isLoading ? (
              <tr>
                <td colSpan={8} className="p-8 text-center text-muted-foreground">
                  <Loader2 aria-hidden className="mx-auto size-6 animate-spin" />
                </td>
              </tr>
            ) : orders.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-10 text-center text-muted-foreground">لا توجد طلبات</td>
              </tr>
            ) : (
              orders.map((o) => {
                const st = (o.status as Status) in STATUS_META ? (o.status as Status) : "PENDING";
                const meta = STATUS_META[st];
                const next = NEXT_STEP[st];
                const isBusy = setStatusM.isPending || printingId === o.id;
                return (
                  <tr key={o.id} className="border-t border-border hover:bg-muted/40">
                    <td className="p-2 font-bold tracking-wider" dir="ltr">{o.orderNumber}</td>
                    <td className="p-2">{o.customerName ?? "—"}</td>
                    <td className="p-2 tabular-nums" dir="ltr">{o.customerPhone ?? "—"}</td>
                    <td className="p-2">{o.governorate ?? "—"}</td>
                    <td className="p-2 text-center tabular-nums">{o.itemCount}</td>
                    <td className="p-2 font-bold tabular-nums" dir="ltr">{money(o.total)} د.ع</td>
                    <td className="p-2">
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-bold ${meta.pill}`}>{meta.label}</span>
                    </td>
                    <td className="p-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          onClick={() => printLabel(o.id)}
                          disabled={isBusy}
                          className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-bold transition hover:bg-accent disabled:opacity-50"
                        >
                          {printingId === o.id ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Printer aria-hidden className="size-3.5" />}
                          الملصق
                        </button>
                        {o.customerPhone && (
                          <button
                            onClick={() => openWhatsApp(o.customerPhone, buildOnlineOrderFollowupMessage({ orderNumber: o.orderNumber, customerName: o.customerName, total: o.total, status: o.status }))}
                            title="متابعة الزبون عبر واتساب"
                            className="flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-50 px-2.5 py-1.5 text-xs font-bold text-emerald-700 transition hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-400"
                          >
                            <MessageCircle aria-hidden className="size-3.5" /> واتساب
                          </button>
                        )}
                        {next && (
                          <button
                            onClick={() => advance(o.id, next.to, next.label)}
                            disabled={isBusy}
                            className="flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                          >
                            <Check aria-hidden className="size-3.5" />
                            {next.label}
                          </button>
                        )}
                        {(st === "PENDING" || st === "CONFIRMED" || st === "PROCESSING") && (
                          <button
                            onClick={() => cancel(o.id)}
                            disabled={isBusy}
                            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-rose-500 transition hover:bg-rose-50 disabled:opacity-50 dark:hover:bg-rose-500/10"
                          >
                            <X aria-hidden className="size-3.5" />
                            إلغاء
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </ScrollTableShell>
    </div>
  );
}
