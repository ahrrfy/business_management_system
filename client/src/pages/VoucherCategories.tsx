// إدارة فئات السندات — admin/manager (list مَتاحة، CRUD admin فقط).
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Edit3, Plus } from "lucide-react";
import { ListToolbar, RowActions } from "@/components/list";

type Row = RouterOutputs["voucherCategories"]["list"][number];

// توحيد التسمية مع نموذج الإضافة/التعديل أدناه (كان BOTH يُعرَض «كلاهما» هنا و«قبض وصرف» في النموذج
// لنفس القيمة — تسمية غير متّسقة على الشاشة نفسها).
const DIR_LABEL: Record<string, string> = { IN: "قبض فقط", OUT: "صرف فقط", BOTH: "قبض وصرف" };
const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function VoucherCategories() {
  const utils = trpc.useUtils();
  const list = trpc.voucherCategories.list.useQuery({ includeInactive: true });
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";
  const [query, setQuery] = useState("");
  const rows = list.data ?? [];
  const visibleRows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    return q ? rows.filter((r) => [r.name, r.description, DIR_LABEL[r.direction]].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(q))) : rows;
  }, [rows, query]);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState<"IN" | "OUT" | "BOTH">("BOTH");
  const [description, setDescription] = useState("");
  const [sortOrder, setSortOrder] = useState<number>(100);

  const create = trpc.voucherCategories.create.useMutation({
    onSuccess: async () => {
      await utils.voucherCategories.list.invalidate();
      resetForm();
      notify.ok("أُضيفت الفئة");
    },
    onError: (e) => notify.err(e),
  });
  const update = trpc.voucherCategories.update.useMutation({
    onSuccess: async () => {
      await utils.voucherCategories.list.invalidate();
      resetForm();
      notify.ok("حُدّثت الفئة");
    },
    onError: (e) => notify.err(e),
  });
  const setActive = trpc.voucherCategories.setActive.useMutation({
    onSuccess: async () => {
      await utils.voucherCategories.list.invalidate();
      notify.ok("تَمّ التَحديث");
    },
    onError: (e) => notify.err(e),
  });
  const merge = trpc.voucherCategories.merge.useMutation({
    onSuccess: async () => {
      await utils.voucherCategories.list.invalidate();
      notify.ok("تَمّ الدَمج");
      setMergingRow(null);
      setMergeTargetId("");
    },
    onError: (e) => notify.err(e),
  });

  function resetForm() {
    setShowForm(false);
    setEditing(null);
    setName(""); setDirection("BOTH"); setDescription(""); setSortOrder(100);
  }

  function startEdit(r: Row) {
    setEditing(r);
    setName(r.name);
    setDirection(r.direction as "IN" | "OUT" | "BOTH");
    setDescription(r.description ?? "");
    setSortOrder(r.sortOrder);
    setShowForm(true);
  }

  function submitForm() {
    if (!name.trim()) { notify.err("الاسم مطلوب"); return; }
    if (editing) {
      update.mutate({ id: Number(editing.id), name: name.trim(), direction, description: description.trim() || null, sortOrder });
    } else {
      create.mutate({ name: name.trim(), direction, description: description.trim() || null, sortOrder });
    }
  }

  async function toggleActive(r: Row) {
    const ok = await confirm({
      variant: r.isActive ? "warning" : "info",
      title: r.isActive ? "تَعطيل الفئة" : "تَفعيل الفئة",
      description: r.isActive
        ? `سَتَختفي فئة «${r.name}» من قوائم اختيار السندات الجَديدة (السندات القَديمة تَحتفظ بربطها).`
        : `سَتَعود فئة «${r.name}» للظُهور في قوائم السندات الجَديدة.`,
      confirmText: r.isActive ? "تَعطيل" : "تَفعيل",
    });
    if (!ok) return;
    setActive.mutate({ id: Number(r.id), isActive: !r.isActive });
  }

  // دَمج فئتين — حوار بمنتقٍ بالاسم (لا رقم فئة خام يكتبه المستخدم يدوياً عبر window.prompt).
  const [mergingRow, setMergingRow] = useState<Row | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState<string>("");

  function doMerge(r: Row) {
    setMergingRow(r);
    setMergeTargetId("");
  }

  const mergeCandidates = useMemo(
    () => rows.filter((c) => c.isActive && Number(c.id) !== Number(mergingRow?.id ?? -1)),
    [rows, mergingRow],
  );

  function confirmMerge() {
    if (!mergingRow || !mergeTargetId) return;
    merge.mutate({ fromId: Number(mergingRow.id), toId: Number(mergeTargetId) });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="فئات السندات"
        description="تَصنيف سندات القَبض/الصَرف لتَقارير «مَصاريف حسب الفئة» و«إيرادات حسب الفئة»."
        actions={
          <div className="flex gap-2">
            <Link href="/vouchers"><Button variant="outline" size="sm">→ السندات</Button></Link>
            {isAdmin && (
              <Button onClick={() => { resetForm(); setShowForm(true); }} className="bg-emerald-600 hover:bg-emerald-700">
                <Plus aria-hidden className="size-4 ms-1" /> فئة جديدة
              </Button>
            )}
          </div>
        }
      />

      {!isAdmin && (
        <Card>
          <CardContent className="p-3 text-sm text-muted-foreground">
            عرض فقط — الإضافة/التَعديل مُتاحة للأدمن.
          </CardContent>
        </Card>
      )}

      {showForm && isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{editing ? "تَعديل فئة" : "فئة جديدة"}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>الاسم *</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="مَثلاً: إعلانات ومُلصقات" />
            </div>
            <div className="space-y-1">
              <Label>الاتجاه *</Label>
              <select className={selectCls} value={direction} onChange={(e) => setDirection(e.target.value as any)}>
                <option value="BOTH">قبض وصرف</option>
                <option value="IN">قبض فقط</option>
                <option value="OUT">صرف فقط</option>
              </select>
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label>الوَصف (اختياري)</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="شَرح مُختصر للفئة" />
            </div>
            <div className="space-y-1">
              <Label>ترتيب العرض</Label>
              <Input type="number" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value) || 0)} />
            </div>
            <div className="md:col-span-2 flex gap-2">
              <Button onClick={submitForm} disabled={create.isPending || update.isPending} className="bg-emerald-600 hover:bg-emerald-700">
                {editing ? "حفظ التَعديل" : "حفظ الفئة"}
              </Button>
              <Button variant="outline" onClick={resetForm}>إلغاء</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <ListToolbar
            title="فئات السندات"
            count={visibleRows.length}
            loading={list.isLoading}
            search={{ value: query, onChange: setQuery, placeholder: "اسم الفئة، الاتجاه أو الوصف…" }}
            onResetFilters={() => setQuery("")}
            onRefresh={() => void list.refetch()}
            refreshing={list.isFetching}
            onPrint={() => window.print()}
            exportSpec={{
              filename: "فئات-السندات",
              rows: visibleRows,
              formats: ["xlsx", "csv"],
              columns: [
                { key: "id", header: "#" }, { key: "name", header: "الاسم" },
                { key: "direction", header: "الاتجاه", map: (r) => DIR_LABEL[r.direction] ?? r.direction },
                { key: "description", header: "الوصف" }, { key: "sortOrder", header: "الترتيب" },
                { key: "isActive", header: "الحالة", map: (r) => r.isActive ? "نشطة" : "معطّلة" },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-center">#</th>
                  <th className="p-2">الاسم</th>
                  <th className="p-2 text-center">الاتجاه</th>
                  <th className="p-2">الوصف</th>
                  <th className="p-2 text-center">ترتيب</th>
                  <th className="p-2 text-center">نَشِطة</th>
                  {isAdmin && <th className="p-2 text-center">إجراء</th>}
                </tr>
              </thead>
              <tbody>
                {list.isLoading && <tr><td colSpan={7}><LoadingState /></td></tr>}
                {list.isError && (
                  <tr><td colSpan={7}><ErrorState message={list.error?.message} onRetry={() => void list.refetch()} /></td></tr>
                )}
                {visibleRows.map((r) => (
                  <tr key={Number(r.id)} className={`border-t ${r.isActive ? "" : "opacity-60"}`}>
                    <td className="p-2 text-center text-xs text-muted-foreground">{Number(r.id)}</td>
                    <td className="p-2 font-medium">{r.name}</td>
                    <td className="p-2 text-center text-xs">
                      <span className={`inline-block rounded-full px-2 py-0.5 ${
                        r.direction === "IN" ? "bg-emerald-100 text-emerald-800"
                        : r.direction === "OUT" ? "bg-rose-100 text-rose-800"
                        : "bg-[var(--sem-info-bg)] text-[var(--sem-info)]"
                      }`}>
                        {DIR_LABEL[r.direction]}
                      </span>
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">{r.description ?? "—"}</td>
                    <td className="p-2 text-center text-xs tabular-nums">{r.sortOrder}</td>
                    <td className="p-2 text-center text-xs">{r.isActive ? "نعم" : "لا"}</td>
                    {isAdmin && (
                      <td className="p-2 text-center">
                        <RowActions
                          mode="menu"
                          actions={[
                            {
                              key: "edit",
                              kind: "edit",
                              label: "تعديل",
                              icon: Edit3,
                              onSelect: () => startEdit(r),
                              gate: { adminOnly: true },
                            },
                            {
                              key: "toggle",
                              kind: "approve",
                              label: r.isActive ? "تعطيل" : "تفعيل",
                              variant: r.isActive ? "destructive" : "default",
                              onSelect: () => void toggleActive(r),
                              gate: { adminOnly: true },
                            },
                            {
                              key: "merge",
                              kind: "reverse",
                              label: "دمج",
                              hidden: !r.isActive,
                              onSelect: () => void doMerge(r),
                              gate: { adminOnly: true },
                            },
                          ]}
                        />
                      </td>
                    )}
                  </tr>
                ))}
                {!list.isLoading && visibleRows.length === 0 && (
                  <TableEmptyRow colSpan={7} message="لا فئات حتى الآن." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {/* دمج فئتين — منتقٍ بالاسم بدل رقم فئة خام (كان window.prompt يطلب رقماً يدوياً). */}
      <Dialog open={mergingRow != null} onOpenChange={(open) => { if (!open) { setMergingRow(null); setMergeTargetId(""); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>دمج فئة «{mergingRow?.name}»</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            كل سندات «{mergingRow?.name}» سَتُنقل إلى الفئة المُختارة وتُعطَّل الفئة الحالية. هذا الإجراء لا يُمكن التراجع عنه.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="merge-target">الفئة الهدف *</Label>
            <AppSelect
              id="merge-target"
              value={mergeTargetId}
              onValueChange={setMergeTargetId}
              placeholder="— اختر الفئة الهدف —"
            >
              <option value="">— اختر الفئة الهدف —</option>
              {mergeCandidates.map((c) => (
                <option key={Number(c.id)} value={String(c.id)}>{c.name}</option>
              ))}
            </AppSelect>
            {mergeCandidates.length === 0 && (
              <p className="text-xs text-muted-foreground">لا فئات نشِطة أخرى للدمج فيها.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setMergingRow(null); setMergeTargetId(""); }}>إلغاء</Button>
            <Button
              variant="destructive"
              disabled={!mergeTargetId || merge.isPending}
              onClick={confirmMerge}
            >
              {merge.isPending ? "جارٍ الدمج…" : "دمج"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
