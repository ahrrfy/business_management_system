import { RowActions } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { confirm } from "@/lib/confirm";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { fmtInt } from "@/lib/money";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { useState } from "react";

const MTYPE: Record<string, string> = {
  IN: "وارد",
  OUT: "صادر",
  ADJUST: "تسوية",
  RETURN: "مرتجع",
  TRANSFER_IN: "تحويل وارد",
  TRANSFER_OUT: "تحويل صادر",
};

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function variantLabel(r: { variantName: string | null; color: string | null; size: string | null; sku: string }): string {
  const parts = [r.variantName, r.color, r.size].filter(Boolean);
  return parts.length ? parts.join(" / ") : r.sku;
}

export default function Inventory() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const canPickBranch = role === "admin" || role === "manager";
  const canAdjust = role === "admin" || role === "manager" || role === "warehouse";
  // التسوية المضمّنة سطر-بسطر للمدير فقط — المسار المعتمد للجميع صار جلسة جرد موثّقة.
  const canInlineAdjust = role === "admin" || role === "manager";
  const myBranch = me.data?.branchId ?? 1;

  const branches = trpc.branches.list.useQuery(undefined, { enabled: canPickBranch });
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const branchId = canPickBranch ? pickedBranch ?? myBranch : myBranch;

  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [err, setErr] = useState("");

  const onHand = trpc.inventory.onHand.useQuery(
    { branchId, q: q.trim() || undefined, lowOnly },
    { enabled: me.data != null },
  );
  const movements = trpc.inventory.movements.useQuery(
    { branchId, limit: 100 },
    { enabled: me.data != null },
  );

  // تسوية مضمّنة (سطر واحد في كل مرة)
  const [editing, setEditing] = useState<number | null>(null);
  const [target, setTarget] = useState("");
  const [notes, setNotes] = useState("");

  const adjust = trpc.inventory.adjust.useMutation({
    onSuccess: async () => {
      setEditing(null);
      setTarget("");
      setNotes("");
      await Promise.all([utils.inventory.onHand.invalidate(), utils.inventory.movements.invalidate()]);
    },
    onError: (e) => setErr(e.message),
  });

  function startAdjust(r: { variantId: number; quantity: number }) {
    setErr("");
    setEditing(r.variantId);
    setTarget(String(r.quantity));
    setNotes("");
  }
  async function saveAdjust(variantId: number) {
    setErr("");
    const t = Number(target);
    if (!Number.isInteger(t) || t < 0) {
      setErr("الرصيد المستهدف يجب أن يكون عدداً صحيحاً غير سالب.");
      return;
    }
    if (
      !(await confirm({
        variant: "danger",
        title: "تأكيد تسوية الرصيد",
        description: `تعديل الرصيد إلى ${t.toLocaleString("ar-IQ-u-nu-latn")} تغيير مالي مباشر بلا رجوع. متابعة؟`,
        confirmText: "تعديل",
      }))
    )
      return;
    adjust.mutate({ variantId, branchId, targetQuantity: t, notes: notes.trim() || undefined });
  }

  const rows = onHand.data ?? [];
  const lowCount = rows.filter((r) => r.isLow).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="المخزون"
        description="الأرصدة الحالية لكل منتج مع تسوية يدوية (جرد/تلف/تصحيح) تُسجَّل كحركة تدقيق، وسجلّ آخر الحركات."
        actions={
          lowCount > 0 ? (
            <span className="badge-stock-low rounded-full px-3 py-1 text-xs">
              {fmtInt(lowCount)} منتج تحت الحد الأدنى
            </span>
          ) : undefined
        }
      />

      <Card>
        <CardHeader><CardTitle className="text-base">الفلاتر</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          {canPickBranch && (
            <div className="space-y-1">
              <Label>الفرع</Label>
              <select
                className={selectCls}
                value={branchId}
                onChange={(e) => setPickedBranch(Number(e.target.value))}
              >
                {(branches.data ?? []).map((b) => (
                  <option key={Number(b.id)} value={Number(b.id)}>{b.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1">
            <Label>بحث (اسم/SKU/متغيّر)</Label>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="مثال: ورق A4" />
          </div>
          <label className="flex items-center gap-2 h-9 text-sm">
            <input type="checkbox" className="size-4" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
            <span className="text-muted-foreground">تحت الحد الأدنى فقط</span>
          </label>
        </CardContent>
      </Card>

      {err && <p className="text-sm text-destructive">{err}</p>}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">الأرصدة الحالية</CardTitle>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {onHand.isLoading ? "جارٍ التحميل…" : `${fmtInt(rows.length)} منتج`}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length === 0}
              onClick={() =>
                exportRows(rows, {
                  filename: "المخزون",
                  columns: [
                    { key: "productName", header: "المنتج" },
                    { key: "sku", header: "المتغيّر / SKU", map: (r) => variantLabel(r) + " (" + r.sku + ")" },
                    { key: "quantity", header: "الرصيد", map: (r) => r.quantity },
                    { key: "minStock", header: "الحد الأدنى", map: (r) => r.minStock ?? 0 },
                    { key: "isLow", header: "الحالة", map: (r) => (r.isLow ? "منخفض" : "متوفّر") },
                  ],
                })
              }
            >
              تصدير Excel
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 text-start">المنتج</th>
                <th className="p-2 text-start">المتغيّر / SKU</th>
                <th className="p-2 text-center">الرصيد</th>
                <th className="p-2 text-center">الحد الأدنى</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">آخر جرد</th>
                {/* العمود لكل الأدوار الآن (تحويل/حركات روابط قراءة)، والتسوية تبقى لمن يملكها */}
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isEditing = editing === r.variantId;
                return (
                  <tr key={r.variantId} className={`border-t ${r.isLow ? "bg-amber-50/50" : ""}`}>
                    <td className="p-2 font-medium">{r.productName}</td>
                    <td className="p-2 text-xs">
                      {variantLabel(r)} <span className="text-muted-foreground font-mono" dir="ltr">({r.sku})</span>
                    </td>
                    <td className="p-2 text-center tabular-nums font-semibold">
                      {isEditing ? (
                        <Input
                          dir="ltr"
                          value={target}
                          onChange={(e) => setTarget(e.target.value)}
                          className="h-8 w-24 mx-auto text-center"
                          autoFocus
                        />
                      ) : (
                        fmtInt(r.quantity)
                      )}
                    </td>
                    <td className="p-2 text-center tabular-nums text-muted-foreground">{fmtInt(r.minStock ?? 0)}</td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${r.isLow ? "badge-stock-low" : "badge-status-active"}`}>
                        {r.isLow ? "منخفض" : "متوفّر"}
                      </span>
                    </td>
                    <td className="p-2 text-center text-xs text-muted-foreground" title="آخر جرد معتمد شمل هذا المنتج">
                      {r.lastCountedAt ? fmtDate(r.lastCountedAt) : "لم يُجرَد"}
                    </td>
                    <td className="p-2 text-center">
                      {canInlineAdjust && isEditing ? (
                        <div className="flex flex-col gap-1 items-stretch min-w-[180px]">
                          <Input
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="سبب التسوية (جرد/تلف…)"
                            className="h-8 text-xs"
                          />
                          <div className="flex gap-1 justify-center">
                            <Button size="sm" onClick={() => saveAdjust(r.variantId)} disabled={adjust.isPending}>
                              {adjust.isPending ? "…" : "حفظ"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={adjust.isPending}>
                              إلغاء
                            </Button>
                          </div>
                        </div>
                      ) : (
                        // menu صريح: عدد الإجراءات الظاهرة يتفاوت بالدور — نثبّت ⋯ لاتساق الصفوف
                        <RowActions
                          mode="menu"
                          actions={[
                            {
                              key: "stocktake",
                              label: "جلسة جرد للمنتج",
                              hidden: !canAdjust,
                              href: `/stocktakes/new?variants=${r.variantId}&name=${encodeURIComponent(`جرد تحقّق — ${r.productName}`)}`,
                            },
                            {
                              key: "adjust",
                              label: "تسوية مباشرة (مدير)",
                              hidden: !canInlineAdjust,
                              onSelect: () => startAdjust(r),
                            },
                            { key: "transfer", label: "تحويل بين الفروع", href: "/transfers" },
                            {
                              key: "moves",
                              label: "حركات المنتج",
                              // شاشة الحركات تقرأ ?q= من URL فتفتح مفلترة على SKU
                              href: `/inventory-movements?q=${encodeURIComponent(r.sku)}`,
                            },
                          ]}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
              {!onHand.isLoading && rows.length === 0 && (
                <TableEmptyRow colSpan={7} message="لا منتجات برصيد في هذا الفرع. أضف رصيداً افتتاحياً أو سجّل استلام شراء." />
              )}
            </tbody>
          </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">آخر الحركات</CardTitle></CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 text-start">التاريخ</th>
                <th className="p-2 text-start">المتغيّر</th>
                <th className="p-2 text-start">النوع</th>
                <th className="p-2 text-center">الكمية (أساس)</th>
                <th className="p-2 text-start">المرجع</th>
              </tr>
            </thead>
            <tbody>
              {(movements.data ?? []).map((m) => (
                <tr key={m.id} className="border-t">
                  <td className="p-2 text-xs">{fmtDateTime(m.createdAt)}</td>
                  <td className="p-2 font-mono text-xs" dir="ltr">#{m.variantId}</td>
                  <td className="p-2 text-xs">{MTYPE[m.movementType] ?? m.movementType}</td>
                  <td className="p-2 text-center tabular-nums">{fmtInt(m.quantity)}</td>
                  <td className="p-2 text-muted-foreground text-xs">{m.referenceType ?? "—"}{m.referenceId ? ` #${m.referenceId}` : ""}</td>
                </tr>
              ))}
              {movements.data && movements.data.length === 0 && (
                <TableEmptyRow colSpan={5} message="لا حركات مخزون بعد." />
              )}
            </tbody>
          </table>
          </ScrollTableShell>
        </CardContent>
      </Card>
    </div>
  );
}
