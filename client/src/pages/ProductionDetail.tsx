import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/PageState";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { confirm } from "@/lib/confirm";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { fmt, fmtInt, pct } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printProductionDoc } from "@/lib/printing/printTemplates";
import { trpc } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { Printer } from "lucide-react";
import { Link, useRoute } from "wouter";

/**
 * سطرُ مستند الإنتاج (مدخلاً كان أو مخرجاً). `production.get` يعود `any` في هذه الشاشة،
 * فنثبّت الشكل هنا كي تستنتج أعمدةُ الجدول أنواعَها بدل `unknown`.
 */
type ProductionLine = {
  id: number | string;
  productName?: string | null;
  variantName?: string | null;
  sku?: string | null;
  baseQuantity?: string | number | null;
  unitCost?: string | number | null;
  lineCost?: string | number | null;
  allocatedCost?: string | number | null;
};

/** اسم المادة/المنتَج مع بديله إن وُجد — نصٌّ واحد للعرض وللنسخ معاً. */
const lineName = (l: ProductionLine) => (l.productName ?? "") + (l.variantName ? " — " + l.variantName : "");

/** الأعمدة المشتركة بين جدولَي المدخلات والمخرجات (الاسم/الرمز/الكمية). */
function lineHeadColumns(nameHeader: string): ColumnDef<ProductionLine, unknown>[] {
  return [
    { id: "name", header: nameHeader, accessorFn: lineName, meta: { width: "wide" }, cell: ({ row }) => lineName(row.original) },
    { id: "sku", header: "SKU", accessorFn: (l) => l.sku ?? "", meta: { kind: "code" }, cell: ({ row }) => <span className="text-xs">{row.original.sku}</span> },
    {
      id: "qty",
      header: "الكمية (أساس)",
      accessorFn: (l) => fmtInt(l.baseQuantity),
      meta: { kind: "number", align: "center" },
      cell: ({ row }) => fmtInt(row.original.baseQuantity),
    },
  ];
}

/* جدولان مُضمَّنان في بطاقتين تحملان عنوانيهما — شريطُ حالةٍ لكلٍّ منهما ضجيجٌ لا معلومة. */
const LINE_TABLE = { embedded: true, searchable: false, bounded: false, pageSize: Infinity } as const;

export default function ProductionDetail() {
  const [, params] = useRoute("/production/:id");
  const id = Number(params?.id);
  const me = trpc.auth.me.useQuery();
  const isManager = !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "inventory",
      "FULL",
      ["manager"],
    );
  const utils = trpc.useUtils();

  const q = trpc.production.get.useQuery({ productionOrderId: id }, { enabled: Number.isFinite(id) && id > 0 });
  const doc = q.data as any;

  const cancel = trpc.production.cancel.useMutation({
    onSuccess: () => {
      notify.ok("أُلغي المستند", "عاد المخزون وسُحبت المخرجات.");
      utils.production.get.invalidate({ productionOrderId: id });
      utils.production.list.invalidate();
      utils.inventory.onHand.invalidate();
      utils.inventory.movementsRich.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  async function onCancel() {
    const ok = await confirm({
      variant: "danger",
      title: "إلغاء مستند الإنتاج",
      description: "ستُعاد المدخلات للمخزون وتُسحب المخرجات. متابعة؟",
      confirmText: "إلغاء المستند",
    });
    if (!ok) return;
    cancel.mutate({ productionOrderId: id });
  }

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState message={`تعذّر تحميل مستند الإنتاج: ${q.error.message}`} onRetry={() => void q.refetch()} />;
  if (!doc) return <div className="p-6 text-muted-foreground" dir="rtl">المستند غير موجود.</div>;

  const inputs = doc.inputs ?? [];
  const outputs = doc.outputs ?? [];
  const isRecipeRun = doc.batchQty != null;
  const batchQ = Number(doc.batchQty ?? 0);
  const abLoss = Number(doc.abnormalLoss ?? 0);
  const wasteStd = Number(doc.wasteStdPct ?? 0);
  // أرقام الإنتاجية مشتقّة خادمياً بـspoilageSplit (مصدر حقيقة واحد) — العميل يعرضها فقط.
  const normalAllow = Number(doc.normalAllow ?? 0);
  const abnormalUnits = Number(doc.abnormalUnits ?? 0);
  const yieldPct = doc.yieldPct != null ? Number(doc.yieldPct) : null;

  function printDocument() {
    const out0: any = outputs[0] ?? {};
    printProductionDoc({
      docNumber: doc.docNumber, date: fmtDate(doc.createdAt), branchName: doc.branchName, recipeName: doc.recipeName,
      outputName: out0.productName ?? "", outputUnit: out0.unitName,
      planned: batchQ || Number(out0.baseQuantity ?? 0),
      good: Number(doc.goodQty ?? out0.baseQuantity ?? 0),
      scrap: Number(doc.scrapQty ?? 0),
      wasteStdPct: wasteStd,
      normalAllow, abnormalUnits, yieldPct,
      inputs: inputs.map((i: any) => ({ name: i.productName ?? "", sku: i.sku, perUnit: batchQ > 0 ? Number(i.baseQuantity) / batchQ : Number(i.baseQuantity), consumed: Number(i.baseQuantity), short: false })),
      materialsCost: doc.materialsCost, laborCost: doc.laborCost, totalCost: doc.totalCost,
      abnormalLoss: doc.abnormalLoss, unitCost: out0.unitCost ?? "0",
    }, "document");
  }

  return (
    <div className="space-y-4 max-w-4xl" dir="rtl">
      <PageHeader
        title={<>مستند إنتاج <span className="font-mono text-lg" dir="ltr">{doc.docNumber}</span></>}
        backHref="/production"
        actions={<Button variant="outline" size="sm" onClick={printDocument}><Printer aria-hidden className="size-4" /> طباعة المستند</Button>}
      />

      <Card>
        <CardHeader><CardTitle className="text-base">الرأس</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div className="text-xs text-muted-foreground">الفرع</div><div>{doc.branchName}</div></div>
          <div><div className="text-xs text-muted-foreground">الحالة</div>
            <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${doc.status === "CANCELLED" ? "badge-status-cancelled" : "badge-status-active"}`}>
              {doc.status === "CANCELLED" ? "ملغى" : "مُرحَّل"}
            </span>
          </div>
          <div><div className="text-xs text-muted-foreground">كلفة المواد</div><div className="tabular-nums" dir="ltr">{fmt(doc.materialsCost)}</div></div>
          <div><div className="text-xs text-muted-foreground">العمالة</div><div className="tabular-nums" dir="ltr">{fmt(doc.laborCost)}</div></div>
          <div><div className="text-xs text-muted-foreground">الكلفة الكلية</div><div className="font-bold text-primary tabular-nums" dir="ltr">{fmt(doc.totalCost)}</div></div>
          <div><div className="text-xs text-muted-foreground">التاريخ</div><div className="text-xs">{fmtDateTime(doc.createdAt)}</div></div>
          {doc.recipeName && <div><div className="text-xs text-muted-foreground">وصفة</div><div>{doc.recipeName}</div></div>}
          {doc.notes && <div className="col-span-2"><div className="text-xs text-muted-foreground">ملاحظة</div><div>{doc.notes}</div></div>}
        </CardContent>
      </Card>

      {isRecipeRun && (
        <Card>
          <CardHeader><CardTitle className="text-base">الإنتاجية والهدر</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
            <div><div className="text-xs text-muted-foreground">الدفعة</div><div className="font-semibold tabular-nums" dir="ltr">{fmtInt(doc.batchQty)}</div></div>
            <div><div className="text-xs text-muted-foreground">السليم</div><div className="font-semibold text-money-positive tabular-nums" dir="ltr">{fmtInt(doc.goodQty)}</div></div>
            <div><div className="text-xs text-muted-foreground">التالف</div><div className="font-semibold text-[var(--stock-low)] tabular-nums" dir="ltr">{fmtInt(doc.scrapQty)}</div></div>
            <div><div className="text-xs text-muted-foreground">الإنتاجية</div><div className="font-semibold tabular-nums" dir="ltr">{yieldPct != null ? pct(yieldPct) : "—"}</div></div>
            <div><div className="text-xs text-muted-foreground">خسارة هدر غير طبيعي</div><div className={`font-semibold tabular-nums ${abLoss > 0 ? "text-money-negative" : "text-muted-foreground"}`} dir="ltr">{abLoss > 0 ? `${fmt(doc.abnormalLoss)} (${abnormalUnits} وحدة)` : "لا يوجد"}</div></div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">المدخلات (المُستهلَكة)</CardTitle></CardHeader>
        <CardContent className="p-0">
          <DataTable<ProductionLine>
            {...LINE_TABLE}
            data={inputs}
            emptyText="لا مدخلات."
            columns={[
              ...lineHeadColumns("المادة"),
              { id: "unitCost", header: "كلفة الوحدة", accessorFn: (l) => fmt(l.unitCost), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.unitCost) },
              { id: "lineCost", header: "كلفة السطر", accessorFn: (l) => fmt(l.lineCost), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.lineCost) },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">المخرجات (المُنتَجة)</CardTitle></CardHeader>
        <CardContent className="p-0">
          <DataTable<ProductionLine>
            {...LINE_TABLE}
            data={outputs}
            emptyText="لا مخرجات."
            columns={[
              ...lineHeadColumns("المنتَج"),
              {
                id: "unitCost",
                header: "كلفة الوحدة المحتسبة",
                accessorFn: (l) => fmt(l.unitCost),
                meta: { kind: "money" },
                cell: ({ row }) => <span className="text-primary">{fmt(row.original.unitCost)}</span>,
              },
              { id: "allocatedCost", header: "الكلفة المُمتصّة", accessorFn: (l) => fmt(l.allocatedCost), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.allocatedCost) },
            ]}
          />
        </CardContent>
      </Card>

      {isManager && doc.status !== "CANCELLED" && (
        <div>
          <Button variant="destructive" onClick={onCancel} disabled={cancel.isPending}>
            {cancel.isPending ? "جارٍ الإلغاء…" : "إلغاء المستند (يعكس المخزون)"}
          </Button>
        </div>
      )}
    </div>
  );
}
