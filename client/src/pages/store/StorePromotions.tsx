/**
 * StorePromotions — «العروض» في لوحة hPanel (تبويب مديري).
 * إنشاء عروض/خصومات تظهر للزبائن في المتجر الإلكتروني (خصم نسبة/مبلغ على كل المنتجات أو فئات/منتجات
 * محدَّدة، بنافذة تاريخ). العرض المتجريّ يُفرَض تلقائياً على فئة «مفرد» وفرع المتجر ⇒ يظهر فوراً في
 * المتجر (بنر «عروض» + سعر مخصوم على البطاقات). العروض «العامّة» (تُدار من الإدارة) تُعرَض للسياق فقط.
 */
import { useState } from "react";
import { BadgePercent, Calendar, Check, Loader2, Plus, Save, Search, Sparkles, Tag, Ticket, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { fmt } from "@/lib/money";

type PromoType = "PERCENT" | "AMOUNT";
type PromoScope = "ALL" | "CATEGORIES" | "PRODUCTS";
interface TargetPick { kind: "category" | "product"; id: number; label: string }

function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface FormState {
  name: string; description: string; type: PromoType;
  discountPercent: string; discountAmount: string; scope: PromoScope;
  effectiveFrom: string; effectiveTo: string; minLineAmount: string; priority: string;
  targets: TargetPick[];
}
const EMPTY: FormState = {
  name: "", description: "", type: "PERCENT", discountPercent: "10", discountAmount: "",
  scope: "ALL", effectiveFrom: todayYmd(), effectiveTo: "", minLineAmount: "", priority: "0", targets: [],
};

export default function StorePromotions() {
  const [form, setForm] = useState<FormState | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const utils = trpc.useUtils();
  const listQ = trpc.storeAdmin.promotions.list.useQuery({ includeInactive });

  const invalidate = () => void utils.storeAdmin.promotions.list.invalidate();
  const createM = trpc.storeAdmin.promotions.create.useMutation({ onSuccess: () => { notify.ok("أُضيف العرض — يظهر الآن في المتجر"); setForm(null); invalidate(); }, onError: (e) => notify.err(e) });
  const deactM = trpc.storeAdmin.promotions.deactivate.useMutation({ onSuccess: () => { notify.ok("عُطِّل العرض"); invalidate(); }, onError: (e) => notify.err(e) });

  const promos = listQ.data ?? [];

  function submit() {
    if (!form) return;
    const name = form.name.trim();
    if (!name) { notify.err("اسم العرض مطلوب"); return; }
    if (form.type === "PERCENT") {
      const p = Number(form.discountPercent);
      if (!(p > 0 && p <= 100)) { notify.err("نسبة الخصم بين ١ و١٠٠"); return; }
    } else if (!(Number(form.discountAmount) > 0)) { notify.err("مبلغ الخصم يجب أن يكون أكبر من صفر"); return; }
    if (form.effectiveTo && form.effectiveTo < form.effectiveFrom) { notify.err("تاريخ الانتهاء أقدم من البدء"); return; }
    if (form.scope !== "ALL" && form.targets.length === 0) { notify.err("أضف هدفاً واحداً على الأقلّ"); return; }
    createM.mutate({
      name,
      description: form.description.trim() || null,
      type: form.type,
      discountPercent: form.type === "PERCENT" ? form.discountPercent : undefined,
      discountAmount: form.type === "AMOUNT" ? form.discountAmount : undefined,
      scope: form.scope,
      effectiveFrom: form.effectiveFrom,
      effectiveTo: form.effectiveTo || null,
      minLineAmount: form.minLineAmount || undefined,
      priority: Number(form.priority) || 0,
      targets: form.scope === "ALL" ? undefined : form.targets.map((t) => ({
        categoryId: t.kind === "category" ? t.id : null,
        productId: t.kind === "product" ? t.id : null,
        variantId: null,
      })),
    });
  }

  async function del(id: number, name: string) {
    const ok = await confirm({ title: "تعطيل العرض؟", description: `«${name}» — يختفي فوراً من المتجر.` });
    if (ok) deactM.mutate({ promotionId: id });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold"><BadgePercent aria-hidden className="size-5 text-primary" /> عروض المتجر</h2>
        {!form && (
          <button onClick={() => setForm({ ...EMPTY })} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-bold text-primary-foreground transition hover:opacity-90">
            <Plus aria-hidden className="size-4" /> عرض جديد
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">الخصم يظهر تلقائياً للزبائن في المتجر (شارة «عروض» + سعر مخصوم على المنتجات). السعر التعاقدي يفوز دائماً.</p>

      {form && <PromoForm form={form} setForm={setForm} onSubmit={submit} saving={createM.isPending} />}

      {/* القائمة */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-muted-foreground">العروض ({promos.length})</h3>
        <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} className="size-4" />
          تضمين المعطَّلة
        </label>
      </div>

      {listQ.isLoading ? (
        <div className="flex justify-center py-16 text-muted-foreground"><Loader2 aria-hidden className="size-6 animate-spin" /></div>
      ) : promos.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          <Sparkles aria-hidden className="mx-auto mb-2 size-8 opacity-40" />
          لا عروض بعد — أنشئ أوّل عرض ليظهر للزبائن في المتجر.
        </div>
      ) : (
        <div className="space-y-2">
          {promos.map((p) => (
            <div key={p.id} className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
              <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${p.liveNow ? "bg-emerald-500/12 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
                <Ticket aria-hidden className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="truncate text-sm font-bold">{p.name}</p>
                  {p.liveNow && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-600">ظاهرٌ الآن</span>}
                  {!p.isActive && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">معطَّل</span>}
                  {!p.storeOwned && <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-bold text-amber-600">عامّ</span>}
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  <span className="font-bold text-foreground">
                    {p.type === "PERCENT" ? `${p.discountPercent}٪` : <>{fmt(p.discountAmount)} د.ع</>}
                  </span>
                  {" · "}{p.scope === "ALL" ? "كل المنتجات" : p.scope === "CATEGORIES" ? `${p.targetCount} فئة` : `${p.targetCount} منتج`}
                  {" · "}<Calendar aria-hidden className="inline size-2.5" /> {p.effectiveFrom}{p.effectiveTo ? ` — ${p.effectiveTo}` : " (مستمرّ)"}
                </p>
              </div>
              {p.storeOwned && p.isActive && (
                <button onClick={() => del(p.id, p.name)} className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10">
                  <X aria-hidden className="size-3.5" /> تعطيل
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** نموذج إنشاء العرض — نوع/قيمة/نطاق/أهداف/تواريخ. */
function PromoForm({ form, setForm, onSubmit, saving }: { form: FormState; setForm: (f: FormState | null) => void; onSubmit: () => void; saving: boolean }) {
  const [prodQuery, setProdQuery] = useState("");
  const catsQ = trpc.storeAdmin.categories.list.useQuery(undefined, { enabled: form.scope === "CATEGORIES" });
  const prodsQ = trpc.storeAdmin.categories.listProducts.useQuery(
    { q: prodQuery.trim() || undefined, limit: 20 },
    { enabled: form.scope === "PRODUCTS" && prodQuery.trim().length >= 2 },
  );
  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  const addTarget = (t: TargetPick) => { if (!form.targets.some((x) => x.kind === t.kind && x.id === t.id)) set({ targets: [...form.targets, t] }); };
  const rmTarget = (i: number) => set({ targets: form.targets.filter((_, idx) => idx !== i) });

  const fieldCls = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30";
  const cats = catsQ.data ?? [];
  const prods = prodsQ.data ?? [];

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-muted-foreground">عرض جديد</h3>
        <button onClick={() => setForm(null)} aria-label="إغلاق" className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-accent"><X aria-hidden className="size-4" /></button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm md:col-span-2">
          <span className="mb-1 block font-medium text-muted-foreground">اسم العرض *</span>
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="عودة المدارس" dir="auto" className={fieldCls} />
        </label>

        {/* النوع + القيمة */}
        <div className="text-sm">
          <span className="mb-1 block font-medium text-muted-foreground">نوع الخصم *</span>
          <div className="flex gap-1.5">
            {(["PERCENT", "AMOUNT"] as PromoType[]).map((t) => (
              <button key={t} type="button" onClick={() => set({ type: t })} className={`flex-1 rounded-lg px-3 py-2 text-sm font-bold transition ${form.type === t ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:bg-accent"}`}>
                {t === "PERCENT" ? "نسبة ٪" : "مبلغ ثابت"}
              </button>
            ))}
          </div>
        </div>
        {form.type === "PERCENT" ? (
          <label className="text-sm">
            <span className="mb-1 block font-medium text-muted-foreground">نسبة الخصم (١–١٠٠) *</span>
            <input type="number" min={1} max={100} step="0.01" value={form.discountPercent} onChange={(e) => set({ discountPercent: e.target.value })} className={fieldCls} />
          </label>
        ) : (
          <label className="text-sm">
            <span className="mb-1 block font-medium text-muted-foreground">مبلغ الخصم لكل وحدة (د.ع) *</span>
            <input type="number" min={0} step="1" value={form.discountAmount} onChange={(e) => set({ discountAmount: e.target.value })} placeholder="500" className={fieldCls} />
          </label>
        )}

        {/* التواريخ */}
        <label className="text-sm">
          <span className="mb-1 block font-medium text-muted-foreground">من تاريخ *</span>
          <input type="date" value={form.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} className={fieldCls} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-muted-foreground">إلى تاريخ (فارغ = مستمرّ)</span>
          <input type="date" value={form.effectiveTo} onChange={(e) => set({ effectiveTo: e.target.value })} className={fieldCls} />
        </label>

        {/* النطاق */}
        <div className="text-sm md:col-span-2">
          <span className="mb-1 block font-medium text-muted-foreground">النطاق *</span>
          <div className="flex flex-wrap gap-1.5">
            {(["ALL", "CATEGORIES", "PRODUCTS"] as PromoScope[]).map((s) => (
              <button key={s} type="button" onClick={() => set({ scope: s, targets: [] })} className={`rounded-lg px-3 py-1.5 text-sm font-bold transition ${form.scope === s ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:bg-accent"}`}>
                {s === "ALL" ? "كل المنتجات" : s === "CATEGORIES" ? "فئات محدَّدة" : "منتجات محدَّدة"}
              </button>
            ))}
          </div>
        </div>

        {/* أهداف الفئات */}
        {form.scope === "CATEGORIES" && (
          <div className="text-sm md:col-span-2">
            <span className="mb-1 block font-medium text-muted-foreground">اختر الفئات</span>
            <div className="flex flex-wrap gap-1.5">
              {cats.filter((c) => !form.targets.some((t) => t.kind === "category" && t.id === c.id)).map((c) => (
                <button key={c.id} type="button" onClick={() => addTarget({ kind: "category", id: c.id, label: c.name })} className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent">
                  <Plus aria-hidden className="size-3" /> {c.name}
                </button>
              ))}
              {cats.length === 0 && !catsQ.isLoading && <span className="text-xs text-muted-foreground">لا فئات — أنشئها من تبويب «الفئات».</span>}
            </div>
          </div>
        )}

        {/* أهداف المنتجات */}
        {form.scope === "PRODUCTS" && (
          <div className="text-sm md:col-span-2">
            <span className="mb-1 block font-medium text-muted-foreground">ابحث عن منتج (حرفان فأكثر)</span>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input value={prodQuery} onChange={(e) => setProdQuery(e.target.value)} placeholder="اسم المنتج…" className={`${fieldCls} pr-10`} />
            </div>
            {prodQuery.trim().length >= 2 && prods.length > 0 && (
              <div className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-border">
                {prods.filter((r) => !form.targets.some((t) => t.kind === "product" && t.id === r.id)).map((r) => (
                  <button key={r.id} type="button" onClick={() => { addTarget({ kind: "product", id: r.id, label: r.name }); setProdQuery(""); }} className="block w-full px-3 py-2 text-right text-sm hover:bg-accent">
                    {r.name}{r.categoryName ? <span className="text-muted-foreground"> — {r.categoryName}</span> : null}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* شارات الأهداف المختارة */}
        {form.scope !== "ALL" && form.targets.length > 0 && (
          <div className="flex flex-wrap gap-1.5 md:col-span-2">
            {form.targets.map((t, i) => (
              <span key={`${t.kind}-${t.id}`} className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                <Tag aria-hidden className="size-3" /> {t.label}
                <button onClick={() => rmTarget(i)} aria-label="حذف" className="hover:text-rose-500"><X aria-hidden className="size-3" /></button>
              </span>
            ))}
          </div>
        )}

        {/* حقول اختيارية */}
        <label className="text-sm">
          <span className="mb-1 block font-medium text-muted-foreground">أولوية (الأعلى يفوز عند التعارض)</span>
          <input type="number" min={0} max={999} value={form.priority} onChange={(e) => set({ priority: e.target.value })} className={fieldCls} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-muted-foreground">أدنى سعر وحدة للتطبيق (اختياري)</span>
          <input type="number" min={0} step="1" value={form.minLineAmount} onChange={(e) => set({ minLineAmount: e.target.value })} placeholder="0" className={fieldCls} />
        </label>

        <label className="text-sm md:col-span-2">
          <span className="mb-1 block font-medium text-muted-foreground">الوصف (اختياري)</span>
          <input value={form.description} onChange={(e) => set({ description: e.target.value })} className={fieldCls} />
        </label>
      </div>

      <button onClick={onSubmit} disabled={saving} className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
        {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Save aria-hidden className="size-4" />} حفظ العرض
      </button>
    </div>
  );
}
