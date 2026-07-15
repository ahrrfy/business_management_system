/**
 * BannerManager — إدارة البنرات الإعلانية للمتجر (لوحة hPanel، تبويب «البنرات»).
 * إضافة/تعديل/تفعيل/حذف بنر بعنوان + صورة + زرّ (CTA) + ترتيب + نافذة تاريخ + **موضع**
 * (رئيسي/جانبي طولي/فاصل بين المنتجات). تظهر فوراً في المتجر.
 */
import { useState } from "react";
import { ImagePlus, Loader2, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";

type Placement = "HERO" | "SIDE" | "INLINE";
type RenderMode = "SMART_CROP" | "PRESERVE_FULL" | "LAYERED";

/** مواصفات كل موضع: تسمية للمدير + مقاس الصورة الموصى به (يُبنى عليه العرض في المتجر). */
const PLACEMENTS: Record<Placement, { label: string; hint: string; badge: string }> = {
  HERO: {
    label: "رئيسي — كاروسيل أعلى المتجر",
    hint: "المقاس المثالي ١٦٠٠×٥٠٠ بكسل (نسبة ٣.٢:١ تقريباً) — صورة أفقية، تُضغط تلقائياً",
    badge: "رئيسي",
  },
  SIDE: {
    label: "جانبي طولي — جوانب الشاشات العريضة",
    hint: "المقاس المثالي ٦٠٠×١٢٠٠ بكسل (نسبة ١:٢ طولية) — يظهر على الشاشات العريضة فقط، تُضغط تلقائياً",
    badge: "جانبي",
  },
  INLINE: {
    label: "فاصل تسويقي — شريط عرضي بين صفوف المنتجات",
    hint: "المقاس المثالي ١٢٠٠×٢٠٠ بكسل (نسبة ٦:١ عريضة) — يظهر كل عشرة منتجات تقريباً، تُضغط تلقائياً",
    badge: "فاصل",
  },
};

interface FormState {
  id: number | null;
  title: string;
  subtitle: string;
  ctaLabel: string;
  ctaUrl: string;
  sortOrder: string;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string;
  images: ImageItem[];
  mobileImages: ImageItem[];
  placement: Placement;
  renderMode: RenderMode;
  focusX: number;
  focusY: number;
}

const EMPTY: FormState = {
  id: null, title: "", subtitle: "", ctaLabel: "", ctaUrl: "", sortOrder: "0",
  isActive: true, effectiveFrom: "", effectiveTo: "", images: [], mobileImages: [], placement: "HERO", renderMode: "PRESERVE_FULL", focusX: 50, focusY: 50,
};

export default function BannerManager() {
  const [form, setForm] = useState<FormState | null>(null);
  const utils = trpc.useUtils();
  const listQ = trpc.storeAdmin.banners.list.useQuery();

  const invalidate = () => {
    void utils.storeAdmin.banners.list.invalidate();
  };
  const createM = trpc.storeAdmin.banners.create.useMutation({ onSuccess: () => { notify.ok("أُضيف البنر"); setForm(null); invalidate(); }, onError: (e) => notify.err(e) });
  const updateM = trpc.storeAdmin.banners.update.useMutation({ onSuccess: () => { notify.ok("حُفظ البنر"); setForm(null); invalidate(); }, onError: (e) => notify.err(e) });
  const removeM = trpc.storeAdmin.banners.remove.useMutation({ onSuccess: () => { notify.ok("حُذف البنر"); invalidate(); }, onError: (e) => notify.err(e) });

  const banners = listQ.data ?? [];
  const saving = createM.isPending || updateM.isPending;

  function edit(b: (typeof banners)[number]) {
    setForm({
      id: b.id,
      title: b.title,
      subtitle: b.subtitle ?? "",
      ctaLabel: b.ctaLabel ?? "",
      ctaUrl: b.ctaUrl ?? "",
      sortOrder: String(b.sortOrder ?? 0),
      isActive: !!b.isActive,
      effectiveFrom: b.effectiveFrom ?? "",
      effectiveTo: b.effectiveTo ?? "",
      images: b.imageUrl ? [{ id: "cur", dataUrl: b.imageUrl, isPrimary: true }] : [],
      mobileImages: b.mobileImageUrl ? [{ id: "mobile", dataUrl: b.mobileImageUrl, isPrimary: true }] : [],
      placement: (b.placement as Placement) ?? "HERO",
      renderMode: (b.renderMode as RenderMode) ?? "PRESERVE_FULL",
      focusX: b.focusX ?? 50,
      focusY: b.focusY ?? 50,
    });
  }

  function save() {
    if (!form) return;
    const title = form.title.trim();
    if (!title) { notify.err("العنوان مطلوب"); return; }
    const payload = {
      title,
      subtitle: form.subtitle.trim() || null,
      imageUrl: form.images[0]?.dataUrl ?? form.images[0]?.url ?? null,
      mobileImageUrl: form.mobileImages[0]?.dataUrl ?? form.mobileImages[0]?.url ?? null,
      ctaLabel: form.ctaLabel.trim() || null,
      ctaUrl: form.ctaUrl.trim() || null,
      sortOrder: Number(form.sortOrder) || 0,
      isActive: form.isActive,
      effectiveFrom: form.effectiveFrom || null,
      effectiveTo: form.effectiveTo || null,
      placement: form.placement,
      renderMode: form.renderMode,
      focusX: form.focusX,
      focusY: form.focusY,
    };
    if (form.id == null) createM.mutate(payload);
    else updateM.mutate({ id: form.id, ...payload });
  }

  async function del(id: number, title: string) {
    const ok = await confirm({ title: "حذف البنر؟", description: title });
    if (ok) removeM.mutate({ id });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">البنرات الإعلانية</h2>
        {!form && (
          <button onClick={() => setForm({ ...EMPTY })} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-bold text-primary-foreground transition hover:opacity-90">
            <Plus aria-hidden className="size-4" /> بنر جديد
          </button>
        )}
      </div>

      {/* نموذج الإضافة/التعديل */}
      {form && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold text-muted-foreground">{form.id == null ? "بنر جديد" : "تعديل البنر"}</h3>
            <button onClick={() => setForm(null)} aria-label="إغلاق" className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-accent">
              <X aria-hidden className="size-4" />
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm md:col-span-2">
              <span className="mb-1 block font-medium text-muted-foreground">موضع البنر في المتجر</span>
              <select value={form.placement} onChange={(e) => setForm({ ...form, placement: e.target.value as Placement })} className="w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30">
                {(Object.keys(PLACEMENTS) as Placement[]).map((p) => (
                  <option key={p} value={p}>{PLACEMENTS[p].label}</option>
                ))}
              </select>
            </label>
            <label className="text-sm md:col-span-2">
              <span className="mb-1 block font-medium text-muted-foreground">معالجة الصورة تلقائياً</span>
              <select value={form.renderMode} onChange={(e) => setForm({ ...form, renderMode: e.target.value as RenderMode })} className="w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30">
                <option value="PRESERVE_FULL">حفظ التصميم كاملاً — خلفية ممتدة، بلا قص للنص أو الشعار</option>
                <option value="SMART_CROP">ملء ذكي — للصور التي لا تحتوي نصاً داخلها</option>
                <option value="LAYERED">تصميم طبقات — الصورة خلفية والنص والزر من حقول المتجر</option>
              </select>
              <span className="mt-1 block text-xs text-muted-foreground">الوضع الآمن الافتراضي يحافظ على الصورة كاملة ويملأ الفراغ من الخلفية نفسها.</span>
            </label>
            {form.renderMode !== "PRESERVE_FULL" && <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
              <label className="text-sm"><span className="mb-1 block font-medium text-muted-foreground">تركيز أفقي: {form.focusX}%</span><input className="w-full" type="range" min="0" max="100" value={form.focusX} onChange={(e) => setForm({ ...form, focusX: Number(e.target.value) })} /></label>
              <label className="text-sm"><span className="mb-1 block font-medium text-muted-foreground">تركيز عمودي: {form.focusY}%</span><input className="w-full" type="range" min="0" max="100" value={form.focusY} onChange={(e) => setForm({ ...form, focusY: Number(e.target.value) })} /></label>
            </div>}
            <label className="text-sm">
              <span className="mb-1 block font-medium text-muted-foreground">العنوان *</span>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-muted-foreground">الوصف</span>
              <input value={form.subtitle} onChange={(e) => setForm({ ...form, subtitle: e.target.value })} className="w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-muted-foreground">نصّ الزرّ (اختياري)</span>
              <input value={form.ctaLabel} onChange={(e) => setForm({ ...form, ctaLabel: e.target.value })} placeholder="تسوّق الآن" className="w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-muted-foreground">رابط الزرّ (اختياري)</span>
              <input value={form.ctaUrl} onChange={(e) => setForm({ ...form, ctaUrl: e.target.value })} dir="ltr" placeholder="/store?category=..." className="w-full rounded-lg border border-border bg-background px-3 py-2 text-left outline-none focus:ring-2 focus:ring-primary/30" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-muted-foreground">الترتيب</span>
              <input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} className="w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30" />
            </label>
            <label className="flex items-center gap-2 self-end text-sm font-medium">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} className="size-4" />
              مفعّل (يظهر في المتجر)
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-muted-foreground">فعّال من (اختياري)</span>
              <input type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} className="w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-muted-foreground">فعّال إلى (اختياري)</span>
              <input type="date" value={form.effectiveTo} onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })} className="w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30" />
            </label>
          </div>
          <div className="mt-3">
            <span className="mb-1 flex items-center gap-1.5 text-sm font-medium text-muted-foreground"><ImagePlus aria-hidden className="size-4" /> صورة البنر</span>
            <ImageUploader value={form.images} onChange={(imgs) => setForm({ ...form, images: imgs })} maxItems={1} singlePrimary={false} hint={PLACEMENTS[form.placement].hint} />
            {form.placement !== "SIDE" && <div className="mt-3">
              <span className="mb-1 block text-sm font-medium text-muted-foreground">نسخة الهاتف (اختيارية، موصى بها للحملات النصية)</span>
              <ImageUploader value={form.mobileImages} onChange={(imgs) => setForm({ ...form, mobileImages: imgs })} maxItems={1} singlePrimary={false} hint={form.placement === "HERO" ? "1200×600 للهاتف (2:1)" : "1080×360 للهاتف (3:1)"} />
            </div>}
          </div>
          <button onClick={save} disabled={saving} className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
            {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Save aria-hidden className="size-4" />} حفظ
          </button>
        </div>
      )}

      {/* القائمة */}
      {listQ.isLoading ? (
        <div className="flex justify-center py-16 text-muted-foreground"><Loader2 aria-hidden className="size-6 animate-spin" /></div>
      ) : banners.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">لا توجد بنرات — أضف أوّل بنر ترويجي.</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {banners.map((b) => (
            <div key={b.id} className="flex gap-3 rounded-2xl border border-border bg-card p-3">
              <div className="size-20 shrink-0 overflow-hidden rounded-xl bg-muted">
                {b.imageUrl ? <img src={b.imageUrl} alt={b.title} className="size-full object-cover" /> : <div className="flex size-full items-center justify-center text-muted-foreground"><ImagePlus aria-hidden className="size-6 opacity-40" /></div>}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-bold">{b.title}</p>
                  <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
                    {PLACEMENTS[(b.placement as Placement) ?? "HERO"]?.badge ?? "رئيسي"}
                  </span>
                  {!b.isActive && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">معطّل</span>}
                </div>
                {b.subtitle && <p className="truncate text-xs text-muted-foreground">{b.subtitle}</p>}
                <p className="mt-0.5 text-[11px] text-muted-foreground">ترتيب: {b.sortOrder}{b.ctaLabel ? ` · زرّ: ${b.ctaLabel}` : ""}</p>
                <div className="mt-1.5 flex gap-1.5">
                  <button onClick={() => edit(b)} className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium hover:bg-accent"><Pencil aria-hidden className="size-3" /> تعديل</button>
                  <button onClick={() => del(b.id, b.title)} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"><Trash2 aria-hidden className="size-3" /> حذف</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
