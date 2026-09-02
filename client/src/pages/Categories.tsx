// شاشة إدارة الفئات/التصنيفات — قائمة بعدد المنتجات لكل فئة + إضافة/تعديل/حذف (مع إعادة تخصيص
// منتجات الفئة المحذوفة) + دمج عدّة فئات في واحدة. أقسام فرعية (٢٩/٧): كل فئة رئيسية قد تحوي
// فئات فرعية (مستويان فقط) — تُدار من نفس الشاشة (زرّ «+ قسم فرعي» على صفّ الفئة الرئيسية)،
// وتُعرض متداخلة تحت أبيها. نقل منتجات محدّدة بين الفئات يتمّ من شاشة المنتجات
// (تحديد + «نقل إلى فئة»). كل العمليات عبر catalog.* (managerProcedure) وتُحدِّث القوائم تلقائياً.
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
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
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "@/components/PageHeader";
import { notify } from "@/lib/notify";
import { matchQuery } from "@/components/search/filter";
import { categoryOptionElements } from "@/lib/categoryTree";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { ACTION_LABELS } from "@shared/actionLabels";
import { CornerDownLeft, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";

type CategoryRow = RouterOutputs["catalog"]["categoriesAdmin"][number];

const num = (n: number) => n.toLocaleString("ar-IQ-u-nu-latn");

export default function Categories() {
  const utils = trpc.useUtils();
  // مرآة الخادم: `catalog.createCategory/updateCategory/deleteCategory/mergeCategories` كلّها
  // `productsManagerProcedure(["manager"], "products", "FULL")` — server/trpc.ts:590. إخفاءُ زرّ
  // «إضافة فئة» على من لا يستطيع الحفظ (بدل زرٍّ يفتح ثمّ يُرفض عند submit).
  const me = trpc.auth.me.useQuery();
  const canWrite = !!me.data?.role && moduleAccessAllowed(
    me.data.role as RoleKey,
    (me.data.permissionsOverride ?? null) as PermissionMap | null,
    "products",
    "FULL",
    ["manager"],
  );
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

  /*
   * أعمدة جدول الفئات. ⛔ **بلا فرز على أيّ عمود**: الصفوف مرتَّبة شجرياً (كل فئة رئيسية
   * يليها أبناؤها مباشرةً) والتداخل البصريّ يعتمد ذلك الترتيب — أيّ فرزٍ يفصل الابن عن أبيه
   * فتصير الإزاحة كذباً. والجدول الخامّ لم يكن قابلاً للفرز أصلاً.
   */
  const columns: ColumnDef<CategoryRow, unknown>[] = [
    {
      id: "name",
      header: "الفئة",
      accessorFn: (c) => c.name,
      enableSorting: false,
      meta: { width: "wide", wrap: true },
      cell: ({ row }) => {
        const c = row.original;
        const isChild = c.parentId != null;
        const kids = isChild ? [] : childrenOf(c.id);
        return (
          <span className="inline-flex items-center gap-1.5 font-medium">
            {isChild && <CornerDownLeft aria-hidden className="size-3.5 text-muted-foreground shrink-0" />}
            {c.name}
            {!isChild && kids.length > 0 && (
              <span
                className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                title="عدد الأقسام الفرعية تحت هذه الفئة"
              >
                {num(kids.length)} فرعية
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: "description",
      header: "الوصف",
      accessorFn: (c) => c.description || "—",
      enableSorting: false,
      meta: { width: "wide", wrap: true },
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.description || "—"}</span>,
    },
    {
      id: "productCount",
      header: "عدد المنتجات",
      // القيمة المعروضة (شاملةً الأبناء حين تكون فئةً أمّاً) لا الرقم المباشر وحده.
      accessorFn: (c) =>
        c.parentId == null && childrenOf(c.id).length > 0
          ? `${num(c.productCountWithChildren)}${c.productCount > 0 ? ` (${num(c.productCount)} مباشرة)` : ""}`
          : num(c.productCount),
      enableSorting: false,
      meta: { kind: "number", align: "center" },
      cell: ({ row }) => {
        const c = row.original;
        const isChild = c.parentId != null;
        const kids = isChild ? [] : childrenOf(c.id);
        return !isChild && kids.length > 0 ? (
          <>
            <span className="font-medium">{num(c.productCountWithChildren)}</span>
            {c.productCount > 0 && <span className="text-xs text-muted-foreground"> ({num(c.productCount)} مباشرة)</span>}
          </>
        ) : (
          num(c.productCount)
        );
      },
    },
    {
      id: "status",
      header: "الحالة",
      accessorFn: (c) => (c.isActive ? "مفعّلة" : "معطّلة"),
      enableSorting: false,
      meta: { kind: "status" },
      cell: ({ row }) => (
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs ${row.original.isActive ? "badge-status-active" : "badge-status-cancelled"}`}
          title={row.original.isActive ? "الفئة تظهر في نماذج تصنيف المنتج" : "الفئة مخفيّة عن نماذج تصنيف المنتج — منتجاتها القائمة تبقى فيها"}
        >
          {row.original.isActive ? "مفعّلة" : "معطّلة"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "إجراء",
      enableSorting: false,
      meta: { kind: "actions" },
      cell: ({ row }) => {
        const c = row.original;
        const isChild = c.parentId != null;
        const kids = isChild ? [] : childrenOf(c.id);
        return (
          <RowActions
            actions={[
              {
                key: "edit",
                kind: "edit",
                label: "تعديل",
                onSelect: () => openEdit(c),
                gate: { roles: ["manager"], module: "products", level: "FULL" },
              },
              {
                key: "addChild",
                kind: "create",
                label: "+ قسم فرعي",
                onSelect: () => openAdd(c.id),
                hidden: isChild,
                gate: { roles: ["manager"], module: "products", level: "FULL" },
              },
              {
                key: "products",
                kind: "view",
                label: "عرض منتجاتها",
                // /products هو Redirect ثابت لـ/inventory?tab=products يُسقِط أي querystring
                // أصلي (App.tsx) — الرابط المباشر لتبويب المخزون يحافظ على فلتر الفئة.
                href: `/inventory?tab=products&category=${c.id}`,
                hidden: c.productCount === 0 && (isChild || kids.length === 0),
                gate: { module: "products", level: "READ" },
              },
              {
                key: "delete",
                kind: "delete",
                label: "حذف",
                variant: "destructive",
                onSelect: () => openDelete(c),
                gate: { roles: ["manager"], module: "products", level: "FULL" },
              },
            ]}
          />
        );
      },
    },
  ];

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
        actions={canWrite ? <Button size="sm" onClick={() => openAdd()}><Plus className="size-4" /> إضافة فئة</Button> : undefined}
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
              // ٢٤/٨ (Codex P2 على PR #760): لا `autoFocus` — الصفحةُ تبويبٌ داخل InventoryHub.
              aria-label="بحث في الفئات"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* البحث في ترويسة البطاقة أعلاه (يغذّي `filtered`) ⇒ `searchable={false}` وإلّا ظهر
              حقلا بحثٍ متجاوران. والصفوف كلّها بلا ترقيم كما كان الجدول الخامّ.
              التحديد المتعدّد يُصيّره DataTable نفسه (عمود الاختيار + «تحديد كل المرئي»). */}
          <DataTable<CategoryRow, number>
            columns={columns}
            data={orderedRows}
            searchable={false}
            externalFiltersActive={query.trim() !== ""}
            pageSize={Infinity}
            selection={sel}
            getRowId={(c) => c.id}
            loading={list.isLoading}
            errorState={{ isError: list.isError, message: list.error?.message, onRetry: () => void list.refetch() }}
            getRowClassName={(c) => [c.isActive ? "" : "opacity-60", c.parentId != null ? "bg-muted/20" : ""].filter(Boolean).join(" ") || undefined}
            emptyState={canWrite ? "لا فئات بعد — أضِف أوّل فئة بزرّ «إضافة فئة» أعلاه." : "لا فئات بعد."}
            emptyFilteredState={
              <div className="space-y-2">
                <div>لا فئات مطابقة للبحث «{query}».</div>
                <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                  مسح البحث
                </Button>
              </div>
            }
          />
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
              <AppSelect
                value={fParentId === "" ? "" : String(fParentId)}
                onValueChange={(next) => setFParentId(next === "" ? "" : Number(next))}
                disabled={editHasChildren}
                className="h-9 border-input px-3 text-sm disabled:opacity-50"
              >
                <option value="">— فئة رئيسية (بلا أب) —</option>
                {rows.filter((r) => r.parentId == null && r.id !== editId).map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </AppSelect>
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
              {createMut.isPending || updateMut.isPending ? ACTION_LABELS.saving : "حفظ"}
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
              <AppSelect
                value={reassignTo == null ? "" : String(reassignTo)}
                onValueChange={(next) => setReassignTo(next === "" ? null : Number(next))}
                className="h-9 border-input px-3 text-sm"
              >
                <option value="">— بلا فئة —</option>
                {categoryOptionElements(rows.filter((r) => r.id !== delTarget.id))}
              </AppSelect>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDelTarget(null)}>إلغاء</Button>
            <Button variant="destructive" size="sm" onClick={confirmDelete} disabled={deleteMut.isPending || delChildrenCount > 0}>
              {deleteMut.isPending ? ACTION_LABELS.deleting : "حذف الفئة"}
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
            <AppSelect
              value={mergeTarget == null ? "" : String(mergeTarget)}
              onValueChange={(next) => setMergeTarget(next === "" ? null : Number(next))}
              className="h-9 border-input px-3 text-sm"
            >
              {selectedRows.map((r) => <option key={r.id} value={r.id}>{r.name} ({num(r.productCount)} منتج)</option>)}
            </AppSelect>
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
