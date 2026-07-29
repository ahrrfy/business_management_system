// شاشة إدارة الفئات/التصنيفات — قائمة بعدد المنتجات لكل فئة + إضافة/تعديل/حذف (مع إعادة تخصيص
// منتجات الفئة المحذوفة) + دمج عدّة فئات في واحدة. أقسام فرعية (٢٩/٧): كل فئة رئيسية قد تحوي
// فئات فرعية (مستويان فقط) — تُدار من نفس الشاشة (زرّ «+ قسم فرعي» على صفّ الفئة الرئيسية)،
// وتُعرض متداخلة تحت أبيها. نقل منتجات محدّدة بين الفئات يتمّ من شاشة المنتجات
// (تحديد + «نقل إلى فئة»). كل العمليات عبر catalog.* (managerProcedure) وتُحدِّث القوائم تلقائياً.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SelectionBar, useRowSelection } from "@/components/list/SelectionBar";
import { RowActions } from "@/components/list";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { notify } from "@/lib/notify";
import { matchQuery } from "@/components/search/filter";
import { CategoryOptionList } from "@/lib/categoryTree";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { CornerDownLeft, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";

type CategoryRow = RouterOutputs["catalog"]["categoriesAdmin"][number];

const num = (n: number) => n.toLocaleString("ar-IQ-u-nu-latn");

export default function Categories() {
  const utils = trpc.useUtils();
  const list = trpc.catalog.categoriesAdmin.useQuery();
  const rows = list.data ?? [];
  const sel = useRowSelection<number>();

  const childrenOf = (parentId: number) => rows.filter((r) => r.parentId === parentId);

  // بحث نصّي فوري (تصفية على العميل — القائمة كاملة محمّلة) على الاسم/الوصف. فئة فرعية مطابقة
  // تُظهر أباها للسياق، وفئة رئيسية مطابقة تُظهر كل فرعياتها (لا الفرعيات المطابقة فقط).
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return rows;
    const matched = rows.filter((c) => matchQuery(q, [c.name, c.description]));
    const keepIds = new Set<number>();
    for (const m of matched) {
      keepIds.add(m.id);
      if (m.parentId != null) keepIds.add(m.parentId);
      else for (const ch of childrenOf(m.id)) keepIds.add(ch.id);
    }
    return rows.filter((c) => keepIds.has(c.id));
  }, [rows, query]);

  // صفوف مرتَّبة شجرياً: كل فئة رئيسية تليها فرعياتها مباشرةً (للعرض المتداخل فقط).
  const orderedRows = useMemo(() => {
    const tops = filtered.filter((c) => c.parentId == null);
    const out: CategoryRow[] = [];
    for (const top of tops) {
      out.push(top);
      out.push(...filtered.filter((c) => c.parentId === top.id));
    }
    return out;
  }, [filtered]);

  // ── نموذج الإضافة/التعديل ──
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [fName, setFName] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fActive, setFActive] = useState(true);
  const [fParentId, setFParentId] = useState<number | "">("");

  // ── حوار الحذف (مع إعادة تخصيص) ──
  const [delTarget, setDelTarget] = useState<CategoryRow | null>(null);
  const [reassignTo, setReassignTo] = useState<number | null>(null);

  // ── حوار الدمج ──
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<number | null>(null);

  function invalidateAll() {
    utils.catalog.categoriesAdmin.invalidate();
    utils.catalog.categories.invalidate();
    utils.catalog.adminList.invalidate();
  }

  const createMut = trpc.catalog.createCategory.useMutation({
    onSuccess: () => { invalidateAll(); setFormOpen(false); notify.ok("تمت إضافة الفئة"); },
    onError: (e) => notify.err(e),
  });
  const updateMut = trpc.catalog.updateCategory.useMutation({
    onSuccess: () => { invalidateAll(); setFormOpen(false); notify.ok("تم حفظ التعديلات"); },
    onError: (e) => notify.err(e),
  });
  const deleteMut = trpc.catalog.deleteCategory.useMutation({
    onSuccess: (res) => {
      invalidateAll();
      setDelTarget(null);
      notify.ok(res.reassigned ? `حُذفت الفئة ونُقل ${num(res.reassigned)} منتجاً` : "حُذفت الفئة");
    },
    onError: (e) => notify.err(e),
  });
  const mergeMut = trpc.catalog.mergeCategories.useMutation({
    onSuccess: (res) => {
      invalidateAll();
      sel.clear();
      setMergeOpen(false);
      notify.ok(`تمّ الدمج — نُقل ${num(res.moved)} منتجاً وحُذفت ${num(res.deleted)} فئة`);
    },
    onError: (e) => notify.err(e),
  });

  function openAdd(parentId?: number) {
    setEditId(null);
    setFName("");
    setFDesc("");
    setFActive(true);
    setFParentId(parentId ?? "");
    setFormOpen(true);
  }
  function openEdit(c: CategoryRow) {
    setEditId(c.id);
    setFName(c.name);
    setFDesc(c.description ?? "");
    setFActive(c.isActive);
    setFParentId(c.parentId ?? "");
    setFormOpen(true);
  }
  const editHasChildren = editId != null && childrenOf(editId).length > 0;
  function submitForm() {
    const name = fName.trim();
    if (!name) { notify.err("اسم الفئة مطلوب"); return; }
    const parentId = fParentId === "" ? null : Number(fParentId);
    if (editId == null) createMut.mutate({ name, description: fDesc.trim() || null, parentId });
    else updateMut.mutate({ id: editId, name, description: fDesc.trim() || null, isActive: fActive, parentId });
  }

  function openDelete(c: CategoryRow) { setDelTarget(c); setReassignTo(null); }
  const delChildrenCount = delTarget ? childrenOf(delTarget.id).length : 0;
  function confirmDelete() {
    if (!delTarget) return;
    deleteMut.mutate({ id: delTarget.id, reassignToId: reassignTo });
  }

  const selectedIds = useMemo(() => Array.from(sel.selected), [sel.selected]);
  const selectedRows = useMemo(() => rows.filter((r) => sel.selected.has(r.id)), [rows, sel.selected]);
  function openMerge() {
    if (selectedIds.length < 2) { notify.err("اختر فئتين على الأقل للدمج"); return; }
    // افتراضي: الفئة الأكثر منتجات بين المحدَّد هي الهدف (أقلّ نقلاً).
    const target = [...selectedRows].sort((a, b) => b.productCount - a.productCount)[0];
    setMergeTarget(target?.id ?? selectedIds[0]);
    setMergeOpen(true);
  }
  function confirmMerge() {
    if (selectedIds.length < 2 || mergeTarget == null) return;
    const sourceIds = selectedIds.filter((id) => id !== mergeTarget);
    if (!sourceIds.length) { notify.err("اختر فئة هدف مختلفة عن المصادر"); return; }
    mergeMut.mutate({ sourceIds, targetId: mergeTarget });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="الفئات والتصنيفات"
        description={
          <>
            نظّم منتجاتك في فئات، وقسّم كل فئة إلى أقسام فرعية عند الحاجة (مستوى واحد إضافي — مثال:
            «الملازم المدرسية» ← «ملازم الصف السادس»). تستطيع إضافة فئة، تعديلها، دمج عدّة فئات من
            نفس المستوى في واحدة، أو حذفها مع نقل منتجاتها. لنقل منتجات محدّدة بين الفئات: افتح{" "}
            <span className="font-medium">المنتجات</span>، حدّدها، ثم «نقل إلى فئة».
          </>
        }
        actions={<Button size="sm" onClick={() => openAdd()}><Plus className="size-4" /> إضافة فئة</Button>}
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div className="text-sm text-muted-foreground">
            {list.isLoading ? "" : query ? `${num(filtered.length)} / ${num(rows.length)} فئة` : `${num(rows.length)} فئة`}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="بحث بالاسم أو الوصف…"
              className="h-8 w-56 pr-8"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 w-8">
                  <input
                    type="checkbox"
                    className="size-4"
                    aria-label="تحديد كل الفئات"
                    checked={filtered.length > 0 && filtered.every((r) => sel.isSelected(r.id))}
                    onChange={(e) => sel.setMany(filtered.map((r) => r.id), e.target.checked)}
                  />
                </th>
                <th className="p-2">الفئة</th>
                <th className="p-2">الوصف</th>
                <th className="p-2 text-center">عدد المنتجات</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {orderedRows.map((c) => {
                const isChild = c.parentId != null;
                const kids = isChild ? [] : childrenOf(c.id);
                return (
                  <tr key={c.id} className={`border-t ${c.isActive ? "" : "opacity-60"} ${isChild ? "bg-muted/20" : ""}`}>
                    <td className="p-2">
                      <input
                        type="checkbox"
                        className="size-4"
                        aria-label={`تحديد ${c.name}`}
                        checked={sel.isSelected(c.id)}
                        onChange={() => sel.toggle(c.id)}
                      />
                    </td>
                    <td className="p-2 font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {isChild && <CornerDownLeft aria-hidden className="size-3.5 text-muted-foreground shrink-0" />}
                        {c.name}
                        {!isChild && kids.length > 0 && (
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            {num(kids.length)} فرعية
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="p-2 text-muted-foreground">{c.description || "—"}</td>
                    <td className="p-2 text-center tabular-nums">
                      {!isChild && kids.length > 0 ? (
                        <>
                          <span className="font-medium">{num(c.productCountWithChildren)}</span>
                          {c.productCount > 0 && (
                            <span className="text-xs text-muted-foreground"> ({num(c.productCount)} مباشرة)</span>
                          )}
                        </>
                      ) : (
                        num(c.productCount)
                      )}
                    </td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${c.isActive ? "badge-status-active" : "badge-status-cancelled"}`}>
                        {c.isActive ? "مفعّلة" : "معطّلة"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      <RowActions
                        actions={[
                          { key: "edit", label: "تعديل", onSelect: () => openEdit(c) },
                          { key: "addChild", label: "+ قسم فرعي", onSelect: () => openAdd(c.id), hidden: isChild },
                          {
                            key: "products",
                            label: "عرض منتجاتها",
                            // /products هو Redirect ثابت لـ/inventory?tab=products يُسقِط أي querystring
                            // أصلي (App.tsx) — الرابط المباشر لتبويب المخزون يحافظ على فلتر الفئة.
                            href: `/inventory?tab=products&category=${c.id}`,
                            hidden: c.productCount === 0 && (isChild || kids.length === 0),
                          },
                          { key: "delete", label: "حذف", variant: "destructive", onSelect: () => openDelete(c) },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
              {list.isLoading && (
                <tr><td colSpan={6}><LoadingState /></td></tr>
              )}
              {!list.isLoading && filtered.length === 0 && (
                <TableEmptyRow colSpan={6} message={query ? "لا فئات مطابقة للبحث." : "لا فئات بعد — أضِف أوّل فئة."} />
              )}
            </tbody>
          </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <SelectionBar
        count={sel.count}
        onClear={sel.clear}
        actions={
          <Button variant="outline" size="sm" onClick={openMerge} disabled={sel.count < 2}>
            دمج المحدَّد
          </Button>
        }
      />

      {/* نموذج إضافة/تعديل فئة (أو قسم فرعي) */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editId == null ? (fParentId === "" ? "إضافة فئة" : "إضافة قسم فرعي") : "تعديل فئة"}
            </DialogTitle>
            <DialogDescription>اسم الفئة فريد. الوصف اختياري.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">اسم الفئة</label>
              <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="مثال: قرطاسية مدرسية" dir="auto" autoFocus />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">الوصف (اختياري)</label>
              <Textarea rows={2} value={fDesc} onChange={(e) => setFDesc(e.target.value)} placeholder="وصف مختصر…" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">الفئة الرئيسية (اختياري)</label>
              <select
                value={fParentId === "" ? "" : String(fParentId)}
                onChange={(e) => setFParentId(e.target.value === "" ? "" : Number(e.target.value))}
                disabled={editHasChildren}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm disabled:opacity-50"
              >
                <option value="">— فئة رئيسية (بلا أب) —</option>
                {rows.filter((r) => r.parentId == null && r.id !== editId).map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
              {editHasChildren ? (
                <p className="text-xs text-muted-foreground">
                  هذه الفئة تحوي فئات فرعية، فلا يمكن أن تصبح فرعيةً لأخرى.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">اتركها فارغة لتبقى فئة رئيسية، أو اختر فئة لتصبح قسماً فرعياً منها.</p>
              )}
            </div>
            {editId != null && (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={fActive} onCheckedChange={setFActive} />
                <span className="text-muted-foreground">{fActive ? "مفعّلة" : "معطّلة"}</span>
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setFormOpen(false)}>إلغاء</Button>
            <Button size="sm" onClick={submitForm} disabled={createMut.isPending || updateMut.isPending}>
              {createMut.isPending || updateMut.isPending ? "جارٍ الحفظ…" : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار الحذف */}
      <Dialog open={!!delTarget} onOpenChange={(o) => { if (!o) setDelTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>حذف الفئة «{delTarget?.name}»</DialogTitle>
            <DialogDescription>
              {delChildrenCount > 0
                ? `هذه الفئة تحوي ${num(delChildrenCount)} فئة فرعية. احذفها أو انقلها إلى فئة أخرى أولاً.`
                : delTarget && delTarget.productCount > 0
                  ? `هذه الفئة تحوي ${num(delTarget.productCount)} منتجاً. اختر فئة لنقلها إليها قبل الحذف (أو اتركها «بلا فئة»).`
                  : "لا منتجات في هذه الفئة. سيُحذف التصنيف نهائياً."}
            </DialogDescription>
          </DialogHeader>
          {delChildrenCount === 0 && delTarget && delTarget.productCount > 0 && (
            <div className="space-y-1">
              <label className="text-sm font-medium">نقل المنتجات إلى</label>
              <select
                value={reassignTo == null ? "" : String(reassignTo)}
                onChange={(e) => setReassignTo(e.target.value === "" ? null : Number(e.target.value))}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
              >
                <option value="">— بلا فئة —</option>
                <CategoryOptionList categories={rows.filter((r) => r.id !== delTarget.id)} />
              </select>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDelTarget(null)}>إلغاء</Button>
            <Button variant="destructive" size="sm" onClick={confirmDelete} disabled={deleteMut.isPending || delChildrenCount > 0}>
              {deleteMut.isPending ? "جارٍ الحذف…" : "حذف الفئة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار الدمج */}
      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>دمج {num(selectedIds.length)} فئات</DialogTitle>
            <DialogDescription>
              ستُنقل منتجات الفئات المحدَّدة إلى الفئة الهدف، ثم تُحذف باقي الفئات. اختر الفئة التي تبقى:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <label className="text-sm font-medium">الفئة الهدف (تبقى)</label>
            <select
              value={mergeTarget == null ? "" : String(mergeTarget)}
              onChange={(e) => setMergeTarget(e.target.value === "" ? null : Number(e.target.value))}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
            >
              {selectedRows.map((r) => <option key={r.id} value={r.id}>{r.name} ({num(r.productCount)} منتج)</option>)}
            </select>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setMergeOpen(false)}>إلغاء</Button>
            <Button size="sm" onClick={confirmMerge} disabled={mergeMut.isPending}>
              {mergeMut.isPending ? "جارٍ الدمج…" : "دمج"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
