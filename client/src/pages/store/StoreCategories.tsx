/**
 * StoreCategories — إدارة أقسام المتجر (لوحة hPanel، تبويب «الفئات»).
 * إنشاء/تعديل/حذف قسم + ترتيب عرضه + إظهاره/إخفاؤه من واجهة الزبون + إسناد منتجات إليه.
 * الأقسام هي فئات المنتجات نفسها (categories) — تظهر بطاقاتها في المتجر عبر «تسوّق حسب القسم».
 */
import { useState } from "react";
import { ArrowDown, ArrowUp, Check, Eye, EyeOff, FolderPlus, Layers, Loader2, Pencil, Plus, Save, Search, Tag, Trash2, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";

interface FormState {
  id: number | null;
  name: string;
  description: string;
}
const EMPTY: FormState = { id: null, name: "", description: "" };

export default function StoreCategories() {
  const [form, setForm] = useState<FormState | null>(null);
  const [assignFor, setAssignFor] = useState<{ id: number; name: string } | null>(null);
  const utils = trpc.useUtils();
  const listQ = trpc.storeAdmin.categories.list.useQuery();

  const invalidate = () => void utils.storeAdmin.categories.list.invalidate();
  const createM = trpc.storeAdmin.categories.create.useMutation({ onSuccess: () => { notify.ok("أُضيف القسم"); setForm(null); invalidate(); }, onError: (e) => notify.err(e) });
  const updateM = trpc.storeAdmin.categories.update.useMutation({ onSuccess: () => { notify.ok("حُفظ القسم"); setForm(null); invalidate(); }, onError: (e) => notify.err(e) });
  const removeM = trpc.storeAdmin.categories.remove.useMutation({ onSuccess: () => { notify.ok("حُذف القسم"); invalidate(); }, onError: (e) => notify.err(e) });
  const visM = trpc.storeAdmin.categories.setVisibility.useMutation({ onSuccess: invalidate, onError: (e) => notify.err(e) });
  const reorderM = trpc.storeAdmin.categories.reorder.useMutation({ onSuccess: invalidate, onError: (e) => notify.err(e) });

  const cats = listQ.data ?? [];
  const saving = createM.isPending || updateM.isPending;

  function save() {
    if (!form) return;
    const name = form.name.trim();
    if (!name) { notify.err("اسم القسم مطلوب"); return; }
    const payload = { name, description: form.description.trim() || null };
    if (form.id == null) createM.mutate(payload);
    else updateM.mutate({ id: form.id, ...payload });
  }
  async function del(id: number, name: string) {
    const ok = await confirm({ title: "حذف القسم؟", description: `«${name}» — منتجاته تُنقَل إلى «بلا قسم» ولا تُحذف.` });
    if (ok) removeM.mutate({ id });
  }
  function move(idx: number, dir: -1 | 1) {
    const next = [...cats];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    reorderM.mutate({ orderedIds: next.map((c) => c.id) });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Layers aria-hidden className="size-5 text-primary" /> أقسام المتجر</h2>
        {!form && (
          <button onClick={() => setForm({ ...EMPTY })} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-bold text-primary-foreground transition hover:opacity-90">
            <Plus aria-hidden className="size-4" /> قسم جديد
          </button>
        )}
      </div>

      {form && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold text-muted-foreground">{form.id == null ? "قسم جديد" : "تعديل القسم"}</h3>
            <button onClick={() => setForm(null)} aria-label="إغلاق" className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-accent"><X aria-hidden className="size-4" /></button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block font-medium text-muted-foreground">اسم القسم *</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="قرطاسية" className="w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-muted-foreground">الوصف (اختياري)</span>
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30" />
            </label>
          </div>
          <button onClick={save} disabled={saving} className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
            {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Save aria-hidden className="size-4" />} حفظ
          </button>
        </div>
      )}

      {listQ.isLoading ? (
        <div className="flex justify-center py-16 text-muted-foreground"><Loader2 aria-hidden className="size-6 animate-spin" /></div>
      ) : cats.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          <FolderPlus aria-hidden className="mx-auto mb-2 size-8 opacity-40" />
          لا توجد أقسام بعد — أضف قسمك الأول ثم أسنِد إليه منتجاتك، فتظهر بطاقات «تسوّق حسب القسم» في المتجر.
        </div>
      ) : (
        <div className="space-y-2">
          {cats.map((c, i) => (
            <div key={c.id} className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
              <div className="flex flex-col">
                <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="أعلى" className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"><ArrowUp aria-hidden className="size-4" /></button>
                <button onClick={() => move(i, 1)} disabled={i === cats.length - 1} aria-label="أسفل" className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"><ArrowDown aria-hidden className="size-4" /></button>
              </div>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Tag aria-hidden className="size-4" /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-bold">{c.name}</p>
                  {!c.showInStore && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">مخفيّ</span>}
                </div>
                <p className="text-[11px] text-muted-foreground">{c.productCount} منتج{c.description ? ` · ${c.description}` : ""}</p>
              </div>
              <button onClick={() => visM.mutate({ id: c.id, showInStore: !c.showInStore })} title={c.showInStore ? "إخفاء من المتجر" : "إظهار في المتجر"} aria-label="إظهار/إخفاء" className={`flex size-8 items-center justify-center rounded-lg border border-border transition hover:bg-accent ${c.showInStore ? "text-emerald-600" : "text-muted-foreground"}`}>
                {c.showInStore ? <Eye aria-hidden className="size-4" /> : <EyeOff aria-hidden className="size-4" />}
              </button>
              <button onClick={() => setAssignFor({ id: c.id, name: c.name })} className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs font-medium hover:bg-accent"><Plus aria-hidden className="size-3" /> منتجات</button>
              <button onClick={() => setForm({ id: c.id, name: c.name, description: c.description ?? "" })} aria-label="تعديل" className="flex size-8 items-center justify-center rounded-lg border border-border hover:bg-accent"><Pencil aria-hidden className="size-3.5" /></button>
              <button onClick={() => del(c.id, c.name)} aria-label="حذف" className="flex size-8 items-center justify-center rounded-lg text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"><Trash2 aria-hidden className="size-3.5" /></button>
            </div>
          ))}
        </div>
      )}

      {assignFor && <AssignDialog category={assignFor} onClose={() => setAssignFor(null)} onDone={invalidate} />}
    </div>
  );
}

/** حوار إسناد منتجات لقسم — يبحث في المنتجات (الافتراضي: بلا قسم) ويُسنِد المُختار دفعةً. */
function AssignDialog({ category, onClose, onDone }: { category: { id: number; name: string }; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const [onlyUnassigned, setOnlyUnassigned] = useState(true);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const utils = trpc.useUtils();
  const prodQ = trpc.storeAdmin.categories.listProducts.useQuery({ q: q.trim() || undefined, categoryId: onlyUnassigned ? 0 : undefined, limit: 200 });
  const assignM = trpc.storeAdmin.categories.assignProducts.useMutation({
    onSuccess: (r) => { notify.ok(`أُسنِد ${r.moved} منتج إلى «${category.name}»`); void utils.storeAdmin.categories.list.invalidate(); onDone(); onClose(); },
    onError: (e) => notify.err(e),
  });
  const products = prodQ.data ?? [];
  function toggle(id: number) {
    setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-t-2xl border border-border bg-card sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border p-4">
          <h3 className="text-sm font-bold">إسناد منتجات إلى «{category.name}»</h3>
          <button onClick={onClose} aria-label="إغلاق" className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-accent"><X aria-hidden className="size-4" /></button>
        </div>
        <div className="space-y-2 border-b border-border p-3">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث عن منتج…" className="w-full rounded-lg border border-border bg-background py-2 pr-10 pl-3 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <input type="checkbox" checked={onlyUnassigned} onChange={(e) => setOnlyUnassigned(e.target.checked)} className="size-4" />
            المنتجات بلا قسم فقط (الأنسب لأول تنظيم)
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {prodQ.isLoading ? (
            <div className="flex justify-center py-12 text-muted-foreground"><Loader2 aria-hidden className="size-6 animate-spin" /></div>
          ) : products.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">لا منتجات مطابقة</p>
          ) : (
            products.map((p) => {
              const on = sel.has(p.id);
              return (
                <button key={p.id} onClick={() => toggle(p.id)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-right text-sm transition hover:bg-accent ${on ? "bg-primary/10" : ""}`}>
                  <span className={`flex size-5 shrink-0 items-center justify-center rounded border ${on ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>{on && <Check aria-hidden className="size-3.5" />}</span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.categoryName && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{p.categoryName}</span>}
                </button>
              );
            })
          )}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border p-3">
          <span className="text-xs text-muted-foreground">{sel.size} محدَّد</span>
          <button onClick={() => sel.size && assignM.mutate({ productIds: Array.from(sel), categoryId: category.id })} disabled={sel.size === 0 || assignM.isPending} className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
            {assignM.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />} إسناد المحدَّد
          </button>
        </div>
      </div>
    </div>
  );
}
