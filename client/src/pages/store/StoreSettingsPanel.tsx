/**
 * StoreSettingsPanel — إعدادات المتجر العامة (لوحة hPanel، تبويب «الإعدادات»).
 * فتح/إغلاق المتجر (يوقف الطلب مؤقتاً)، شريط إعلان أعلى المتجر، رقم واتساب.
 */
import { useEffect, useState } from "react";
import { Building2, Loader2, Megaphone, Phone, Power, Save, Truck, TriangleAlert } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { AppSelect } from "@/components/ui/AppSelect";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { MoneyInput } from "@/components/form/MoneyInput";

export default function StoreSettingsPanel() {
  const utils = trpc.useUtils();
  const q = trpc.storeAdmin.settings.get.useQuery();
  const branchesQ = trpc.branches.list.useQuery();
  const [form, setForm] = useState({
    isOpen: false,
    fulfillmentBranchId: null as number | null,
    announcement: "",
    whatsappNumber: "",
    freeShippingThreshold: "",
  });

  useEffect(() => {
    if (q.data) setForm({
      isOpen: q.data.isOpen,
      fulfillmentBranchId: q.data.fulfillmentBranchId,
      announcement: q.data.announcement ?? "",
      whatsappNumber: q.data.whatsappNumber ?? "",
      freeShippingThreshold: q.data.freeShippingThreshold ? String(Number(q.data.freeShippingThreshold)) : "",
    });
  }, [q.data]);

  const m = trpc.storeAdmin.settings.update.useMutation({
    onSuccess: () => {
      notify.ok("حُفظت الإعدادات");
      void utils.storeAdmin.settings.get.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  return (
    <div className="max-w-xl space-y-4">
      <h2 className="text-lg font-bold">إعدادات المتجر</h2>

      <label className="block text-sm">
        <span className="mb-1 flex items-center gap-1.5 font-medium text-muted-foreground">
          <Building2 aria-hidden className="size-4" /> فرع تسليم المتجر
        </span>
        <AppSelect
          value={String(form.fulfillmentBranchId ?? "")}
          onValueChange={(value) => setForm({
            ...form,
            fulfillmentBranchId: value ? Number(value) : null,
          })}
          aria-label="فرع تسليم المتجر"
        >
          <option value="">اختر فرعاً نشطاً</option>
          {(branchesQ.data ?? []).map((branch) => (
            <option key={branch.id} value={branch.id}>{branch.name} — {branch.code}</option>
          ))}
        </AppSelect>
        <span className="mt-1 block text-xs text-muted-foreground">
          هذا الفرع هو مصدر المخزون الوحيد للمتجر العام والطلبات ولوحة الكتالوج.
        </span>
      </label>

      {!form.fulfillmentBranchId && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>يبقى المتجر مغلقاً حتى تعيين فرع تسليم يحوي منتجاً جاهزاً للبيع.</span>
        </div>
      )}

      {/* حالة المتجر دلالةٌ لا زخرفة: مفتوح ⇒ sem-pos، مغلق ⇒ sem-neg. ومقبض المفتاح الأبيض يبقى
          ظاهراً: `--sem-pos` أغمق من `emerald-500` في الفاتح (تباينٌ أعلى) ومساوٍ له تقريباً في الداكن. */}
      <div className="flex items-center justify-between rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-3">
          <span className={`flex size-10 items-center justify-center rounded-xl ${form.isOpen ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]"}`}>
            <Power aria-hidden className="size-5" />
          </span>
          <div>
            <p className="text-sm font-bold">{form.isOpen ? "المتجر مفتوح" : "المتجر مغلق مؤقتاً"}</p>
            <p className="text-xs text-muted-foreground">{form.isOpen ? "الزبائن يستطيعون الطلب" : "يُعرَض للزبائن أن المتجر مغلق، ويُمنع الطلب"}</p>
          </div>
        </div>
        <button
          onClick={() => setForm({ ...form, isOpen: !form.isOpen })}
          disabled={!form.fulfillmentBranchId}
          className={`relative h-7 w-12 rounded-full transition ${form.isOpen ? "bg-[var(--sem-pos)]" : "bg-muted-foreground/40"}`}
          aria-label="فتح/إغلاق المتجر"
        >
          <span className={`absolute top-0.5 size-6 rounded-full bg-white shadow transition ${form.isOpen ? "right-0.5" : "right-[calc(100%-1.625rem)]"}`} />
        </button>
      </div>

      <label className="block text-sm">
        <span className="mb-1 flex items-center gap-1.5 font-medium text-muted-foreground"><Megaphone aria-hidden className="size-4" /> شريط إعلان أعلى المتجر (اختياري)</span>
        <input value={form.announcement} onChange={(e) => setForm({ ...form, announcement: e.target.value })} placeholder="توصيل مجاني هذا الأسبوع!" className="w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30" />
      </label>

      <label className="block text-sm">
        <span className="mb-1 flex items-center gap-1.5 font-medium text-muted-foreground"><Phone aria-hidden className="size-4" /> رقم واتساب المتجر (اختياري)</span>
        <IntlPhoneInput value={form.whatsappNumber} onChange={(whatsappNumber) => setForm({ ...form, whatsappNumber })} ariaLabel="رقم واتساب المتجر" />
      </label>

      <label className="block text-sm">
        <span className="mb-1 flex items-center gap-1.5 font-medium text-muted-foreground"><Truck aria-hidden className="size-4" /> عتبة التوصيل المجاني بالدينار (اختياري)</span>
        <MoneyInput value={form.freeShippingThreshold} onChange={(freeShippingThreshold) => setForm({ ...form, freeShippingThreshold })} decimals={0} placeholder="مثال: 50,000 (اتركه فارغاً للتعطيل)" ariaLabel="حد الشحن المجاني" />
        <span className="mt-1 block text-xs text-muted-foreground">إن بلغ طلب الزبون هذا المبلغ ⇒ توصيل مجاني (يرفع متوسط قيمة الطلب).</span>
      </label>

      <button onClick={() => m.mutate({ fulfillmentBranchId: form.fulfillmentBranchId, isOpen: form.isOpen, announcement: form.announcement || null, whatsappNumber: form.whatsappNumber || null, freeShippingThreshold: form.freeShippingThreshold ? String(Number(form.freeShippingThreshold)) : null })} disabled={m.isPending} className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
        {m.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Save aria-hidden className="size-4" />} حفظ الإعدادات
      </button>
    </div>
  );
}
