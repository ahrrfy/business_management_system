// تنبيهات إعادة الطلب — إنذار نفاد مبكّر للقرطاسية (بند 7 من خارطة المالك).
// جدول (متغيّر × فرع) رصيده ≤ حدّ إعادة الطلب، مرتّب بالأشدّ نقصاً، مع:
// - تحرير مباشر للعتبتين (الحد الأدنى/حدّ الطلب) لكل صف — المدير/المخزن.
// - تحديد صفوف ثم «إنشاء مسودة أمر شراء» بحوار اختيار المورّد وكميات مقترحة قابلة للتعديل.
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtInt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { FileEdit, ShoppingCart } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "wouter";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function variantLabel(r: { variantName: string | null; color: string | null; size: string | null; sku: string }): string {
  const parts = [r.variantName, r.color, r.size].filter(Boolean);
  return parts.length ? parts.join(" / ") : r.sku;
}

/** مفتاح صف فريد: نفس المتغيّر قد يظهر لفرعين. */
const rowKey = (r: { variantId: number; branchId: number }) => `${r.variantId}:${r.branchId}`;

export default function ReorderAlerts() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const isAdmin = role === "admin";
  const canPickBranch = isAdmin || role === "manager";
  const canWrite = isAdmin || role === "manager" || role === "warehouse";
  const myBranch = me.data?.branchId ?? null;

  const branches = trpc.branches.list.useQuery(undefined, { enabled: canPickBranch });
  // admin: null = كل الفروع (الافتراضي)؛ manager: فرعه (الخادم يرفض غيره).
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const branchId = isAdmin ? pickedBranch : canPickBranch ? pickedBranch ?? myBranch : myBranch;

  const alerts = trpc.inventory.reorderAlerts.useQuery(
    { branchId: branchId ?? undefined },
    { enabled: me.data != null },
  );
  const rows = alerts.data ?? [];

  // ── تحرير العتبتين المباشر (لكل صف) ─────────────────────────────────────
  const [editing, setEditing] = useState<string | null>(null);
  const [minVal, setMinVal] = useState("");
  const [reorderVal, setReorderVal] = useState("");
  const setThresholds = trpc.inventory.setReorderThresholds.useMutation({
    onSuccess: async () => {
      setEditing(null);
      notify.ok("حُدِّثت عتبتا إعادة الطلب");
      await utils.inventory.reorderAlerts.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  function startEdit(r: { variantId: number; branchId: number; minStock: number; reorderPoint: number }) {
    setEditing(rowKey(r));
    setMinVal(String(r.minStock));
    setReorderVal(String(r.reorderPoint));
  }
  function saveEdit(variantId: number) {
    const minStock = Number(minVal);
    const reorderPoint = Number(reorderVal);
    if (!Number.isInteger(minStock) || minStock < 0 || !Number.isInteger(reorderPoint) || reorderPoint < 0) {
      notify.err("العتبتان يجب أن تكونا عددين صحيحين غير سالبين");
      return;
    }
    if (minStock > reorderPoint) {
      notify.err("الحد الأدنى لا يصحّ أن يتجاوز حدّ إعادة الطلب");
      return;
    }
    setThresholds.mutate({ variantId, minStock, reorderPoint });
  }

  // ── تحديد الصفوف + حوار المسودة ─────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(rowKey(r))), [rows, selected]);
  const selectedBranchIds = useMemo(() => new Set(selectedRows.map((r) => r.branchId)), [selectedRows]);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map(rowKey))));
  }

  const [dialogOpen, setDialogOpen] = useState(false);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [createdPo, setCreatedPo] = useState<{ purchaseOrderId: number; poNumber?: string } | null>(null);
  const supplierList = trpc.suppliers.list.useQuery(undefined, { enabled: dialogOpen });

  function openDraftDialog() {
    if (selectedRows.length === 0) {
      notify.err("اختر صنفاً واحداً على الأقل من الجدول");
      return;
    }
    if (selectedBranchIds.size > 1) {
      notify.err("أمر الشراء لفرع واحد — اختر أصنافاً من نفس الفرع");
      return;
    }
    setQtys(Object.fromEntries(selectedRows.map((r) => [rowKey(r), String(r.suggestedQty)])));
    setSupplierId(null);
    setDialogOpen(true);
  }

  const createDraft = trpc.inventory.createReorderDraft.useMutation({
    onSuccess: async (res) => {
      setDialogOpen(false);
      setSelected(new Set());
      setCreatedPo(res);
      notify.ok(
        res.poNumber ? `أُنشئت مسودة أمر الشراء ${res.poNumber}` : "أُنشئت مسودة أمر الشراء",
        "تجدها في شاشة المشتريات بحالة «مسودة»",
      );
      await utils.inventory.reorderAlerts.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  function submitDraft() {
    if (supplierId == null) {
      notify.err("اختر المورّد أولاً");
      return;
    }
    const draftBranch = selectedRows[0]?.branchId;
    if (draftBranch == null) return;
    const lines: Array<{ variantId: number; quantity: number }> = [];
    for (const r of selectedRows) {
      const q = Number(qtys[rowKey(r)]);
      if (!Number.isInteger(q) || q <= 0) {
        notify.err(`كمية غير صالحة للصنف «${r.productName}» — عدد صحيح موجب`);
        return;
      }
      lines.push({ variantId: r.variantId, quantity: q });
    }
    createDraft.mutate({ supplierId, branchId: draftBranch, lines });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="تنبيهات إعادة الطلب"
        description="الأصناف التي بلغ رصيدها حدّ إعادة الطلب — الأشدّ نقصاً أولاً. حدّد الأصناف وأنشئ مسودة أمر شراء بنقرة."
        actions={
          canWrite ? (
            <Button onClick={openDraftDialog} disabled={selectedRows.length === 0}>
              <ShoppingCart aria-hidden className="size-4" />
              إنشاء مسودة أمر شراء{selectedRows.length > 0 ? ` (${fmtInt(selectedRows.length)})` : ""}
            </Button>
          ) : undefined
        }
      />

      {createdPo && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm flex items-center justify-between gap-3">
          <span>
            أُنشئت مسودة أمر الشراء{createdPo.poNumber ? <b className="font-mono mx-1" dir="ltr">{createdPo.poNumber}</b> : null} بنجاح.
          </span>
          <Link href="/purchases" className="text-primary underline underline-offset-4 whitespace-nowrap">
            فتح شاشة المشتريات
          </Link>
        </div>
      )}

      {canPickBranch && (
        <Card>
          <CardHeader><CardTitle className="text-base">الفلاتر</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div className="space-y-1">
              <Label>الفرع</Label>
              <select
                className={selectCls}
                value={branchId ?? ""}
                onChange={(e) => setPickedBranch(e.target.value === "" ? null : Number(e.target.value))}
              >
                {isAdmin && <option value="">كل الفروع</option>}
                {(branches.data ?? []).map((b) => (
                  <option key={Number(b.id)} value={Number(b.id)}>{b.name}</option>
                ))}
              </select>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">الأصناف الواجب إعادة طلبها</CardTitle>
          <span className="text-xs text-muted-foreground">
            {alerts.isLoading ? "جارٍ التحميل…" : `${fmtInt(rows.length)} صنف`}
          </span>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  {canWrite && (
                    <th className="p-2 text-center w-10">
                      <input
                        type="checkbox"
                        className="size-4 align-middle"
                        aria-label="تحديد الكل"
                        checked={rows.length > 0 && selected.size === rows.length}
                        onChange={toggleAll}
                      />
                    </th>
                  )}
                  <th className="p-2 text-start">المنتج</th>
                  <th className="p-2 text-start">المتغيّر / SKU</th>
                  <th className="p-2 text-start">الفرع</th>
                  <th className="p-2 text-left">الرصيد</th>
                  <th className="p-2 text-left">الحد الأدنى</th>
                  <th className="p-2 text-left">حدّ الطلب</th>
                  <th className="p-2 text-left">الكمية المقترحة</th>
                  {canWrite && <th className="p-2 text-center">العتبتان</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const key = rowKey(r);
                  const isEditing = editing === key;
                  const severe = r.quantity <= r.minStock;
                  return (
                    <tr key={key} className={`border-t ${severe ? "bg-destructive/5" : "bg-amber-50/50"}`}>
                      {canWrite && (
                        <td className="p-2 text-center">
                          <input
                            type="checkbox"
                            className="size-4 align-middle"
                            aria-label={`تحديد ${r.productName}`}
                            checked={selected.has(key)}
                            onChange={() => toggle(key)}
                          />
                        </td>
                      )}
                      <td className="p-2 font-medium">{r.productName}</td>
                      <td className="p-2 text-xs">
                        {variantLabel(r)} <span className="text-muted-foreground font-mono" dir="ltr">({r.sku})</span>
                      </td>
                      <td className="p-2 text-xs">{r.branchName}</td>
                      <td className="p-2 text-left tabular-nums font-semibold">{fmtInt(r.quantity)}</td>
                      <td className="p-2 text-left tabular-nums">
                        {isEditing ? (
                          <Input
                            dir="ltr"
                            inputMode="numeric"
                            value={minVal}
                            onChange={(e) => setMinVal(e.target.value.replace(/[^\d]/g, ""))}
                            className="h-8 w-20 text-center"
                            aria-label="الحد الأدنى"
                            autoFocus
                          />
                        ) : (
                          fmtInt(r.minStock)
                        )}
                      </td>
                      <td className="p-2 text-left tabular-nums">
                        {isEditing ? (
                          <Input
                            dir="ltr"
                            inputMode="numeric"
                            value={reorderVal}
                            onChange={(e) => setReorderVal(e.target.value.replace(/[^\d]/g, ""))}
                            className="h-8 w-20 text-center"
                            aria-label="حدّ إعادة الطلب"
                          />
                        ) : (
                          fmtInt(r.reorderPoint)
                        )}
                      </td>
                      <td className="p-2 text-left tabular-nums font-semibold text-primary">{fmtInt(r.suggestedQty)}</td>
                      {canWrite && (
                        <td className="p-2 text-center">
                          {isEditing ? (
                            <div className="flex gap-1 justify-center">
                              <Button size="sm" onClick={() => saveEdit(r.variantId)} disabled={setThresholds.isPending}>
                                {setThresholds.isPending ? "…" : "حفظ"}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={setThresholds.isPending}>
                                إلغاء
                              </Button>
                            </div>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => startEdit(r)}>
                              <FileEdit aria-hidden className="size-3.5" />
                              تعديل
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {!alerts.isLoading && rows.length === 0 && (
                  <TableEmptyRow
                    colSpan={canWrite ? 9 : 7}
                    message="لا أصناف بلغت حدّ إعادة الطلب. اضبط «حدّ الطلب» من شاشة المنتج (أو من هنا) لتفعيل الإنذار المبكّر."
                  />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>مسودة أمر شراء — {fmtInt(selectedRows.length)} صنف</DialogTitle>
            <DialogDescription>
              اختر المورّد وعدّل الكميات المقترحة عند الحاجة. تُنشأ بحالة «مسودة» وتُستكمل من شاشة المشتريات.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label>المورّد</Label>
              <select
                className={selectCls}
                value={supplierId ?? ""}
                onChange={(e) => setSupplierId(e.target.value === "" ? null : Number(e.target.value))}
              >
                <option value="">— اختر المورّد —</option>
                {(supplierList.data ?? []).map((s) => (
                  <option key={Number(s.id)} value={Number(s.id)}>{s.name}</option>
                ))}
              </select>
            </div>

            <ScrollTableShell>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-start">الصنف</th>
                    <th className="p-2 text-left">الرصيد</th>
                    <th className="p-2 text-left">الكمية المطلوبة (أساس)</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedRows.map((r) => {
                    const key = rowKey(r);
                    return (
                      <tr key={key} className="border-t">
                        <td className="p-2">
                          {r.productName} <span className="text-xs text-muted-foreground">({variantLabel(r)})</span>
                        </td>
                        <td className="p-2 text-left tabular-nums">{fmtInt(r.quantity)}</td>
                        <td className="p-2 text-left">
                          <Input
                            dir="ltr"
                            inputMode="numeric"
                            value={qtys[key] ?? ""}
                            onChange={(e) => setQtys((prev) => ({ ...prev, [key]: e.target.value.replace(/[^\d]/g, "") }))}
                            className="h-8 w-24 text-center"
                            aria-label={`كمية ${r.productName}`}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollTableShell>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={createDraft.isPending}>
              إلغاء
            </Button>
            <Button onClick={submitDraft} disabled={createDraft.isPending || supplierId == null}>
              {createDraft.isPending ? "جارٍ الإنشاء…" : "إنشاء المسودة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
