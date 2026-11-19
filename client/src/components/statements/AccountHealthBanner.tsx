import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirm } from "@/lib/confirm";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, ShieldAlert } from "lucide-react";
import { Link } from "wouter";

export interface AccountAnomalyItem {
  id: string;
  kind:
    | "ANOMALOUS_USD_RATE"
    | "SUPPLIER_USD_DRIFT"
    | "UNCLASSIFIED_SUPPLIER_RECEIPT"
    | "CROSS_BRANCH_CUSTOMER_CREDIT"
    | "LEDGER_BALANCE_DRIFT";
  severity: "critical" | "warning" | "info";
  partyType: "SUPPLIER" | "CUSTOMER";
  partyId: number;
  partyName: string;
  branchId: number | null;
  branchName: string | null;
  title: string;
  description: string;
  recommendedAction:
    | "ALIGN_SUPPLIER_USD"
    | "RECLASSIFY_RECEIPT"
    | "RECONCILE_CROSS_BRANCH"
    | "REVIEW_PO_RATE"
    | "RECONCILE_LEDGER";
  targetHref?: string | null;
  metrics: {
    expectedAmount?: string | null;
    actualAmount?: string | null;
    deltaAmount?: string | null;
    currency?: "IQD" | "USD";
    rate?: string | null;
  };
  metadata: Record<string, string | number | boolean | null>;
}

export interface AccountHealthBannerProps {
  partyType: "SUPPLIER" | "CUSTOMER";
  partyId: number;
  branchId?: number;
  onResolved?: () => void;
}

function severityLabel(severity: AccountAnomalyItem["severity"]): string {
  if (severity === "critical") return "حرج";
  if (severity === "warning") return "تنبيه";
  return "معلومة";
}

function severityVariant(severity: AccountAnomalyItem["severity"]): "destructive" | "warning" | "info" {
  if (severity === "critical") return "destructive";
  if (severity === "warning") return "warning";
  return "info";
}

const NOOP_QUERY_RES = {
  data: undefined as { anomalies?: AccountAnomalyItem[] } | undefined,
  isLoading: false,
  isFetching: false,
  refetch: async () => undefined,
};
type AnomalyQueryResult = {
  data?: { anomalies?: AccountAnomalyItem[] };
  isLoading?: boolean;
  isFetching?: boolean;
  refetch: () => Promise<unknown>;
};
function useOptionalAnomalyQuery<TArgs extends unknown[]>(
  hookFn: ((...args: TArgs) => AnomalyQueryResult) | undefined,
  ...args: TArgs
): AnomalyQueryResult {
  return hookFn ? hookFn(...args) : NOOP_QUERY_RES;
}

function useOptionalAnomalyMutation<TInput, TOutput>(
  hookFn: ((opts?: { onSuccess?: (res: TOutput) => void; onError?: (e: unknown) => void }) => {
    mutate: (input: TInput) => void;
    isPending: boolean;
  }) | undefined,
  opts?: { onSuccess?: (res: TOutput) => void; onError?: (e: unknown) => void },
) {
  return hookFn ? hookFn(opts) : { mutate: (_input: TInput) => undefined, isPending: false };
}

export function AccountHealthBanner({
  partyType,
  partyId,
  branchId,
  onResolved,
}: AccountHealthBannerProps) {
  const utils = trpc.useUtils();
  const suppliersNs = trpc.suppliers as
    | {
        anomalies?: { useQuery?: typeof trpc.suppliers.anomalies.useQuery };
        alignUsdBalance?: { useMutation?: typeof trpc.suppliers.alignUsdBalance.useMutation };
        reclassifyReceipt?: { useMutation?: typeof trpc.suppliers.reclassifyReceipt.useMutation };
      }
    | undefined;
  const customersNs = trpc.customers as
    | {
        anomalies?: { useQuery?: typeof trpc.customers.anomalies.useQuery };
        reconcileCrossBranch?: { useMutation?: typeof trpc.customers.reconcileCrossBranch.useMutation };
      }
    | undefined;

  const supplierQ = useOptionalAnomalyQuery(
    suppliersNs?.anomalies?.useQuery as ((...args: unknown[]) => AnomalyQueryResult) | undefined,
    { supplierId: partyId, branchId },
    { enabled: partyType === "SUPPLIER" && partyId > 0, retry: false },
  );
  const customerQ = useOptionalAnomalyQuery(
    customersNs?.anomalies?.useQuery as ((...args: unknown[]) => AnomalyQueryResult) | undefined,
    { customerId: partyId, branchId },
    { enabled: partyType === "CUSTOMER" && partyId > 0, retry: false },
  );

  async function invalidateParty() {
    await Promise.all([
      utils?.suppliers?.invalidate?.(),
      utils?.customers?.invalidate?.(),
      utils?.reports?.invalidate?.(),
      utils?.vouchers?.invalidate?.(),
    ]);
    onResolved?.();
  }

  const alignUsdMut = useOptionalAnomalyMutation(
    suppliersNs?.alignUsdBalance?.useMutation as
      | ((opts?: {
          onSuccess?: (res: { usdBefore: string; usdAfter: string }) => void;
          onError?: (e: unknown) => void;
        }) => { mutate: (input: { supplierId: number; clientRequestId?: string }) => void; isPending: boolean })
      | undefined,
    {
      onSuccess: async (res) => {
        await invalidateParty();
        notify.ok(
          "تمت مواءمة عداد الدولار",
          `الرصيد قبل: $${fmt(res.usdBefore)} — بعد: $${fmt(res.usdAfter)}`,
        );
      },
      onError: (e) => notify.err(e),
    },
  );

  const reclassifyMut = useOptionalAnomalyMutation(
    suppliersNs?.reclassifyReceipt?.useMutation as
      | ((opts?: {
          onSuccess?: (res: { action: string; cancelledImmediately?: boolean }) => void;
          onError?: (e: unknown) => void;
        }) => {
          mutate: (input: {
            receiptId: number;
            action: "CONFIRM_CREDIT_OBLIGATION" | "REVERSE_RECEIPT";
            reason?: string;
            clientRequestId?: string;
          }) => void;
          isPending: boolean;
        })
      | undefined,
    {
      onSuccess: async (res) => {
        await invalidateParty();
        notify.ok(
          res.action === "CONFIRM_CREDIT_OBLIGATION"
            ? "تم تثبيت السند كتسوية دائن على المورد"
            : res.cancelledImmediately
              ? "تم عكس السند نظامياً"
              : "تم إرسال طلب عكس السند للاعتماد",
        );
      },
      onError: (e) => notify.err(e),
    },
  );

  const reconcileBranchMut = useOptionalAnomalyMutation(
    customersNs?.reconcileCrossBranch?.useMutation as
      | ((opts?: {
          onSuccess?: (res: { settledAmount: string }) => void;
          onError?: (e: unknown) => void;
        }) => {
          mutate: (input: {
            customerId: number;
            sourceBranchId: number;
            targetBranchId: number;
            invoiceId?: number;
            amount?: string;
            note?: string;
            clientRequestId?: string;
          }) => void;
          isPending: boolean;
        })
      | undefined,
    {
      onSuccess: async (res) => {
        await invalidateParty();
        notify.ok("تمت مقاصة الرصيد بين الفروع", `المبلغ المسوّى: ${fmt(res.settledAmount)} د.ع`);
      },
      onError: (e) => notify.err(e),
    },
  );

  const anomalies: AccountAnomalyItem[] =
    (partyType === "SUPPLIER" ? supplierQ.data?.anomalies : customerQ.data?.anomalies) ?? [];

  if (anomalies.length === 0) return null;

  const isBusy = alignUsdMut.isPending || reclassifyMut.isPending || reconcileBranchMut.isPending;

  async function handleAlignUsd(a: AccountAnomalyItem) {
    const ok = await confirm({
      variant: "info",
      title: "مواءمة عداد الدولار المرجعي",
      description: `سيتم ضبط رصيد الدولار إلى مجموع الفواتير الدولارية المفتوحة (${fmt(a.metrics.expectedAmount ?? "0")} $) بدلاً من (${fmt(a.metrics.actualAmount ?? "0")} $) مع تسجيل إثبات التدقيق دون المساس بالذمة الدينارية.`,
      confirmText: "تأكيد المواءمة",
      cancelText: "تراجع",
    });
    if (ok) alignUsdMut.mutate({ supplierId: partyId });
  }

  async function handleReclassify(a: AccountAnomalyItem, action: "CONFIRM_CREDIT_OBLIGATION" | "REVERSE_RECEIPT") {
    const receiptId = Number(a.metadata?.receiptId ?? 0);
    if (!receiptId) return;
    const ok = await confirm({
      variant: action === "REVERSE_RECEIPT" ? "danger" : "info",
      title: action === "CONFIRM_CREDIT_OBLIGATION" ? "تثبيت سند القبض على حساب المورد" : "عكس سند القبض",
      description:
        action === "CONFIRM_CREDIT_OBLIGATION"
          ? "سيُصنَّف السند كالتزام دائن مشروع يرفع حساب المورد (له علينا) دون حظر التسوية."
          : "سيُعكس أثر السند في الصندوق ودفتر الأستاذ.",
      confirmText: action === "CONFIRM_CREDIT_OBLIGATION" ? "تثبيت التصنيف" : "تنفيذ العكس",
      cancelText: "تراجع",
    });
    if (ok) reclassifyMut.mutate({ receiptId, action });
  }

  async function handleCrossBranch(a: AccountAnomalyItem) {
    const sourceBranchId = Number(a.metadata?.sourceBranchId ?? 0);
    const targetBranchId = Number(a.metadata?.targetBranchId ?? 0);
    const invoiceId = a.metadata?.invoiceId ? Number(a.metadata.invoiceId) : undefined;
    if (!sourceBranchId || !targetBranchId) return;
    const ok = await confirm({
      variant: "info",
      title: "مقاصة الرصيد الدائن بين الفروع",
      description: `سيتم ترحيل قيد مقاصة آلي بمبلغ ${fmt(a.metrics.deltaAmount ?? a.metrics.actualAmount ?? "0")} د.ع لتسوية الفاتورة المفتوحة بين الفرعين.`,
      confirmText: "تنفيذ المقاصة",
      cancelText: "تراجع",
    });
    if (ok) {
      reconcileBranchMut.mutate({
        customerId: partyId,
        sourceBranchId,
        targetBranchId,
        invoiceId,
        amount: a.metrics.deltaAmount ?? a.metrics.actualAmount ?? undefined,
      });
    }
  }

  const hasCritical = anomalies.some((a) => a.severity === "critical");

  return (
    <div
      role="region"
      aria-label="تنبيهات صحة الحساب"
      className={`rounded-md border p-3 space-y-2.5 text-xs ${
        hasCritical
          ? "border-[var(--sem-neg)]/50 bg-[var(--sem-neg-bg)]/40"
          : "border-[var(--sem-warn)]/50 bg-[var(--sem-warn-bg)]/40"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold">
          {hasCritical ? (
            <ShieldAlert aria-hidden className="size-4 text-[var(--sem-neg)] shrink-0" />
          ) : (
            <AlertTriangle aria-hidden className="size-4 text-[var(--sem-warn)] shrink-0" />
          )}
          <span>كاشف الشذوذ التلقائي ({anomalies.length})</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs gap-1"
          disabled={isBusy}
          onClick={() => void (partyType === "SUPPLIER" ? supplierQ.refetch() : customerQ.refetch())}
        >
          <RefreshCw aria-hidden className={`size-3 ${(supplierQ.isFetching || customerQ.isFetching) ? "animate-spin" : ""}`} />
          <span>فحص</span>
        </Button>
      </div>

      <div className="space-y-2">
        {anomalies.map((a) => (
          <div
            key={a.id}
            className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded border border-border/60 bg-background/85 p-2.5"
          >
            <div className="space-y-1 min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={severityVariant(a.severity)}>{severityLabel(a.severity)}</Badge>
                <span className="font-semibold text-foreground">{a.title}</span>
              </div>
              <p className="text-muted-foreground leading-relaxed">{a.description}</p>
              {(a.metrics.expectedAmount || a.metrics.actualAmount || a.metrics.deltaAmount) && (
                <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground tabular-nums">
                  {a.metrics.expectedAmount && (
                    <span>
                      الموثق: <bdi dir="ltr">{fmt(a.metrics.expectedAmount)} {a.metrics.currency === "USD" ? "$" : "د.ع"}</bdi>
                    </span>
                  )}
                  {a.metrics.actualAmount && (
                    <span>
                      الحالي: <bdi dir="ltr">{fmt(a.metrics.actualAmount)} {a.metrics.currency === "USD" ? "$" : "د.ع"}</bdi>
                    </span>
                  )}
                  {a.metrics.deltaAmount && (
                    <span className="font-semibold text-foreground">
                      الفرق: <bdi dir="ltr">{fmt(a.metrics.deltaAmount)} {a.metrics.currency === "USD" ? "$" : "د.ع"}</bdi>
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
              {a.recommendedAction === "ALIGN_SUPPLIER_USD" && (
                <Button type="button" size="sm" className="h-7 text-xs gap-1" disabled={isBusy} onClick={() => void handleAlignUsd(a)}>
                  <CheckCircle2 aria-hidden className="size-3.5" />
                  <span>مواءمة عداد الدولار</span>
                </Button>
              )}
              {a.recommendedAction === "RECLASSIFY_RECEIPT" && (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={isBusy}
                    onClick={() => void handleReclassify(a, "CONFIRM_CREDIT_OBLIGATION")}
                  >
                    تثبيت كتسوية ترفع الحساب
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    className="h-7 text-xs"
                    disabled={isBusy}
                    onClick={() => void handleReclassify(a, "REVERSE_RECEIPT")}
                  >
                    عكس نظامي
                  </Button>
                </>
              )}
              {a.recommendedAction === "RECONCILE_CROSS_BRANCH" && (
                <Button type="button" size="sm" className="h-7 text-xs" disabled={isBusy} onClick={() => void handleCrossBranch(a)}>
                  تنفيذ مقاصة الفروع
                </Button>
              )}
              {a.targetHref && (
                <Button asChild type="button" size="sm" variant="outline" className="h-7 text-xs gap-1">
                  <Link href={a.targetHref}>
                    <span>مراجعة</span>
                    <ExternalLink aria-hidden className="size-3" />
                  </Link>
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
