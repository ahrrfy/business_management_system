import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { CheckCircle2, Sparkles, XCircle } from "lucide-react";
import { DataTable } from "@/components/data-table/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";

/**
 * ProductContentDrafts — طابور الاعتماد الموحّد للمسودّات التي ولّدتها الحوكمة تلقائياً
 * بعد اعتماد صور الاستوديو (الشقّ التلقائيّ للهجين). المدير يفتح الشاشة مرّةً ويعتمد
 * العشرات دفعةً بدل الدوران على كل منتج.
 *
 * كل صفٍّ يعرض: اسم المنتج، عيّنة من العنوان/الوصف، تاريخ التوليد، ومعالجَين:
 * «اعتماد وتطبيق» يكتب المحتوى على أعمدة المنتج ويعلّم المسودّة APPLIED؛ «رفض» يعلّمها
 * REJECTED بلا تغييرٍ على المنتج. كلاهما ذرّيّ خادمياً — الشاشة تُحدِث القائمة عند النجاح.
 */

type Row = {
  id: number;
  productId: number;
  productName: string;
  content: {
    seoTitle?: string | null;
    posLabel?: string | null;
    description?: string | null;
    marketingCopy?: string | null;
  } | null;
  promptVersion: string;
  model: string;
  createdAt: string | Date;
};

const dateFmt = new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
  dateStyle: "short",
  timeStyle: "short",
});

function truncate(value: string | null | undefined, max = 90): string {
  if (!value) return "—";
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export default function ProductContentDrafts() {
  const utils = trpc.useUtils();
  const [busyId, setBusyId] = useState<number | null>(null);
  const query = trpc.catalog.listPendingContentDrafts.useQuery({ limit: 200 });
  const apply = trpc.catalog.applyContentDraft.useMutation({
    onSettled: () => {
      setBusyId(null);
      void utils.catalog.listPendingContentDrafts.invalidate();
    },
  });
  const decide = trpc.catalog.decideContentDraft.useMutation({
    onSettled: () => {
      setBusyId(null);
      void utils.catalog.listPendingContentDrafts.invalidate();
    },
  });

  const rows = useMemo<Row[]>(
    () =>
      (query.data ?? []).map((r) => ({
        id: Number(r.id),
        productId: Number(r.productId),
        productName: String(r.productName ?? ""),
        content: (r.content ?? null) as Row["content"],
        promptVersion: String(r.promptVersion ?? ""),
        model: String(r.model ?? ""),
        createdAt: r.createdAt as string | Date,
      })),
    [query.data],
  );

  async function handleApply(row: Row) {
    if (busyId != null) return;
    const ok = await confirm({
      title: "تطبيق المسودّة على المنتج؟",
      description: `سيُكتب العنوان والوصف والحقول التسويقيّة على المنتج «${row.productName}» — يمكن التراجع بتعديلٍ يدويّ لاحق.`,
      confirmText: "طبّق",
      variant: "info",
    });
    if (!ok) return;
    setBusyId(row.id);
    apply.mutate({ draftId: row.id });
  }

  async function handleReject(row: Row) {
    if (busyId != null) return;
    const ok = await confirm({
      title: "رفض المسودّة؟",
      description: `سيُعلَم أنّ محتوى «${row.productName}» مرفوض — يمكن توليد مسودّةٍ جديدة يدوياً من شاشة المنتج.`,
      confirmText: "رفض",
      variant: "danger",
    });
    if (!ok) return;
    setBusyId(row.id);
    decide.mutate({
      draftId: row.id,
      decision: "REJECTED",
      note: "رُفضت من طابور المراجعة الموحّد.",
    });
  }

  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        header: "المنتج",
        accessorKey: "productName",
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <a
              href={`/products/${row.original.productId}/edit`}
              className="font-medium hover:underline"
            >
              {row.original.productName}
            </a>
            <span className="text-[10px] text-muted-foreground">
              #{row.original.productId}
            </span>
          </div>
        ),
      },
      {
        id: "seoTitle",
        header: "العنوان المقترح",
        accessorFn: (r) => r.content?.seoTitle ?? "",
        cell: ({ row }) => (
          <div className="text-sm">{truncate(row.original.content?.seoTitle, 60)}</div>
        ),
      },
      {
        id: "description",
        header: "الوصف",
        accessorFn: (r) => r.content?.description ?? "",
        cell: ({ row }) => (
          <div className="text-xs text-muted-foreground">
            {truncate(row.original.content?.description, 120)}
          </div>
        ),
      },
      {
        id: "meta",
        header: "المصدر",
        cell: ({ row }) => (
          <div className="flex flex-col gap-1">
            <Badge variant="outline" className="w-fit text-[10px]">
              {row.original.promptVersion.includes("vision") ? "بصريّ" : "نصّيّ"}
            </Badge>
            <span dir="ltr" className="text-[10px] text-muted-foreground tabular-nums">
              {dateFmt.format(new Date(row.original.createdAt))}
            </span>
          </div>
        ),
      },
      {
        id: "actions",
        header: "قرار",
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => handleReject(row.original)}
              disabled={busyId === row.original.id}
            >
              <XCircle aria-hidden className="size-4" />
              رفض
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => handleApply(row.original)}
              disabled={busyId === row.original.id}
            >
              <CheckCircle2 aria-hidden className="size-4" />
              اعتماد وتطبيق
            </Button>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busyId],
  );

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        title="مسودّات محتوى تنتظر مراجعة"
        description="محتوى ولّده الذكاء تلقائياً بعد اعتماد صور الاستوديو — راجع واعتمد."
        icon={<Sparkles aria-hidden className="size-5 text-violet-600" />}
        backHref="/inventory"
        backLabel="العودة إلى المخزون"
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {query.data ? `${query.data.length} مسودّة قيد المراجعة` : ACTION_LABELS.loading}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={rows}
            searchable
            searchPlaceholder="ابحث بالمنتج أو العنوان أو الوصف…"
            loading={query.isLoading}
            errorState={{
              isError: query.isError,
              message: query.error?.message,
              onRetry: () => void query.refetch(),
            }}
            resourceKey="products"
            emptyText="لا مسودّاتٍ تنتظر مراجعتك — كلّ شيء مُطبَّق أو مرفوض."
          />
        </CardContent>
      </Card>
    </div>
  );
}
