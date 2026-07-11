/**
 * StoreSettingsPanel — إعدادات المتجر العامة (لوحة hPanel، تبويب «الإعدادات»).
 * فتح/إغلاق المتجر (يوقف الطلب مؤقتاً)، شريط إعلان أعلى المتجر، رقم واتساب.
 */
import { useEffect, useState } from "react";
import { Loader2, Megaphone, Phone, Power, Save } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";

export default function StoreSettingsPanel() {
  const utils = trpc.useUtils();
  const q = trpc.storeAdmin.settings.get.useQuery();
  const [form, setForm] = useState({ isOpen: true, announcement: "", whatsappNumber: "" });

  useEffect(() => {
    if (q.data) setForm({ isOpen: q.data.isOpen, announcement: q.data.announcement ?? "", whatsappNumber: q.data.whatsappNumber ?? "" });
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

      <div className="flex items-center justify-between rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-3">
          <span className={`flex size-10 items-center justify-center rounded-xl ${form.isOpen ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400" : "bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400"}`}>
            <Power aria-hidden className="size-5" />
          </span>
          <div>
            <p className="text-sm font-bold">{form.isOpen ? "المتجر مفتوح" : "المتجر مغلق مؤقتاً"}</p>
            <p className="text-xs text-muted-foreground">{form.isOpen ? "الزبائن يستطيعون الطلب" : "يُعرَض للزبائن أن المتجر مغلق، ويُمنع الطلب"}</p>
          </div>
        </div>
        <button
          onClick={() => setForm({ ...form, isOpen: !form.isOpen })}
          className={`relative h-7 w-12 rounded-full transition ${form.isOpen ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
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
        <input value={form.whatsappNumber} onChange={(e) => setForm({ ...form, whatsappNumber: e.target.value })} dir="ltr" placeholder="+9647XXXXXXXXX" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-left outline-none focus:ring-2 focus:ring-primary/30" />
      </label>

      <button onClick={() => m.mutate({ isOpen: form.isOpen, announcement: form.announcement || null, whatsappNumber: form.whatsappNumber || null })} disabled={m.isPending} className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
        {m.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Save aria-hidden className="size-4" />} حفظ الإعدادات
      </button>
    </div>
  );
}
