// شاشة إدارة الفئات/التصنيفات — قائمة بعدد المنتجات لكل فئة + إضافة/تعديل/حذف (مع إعادة تخصيص
// منتجات الفئة المحذوفة) + دمج عدّة فئات في واحدة. نقل منتجات محدّدة بين الفئات يتمّ من شاشة المنتجات
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
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { notify } from "@/lib/notify";
import { matchQuery } from "@/components/search/filter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";

type CategoryRow = RouterOutputs["catalog"]["categoriesAdmin"][number];

const num = (n: number) => n.toLocaleString("ar-IQ-u-nu-latn");

export default function Categories() {
  const utils = trpc.useUtils();
  const list = trpc.catalog.categoriesAdmin.useQuery();
  const rows = list.data ?? [];
  const sel = useRowSelection<number>();

  // بحث نصّي فوري (تصفية على العميل — القائمة كاملة محمّلة) على الاسم/الوصف.
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => rows.filter((c) => matchQuery(query, [c.name, c.description])),
    [rows, query],
  );

  // ── نموذج الإضافة/التعديل ──
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [fName, setFName] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fActive, setFActive] = useState(true);

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

  function openAdd() { setEditId(null); setFName(""); setFDesc(""); setFActive(true); setFormOpen(true); }
  function openEdit(c: CategoryRow) { setEditId(c.id); setFName(c.name); setFDesc(c.description ?? ""); setFActive(c.isActive); setFormOpen(true); }
  function submitForm() {
    const name = fName.trim();
    if (!name) { notify.err("اسم الفئة مطلوب"); return; }
    if (editId == null) createMut.mutate({ name, description: fDesc.trim() || null });
    else updateMut.mutate({ id: editId, name, description: fDesc.trim() || null, isActive: fActive });
  }

  function openDelete(c: CategoryRow) { setDelTarget(c); setReassignTo(null); }
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
            نظّم منتجاتك في فئات. تستطيع إضافة فئة، تعديلها، دمج عدّة فئات في واحدة، أو حذفها مع نقل منتجاتها.
            لنقل منتجات محدّدة بين الفئات: افتح <span className="font-medium">المنتجات</span>، حدّدها، ثم «نقل إلى فئة».
          </>
        }
        actions={<Button size="sm" onClick={openAdd}><Plus className="size-4" /> إضافة فئة</Button>}
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
              {filtered.map((c) => (
                <tr key={c.id} className={`border-t ${c.isActive ? "" : "opacity-60"}`}>
                  <td className="p-2">
                    <input
                      type="checkbox"
                      className="size-4"
                      aria-label={`تحديد ${c.name}`}
                      checked={sel.isSelected(c.id)}
                      onChange={() => sel.toggle(c.id)}
                    />
                  </td>
                  <td className="p-2 font-medium">{c.name}</td>
                  <td className="p-2 text-muted-foreground">{c.description || "—"}</td>
                  <td className="p-2 text-center tabular-nums">{num(c.productCount)}</td>
                  <td className="p-2 text-center">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${c.isActive ? "badge-status-active" : "badge-status-cancelled"}`}>
                      {c.isActive ? "مفعّلة" : "معطّلة"}
                    </span>
                  </td>
                  <td className="p-2 text-center">
                    <RowActions
                      actions={[
                        { key: "edit", label: "تعديل", onSelect: () => openEdit(c) },
                        { key: "products", label: "عرض منتجاتها", href: `/products?category=${c.id}`, hidden: c.productCount === 0 },
                        { key: "delete", label: "حذف", variant: "destructive", onSelect: () => openDelete(c) },
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {list.isLoading && (
                <tr><td colSpan={6}><LoadingState /></td></tr>
              )}
              {!list.isLoading && filtered.length === 0 && (
                <TableEmptyRow colSpan={6} message={query ? "لا فئات مطابقة للبحث." : "لا فئات بعد — أضِف أوّل فئة."} />
              )}
            </tbody>
          </table>
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

      {/* نموذج إضافة/تعديل فئة */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editId == null ? "إضافة فئة" : "تعديل فئة"}</DialogTitle>
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
              {delTarget && delTarget.productCount > 0
                ? `هذه الفئة تحوي ${num(delTarget.productCount)} منتجاً. اختر فئة لنقلها إليها قبل الحذف (أو اتركها «بلا فئة»).`
                : "لا منتجات في هذه الفئة. سيُحذف التصنيف نهائياً."}
            </DialogDescription>
          </DialogHeader>
          {delTarget && delTarget.productCount > 0 && (
            <div className="space-y-1">
              <label className="text-sm font-medium">نقل المنتجات إلى</label>
              <select
                value={reassignTo == null ? "" : String(reassignTo)}
                onChange={(e) => setReassignTo(e.target.value === "" ? null : Number(e.target.value))}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
              >
                <option value="">— بلا فئة —</option>
                {rows.filter((r) => r.id !== delTarget.id).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDelTarget(null)}>إلغاء</Button>
            <Button variant="destructive" size="sm" onClick={confirmDelete} disabled={deleteMut.isPending}>
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
