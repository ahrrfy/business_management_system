// إدارة فئات السندات — admin/manager (list مَتاحة، CRUD admin فقط).
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useState } from "react";
import { Link } from "wouter";
import { Edit3, Plus } from "lucide-react";

type Row = RouterOutputs["voucherCategories"]["list"][number];

const DIR_LABEL: Record<string, string> = { IN: "قبض فقط", OUT: "صرف فقط", BOTH: "كلاهما" };
const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function VoucherCategories() {
  const utils = trpc.useUtils();
  const list = trpc.voucherCategories.list.useQuery({ includeInactive: true });
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";

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

  async function doMerge(r: Row) {
    const otherId = window.prompt(`دَمج «${r.name}» في فئة أخرى — أدخل رقم الفئة الهدف:`);
    if (!otherId) return;
    const toId = Number(otherId);
    if (!Number.isFinite(toId) || toId <= 0) { notify.err("رقم غير صالح"); return; }
    const ok = await confirm({
      variant: "danger",
      title: "دَمج الفئات",
      description: `كل سندات «${r.name}» سَتُنقل إلى الفئة #${toId} وتُعطَّل الفئة الحالية. هل تتابع؟`,
      confirmText: "دَمج",
    });
    if (!ok) return;
    merge.mutate({ fromId: Number(r.id), toId });
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
                <option value="BOTH">قبض وصَرف (BOTH)</option>
                <option value="IN">قبض فقط (IN)</option>
                <option value="OUT">صَرف فقط (OUT)</option>
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
        <CardHeader><CardTitle className="text-base">القائمة</CardTitle></CardHeader>
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
                {(list.data ?? []).map((r) => (
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
                        <div className="flex justify-center gap-1">
                          <Button size="sm" variant="ghost" onClick={() => startEdit(r)} title="تَعديل">
                            <Edit3 aria-hidden className="size-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void toggleActive(r)}>
                            {r.isActive ? "تَعطيل" : "تَفعيل"}
                          </Button>
                          {r.isActive && (
                            <Button size="sm" variant="ghost" onClick={() => void doMerge(r)} title="دَمج في فئة أخرى">
                              دَمج
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                {!list.isLoading && (list.data ?? []).length === 0 && (
                  <TableEmptyRow colSpan={7} message="لا فئات حتى الآن." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>
    </div>
  );
}
