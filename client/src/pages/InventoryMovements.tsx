import { CopyInline } from "@/components/CopyButton";
import { RowActions } from "@/components/list";
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
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { confirm } from "@/lib/confirm";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { fmtInt } from "@/lib/money";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useMemo, useRef, useState } from "react";

/* ============================ Constants & helpers ============================ */

type MovementType = "IN" | "OUT" | "ADJUST" | "RETURN" | "TRANSFER_IN" | "TRANSFER_OUT";
type ManualType = "IN" | "OUT" | "RETURN";
type Reason =
  | "STOCK_TAKE"
  | "DAMAGE"
  | "SAMPLE"
  | "INTERNAL_USE"
  | "GIFT"
  | "CORRECTION"
  | "OTHER";

const MTYPE_LABEL: Record<MovementType, string> = {
  IN: "وارد",
  OUT: "صادر",
  ADJUST: "تسوية",
  RETURN: "مرتجع",
  TRANSFER_IN: "تحويل وارد",
  TRANSFER_OUT: "تحويل صادر",
};

const REASON_LABEL: Record<Reason, string> = {
  STOCK_TAKE: "جرد",
  DAMAGE: "تالف",
  SAMPLE: "عيّنة",
  INTERNAL_USE: "استخدام داخلي",
  GIFT: "إهداء",
  CORRECTION: "تصحيح",
  OTHER: "أخرى",
};

const POSITIVE_TYPES = new Set<MovementType>(["IN", "RETURN", "TRANSFER_IN"]);
const NEGATIVE_TYPES = new Set<MovementType>(["OUT", "TRANSFER_OUT"]);
const ADJUST_TYPES = new Set<MovementType>(["ADJUST"]);

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function variantLine(r: {
  productName: string;
  variantName: string | null;
  color: string | null;
  size: string | null;
  sku: string;
}): { primary: string; secondary: string } {
  const detail = [r.variantName, r.color, r.size].filter(Boolean).join(" / ");
  const primary = detail ? `${r.productName} — ${detail}` : r.productName;
  return { primary, secondary: r.sku };
}

function TypeBadge({ type }: { type: MovementType }) {
  const label = MTYPE_LABEL[type] ?? type;
  const cls = POSITIVE_TYPES.has(type)
    ? "badge-status-active"
    : NEGATIVE_TYPES.has(type)
    ? "badge-stock-out"
    : ADJUST_TYPES.has(type)
    ? "badge-stock-low"
    : "bg-muted text-foreground";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${cls}`}>{label}</span>
  );
}

function signedQty(type: MovementType, qty: number): string {
  const abs = Math.abs(qty);
  if (POSITIVE_TYPES.has(type)) return `+${fmtInt(abs)}`;
  if (NEGATIVE_TYPES.has(type)) return `−${fmtInt(abs)}`;
  // ADJUST: الخادم يخزّن abs(delta) بلا إشارة (انظر setStock في inventoryService) —
  // لا نتظاهر بإشارة لا نعرفها؛ الاتجاه يُستنبط من notes ("من X إلى Y").
  return fmtInt(abs);
}

/* ============================ Page ============================ */

type RichRow = RouterOutputs["inventory"]["movementsRich"]["rows"][number];
type PosRow = RouterOutputs["catalog"]["posList"][number];

const PAGE_SIZE = 50;

export default function InventoryMovements() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const canPickBranch = role === "admin" || role === "manager";
  const canCreateManual = role === "admin" || role === "manager" || role === "warehouse";
  const myBranch = me.data?.branchId ?? 1;

  /* ----- filters ----- */
  const branches = trpc.branches.list.useQuery(undefined, { enabled: canPickBranch });
  const [pickedBranch, setPickedBranch] = useState<number | "">("");
  const branchId = canPickBranch
    ? pickedBranch === ""
      ? undefined
      : Number(pickedBranch)
    : myBranch;

  const [movementType, setMovementType] = useState<"" | MovementType>("");
  // ‎?q= من URL (نمط CustomerStatement): wouter يقصّ الاستعلام، فنقرأ window.location مباشرة —
  // يتيح روابط «حركات المنتج» العميقة من شاشتي المنتجات/المخزون.
  const [q, setQ] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(0);

  const offset = page * PAGE_SIZE;

  const queryInput = useMemo(
    () => ({
      branchId: branchId ?? undefined,
      movementType: movementType || undefined,
      q: q.trim() || undefined,
      fromDate: fromDate ? new Date(fromDate + "T00:00:00").toISOString() : undefined,
      toDate: toDate ? new Date(toDate + "T00:00:00").toISOString() : undefined,
      limit: PAGE_SIZE,
      offset,
    }),
    [branchId, movementType, q, fromDate, toDate, offset]
  );

  const movements = trpc.inventory.movementsRich.useQuery(queryInput, {
    enabled: me.data != null,
  });

  const rows: RichRow[] = movements.data?.rows ?? [];
  const total = movements.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = page + 1;

  /* ----- manual movement dialog ----- */
  const [open, setOpen] = useState(false);
  const [mSearch, setMSearch] = useState("");
  const [mPicked, setMPicked] = useState<PosRow | null>(null);
  const [mType, setMType] = useState<ManualType>("IN");
  const [mProductUnitId, setMProductUnitId] = useState<number | "">("");
  const [mQty, setMQty] = useState("");
  const [mReason, setMReason] = useState<Reason>("STOCK_TAKE");
  const [mNotes, setMNotes] = useState("");
  const [mError, setMError] = useState("");
  const [pageMsg, setPageMsg] = useState("");
  const [exporting, setExporting] = useState(false);

  // For manual movement: warehouse user is locked to own branch; admin/manager use picked branch (or own if none picked).
  const manualBranchId = canPickBranch ? (branchId ?? myBranch) : myBranch;
  const manualBranchName =
    (branches.data ?? []).find((b) => Number(b.id) === Number(manualBranchId))?.name ??
    (me.data?.branchId === manualBranchId ? "فرعي" : `فرع #${manualBranchId}`);

  const searchResults = trpc.catalog.posList.useQuery(
    { branchId: Number(manualBranchId), tier: "RETAIL", query: mSearch, limit: 200 },
    { enabled: open && mSearch.trim().length > 0 }
  );

  // Unique variants from search (one row per variant; pick base unit when available).
  const searchVariants = useMemo(() => {
    const byVariant = new Map<number, PosRow>();
    for (const r of searchResults.data ?? []) {
      const cur = byVariant.get(r.variantId);
      if (!cur || (r.isBaseUnit && !cur.isBaseUnit)) {
        byVariant.set(r.variantId, r);
      }
    }
    return Array.from(byVariant.values());
  }, [searchResults.data]);

  // For the picked variant, list its units (so user can pick the unit for quantity entry).
  const pickedVariantUnits = useMemo(() => {
    if (!mPicked) return [];
    const all = searchResults.data ?? [];
    const sameVariant = all.filter((r) => r.variantId === mPicked.variantId);
    if (sameVariant.length > 0) return sameVariant;
    // fallback: just the picked row itself
    return [mPicked];
  }, [mPicked, searchResults.data]);

  function resetDialog() {
    setMSearch("");
    setMPicked(null);
    setMType("IN");
    setMProductUnitId("");
    setMQty("");
    setMReason("STOCK_TAKE");
    setMNotes("");
    setMError("");
  }

  // idempotency (تدقيق ١٧/٧): مفتاح ثابت لكل محاولة حركة — يُبقى عند الفشل (إعادة المحاولة لا تكرّر
  // الخصم/الإضافة) ويتجدّد بعد النجاح فقط.
  const manualReqIdRef = useRef<string>(crypto.randomUUID());
  const createManual = trpc.inventory.createManualMovement.useMutation({
    onSuccess: async () => {
      manualReqIdRef.current = crypto.randomUUID();
      setPageMsg("تمت إضافة الحركة بنجاح.");
      setOpen(false);
      resetDialog();
      await Promise.all([
        utils.inventory.movementsRich.invalidate(),
        utils.inventory.onHand.invalidate(),
        utils.inventory.movements.invalidate(),
      ]);
      // auto-clear toast after 4s
      setTimeout(() => setPageMsg(""), 4000);
    },
    onError: (e) => setMError(e.message),
  });

  async function submitManual() {
    setMError("");
    if (!mPicked) return setMError("اختر متغيّراً أولاً.");
    if (!mProductUnitId) return setMError("اختر الوحدة.");
    const n = Number(mQty);
    if (!Number.isFinite(n) || n <= 0) return setMError("الكمية يجب أن تكون رقماً موجباً.");
    if (
      !(await confirm({
        variant: "warning",
        title: "تأكيد إضافة حركة يدوية",
        description: "إضافة حركة يدوية قد تؤثّر على الأرصدة. تأكّد من البيانات.",
        confirmText: "حفظ",
      }))
    )
      return;
    createManual.mutate({
      variantId: mPicked.variantId,
      branchId: Number(manualBranchId),
      movementType: mType,
      productUnitId: Number(mProductUnitId),
      quantity: String(n),
      reason: mReason,
      notes: mNotes.trim() || undefined,
      clientRequestId: manualReqIdRef.current,
    });
  }

  /* ----- export ----- */
  // تصدير كل النتائج المطابقة للفلاتر (لا الصفحة المعروضة): يكرّر offset عبر movementsRich
  // (شكلها {rows,total}) حتى تنضب. النوع محسوم صراحةً بـRichRow لتفادي فشل استدلال T.
  async function exportAll() {
    if (total === 0 || exporting) return;
    setExporting(true);
    try {
      const { limit: _limit, offset: _offset, ...filterInput } = queryInput;
      const all = await fetchAllPaged<RichRow>(
        (off, lim) =>
          utils.inventory.movementsRich
            .fetch({ ...filterInput, limit: lim, offset: off })
            .then((r) => ({ rows: r.rows, total: r.total })),
        { pageSize: 500 }
      );
      if (all.length === 0) return;
      exportRows(all, {
      filename: "حركات المخزون",
      columns: [
        { key: "createdAt", header: "التاريخ والوقت", map: (r) => fmtDateTime(r.createdAt) },
        // ملاحظة: التاريخ يُصدَّر كنص معروض (لا قيمة رقمية) — تنسيق موحّد عبر @/lib/date.
        { key: "productName", header: "المنتج", map: (r) => variantLine(r).primary },
        { key: "sku", header: "SKU" },
        { key: "movementType", header: "النوع", map: (r) => MTYPE_LABEL[r.movementType as MovementType] ?? r.movementType },
        // Excel: كمية مطلقة كرقم خام (للفرز/الجمع)؛ الاتجاه عبر عمود النوع.
        { key: "quantity", header: "الكمية", map: (r) => Math.abs(r.quantity) },
        { key: "branchName", header: "الفرع" },
        { key: "relatedBranchName", header: "فرع مرتبط", map: (r) => r.relatedBranchName ?? "" },
        {
          key: "referenceType",
          header: "المرجع",
          map: (r) =>
            r.referenceType ? `${r.referenceType}${r.referenceId ? ` #${r.referenceId}` : ""}` : "",
        },
        { key: "createdByName", header: "المستخدم", map: (r) => r.createdByName ?? "" },
        { key: "notes", header: "الملاحظة", map: (r) => r.notes ?? "" },
      ],
      });
    } finally {
      setExporting(false);
    }
  }

  /* ----- render ----- */
  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        title="حركات المخزون"
        description="السجلّ الكامل للوارد والصادر، التحويلات، التسويات، والمرتجعات. أنشئ حركات يدوية للجرد والتالف."
        actions={
          canCreateManual ? (
            <Button
              onClick={() => {
                resetDialog();
                setOpen(true);
              }}
            >
              + حركة يدوية
            </Button>
          ) : undefined
        }
      />

      {pageMsg && (
        <div className="rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm p-2">
          {pageMsg}
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">الفلاتر</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
          {canPickBranch && (
            <div className="space-y-1">
              <Label>الفرع</Label>
              <select
                className={selectCls}
                value={pickedBranch === "" ? "" : String(pickedBranch)}
                onChange={(e) => {
                  setPickedBranch(e.target.value ? Number(e.target.value) : "");
                  setPage(0);
                }}
              >
                <option value="">— كل الفروع —</option>
                {(branches.data ?? []).map((b) => (
                  <option key={Number(b.id)} value={Number(b.id)}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1">
            <Label>نوع الحركة</Label>
            <select
              className={selectCls}
              value={movementType}
              onChange={(e) => {
                setMovementType(e.target.value as MovementType | "");
                setPage(0);
              }}
            >
              <option value="">— كل الأنواع —</option>
              <option value="IN">وارد (IN)</option>
              <option value="OUT">صادر (OUT)</option>
              <option value="RETURN">مرتجع (RETURN)</option>
              <option value="ADJUST">تسوية (ADJUST)</option>
              <option value="TRANSFER_IN">تحويل وارد</option>
              <option value="TRANSFER_OUT">تحويل صادر</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>بحث (اسم/SKU)</Label>
            <Input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
              placeholder="مثال: ورق A4"
            />
          </div>
          <div className="space-y-1">
            <Label>من تاريخ</Label>
            <Input
              type="date"
              dir="ltr"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setPage(0);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label>إلى تاريخ</Label>
            <Input
              type="date"
              dir="ltr"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setPage(0);
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">
            السجلّ{" "}
            <span className="text-xs text-muted-foreground font-normal">
              ({fmtInt(total)} حركة)
            </span>
          </CardTitle>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {movements.isLoading
                ? "جارٍ التحميل…"
                : `صفحة ${fmtInt(currentPage)} من ${fmtInt(totalPages)}`}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!rows.length}
              onClick={() =>
                printReportDoc({
                  title: "حركات المخزون",
                  headerExtra: [
                    { label: "الفترة", value: `${fromDate || "—"} — ${toDate || "—"}` },
                    {
                      label: "النوع",
                      value: movementType ? MTYPE_LABEL[movementType] : "الكل",
                    },
                  ],
                  columns: [
                    { key: "date", label: "التاريخ" },
                    { key: "product", label: "المنتج" },
                    { key: "type", label: "نوع الحركة" },
                    { key: "qty", label: "الكمية", align: "left" },
                    { key: "branch", label: "الفرع" },
                    { key: "ref", label: "المرجع" },
                    { key: "user", label: "المستخدم" },
                  ],
                  rows: rows.map((r) => {
                    const t = r.movementType as MovementType;
                    return {
                      date: fmtDate(r.createdAt),
                      product: variantLine(r).primary,
                      type: MTYPE_LABEL[t] ?? r.movementType,
                      qty: signedQty(t, r.quantity),
                      branch: r.relatedBranchName
                        ? `${r.branchName} ← ${r.relatedBranchName}`
                        : r.branchName,
                      ref: r.referenceType
                        ? `${r.referenceType}${r.referenceId ? ` #${r.referenceId}` : ""}`
                        : "—",
                      user: r.createdByName ?? "—",
                    };
                  }),
                })
              }
            >
              طباعة / PDF
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={total === 0 || exporting}
              onClick={() => void exportAll()}
            >
              {exporting ? "جارٍ التحضير…" : "تصدير Excel"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 text-start">التاريخ والوقت</th>
                <th className="p-2 text-start">المنتج / المتغيّر</th>
                <th className="p-2 text-center">النوع</th>
                <th className="p-2 text-center">الكمية</th>
                <th className="p-2 text-start">الفرع</th>
                <th className="p-2 text-start">المرجع</th>
                <th className="p-2 text-start">المستخدم</th>
                <th className="p-2 text-start">الملاحظة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const { primary, secondary } = variantLine(r);
                const t = r.movementType as MovementType;
                return (
                  <tr key={r.id} className="border-t align-top">
                    <td className="p-2 text-xs whitespace-nowrap">{fmtDateTime(r.createdAt)}</td>
                    <td className="p-2">
                      <div className="font-medium">{primary}</div>
                      <CopyInline value={secondary} className="text-muted-foreground" />
                    </td>
                    <td className="p-2 text-center">
                      <TypeBadge type={t} />
                    </td>
                    <td
                      className={`p-2 text-center tabular-nums font-semibold ${
                        POSITIVE_TYPES.has(t)
                          ? "text-money-positive"
                          : NEGATIVE_TYPES.has(t)
                          ? "text-money-negative"
                          : "text-[var(--stock-low)]"
                      }`}
                      dir="ltr"
                    >
                      {signedQty(t, r.quantity)}
                    </td>
                    <td className="p-2 text-xs">
                      {r.branchName}
                      {r.relatedBranchName && (
                        <span className="text-muted-foreground">
                          {" "}
                          ← {r.relatedBranchName}
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-xs">
                      {r.referenceType ? (
                        <CopyInline
                          value={r.referenceId ? `${r.referenceType} #${r.referenceId}` : r.referenceType}
                        />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="p-2 text-xs">{r.createdByName ?? "—"}</td>
                    <td className="p-2 text-xs text-muted-foreground max-w-xs truncate" title={r.notes ?? undefined}>
                      {r.notes ?? "—"}
                    </td>
                    <td className="p-2 text-center">
                      {/* «فتح المرجع» الشرطي: قيم referenceType الفعلية من الخدمات —
                          البيع INVOICE (saleService) والشراء PURCHASE_ORDER (purchaseService).
                          غير ذلك ⇒ hidden فيُخفي RowActions نفسه (يعيد null). */}
                      <RowActions
                        actions={[
                          {
                            key: "ref",
                            label: "فتح المرجع",
                            hidden: !r.referenceId ||
                              (r.referenceType !== "INVOICE" && r.referenceType !== "PURCHASE_ORDER"),
                            href:
                              r.referenceType === "INVOICE"
                                ? `/invoices/${r.referenceId}`
                                : `/purchases/${r.referenceId}/receive`,
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
              {!movements.isLoading && rows.length === 0 && (
                <TableEmptyRow colSpan={9} message="لا توجد حركات مطابقة للفلاتر." />
              )}
            </tbody>
          </table>
          </ScrollTableShell>
        </CardContent>
        <div className="flex items-center justify-between p-3 border-t">
          <span className="text-xs text-muted-foreground">
            عرض {rows.length > 0 ? fmtInt(offset + 1) : 0}–
            {fmtInt(offset + rows.length)} من {fmtInt(total)}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0 || movements.isLoading}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              السابق →
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= totalPages || movements.isLoading}
              onClick={() => setPage((p) => p + 1)}
            >
              ← التالي
            </Button>
          </div>
        </div>
      </Card>

      {/* Manual movement dialog */}
      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) resetDialog();
        }}
      >
        <DialogContent className="sm:max-w-3xl" dir="rtl">
          <DialogHeader>
            <DialogTitle>حركة مخزون يدوية</DialogTitle>
            <DialogDescription>
              للجرد، التالف، العيّنات، الإهداء، أو التصحيح. تُسجَّل كحركة تدقيق على الفرع{" "}
              <span className="font-semibold">{manualBranchName}</span>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {/* Variant search */}
            <div className="space-y-1">
              <Label>ابحث عن متغيّر (اسم/SKU/باركود)</Label>
              <div className="relative">
                <Input
                  value={mSearch}
                  onChange={(e) => setMSearch(e.target.value)}
                  placeholder="اكتب للبحث…"
                />
                {mSearch.trim() && (searchVariants.length > 0 || searchResults.isFetching) && (
                  <div className="absolute z-10 mt-1 w-full bg-popover border rounded-md shadow max-h-60 overflow-auto">
                    {searchResults.isFetching && (
                      <div className="p-2 text-xs text-muted-foreground text-center">
                        جارٍ البحث…
                      </div>
                    )}
                    {searchVariants.map((v) => (
                      <button
                        key={v.variantId}
                        type="button"
                        className="block w-full text-right px-3 py-2 text-sm hover:bg-accent"
                        onClick={() => {
                          setMPicked(v);
                          setMProductUnitId(v.productUnitId);
                          setMSearch("");
                        }}
                      >
                        <div className="font-medium">{variantLine(v).primary}</div>
                        <div className="text-xs text-muted-foreground font-mono flex justify-between" dir="ltr">
                          <span>{v.sku}</span>
                          <span>متاح {fmtInt(v.stockBase)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Picked variant card */}
            {mPicked && (
              <div className="rounded-md bg-muted/40 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{variantLine(mPicked).primary}</div>
                    <div className="text-xs text-muted-foreground font-mono" dir="ltr">
                      {mPicked.sku}
                    </div>
                  </div>
                  <div className="text-left">
                    <div className="text-xs text-muted-foreground">المتاح</div>
                    <div className="font-semibold tabular-nums" dir="ltr">
                      {fmtInt(mPicked.stockBase)}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Form grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label>النوع *</Label>
                <select
                  className={selectCls}
                  value={mType}
                  onChange={(e) => setMType(e.target.value as ManualType)}
                >
                  <option value="IN">وارد (IN)</option>
                  <option value="OUT">صادر (OUT)</option>
                  <option value="RETURN">مرتجع (RETURN)</option>
                </select>
              </div>

              <div className="space-y-1">
                <Label>الوحدة *</Label>
                <select
                  className={selectCls}
                  value={mProductUnitId === "" ? "" : String(mProductUnitId)}
                  onChange={(e) =>
                    setMProductUnitId(e.target.value ? Number(e.target.value) : "")
                  }
                  disabled={!mPicked}
                >
                  <option value="">— اختر —</option>
                  {pickedVariantUnits.map((u) => (
                    <option key={u.productUnitId} value={u.productUnitId}>
                      {u.unitName}
                      {u.isBaseUnit ? " (أساس)" : ` × ${u.conversionFactor}`}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <Label>الكمية *</Label>
                <Input
                  dir="ltr"
                  value={mQty}
                  onChange={(e) => setMQty(e.target.value)}
                  placeholder="0"
                />
              </div>

              <div className="space-y-1">
                <Label>السبب *</Label>
                <select
                  className={selectCls}
                  value={mReason}
                  onChange={(e) => setMReason(e.target.value as Reason)}
                >
                  {(Object.keys(REASON_LABEL) as Reason[]).map((r) => (
                    <option key={r} value={r}>
                      {REASON_LABEL[r]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1 md:col-span-2 lg:col-span-3">
                <Label>ملاحظات (اختياري — حتى 500 حرف)</Label>
                <Textarea
                  rows={2}
                  value={mNotes}
                  onChange={(e) => setMNotes(e.target.value.slice(0, 500))}
                  placeholder="تفاصيل إضافية…"
                />
              </div>
            </div>

            {mError && <p className="text-sm text-destructive">{mError}</p>}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                resetDialog();
              }}
              disabled={createManual.isPending}
            >
              إلغاء
            </Button>
            <Button
              onClick={submitManual}
              disabled={createManual.isPending || !mPicked || !mProductUnitId || !mQty}
            >
              {createManual.isPending ? "جارٍ الحفظ…" : "حفظ الحركة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
