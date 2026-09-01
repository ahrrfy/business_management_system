// تنبيهات إعادة الطلب — إنذار نفاد مبكّر للقرطاسية (بند 7 من خارطة المالك).
// جدول (متغيّر × فرع) رصيده ≤ حدّ إعادة الطلب، مرتّب بالأشدّ نقصاً، مع:
// - تحرير مباشر للعتبتين (الحد الأدنى/حدّ الطلب) لكل صف — المدير/المخزن.
// - تحديد صفوف ثم «إنشاء مسوّدة أمر شراء» بحوار اختيار المورّد وكميات مقترحة قابلة للتعديل.
import { PageHeader } from "@/components/PageHeader";
import { AppSelect } from "@/components/ui/AppSelect";
import { TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { FileEdit, ShoppingCart } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { selectClsFull } from "@/lib/ui/formStyles";


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

  // بحث محلي (اسم/متغيّر/SKU) داخل الصفحة المحمَّلة — ترقيمٌ خادميّ (limit/offset) يمنع اقتطاع
  // ٢٠٠ الصامت السابق: طابور أكبر أصبح ظاهراً بلافتة «تحميل المزيد» بدل جدولٍ يبدو مكتملاً.
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 200;
  const alerts = trpc.inventory.reorderAlerts.useQuery(
    { branchId: branchId ?? undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    { enabled: me.data != null },
  );
  const loadedRows = alerts.data?.rows ?? [];
  const total = alerts.data?.total ?? 0;
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return loadedRows;
    return loadedRows.filter(
      (r) =>
        r.productName.toLowerCase().includes(s) ||
        variantLabel(r).toLowerCase().includes(s) ||
        r.sku.toLowerCase().includes(s),
    );
  }, [loadedRows, search]);

  // ── تحرير العتبتين المباشر (لكل صف) ─────────────────────────────────────
  // النطاق: "variant" ⇒ يُحدّث الافتراض العامّ للمتغيّر (يمسّ كل الفروع).
  //         "branch"  ⇒ يُضيف/يُحدّث override لهذا (المتغيّر × الفرع) وحده (P1-#4).
  const [editing, setEditing] = useState<string | null>(null);
  const [minVal, setMinVal] = useState("");
  const [reorderVal, setReorderVal] = useState("");
  const [scope, setScope] = useState<"variant" | "branch">("branch");
  const setThresholds = trpc.inventory.setReorderThresholds.useMutation({
    onSuccess: async () => {
      setEditing(null);
      notify.ok("حُدِّثت عتبتا إعادة الطلب — الافتراض العامّ");
      await utils.inventory.reorderAlerts.invalidate();
      await utils.inventory.listBranchThresholds.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const setBranchOverride = trpc.inventory.setBranchThresholds.useMutation({
    onSuccess: async () => {
      setEditing(null);
      notify.ok("حُدِّثت عتبات الفرع (override)");
      await utils.inventory.reorderAlerts.invalidate();
      await utils.inventory.listBranchThresholds.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const clearBranchOverride = trpc.inventory.clearBranchThresholds.useMutation({
    onSuccess: async () => {
      setEditing(null);
      notify.ok("استُعيد الافتراض العامّ لهذا الفرع");
      await utils.inventory.reorderAlerts.invalidate();
      await utils.inventory.listBranchThresholds.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  // عدّاد overrides المخصّصة لعرضه في رأس البطاقة — يفتحه listBranchThresholds لتوصيل الإجراء
  // بالواجهة (DoD §٤: إجراءٌ خادميٌّ بلا مستهلك = وهمُ اكتمال).
  const overridesList = trpc.inventory.listBranchThresholds.useQuery(
    { branchId: branchId ?? undefined },
    { enabled: canWrite && me.data != null },
  );
  const overridesCount = overridesList.data?.length ?? 0;

  function startEdit(r: { variantId: number; branchId: number; minStock: number; reorderPoint: number; overrideActive: boolean }) {
    setEditing(rowKey(r));
    setMinVal(String(r.minStock));
    setReorderVal(String(r.reorderPoint));
    // إن كان الصفّ يحمل override افتراضياً نبدأ على «هذا الفرع» — للحفاظ على المعنى الظاهر للقيمة.
    setScope(r.overrideActive ? "branch" : "branch");
  }
  function saveEdit(variantId: number, branchIdOfRow: number) {
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
    if (scope === "variant") {
      setThresholds.mutate({ variantId, minStock, reorderPoint });
    } else {
      setBranchOverride.mutate({ variantId, branchId: branchIdOfRow, minStock, reorderPoint });
    }
  }
  function restoreDefault(variantId: number, branchIdOfRow: number) {
    clearBranchOverride.mutate({ variantId, branchId: branchIdOfRow });
  }
  const editSaving = setThresholds.isPending || setBranchOverride.isPending || clearBranchOverride.isPending;

  // ── تحديد الصفوف + حوار المسوّدة ─────────────────────────────────────────
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
      notify.err("اختر منتجاً واحداً على الأقل من الجدول");
      return;
    }
    if (selectedBranchIds.size > 1) {
      notify.err("أمر الشراء لفرع واحد — اختر منتجات من نفس الفرع");
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
        res.poNumber ? `أُنشئت مسوّدة أمر الشراء ${res.poNumber}` : "أُنشئت مسوّدة أمر الشراء",
        "تجدها في شاشة المشتريات بحالة «مسوّدة»",
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
        notify.err(`كمية غير صالحة للمنتج «${r.productName}» — عدد صحيح موجب`);
        return;
      }
      lines.push({ variantId: r.variantId, quantity: q });
    }
    createDraft.mutate({ supplierId, branchId: draftBranch, lines });
  }

  // ── تصدير قائمة إعادة الطلب إلى Excel ───────────────────────────────────
  function doExport() {
    if (rows.length === 0) {
      notify.err("لا بيانات للتصدير");
      return;
    }
    exportRows(rows, {
      filename: "إعادة-الطلب",
      title: "المنتجات الواجب إعادة طلبها",
      columns: [
        { key: "productName", header: "المنتج" },
        { key: "variant", header: "المتغيّر / SKU", map: (r) => `${variantLabel(r)} (${r.sku})` },
        { key: "branchName", header: "الفرع" },
        { key: "quantity", header: "الرصيد", map: (r) => r.quantity },
        { key: "minStock", header: "الحد الأدنى", map: (r) => r.minStock },
        { key: "reorderPoint", header: "حدّ إعادة الطلب", map: (r) => r.reorderPoint },
        { key: "suggestedQty", header: "الكمية المقترحة", map: (r) => r.suggestedQty },
      ],
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="تنبيهات إعادة الطلب"
        description="المنتجات التي بلغ رصيدها حدّ إعادة الطلب — الأشدّ نقصاً أولاً. حدّد المنتجات وأنشئ مسوّدة أمر شراء بنقرة."
        actions={
          canWrite ? (
            <Button onClick={openDraftDialog} disabled={selectedRows.length === 0}>
              <ShoppingCart aria-hidden className="size-4" />
              إنشاء مسوّدة أمر شراء{selectedRows.length > 0 ? ` (${fmtInt(selectedRows.length)})` : ""}
            </Button>
          ) : undefined
        }
      />

      {createdPo && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm flex items-center justify-between gap-3">
          <span>
            أُنشئت مسوّدة أمر الشراء{createdPo.poNumber ? <b className="font-mono mx-1" dir="ltr">{createdPo.poNumber}</b> : null} بنجاح.
          </span>
          <Link href="/purchases" className="text-primary underline underline-offset-4 whitespace-nowrap">
            فتح شاشة المشتريات
          </Link>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">الفلاتر</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          {canPickBranch && (
            <div className="space-y-1">
              <Label>الفرع</Label>
              <AppSelect
                className="h-9"
                value={String(branchId ?? "")}
                onValueChange={(next) => { setPickedBranch(next === "" ? null : Number(next)); setPage(0); }}
              >
                {isAdmin && <option value="">كل الفروع</option>}
                {(branches.data ?? []).map((b) => (
                  <option key={Number(b.id)} value={Number(b.id)}>{b.name}</option>
                ))}
              </AppSelect>
            </div>
          )}
          <div className="space-y-1">
            <Label>بحث (اسم/متغيّر/SKU) — في الصفحة المحمَّلة</Label>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="مثال: ورق A4" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">المنتجات الواجب إعادة طلبها</CardTitle>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {alerts.isLoading ? "جارٍ التحميل…" : `${fmtInt(rows.length)} من ${fmtInt(total)} صنف`}
            </span>
            {canWrite && overridesCount > 0 && (
              <span
                className="text-xs rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-primary"
                title="عتبات مخصّصة لهذا الفرع (override) — تسود على الافتراض العام"
              >
                overrides: {fmtInt(overridesCount)}
              </span>
            )}
            {total > PAGE_SIZE && (
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" disabled={page === 0 || alerts.isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))}>السابق →</Button>
                <span className="text-xs text-muted-foreground">صفحة {fmtInt(page + 1)} من {fmtInt(Math.max(1, Math.ceil(total / PAGE_SIZE)))}</span>
                <Button variant="outline" size="sm" disabled={(page + 1) * PAGE_SIZE >= total || alerts.isFetching} onClick={() => setPage((p) => p + 1)}>← التالي</Button>
              </div>
            )}
            <Button variant="outline" size="sm" disabled={rows.length === 0} onClick={doExport}>
              تصدير Excel
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <Table>
              <TableHeader>
                <TableRow>
                  {canWrite && (
                    <TableHead className="text-center w-10">
                      <input
                        type="checkbox"
                        className="size-4 align-middle"
                        aria-label="تحديد الكل"
                        checked={rows.length > 0 && selected.size === rows.length}
                        onChange={toggleAll}
                      />
                    </TableHead>
                  )}
                  <TableHead className="text-start">المنتج</TableHead>
                  <TableHead className="text-start">المتغيّر / SKU</TableHead>
                  <TableHead className="text-start">الفرع</TableHead>
                  <TableHead className="text-left">الرصيد</TableHead>
                  <TableHead className="text-left">الحد الأدنى</TableHead>
                  <TableHead className="text-left">حدّ إعادة الطلب</TableHead>
                  <TableHead className="text-left">الكمية المقترحة</TableHead>
                  {canWrite && <TableHead className="text-center">العتبتان</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const key = rowKey(r);
                  const isEditing = editing === key;
                  const severe = r.quantity <= r.minStock;
                  return (
                    <TableRow key={key} className={severe ? "bg-destructive/5" : "bg-[var(--sem-warn-bg)]/50"}>
                      {canWrite && (
                        <TableCell className="text-center">
                          <input
                            type="checkbox"
                            className="size-4 align-middle"
                            aria-label={`تحديد ${r.productName}`}
                            checked={selected.has(key)}
                            onChange={() => toggle(key)}
                          />
                        </TableCell>
                      )}
                      <TableCell className="font-medium">{r.productName}</TableCell>
                      <TableCell className="text-xs">
                        {variantLabel(r)} <span className="text-muted-foreground font-mono" dir="ltr">({r.sku})</span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.branchName}
                        {r.overrideActive && (
                          <span
                            className="mx-1 text-[10px] rounded border border-primary/40 bg-primary/10 px-1 py-0.5 text-primary"
                            title="عتبتان مخصّصتان لهذا الفرع — تسودان على الافتراض العام"
                          >
                            مخصّص
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-left tabular-nums font-semibold">{fmtInt(r.quantity)}</TableCell>
                      <TableCell className="text-left tabular-nums">
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
                      </TableCell>
                      <TableCell className="text-left tabular-nums">
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
                      </TableCell>
                      <TableCell className="text-left tabular-nums font-semibold text-primary">{fmtInt(r.suggestedQty)}</TableCell>
                      {canWrite && (
                        <TableCell className="text-center">
                          {isEditing ? (
                            <div className="flex flex-col items-center gap-1">
                              <div className="flex items-center gap-1 text-[11px]">
                                <label className={`px-2 py-0.5 rounded border cursor-pointer ${scope === "branch" ? "bg-primary/10 border-primary text-primary" : "border-input"}`}>
                                  <input
                                    type="radio"
                                    name={`scope-${key}`}
                                    className="hidden"
                                    checked={scope === "branch"}
                                    onChange={() => setScope("branch")}
                                  />
                                  هذا الفرع
                                </label>
                                <label className={`px-2 py-0.5 rounded border cursor-pointer ${scope === "variant" ? "bg-primary/10 border-primary text-primary" : "border-input"}`}>
                                  <input
                                    type="radio"
                                    name={`scope-${key}`}
                                    className="hidden"
                                    checked={scope === "variant"}
                                    onChange={() => setScope("variant")}
                                  />
                                  الافتراض العام
                                </label>
                              </div>
                              <div className="flex gap-1 justify-center">
                                <Button size="sm" onClick={() => saveEdit(r.variantId, r.branchId)} disabled={editSaving}>
                                  {editSaving ? "…" : "حفظ"}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={editSaving}>
                                  إلغاء
                                </Button>
                              </div>
                              {r.overrideActive && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-xs text-muted-foreground"
                                  onClick={() => restoreDefault(r.variantId, r.branchId)}
                                  disabled={editSaving}
                                  title="مسح الـoverrides لهذا الفرع — يعود إلى الافتراض العام"
                                >
                                  استعادة الافتراض
                                </Button>
                              )}
                            </div>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => startEdit(r)}>
                              <FileEdit aria-hidden className="size-3.5" />
                              تعديل
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
                {!alerts.isLoading && rows.length === 0 && (
                  <TableEmptyRow
                    colSpan={canWrite ? 9 : 7}
                    message="لا منتجات بلغت حدّ إعادة الطلب. اضبط «حدّ إعادة الطلب» من شاشة المنتج (أو من هنا) لتفعيل الإنذار المبكّر."
                  />
                )}
              </TableBody>
            </Table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {canWrite && (
        <BranchOverridesPanel
          branchId={branchId}
          overrides={overridesList.data ?? []}
          isLoading={overridesList.isLoading}
          onEdit={(o) => {
            // نُعِيد استعمال setBranchOverride/clearBranchOverride مباشرةً — لا يُشترط أن يكون الصفّ
            // موجوداً في alerts (يعالج ملاحظة Codex P2: override يُخرج الصفّ من alerts فيختفي الزرّ).
          }}
          onSave={(o, min, reorder) => setBranchOverride.mutate({ variantId: o.variantId, branchId: o.branchId, minStock: min, reorderPoint: reorder })}
          onClear={(o) => clearBranchOverride.mutate({ variantId: o.variantId, branchId: o.branchId })}
          onAddNew={(variantId, branchIdNew, min, reorder) =>
            setBranchOverride.mutate({ variantId, branchId: branchIdNew, minStock: min, reorderPoint: reorder })
          }
          saving={editSaving}
        />
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>مسوّدة أمر شراء — {fmtInt(selectedRows.length)} صنف</DialogTitle>
            <DialogDescription>
              اختر المورّد وعدّل الكميات المقترحة عند الحاجة. تُنشأ بحالة «مسوّدة» وتُستكمل من شاشة المشتريات.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label>المورّد</Label>
              <AppSelect
                className="h-9"
                value={String(supplierId ?? "")}
                onValueChange={(next) => setSupplierId(next === "" ? null : Number(next))}
              >
                <option value="">— اختر المورّد —</option>
                {(supplierList.data ?? []).map((s) => (
                  <option key={Number(s.id)} value={Number(s.id)}>{s.name}</option>
                ))}
              </AppSelect>
            </div>

            <ScrollTableShell>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-start">المنتج</TableHead>
                    <TableHead className="text-left">الرصيد</TableHead>
                    <TableHead className="text-left">الكمية المطلوبة (أساس)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedRows.map((r) => {
                    const key = rowKey(r);
                    return (
                      <TableRow key={key}>
                        <TableCell>
                          {r.productName} <span className="text-xs text-muted-foreground">({variantLabel(r)})</span>
                        </TableCell>
                        <TableCell className="text-left tabular-nums">{fmtInt(r.quantity)}</TableCell>
                        <TableCell className="text-left">
                          <Input
                            dir="ltr"
                            inputMode="numeric"
                            value={qtys[key] ?? ""}
                            onChange={(e) => setQtys((prev) => ({ ...prev, [key]: e.target.value.replace(/[^\d]/g, "") }))}
                            className="h-8 w-24 text-center"
                            aria-label={`كمية ${r.productName}`}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </ScrollTableShell>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={createDraft.isPending}>
              إلغاء
            </Button>
            <Button onClick={submitDraft} disabled={createDraft.isPending || supplierId == null}>
              {createDraft.isPending ? "جارٍ الإنشاء…" : "إنشاء المسوّدة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ==================== لوحة إدارة overrides العتبات الفرعيّة ==================== */

type OverrideRow = {
  variantId: number;
  branchId: number;
  branchName: string;
  productName: string;
  sku: string;
  variantName: string | null;
  minStock: number | null;
  reorderPoint: number | null;
  defaultMinStock: number | null;
  defaultReorderPoint: number | null;
};

/**
 * لوحةٌ منفصلة عن جدول التنبيهات — تعرض كلّ overrides المخصّصة (بما فيها الصفوف التي لا تظهر في
 * alerts لأنّ رصيدها فوق العتبة). ملاحظةُ مراجعة Codex P2 (٢٥/٨): زرّ «استعادة الافتراض» كان يعيش
 * داخل صفّ التنبيه، فإذا حفظت override يُخرج الصفّ من alerts ⇒ يختفي الزرّ نفسه. هذه اللوحة تحلّه.
 *
 * وتحلّ الفجوة الثانية: variant بـ`reorderPoint = 0` (الافتراض الشائع) لا يظهر في alerts أبداً
 * ⇒ لا يمكن إسناد أوّل override له من الشاشة القديمة. زرّ «أضف override» يفتح حواراً بـSKU/فرع/قيم.
 */
function BranchOverridesPanel(props: {
  branchId: number | null;
  overrides: OverrideRow[];
  isLoading: boolean;
  onEdit: (o: OverrideRow) => void;
  onSave: (o: OverrideRow, min: number | null, reorder: number | null) => void;
  onClear: (o: OverrideRow) => void;
  onAddNew: (variantId: number, branchId: number, min: number | null, reorder: number | null) => void;
  saving: boolean;
}) {
  const [openPanel, setOpenPanel] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editMin, setEditMin] = useState("");
  const [editReorder, setEditReorder] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addSku, setAddSku] = useState("");
  const [addBranchId, setAddBranchId] = useState<number | null>(props.branchId);
  const [addMin, setAddMin] = useState("");
  const [addReorder, setAddReorder] = useState("");
  const branches = trpc.branches.list.useQuery();
  // بحث المتغيّر بـSKU/اسم عبر inventory.onHand (مقيَّدٌ بالفرع كي يعكس التوفّر الحاليّ).
  const skuLookup = trpc.inventory.onHand.useQuery(
    { branchId: addBranchId ?? 0, q: addSku.trim() || undefined, limit: 20 },
    { enabled: addOpen && addBranchId != null && addSku.trim().length >= 2 },
  );

  function keyOf(o: OverrideRow) { return `${o.variantId}:${o.branchId}`; }

  function startInlineEdit(o: OverrideRow) {
    setEditingKey(keyOf(o));
    setEditMin(o.minStock == null ? "" : String(o.minStock));
    setEditReorder(o.reorderPoint == null ? "" : String(o.reorderPoint));
    props.onEdit(o);
  }
  function saveInline(o: OverrideRow) {
    const min = editMin.trim() === "" ? null : Number(editMin);
    const reorder = editReorder.trim() === "" ? null : Number(editReorder);
    if (min != null && (!Number.isInteger(min) || min < 0)) return notify.err("الحد الأدنى يجب أن يكون عدداً صحيحاً غير سالب");
    if (reorder != null && (!Number.isInteger(reorder) || reorder < 0)) return notify.err("حدّ إعادة الطلب يجب أن يكون عدداً صحيحاً غير سالب");
    props.onSave(o, min, reorder);
    setEditingKey(null);
  }
  function submitAddNew() {
    if (addBranchId == null) return notify.err("اختر الفرع أوّلاً");
    // نبحث عن المتغيّر بمطابقة SKU حرفياً في نتائج البحث.
    const match = (skuLookup.data ?? []).find((r: { sku: string }) => r.sku === addSku.trim());
    if (!match) return notify.err(`لا متغيّر بـSKU يطابق «${addSku.trim()}» في هذا الفرع — تحقّق من SKU أو ابحث بالاسم`);
    const min = addMin.trim() === "" ? null : Number(addMin);
    const reorder = addReorder.trim() === "" ? null : Number(addReorder);
    if (min == null && reorder == null) return notify.err("أدخل قيمةً واحدةً على الأقل (وإلّا لا override يُنشأ)");
    props.onAddNew(match.variantId, addBranchId, min, reorder);
    setAddOpen(false);
    setAddSku("");
    setAddMin("");
    setAddReorder("");
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="text-base">overrides العتبات الفرعيّة ({fmtInt(props.overrides.length)})</CardTitle>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>أضف override جديد</Button>
          <Button size="sm" variant="ghost" onClick={() => setOpenPanel((v) => !v)}>
            {openPanel ? "إخفاء" : "إظهار"}
          </Button>
        </div>
      </CardHeader>
      {openPanel && (
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-start">المنتج</TableHead>
                  <TableHead className="text-start">المتغيّر / SKU</TableHead>
                  <TableHead className="text-start">الفرع</TableHead>
                  <TableHead className="text-left">الحدّ الأدنى (override / افتراض)</TableHead>
                  <TableHead className="text-left">حدّ إعادة الطلب (override / افتراض)</TableHead>
                  <TableHead className="text-center">إجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {props.overrides.map((o) => {
                  const key = keyOf(o);
                  const isEditing = editingKey === key;
                  return (
                    <TableRow key={key}>
                      <TableCell className="font-medium">{o.productName}</TableCell>
                      <TableCell className="text-xs">
                        {o.variantName ?? "—"} <span className="text-muted-foreground font-mono" dir="ltr">({o.sku})</span>
                      </TableCell>
                      <TableCell className="text-xs">{o.branchName}</TableCell>
                      <TableCell className="text-left tabular-nums">
                        {isEditing ? (
                          <Input dir="ltr" inputMode="numeric" value={editMin}
                            onChange={(e) => setEditMin(e.target.value.replace(/[^\d]/g, ""))}
                            placeholder={o.defaultMinStock == null ? "افتراض" : String(o.defaultMinStock)}
                            className="h-8 w-20 text-center" aria-label="override للحد الأدنى" />
                        ) : (
                          <>
                            <b>{o.minStock == null ? "—" : fmtInt(o.minStock)}</b>
                            <span className="text-muted-foreground text-xs mx-1">/ {o.defaultMinStock == null ? "—" : fmtInt(o.defaultMinStock)}</span>
                          </>
                        )}
                      </TableCell>
                      <TableCell className="text-left tabular-nums">
                        {isEditing ? (
                          <Input dir="ltr" inputMode="numeric" value={editReorder}
                            onChange={(e) => setEditReorder(e.target.value.replace(/[^\d]/g, ""))}
                            placeholder={o.defaultReorderPoint == null ? "افتراض" : String(o.defaultReorderPoint)}
                            className="h-8 w-20 text-center" aria-label="override لحدّ إعادة الطلب" />
                        ) : (
                          <>
                            <b>{o.reorderPoint == null ? "—" : fmtInt(o.reorderPoint)}</b>
                            <span className="text-muted-foreground text-xs mx-1">/ {o.defaultReorderPoint == null ? "—" : fmtInt(o.defaultReorderPoint)}</span>
                          </>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {isEditing ? (
                          <div className="flex gap-1 justify-center">
                            <Button size="sm" onClick={() => saveInline(o)} disabled={props.saving}>حفظ</Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditingKey(null)} disabled={props.saving}>إلغاء</Button>
                          </div>
                        ) : (
                          <div className="flex gap-1 justify-center">
                            <Button size="sm" variant="outline" onClick={() => startInlineEdit(o)}>تعديل</Button>
                            <Button size="sm" variant="ghost" onClick={() => props.onClear(o)} disabled={props.saving}>مسح</Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!props.isLoading && props.overrides.length === 0 && (
                  <TableEmptyRow colSpan={6} message="لا overrides مخصّصة — كلّ الفروع تستعمل الافتراض العام." />
                )}
              </TableBody>
            </Table>
          </ScrollTableShell>
        </CardContent>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>أضف override جديد لفرعٍ بعينه</DialogTitle>
            <DialogDescription>
              يعمل حتى لو كان المتغيّر لا يظهر في alerts (رصيدُه فوق الافتراض أو reorderPoint=0).
              حقلٌ واحدٌ على الأقلّ مطلوب؛ ما تتركه فارغاً يرث الافتراض العام.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>الفرع</Label>
              <AppSelect className="h-9 -input px-3 text-sm"
                value={String(addBranchId ?? "")}
                onValueChange={(next) => setAddBranchId(next === "" ? null : Number(next))}>
                <option value="">— اختر الفرع —</option>
                {(branches.data ?? []).map((b) => (
                  <option key={Number(b.id)} value={Number(b.id)}>{b.name}</option>
                ))}
              </AppSelect>
            </div>
            <div className="space-y-1">
              <Label>SKU المتغيّر (طابق حرفياً)</Label>
              <Input dir="ltr" value={addSku} onChange={(e) => setAddSku(e.target.value)} placeholder="PEN-1"
                aria-describedby="sku-help" />
              <p id="sku-help" className="text-xs text-muted-foreground">
                اكتب ≥ ٢ محارف لبدء البحث في الفرع المختار. النتائج المطابقة SKU حرفياً وحدها تُقبَل.
              </p>
              {addSku.trim().length >= 2 && (skuLookup.data ?? []).length > 0 && (
                <div className="text-xs text-muted-foreground mt-1">
                  {(skuLookup.data ?? []).slice(0, 5).map((r: { variantId: number; sku: string; productName: string }) => (
                    <div key={r.variantId} className="flex items-center justify-between">
                      <span className="font-mono" dir="ltr">{r.sku}</span>
                      <span>{r.productName}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>الحدّ الأدنى (اختياري)</Label>
                <Input dir="ltr" inputMode="numeric" value={addMin}
                  onChange={(e) => setAddMin(e.target.value.replace(/[^\d]/g, ""))} />
              </div>
              <div className="space-y-1">
                <Label>حدّ إعادة الطلب (اختياري)</Label>
                <Input dir="ltr" inputMode="numeric" value={addReorder}
                  onChange={(e) => setAddReorder(e.target.value.replace(/[^\d]/g, ""))} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)} disabled={props.saving}>إلغاء</Button>
            <Button onClick={submitAddNew} disabled={props.saving}>حفظ override</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
