// تخطيط موسم المدارس (بند 7): جدول الأصناف الموسمية بمخزونها الكلّيّ عبر **كل الفروع** مقابل هدف الموسم
// + الفجوة (كمية الشراء المقترحة لتجهيز ذروة أيلول). تحرير الهدف مباشرةً، إضافة صنف موسميّ بالبحث،
// تصفية «تحت الهدف فقط»، وتصدير قائمة الشراء إلى Excel. محصورة بالمدير/المخزن (البوّابة خادمية).
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
import { exportRows } from "@/lib/export";
import { fmtInt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { FileEdit, Plus } from "lucide-react";
import { useEffect, useState } from "react";

type VariantLike = { variantName: string | null; color: string | null; size: string | null; sku: string };
function variantLabel(r: VariantLike): string {
  const parts = [r.variantName, r.color, r.size].filter(Boolean);
  return parts.length ? parts.join(" / ") : r.sku;
}

export default function SeasonPlanning() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const canWrite = role === "admin" || role === "manager" || role === "warehouse";

  const [onlyBelow, setOnlyBelow] = useState(true);
  const plan = trpc.inventory.seasonPlan.useQuery(
    { onlyBelowTarget: onlyBelow },
    { enabled: me.data != null },
  );
  const rows = plan.data ?? [];

  // ── تحرير الهدف المباشر (لكل صف) ────────────────────────────────────────
  const [editing, setEditing] = useState<number | null>(null);
  const [targetVal, setTargetVal] = useState("");
  const setTarget = trpc.inventory.setSeasonTarget.useMutation({
    onSuccess: async () => {
      setEditing(null);
      notify.ok("حُدِّث هدف الموسم");
      await utils.inventory.seasonPlan.invalidate();
      await utils.inventory.planningSummary.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  function startEdit(r: { variantId: number; seasonTarget: number }) {
    setEditing(r.variantId);
    setTargetVal(String(r.seasonTarget));
  }
  function saveEdit(variantId: number) {
    const t = Number(targetVal);
    if (!Number.isInteger(t) || t < 0) {
      notify.err("هدف الموسم يجب أن يكون عدداً صحيحاً غير سالب");
      return;
    }
    setTarget.mutate({ variantId, seasonTarget: t });
  }

  // ── إضافة صنف موسميّ (بحث + تعيين هدف) ──────────────────────────────────
  const [addOpen, setAddOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebounced(term.trim()), 300);
    return () => clearTimeout(id);
  }, [term]);
  const search = trpc.inventory.seasonVariantSearch.useQuery(
    { q: debounced },
    { enabled: addOpen && debounced.length > 0 },
  );
  const [addTargets, setAddTargets] = useState<Record<number, string>>({});
  const addTarget = trpc.inventory.setSeasonTarget.useMutation({
    onSuccess: async (res) => {
      notify.ok("أُضيف الصنف لخطة الموسم");
      setAddTargets((prev) => {
        const next = { ...prev };
        delete next[res.variantId];
        return next;
      });
      await utils.inventory.seasonPlan.invalidate();
      await utils.inventory.seasonVariantSearch.invalidate();
      await utils.inventory.planningSummary.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  function addItem(variantId: number) {
    const t = Number(addTargets[variantId]);
    if (!Number.isInteger(t) || t <= 0) {
      notify.err("أدخل هدفاً موجباً للصنف");
      return;
    }
    addTarget.mutate({ variantId, seasonTarget: t });
  }
  function openAdd() {
    setTerm("");
    setDebounced("");
    setAddTargets({});
    setAddOpen(true);
  }

  // ── تصدير قائمة الشراء إلى Excel ────────────────────────────────────────
  function doExport() {
    if (rows.length === 0) {
      notify.err("لا بيانات للتصدير");
      return;
    }
    exportRows(rows, {
      filename: "خطة-موسم-المدارس",
      title: "خطة تجهيز موسم المدارس",
      columns: [
        { key: "productName", header: "المنتج" },
        { key: "variant", header: "المتغيّر / SKU", map: (r) => `${variantLabel(r)} (${r.sku})` },
        { key: "totalStock", header: "المخزون الكلّيّ", map: (r) => r.totalStock },
        { key: "seasonTarget", header: "هدف الموسم", map: (r) => r.seasonTarget },
        { key: "gap", header: "الفجوة (شراء مقترح)", map: (r) => r.gap },
      ],
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="تخطيط موسم المدارس"
        description="الأصناف الموسمية: المخزون الكلّيّ عبر كل الفروع مقابل هدف الموسم — الأبعد عن الهدف أولاً. الفجوة = كمية الشراء المقترحة لتجهيز ذروة أيلول."
        actions={
          canWrite ? (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={rows.length === 0} onClick={doExport}>
                تصدير Excel
              </Button>
              <Button size="sm" onClick={openAdd}>
                <Plus aria-hidden className="size-4" />
                إضافة صنف موسميّ
              </Button>
            </div>
          ) : undefined
        }
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">الأصناف الموسمية</CardTitle>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                className="size-4 align-middle"
                checked={onlyBelow}
                onChange={(e) => setOnlyBelow(e.target.checked)}
              />
              تحت الهدف فقط
            </label>
            <span className="text-xs text-muted-foreground">
              {plan.isLoading ? "جارٍ التحميل…" : `${fmtInt(rows.length)} صنف`}
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">المنتج</th>
                  <th className="p-2 text-start">المتغيّر / SKU</th>
                  <th className="p-2 text-left">المخزون الكلّيّ</th>
                  <th className="p-2 text-left">هدف الموسم</th>
                  <th className="p-2 text-left">الفجوة (شراء مقترح)</th>
                  {canWrite && <th className="p-2 text-center">الهدف</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isEditing = editing === r.variantId;
                  const needs = r.gap > 0;
                  return (
                    <tr key={r.variantId} className={`border-t ${needs ? "bg-amber-50/50" : ""}`}>
                      <td className="p-2 font-medium">{r.productName}</td>
                      <td className="p-2 text-xs">
                        {variantLabel(r)} <span className="text-muted-foreground font-mono" dir="ltr">({r.sku})</span>
                      </td>
                      <td className="p-2 text-left tabular-nums font-semibold">{fmtInt(r.totalStock)}</td>
                      <td className="p-2 text-left tabular-nums">
                        {isEditing ? (
                          <Input
                            dir="ltr"
                            inputMode="numeric"
                            value={targetVal}
                            onChange={(e) => setTargetVal(e.target.value.replace(/[^\d]/g, ""))}
                            className="h-8 w-24 text-center"
                            aria-label="هدف الموسم"
                            autoFocus
                          />
                        ) : (
                          fmtInt(r.seasonTarget)
                        )}
                      </td>
                      <td className="p-2 text-left tabular-nums font-semibold text-primary">{fmtInt(r.gap)}</td>
                      {canWrite && (
                        <td className="p-2 text-center">
                          {isEditing ? (
                            <div className="flex gap-1 justify-center">
                              <Button size="sm" onClick={() => saveEdit(r.variantId)} disabled={setTarget.isPending}>
                                {setTarget.isPending ? "…" : "حفظ"}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={setTarget.isPending}>
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
                {!plan.isLoading && rows.length === 0 && (
                  <TableEmptyRow
                    colSpan={canWrite ? 6 : 5}
                    message={
                      onlyBelow
                        ? "لا أصناف موسمية تحت الهدف. ألغِ «تحت الهدف فقط» لعرض كل الأصناف الموسمية، أو أضِف صنفاً بزرّ «إضافة صنف موسميّ»."
                        : "لا أصناف موسمية بعد. أضِف صنفاً بزرّ «إضافة صنف موسميّ» واضبط هدفه لتجهيز الموسم."
                    }
                  />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>إضافة صنف لخطة موسم المدارس</DialogTitle>
            <DialogDescription>
              ابحث عن الصنف باسم المنتج أو SKU، ثم اضبط هدف الموسم (بالوحدة الأساس). الأصناف المُضافة سلفاً
              تظهر بهدفها الحاليّ. اضبط الهدف إلى صفر لاحقاً لإزالة الصنف من الخطة.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="season-search">بحث الصنف</Label>
              <Input
                id="season-search"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="اسم المنتج أو SKU…"
                autoFocus
              />
            </div>

            <ScrollTableShell>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-start">الصنف</th>
                    <th className="p-2 text-left">المخزون الكلّيّ</th>
                    <th className="p-2 text-left">هدف الموسم</th>
                    <th className="p-2 text-center w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {(search.data ?? []).map((c) => (
                    <tr key={c.variantId} className="border-t">
                      <td className="p-2">
                        {c.productName}{" "}
                        <span className="text-xs text-muted-foreground">
                          ({variantLabel(c)} — <span className="font-mono" dir="ltr">{c.sku}</span>)
                        </span>
                      </td>
                      <td className="p-2 text-left tabular-nums">{fmtInt(c.totalStock)}</td>
                      <td className="p-2 text-left">
                        <Input
                          dir="ltr"
                          inputMode="numeric"
                          value={addTargets[c.variantId] ?? (c.seasonTarget > 0 ? String(c.seasonTarget) : "")}
                          onChange={(e) =>
                            setAddTargets((prev) => ({ ...prev, [c.variantId]: e.target.value.replace(/[^\d]/g, "") }))
                          }
                          className="h-8 w-24 text-center"
                          aria-label={`هدف موسم ${c.productName}`}
                          placeholder="0"
                        />
                      </td>
                      <td className="p-2 text-center">
                        <Button size="sm" onClick={() => addItem(c.variantId)} disabled={addTarget.isPending}>
                          {c.seasonTarget > 0 ? "تحديث" : "إضافة"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {search.isFetching && debounced.length > 0 && (
                    <TableEmptyRow colSpan={4} message="جارٍ البحث…" />
                  )}
                  {!search.isFetching && debounced.length > 0 && (search.data ?? []).length === 0 && (
                    <TableEmptyRow colSpan={4} message="لا نتائج مطابقة." />
                  )}
                  {debounced.length === 0 && (
                    <TableEmptyRow colSpan={4} message="اكتب اسم المنتج أو SKU للبحث." />
                  )}
                </tbody>
              </table>
            </ScrollTableShell>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              إغلاق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
