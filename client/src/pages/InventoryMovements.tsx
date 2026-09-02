import { CopyInline } from "@/components/CopyButton";
import { FilterField, FilterShell, SearchField } from "@/components/list";
import { AppSelect } from "@/components/ui/AppSelect";
import { ATTRIBUTION_LABELS } from "@shared/uiContracts";
import { RowActions } from "@/components/list";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { fmtInt } from "@/lib/money";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useMemo, useState } from "react";

/* ============================ Constants & helpers ============================ */

type MovementType = "IN" | "OUT" | "ADJUST" | "RETURN" | "TRANSFER_IN" | "TRANSFER_OUT";

const MTYPE_LABEL: Record<MovementType, string> = {
  IN: "وارد",
  OUT: "صادر",
  ADJUST: "تسوية",
  RETURN: "مرتجع",
  TRANSFER_IN: "تحويل وارد",
  TRANSFER_OUT: "تحويل صادر",
};


// تعريب referenceType (نصّ خام في DB يُكتَب من عشرات نقاط الخدمة) — القيم غير المدرَجة تُعرَض
// كما هي (fallback في MovementRefBadge أدناه)، فلا تُخفي حركةً بمرجعٍ نادر عن الفلتر أو العرض.
const REFERENCE_TYPE_LABELS: Record<string, string> = {
  OPENING: "رصيد افتتاحي",
  INVOICE: "فاتورة بيع",
  PURCHASE_ORDER: "أمر شراء",
  PURCHASE: "استلام شراء",
  RETURN: "مرتجع",
  TRANSFER: "تحويل بين الفروع",
  WORK_ORDER: "أمر شغل",
  WORK_ORDER_CANCEL: "إلغاء أمر شغل",
  PRODUCTION: "إنتاج",
  PRODUCTION_CANCEL: "إلغاء إنتاج",
  CONSIGN_IN: "إيداع أمانة",
  CONSIGN_OUT: "سحب أمانة",
  DELIVERY_RETURN: "إرجاع أمانة",
  GIFT_IN: "وارد هدايا",
  GIFT_OUT: "صادر هدايا",
  EXPENSE: "مصروف",
  EXPENSE_CANCEL: "إلغاء مصروف",
  PRINT_SALE: "بيع طباعة",
};
const REFERENCE_TYPE_OPTIONS = Object.entries(REFERENCE_TYPE_LABELS).map(([value, label]) => ({ value, label }));

const POSITIVE_TYPES = new Set<MovementType>(["IN", "RETURN", "TRANSFER_IN"]);
const NEGATIVE_TYPES = new Set<MovementType>(["OUT", "TRANSFER_OUT"]);
const ADJUST_TYPES = new Set<MovementType>(["ADJUST"]);


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

// الكمية الموقَّعة تأتي من الخادم (signedQty عبر signedMoveQty — نفس مصدر الكاردكس/الجرد)، تشمل اتجاه
// ADJUST المستنبَط من علامة «(فرق ±D)». هنا نُنسّق العرض فقط — لا تخمين اتجاه في العميل (تدقيق ١١/٨).
function fmtSignedQty(signed: number): string {
  if (signed > 0) return `+${fmtInt(signed)}`;
  if (signed < 0) return `−${fmtInt(Math.abs(signed))}`;
  return fmtInt(0);
}

/* ============================ Page ============================ */

type RichRow = RouterOutputs["inventory"]["movementsRich"]["rows"][number];

const PAGE_SIZE = 50;

export default function InventoryMovements() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const canPickBranch = role === "admin" || role === "manager";
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
  // ‎?q= أو ?variantId= من URL (نمط CustomerStatement): wouter يقصّ الاستعلام، فنقرأ
  // window.location مباشرة — يتيح روابط «حركات المنتج» العميقة من شاشتي المنتجات/المخزون.
  // variantId أدقّ من q (لا يلتبس بمنتج آخر بنفس الاسم الجزئي) — يُفضَّل حين يتوفّر.
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const [q, setQ] = useState(() => initialParams.get("q") ?? "");
  const [variantId] = useState<number | undefined>(() => {
    const v = Number(initialParams.get("variantId"));
    return Number.isInteger(v) && v > 0 ? v : undefined;
  });
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [referenceType, setReferenceType] = useState<"" | (typeof REFERENCE_TYPE_OPTIONS)[number]["value"]>("");
  const [createdByName, setCreatedByName] = useState("");
  const debouncedCreatedByName = useDebouncedValue(createdByName, 250);
  const [page, setPage] = useState(0);

  /**
   * عدّاد الفلاتر المفعّلة + تصفيرها — لم تكن الشاشة تملك زرّ تصفيرٍ أصلاً، فالموظّف
   * يُضيّق سبعة فلاتر ثمّ لا يجد سبيلاً للعودة إلى الكلّ إلّا بإعادة تحميل الصفحة.
   * البحث محسوبٌ هنا لأنّه أحد الفلاتر السبعة المرئية (لا حقلَ بحثٍ عامّاً منفصلاً).
   */
  const activeFilterCount =
    (pickedBranch !== "" ? 1 : 0) +
    (movementType ? 1 : 0) +
    (q ? 1 : 0) +
    (fromDate ? 1 : 0) +
    (toDate ? 1 : 0) +
    (referenceType ? 1 : 0) +
    (createdByName ? 1 : 0);

  const resetFilters = () => {
    setPickedBranch("");
    setMovementType("");
    setQ("");
    setFromDate("");
    setToDate("");
    setReferenceType("");
    setCreatedByName("");
    setPage(0);
  };

  const offset = page * PAGE_SIZE;

  const queryInput = useMemo(
    () => ({
      branchId: branchId ?? undefined,
      movementType: movementType || undefined,
      variantId,
      q: q.trim() || undefined,
      fromDate: fromDate ? new Date(fromDate + "T00:00:00").toISOString() : undefined,
      toDate: toDate ? new Date(toDate + "T00:00:00").toISOString() : undefined,
      referenceType: referenceType || undefined,
      createdByName: debouncedCreatedByName.trim() || undefined,
      limit: PAGE_SIZE,
      offset,
    }),
    [branchId, movementType, variantId, q, fromDate, toDate, referenceType, debouncedCreatedByName, offset]
  );

  const movements = trpc.inventory.movementsRich.useQuery(queryInput, {
    enabled: me.data != null,
  });

  const rows: RichRow[] = movements.data?.rows ?? [];
  const total = movements.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = page + 1;

  const [exporting, setExporting] = useState(false);

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
        // Excel: الكمية **الموقَّعة** (تدقيق ١١/٨) — تُجمَع إلى صافي تغيّر الرصيد وتطابق الشاشة/الطباعة
        // (كانت قيمةً مطلقةً تتجاهل الاتجاه فلا يصحّ جمعها).
        { key: "signedQty", header: "الكمية (موقَّعة)", map: (r) => r.signedQty },
        { key: "branchName", header: "الفرع" },
        { key: "relatedBranchName", header: "فرع مرتبط", map: (r) => r.relatedBranchName ?? "" },
        {
          key: "referenceType",
          header: "المرجع",
          map: (r) =>
            r.referenceType ? `${r.referenceType}${r.referenceId ? ` #${r.referenceId}` : ""}` : "",
        },
        { key: "createdByName", header: ATTRIBUTION_LABELS.performedBy, map: (r) => r.createdByName ?? "" },
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
        description="السجلّ الكامل للوارد والصادر، التحويلات، التسويات، والمرتجعات — للقراءة والتدقيق. لإضافة مخزون استعمل الشراء أو المرتجعات، ولأيّ تصحيح استعمل «تسوية الرصيد» من شاشة المخزون (يعتمده مسؤول آخر)."
      />


      {/*
        الموجة ١ (docs/ui-unification-campaign.md): كان الغلاف بطاقةً يدوية بشبكة
        `lg:grid-cols-7` — سبعةُ حقولٍ في صفٍّ واحد لا يُقرأ على أيّ شاشة، وبلا زرّ
        تصفيرٍ أصلاً (الموظّف يُفلتر ثم لا يجد سبيلاً للعودة إلى الكلّ).
      */}
      <FilterShell
        columns={4}
        activeCount={activeFilterCount}
        onReset={resetFilters}
      >
          {canPickBranch && (
            <FilterField label="الفرع">
              <AppSelect
                value={pickedBranch === "" ? "" : String(pickedBranch)}
                onValueChange={(v) => {
                  setPickedBranch(v ? Number(v) : "");
                  setPage(0);
                }}
              >
                <option value="">— كل الفروع —</option>
                {(branches.data ?? []).map((b) => (
                  <option key={Number(b.id)} value={Number(b.id)}>
                    {b.name}
                  </option>
                ))}
              </AppSelect>
            </FilterField>
          )}
          <FilterField label="نوع الحركة">
            <AppSelect
              value={movementType}
              onValueChange={(v) => {
                setMovementType(v as MovementType | "");
                setPage(0);
              }}
            >
              <option value="">— كل الأنواع —</option>
              <option value="IN">وارد</option>
              <option value="OUT">صادر</option>
              <option value="RETURN">مرتجع</option>
              <option value="ADJUST">تسوية</option>
              <option value="TRANSFER_IN">تحويل وارد</option>
              <option value="TRANSFER_OUT">تحويل صادر</option>
            </AppSelect>
          </FilterField>
          <FilterField label="بحث (اسم/SKU)">
            <SearchField
              value={q}
              onChange={(value) => {
                setQ(value);
                setPage(0);
              }}
              placeholder="مثال: ورق A4"
            />
          </FilterField>
          <FilterField label="من تاريخ">
            <Input
              type="date"
              dir="ltr"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setPage(0);
              }}
            />
          </FilterField>
          <FilterField label="إلى تاريخ">
            <Input
              type="date"
              dir="ltr"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setPage(0);
              }}
            />
          </FilterField>
          <FilterField label="نوع المرجع">
            <AppSelect
              value={referenceType}
              onValueChange={(v) => {
                setReferenceType(v as typeof referenceType);
                setPage(0);
              }}
            >
              <option value="">— كل المراجع —</option>
              {REFERENCE_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </AppSelect>
          </FilterField>
          {/* «منشئ الحركة» = دور `performedBy` في عقد الإسناد الموحّد (shared/uiContracts). */}
          <FilterField label={ATTRIBUTION_LABELS.performedBy}>
            <SearchField
              value={createdByName}
              onChange={(value) => {
                setCreatedByName(value);
                setPage(0);
              }}
              placeholder="اسم المستخدم…"
            />
          </FilterField>
      </FilterShell>

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
                      qty: fmtSignedQty(r.signedQty),
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
                <th className="p-2 text-start">{ATTRIBUTION_LABELS.performedBy}</th>
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
                        r.signedQty > 0
                          ? "text-money-positive"
                          : r.signedQty < 0
                          ? "text-money-negative"
                          : "text-muted-foreground"
                      }`}
                      dir="ltr"
                    >
                      {fmtSignedQty(r.signedQty)}
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
                          display={
                            <>
                              {REFERENCE_TYPE_LABELS[r.referenceType] ?? r.referenceType}
                              {r.referenceId ? <span className="text-muted-foreground"> #{r.referenceId}</span> : null}
                            </>
                          }
                          mono={false}
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
                            kind: "view",
                            label: "فتح المرجع",
                            hidden: !r.referenceId ||
                              (r.referenceType !== "INVOICE" && r.referenceType !== "PURCHASE_ORDER"),
                            href:
                              r.referenceType === "INVOICE"
                                ? `/invoices/${r.referenceId}`
                                : `/purchases/${r.referenceId}/receive`,
                            gate: r.referenceType === "INVOICE"
                              ? { module: "sales", level: "READ" }
                              : { module: "purchases", level: "READ" },
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

    </div>
  );
}
