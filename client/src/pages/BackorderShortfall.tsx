// «المُسنَد المطلوب توريده» — متابعة أصناف «يُباع بالطلب» (هجرة 0318) التي بيعت ولم تُورَّد.
//
// الشاشة تُجيب سؤالاً واحداً: **كم أطلب الآن؟** ولذلك لا تعرض الرصيد السالب وحده — تطرح منه ما
// هو قيد الشراء فعلاً وتُظهر «الصافي المطلوب»، ثمّ تُحوّله بزرٍّ واحد إلى مسوّدة أمر شراء عبر
// `createReorderDraft` القائم (نفس آلية تبويب «إعادة الطلب» — لا منطقَ جديداً يُعاد كتابته).
//
// وصفٌّ صافيه صفر يبقى معروضاً بشارة «مغطّى — بانتظار الاستلام»: إخفاؤه كان سيجعل المدير يظنّ
// الالتزام منتهياً بينما البضاعة لم تصل بعد.
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { exportRows } from "@/lib/export";
import { fmt, fmtInt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { Factory, PackagePlus, ShoppingCart, Truck } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "wouter";

/** مفتاح صف فريد: نفس المتغيّر قد يظهر لفرعين بعجزٍ مستقلّ في كلٍّ منهما. */
const rowKey = (r: { variantId: number; branchId: number }) => `${r.variantId}:${r.branchId}`;

function itemLabel(r: { productName: string; variantName: string | null }): string {
  return r.variantName ? `${r.productName} — ${r.variantName}` : r.productName;
}

/** «منذ متى والزبون ينتظر» — أوضح من تاريخٍ خامّ حين يكون الغرض قياسَ التأخّر. */
function daysSince(at: Date | string | null): number | null {
  if (!at) return null;
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

const PAGE_SIZE = 200;

export default function BackorderShortfall() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const isAdmin = role === "admin";
  const canPickBranch = isAdmin || role === "manager";
  const canDraft = isAdmin || role === "manager" || role === "warehouse";
  const myBranch = me.data?.branchId ?? null;

  const branches = trpc.branches.list.useQuery(undefined, { enabled: canPickBranch });
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const branchId = isAdmin ? pickedBranch : canPickBranch ? (pickedBranch ?? myBranch) : myBranch;

  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const q = trpc.inventory.backorderShortfall.useQuery(
    { branchId: branchId ?? undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    { enabled: me.data != null },
  );

  const loadedRows = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return loadedRows;
    return loadedRows.filter(
      (r) => itemLabel(r).toLowerCase().includes(s) || r.sku.toLowerCase().includes(s),
    );
  }, [loadedRows, search]);

  // ── تحديد الصفوف ثمّ مسوّدة أمر شراء (نفس مسار «إعادة الطلب») ─────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(rowKey(r))), [rows, selected]);
  const selectedBranchIds = useMemo(() => new Set(selectedRows.map((r) => r.branchId)), [selectedRows]);

  function toggle(k: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }
  // «الكلّ» يعني الصفوف التي **تحتاج طلباً فعلاً** — تحديدُ صفٍّ صافيه صفر يُنشئ سطراً بكمية صفر
  // يرفضه الخادم، فيبدو الزرّ معطوباً بينما هو يحرس نفسه.
  const needyRows = useMemo(() => rows.filter((r) => r.netNeededBase > 0), [rows]);
  function toggleAll() {
    setSelected((prev) =>
      prev.size === needyRows.length ? new Set() : new Set(needyRows.map(rowKey)),
    );
  }

  const [dialogOpen, setDialogOpen] = useState(false);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const suppliers = trpc.suppliers.list.useQuery(undefined, { enabled: dialogOpen });

  function openDraftDialog() {
    if (selectedRows.length === 0) {
      notify.err("اختر صنفاً واحداً على الأقل من الجدول");
      return;
    }
    if (selectedBranchIds.size > 1) {
      notify.err("أمر الشراء لفرع واحد", "اختر أصنافاً من نفس الفرع");
      return;
    }
    setQtys(Object.fromEntries(selectedRows.map((r) => [rowKey(r), String(Math.max(1, r.netNeededBase))])));
    setSupplierId(null);
    setDialogOpen(true);
  }

  const createDraft = trpc.inventory.createReorderDraft.useMutation({
    onSuccess: async (res) => {
      setDialogOpen(false);
      setSelected(new Set());
      notify.ok(
        res.poNumber ? `أُنشئت مسوّدة أمر الشراء ${res.poNumber}` : "أُنشئت مسوّدة أمر الشراء",
        "تجدها في شاشة المشتريات بحالة «مسوّدة» — استلامُها يرفع الرصيد ويُنهي العجز",
      );
      await utils.inventory.backorderShortfall.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  function submitDraft() {
    if (supplierId == null) {
      notify.err("اختر المورّد أولاً");
      return;
    }
    const lines: Array<{ variantId: number; quantity: number }> = [];
    for (const r of selectedRows) {
      const n = Number(qtys[rowKey(r)]);
      if (!Number.isInteger(n) || n <= 0) {
        notify.err(`كمية غير صالحة لـ«${itemLabel(r)}»`, "الكمية عدد صحيح أكبر من صفر");
        return;
      }
      lines.push({ variantId: r.variantId, quantity: n });
    }
    const targetBranch = selectedRows[0]?.branchId;
    if (targetBranch == null) return;
    createDraft.mutate({ supplierId, branchId: targetBranch, lines });
  }

  const showCost = loadedRows.some((r) => r.costPrice != null);
  // عددُ الأعمدة يتغيّر بالدور والصلاحية؛ colSpan ثابت يترك صفَّ «لا نتائج» مقصوصاً أو ممتدّاً.
  const colCount = 6 + (canDraft ? 1 : 0) + (showCost ? 1 : 0);
  const totalNet = q.data?.totalNetNeededBase ?? 0;
  const totalValue = q.data?.totalShortfallValue ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="المُسنَد المطلوب توريده"
        description="أصناف «يُباع بالطلب» بيعت للزبائن ولم تُورَّد بعد — يُغلقها شراءٌ من مورّد أو إنتاجٌ داخليّ."
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <PackagePlus aria-hidden className="size-5 text-[var(--sem-warn)]" />
            <div>
              <div className="text-xs text-muted-foreground">أصناف بعجز</div>
              <div className="text-xl font-extrabold tabular-nums" dir="ltr">{fmtInt(total)}</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <ShoppingCart aria-hidden className="size-5 text-[var(--sem-warn)]" />
            <div>
              <div className="text-xs text-muted-foreground">الصافي المطلوب طلبه</div>
              <div className="text-xl font-extrabold tabular-nums" dir="ltr">{fmtInt(totalNet)}</div>
            </div>
          </CardContent>
        </Card>
        {showCost && (
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <Truck aria-hidden className="size-5 text-muted-foreground" />
              <div>
                <div className="text-xs text-muted-foreground">قيمة العجز بالتكلفة</div>
                <div className="text-xl font-extrabold tabular-nums" dir="ltr">
                  {fmt(Number(totalValue ?? 0))} د.ع
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base">قائمة العجز</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {canPickBranch && (
              <AppSelect
                value={branchId == null ? "" : String(branchId)}
                onValueChange={(v) => {
                  setPickedBranch(v === "" ? null : Number(v));
                  setPage(0);
                  setSelected(new Set());
                }}
                className="h-9 w-44"
              >
                {isAdmin && <option value="">كل الفروع</option>}
                {(branches.data ?? []).map((b) => (
                  <option key={Number(b.id)} value={String(Number(b.id))}>
                    {b.name}
                  </option>
                ))}
              </AppSelect>
            )}
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث بالاسم أو SKU…"
              className="h-9 w-52"
              dir="auto"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={rows.length === 0}
              onClick={() =>
                exportRows(rows, {
                  filename: "المسند-المطلوب-توريده",
                  title: "المُسنَد المطلوب توريده",
                  columns: [
                    { key: "productName", header: "الصنف", map: (r) => itemLabel(r) },
                    { key: "sku", header: "SKU" },
                    { key: "branchName", header: "الفرع" },
                    { key: "baseUnitName", header: "الوحدة" },
                    { key: "shortfallBase", header: "مُباع لم يُورَّد", map: (r) => r.shortfallBase },
                    { key: "onOrderBase", header: "قيد الشراء", map: (r) => r.onOrderBase },
                    { key: "netNeededBase", header: "الصافي المطلوب", map: (r) => r.netNeededBase },
                    // التكلفة تُحجب خادمياً لمن لا يراها ⇒ العمود يخرج فارغاً لا مكشوفاً.
                    { key: "shortfallValue", header: "قيمة العجز", map: (r) => r.shortfallValue ?? "" },
                  ],
                })
              }
            >
              تصدير
            </Button>
            {canDraft && (
              <Button type="button" size="sm" onClick={openDraftDialog} disabled={selected.size === 0}>
                <ShoppingCart aria-hidden className="size-4" />
                مسوّدة أمر شراء ({fmtInt(selected.size)})
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ScrollTableShell>
            <Table>
              <TableHeader>
                <TableRow>
                  {canDraft && (
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        aria-label="تحديد كل الصفوف المحتاجة"
                        checked={needyRows.length > 0 && selected.size === needyRows.length}
                        onChange={toggleAll}
                        disabled={needyRows.length === 0}
                      />
                    </TableHead>
                  )}
                  <TableHead>الصنف</TableHead>
                  <TableHead>الفرع</TableHead>
                  <TableHead className="text-center">مُباع لم يُورَّد</TableHead>
                  <TableHead className="text-center">قيد الشراء</TableHead>
                  <TableHead className="text-center">الصافي المطلوب</TableHead>
                  <TableHead className="text-center">منذ آخر بيع</TableHead>
                  {showCost && <TableHead className="text-center">قيمة العجز</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.isLoading && <TableEmptyRow colSpan={colCount} message={ACTION_LABELS.loading} />}
                {!q.isLoading && rows.length === 0 && (
                  <TableEmptyRow colSpan={colCount} message="لا شيء مطلوب توريده — كل الأصناف المُسنَدة مغطّاة." />
                )}
                {rows.map((r) => {
                  const k = rowKey(r);
                  const days = daysSince(r.lastSaleAt);
                  const covered = r.netNeededBase === 0;
                  return (
                    <TableRow key={k} className={covered ? "opacity-70" : undefined}>
                      {canDraft && (
                        <TableCell>
                          <input
                            type="checkbox"
                            aria-label={`تحديد ${itemLabel(r)}`}
                            checked={selected.has(k)}
                            onChange={() => toggle(k)}
                            disabled={covered}
                          />
                        </TableCell>
                      )}
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Link href={`/products/${r.productId}/edit`} className="font-bold hover:underline">
                            {itemLabel(r)}
                          </Link>
                          <span className="text-xs text-muted-foreground" dir="ltr">{r.sku}</span>
                          {r.canProduce && (
                            <Badge variant="secondary" className="gap-1">
                              <Factory aria-hidden className="size-3" />
                              يمكن إنتاجه
                            </Badge>
                          )}
                          {covered && (
                            <Badge variant="secondary" className="bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]">
                              مغطّى — بانتظار الاستلام
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{r.branchName}</TableCell>
                      <TableCell className="text-center font-bold tabular-nums text-destructive" dir="ltr">
                        {fmtInt(r.shortfallBase)}
                      </TableCell>
                      <TableCell className="text-center tabular-nums text-muted-foreground" dir="ltr">
                        {fmtInt(r.onOrderBase)}
                      </TableCell>
                      <TableCell
                        className={`text-center font-extrabold tabular-nums ${covered ? "text-[var(--sem-pos)]" : "text-[var(--sem-warn)]"}`}
                        dir="ltr"
                      >
                        {fmtInt(r.netNeededBase)}
                      </TableCell>
                      <TableCell className="text-center text-xs text-muted-foreground tabular-nums" dir="ltr">
                        {days == null ? "—" : `${fmtInt(days)} يوم`}
                      </TableCell>
                      {showCost && (
                        <TableCell className="text-center tabular-nums" dir="ltr">
                          {r.shortfallValue == null ? "—" : fmt(Number(r.shortfallValue))}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </ScrollTableShell>

          {total > loadedRows.length + page * PAGE_SIZE && (
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                معروض {fmtInt(loadedRows.length)} من {fmtInt(total)}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => setPage((p) => p + 1)}>
                تحميل المزيد
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>مسوّدة أمر شراء</DialogTitle>
            <DialogDescription>
              تُنشأ بحالة «مسوّدة» في شاشة المشتريات؛ استلامُها لاحقاً يرفع الرصيد ويُغلق العجز.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>المورّد</Label>
              <AppSelect
                value={supplierId == null ? "" : String(supplierId)}
                onValueChange={(v) => setSupplierId(v === "" ? null : Number(v))}
              >
                <option value="">— اختر المورّد —</option>
                {(suppliers.data ?? []).map((s: { id: number; name: string }) => (
                  <option key={Number(s.id)} value={String(Number(s.id))}>
                    {s.name}
                  </option>
                ))}
              </AppSelect>
            </div>
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {selectedRows.map((r) => (
                <div key={rowKey(r)} className="flex items-center gap-2 rounded-md border p-2">
                  <span className="flex-1 text-sm">{itemLabel(r)}</span>
                  <Input
                    value={qtys[rowKey(r)] ?? ""}
                    onChange={(e) =>
                      setQtys((prev) => ({ ...prev, [rowKey(r)]: e.target.value.replace(/[^\d]/g, "") }))
                    }
                    className="h-9 w-24 text-center"
                    dir="ltr"
                    aria-label={`كمية ${itemLabel(r)}`}
                  />
                  <span className="w-14 text-xs text-muted-foreground">{r.baseUnitName}</span>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              إلغاء
            </Button>
            <Button type="button" onClick={submitDraft} disabled={createDraft.isPending}>
              {createDraft.isPending ? ACTION_LABELS.saving : "إنشاء المسوّدة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
