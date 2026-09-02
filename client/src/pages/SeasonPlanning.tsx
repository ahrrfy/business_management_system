// تخطيط موسم المدارس (بند 7): جدول المنتجات الموسمية بمخزونها الكلّيّ عبر **كل الفروع** مقابل هدف الموسم
// + الفجوة (كمية الشراء المقترحة لتجهيز ذروة أيلول). تحرير الهدف مباشرةً، إضافة منتج موسميّ بالبحث،
// تصفية «تحت الهدف فقط»، وتصدير قائمة الشراء إلى Excel. محصورة بالمدير/المخزن (البوّابة خادمية).
import { ACTION_LABELS } from "@shared/actionLabels";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
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
import { FileEdit, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
  const allRows = plan.data ?? [];

  // بحث محلي (اسم منتج/SKU/متغيّر) — لا endpoint خادميّ جديد: صفوف الخطة أصلاً مُحمَّلة كاملةً
  // (limit=300 خادمياً، عدد الأصناف الموسمية محدود عملياً) فالفلترة محلياً كافية وفورية.
  // ⚠️ لا فلتر فئة: صفّ `seasonPlan` (server/services/inventory/seasonPlanning.ts، خارج ملكية هذه
  // الشريحة) لا يحمل categoryId/categoryName إطلاقاً — إضافته فعلياً تعديلٌ خادميّ حقيقي رغم
  // الوصف، فتُرك خارج هذه الجولة (راجع خلاصة الجلسة).
  const [planSearch, setPlanSearch] = useState("");
  const rows = useMemo(() => {
    const q = planSearch.trim().toLocaleLowerCase("ar");
    if (!q) return allRows;
    return allRows.filter((r) =>
      [r.productName, r.sku, r.variantName, r.color, r.size].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(q)),
    );
  }, [allRows, planSearch]);

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

  // ── إضافة منتج موسميّ (بحث + تعيين هدف) ──────────────────────────────────
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
      notify.ok("أُضيف المنتج لخطة الموسم");
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

  /** صفُّ الخطة — مشتقٌّ من عقد `inventory.seasonPlan` فلا ينجرف عن الخادم. */
  type PlanRow = (typeof allRows)[number];

  /* أعمدة الخطة — تُبنى داخل الرسم لأنّها تلتقط صفَّ التحرير الجاري (`editing`/`targetVal`)
     وحالة الطفرة. جدولُ عرضٍ لا شبكةُ تحرير: صفٌّ واحدٌ فقط يدخل وضع التحرير في كل لحظة،
     وبقيّة الصفوف قراءةٌ محضة. */
  const planColumns: ColumnDef<PlanRow, unknown>[] = [
    {
      id: "product",
      header: "المنتج",
      accessorFn: (r) => r.productName,
      meta: { width: "wide" },
      cell: ({ row }) => <span className="font-medium">{row.original.productName}</span>,
    },
    {
      id: "variant",
      header: "المتغيّر / SKU",
      accessorFn: (r) => `${variantLabel(r)} (${r.sku})`,
      meta: { width: "wide" },
      cell: ({ row }) => (
        <span className="text-xs">
          {variantLabel(row.original)}{" "}
          <span className="text-muted-foreground font-mono" dir="ltr">({row.original.sku})</span>
        </span>
      ),
    },
    {
      id: "totalStock",
      header: "المخزون الكلّيّ",
      accessorFn: (r) => fmtInt(r.totalStock),
      meta: { kind: "number" },
      cell: ({ row }) => <span className="font-semibold">{fmtInt(row.original.totalStock)}</span>,
    },
    {
      id: "seasonTarget",
      header: "هدف الموسم",
      accessorFn: (r) => fmtInt(r.seasonTarget),
      meta: { kind: "number" },
      cell: ({ row }) =>
        editing === row.original.variantId ? (
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
          fmtInt(row.original.seasonTarget)
        ),
    },
    {
      id: "gap",
      header: "الفجوة (شراء مقترح)",
      accessorFn: (r) => fmtInt(r.gap),
      meta: { kind: "number" },
      cell: ({ row }) => <span className="font-semibold text-primary">{fmtInt(row.original.gap)}</span>,
    },
    ...(canWrite
      ? ([
          {
            id: "targetActions",
            header: "الهدف",
            enableSorting: false,
            meta: { kind: "actions" },
            cell: ({ row }) =>
              editing === row.original.variantId ? (
                <div className="flex gap-1 justify-center">
                  <Button size="sm" onClick={() => saveEdit(row.original.variantId)} disabled={setTarget.isPending}>
                    {setTarget.isPending ? "…" : "حفظ"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={setTarget.isPending}>
                    إلغاء
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={() => startEdit(row.original)}>
                  <FileEdit aria-hidden className="size-3.5" />
                  تعديل
                </Button>
              ),
          },
        ] as ColumnDef<PlanRow, unknown>[])
      : []),
  ];

  /* رسالة الفراغ تحفظ التمييز الثلاثيّ الأصليّ (بحث / «تحت الهدف فقط» / لا خطّة بعد)،
     وتُمرَّر لطرفَي الفراغ معاً كي لا يتوقّف النصّ على تصنيف DataTable للسبب. */
  const emptyMessage = planSearch.trim()
    ? "لا منتجات موسمية مطابقة للبحث."
    : onlyBelow
      ? "لا منتجات موسمية تحت الهدف. ألغِ «تحت الهدف فقط» لعرض كل المنتجات الموسمية، أو أضِف منتجاً بزرّ «إضافة منتج موسميّ»."
      : "لا منتجات موسمية بعد. أضِف منتجاً بزرّ «إضافة منتج موسميّ» واضبط هدفه لتجهيز الموسم.";

  return (
    <div className="space-y-4">
      <PageHeader
        title="تخطيط موسم المدارس"
        description="المنتجات الموسمية: المخزون الكلّيّ عبر كل الفروع مقابل هدف الموسم — الأبعد عن الهدف أولاً. الفجوة = كمية الشراء المقترحة لتجهيز ذروة أيلول."
        actions={
          canWrite ? (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={rows.length === 0} onClick={doExport}>
                تصدير Excel
              </Button>
              <Button size="sm" onClick={openAdd}>
                <Plus aria-hidden className="size-4" />
                إضافة منتج موسميّ
              </Button>
            </div>
          ) : undefined
        }
      />

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">المنتجات الموسمية</CardTitle>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={planSearch}
                onChange={(e) => setPlanSearch(e.target.value)}
                placeholder="بحث بالاسم أو SKU…"
                aria-label="بحث في المنتجات الموسمية"
                className="h-8 w-48 pr-8"
              />
            </div>
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
              {plan.isLoading ? ACTION_LABELS.loading : `${fmtInt(rows.length)} صنف`}
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* البحث و«تحت الهدف فقط» في رأس البطاقة أعلاه (يغذّيان `rows`) ⇒ `searchable={false}`
              مع `externalFiltersActive` وإلّا ظهر حقلا بحثٍ متجاوران وأعلن الجدولُ «لا صفوف بعد»
              على قائمةٍ حجَبها الفلتر. بلا ترقيمٍ محلّيّ: الخطّة تُقرأ كاملةً كما كانت. */}
          <DataTable<PlanRow>
            columns={planColumns}
            data={rows}
            searchable={false}
            externalFiltersActive={planSearch.trim() !== "" || onlyBelow}
            pageSize={Infinity}
            loading={plan.isLoading}
            errorState={{ isError: plan.isError, message: plan.error?.message, onRetry: () => void plan.refetch() }}
            getRowClassName={(r) => (r.gap > 0 ? "bg-[var(--sem-warn-bg)]/50" : undefined)}
            emptyState={emptyMessage}
            emptyFilteredState={emptyMessage}
          />
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>إضافة منتج لخطة موسم المدارس</DialogTitle>
            <DialogDescription>
              ابحث عن المنتج باسمه أو SKU، ثم اضبط هدف الموسم (بالوحدة الأساس). المنتجات المُضافة سلفاً
              تظهر بهدفها الحاليّ. اضبط الهدف إلى صفر لاحقاً لإزالة المنتج من الخطة.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="season-search">بحث المنتج</Label>
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
                    <th className="p-2 text-start">المنتج</th>
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
