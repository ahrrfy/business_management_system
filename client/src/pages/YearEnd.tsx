/**
 * إقفال سنوي + رولوفر Retained Earnings — adminProcedure.
 */
import { PageHeader } from "@/components/PageHeader";
import { AppSelect } from "@/components/ui/AppSelect";
import { DataTable } from "@/components/data-table/DataTable";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { D, formatIqd } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import {
  Check,
  CircleAlert,
  LockOpen,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";

export interface YearEndCloseRequestLike {
  id: number;
  month: string;
  status: string;
  requestedBy: number;
  requestedByName: string;
  requestedAt: Date | string;
}

/**
 * قيمة المخزون المخزَّنة في لقطة الإقفال (`snapshotData.inventoryValue`).
 *
 * أصل المخزون في الميزانية يُقرأ **حيّاً** (`SUM(quantity × costPrice)`) بلا تاريخٍ مرجعيّ، فبلا
 * هذه اللقطة تُحسب ميزانية السنة المقفلة من مخزون **اليوم** لا من مخزون تاريخ إقفالها — ولا يبقى
 * لها أصلٌ يُعاد إنتاجه (تدقيق ٢٧/٧، H5). تُعيد `null` للإقفالات السابقة للّقطة أو للحمولة التالفة،
 * فتُعرَض «غير مسجَّلة» بدل صفرٍ كاذبٍ يُقرأ مخزوناً فارغاً.
 */
export function readSnapshotInventoryValue(snapshotData: unknown): string | null {
  if (typeof snapshotData !== "string" || snapshotData.trim() === "") return null;
  try {
    const parsed = JSON.parse(snapshotData) as { inventoryValue?: unknown };
    const raw = parsed?.inventoryValue;
    if (typeof raw !== "string" && typeof raw !== "number") return null;
    const text = String(raw).trim();
    return text === "" || Number.isNaN(Number(text)) ? null : text;
  } catch {
    return null;
  }
}

/** طلبات ديسمبر المعلّقة التي يمكن أن تسند إقفال السنة المحددة، بلا تسريب طلبات شهور أخرى. */
export function pendingDecemberRequests(
  rows: readonly YearEndCloseRequestLike[] | undefined,
  year: number,
): YearEndCloseRequestLike[] {
  const closingMonth = `${year}-12`;
  return (rows ?? []).filter(
    (row) => row.month === closingMonth && row.status === "PENDING_APPROVAL",
  );
}

/** يطبّق فصل المهام واجهياً؛ الخادم يعيده تحت القفل ويبقى مصدر الحقيقة. */
export function checkerEligibleRequests(
  rows: readonly YearEndCloseRequestLike[],
  reviewerId: number | undefined,
): YearEndCloseRequestLike[] {
  if (reviewerId == null) return [];
  return rows.filter((row) => row.requestedBy !== reviewerId);
}

export interface YearEndDeepLinkSelection {
  year: number;
  requestId: number | null;
}

export type YearEndReopenState =
  | "AVAILABLE"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "HISTORICAL";

/** صفوفٌ مشتقّة من عقد الخادم فلا تنجرف عنه. */
type YearEndSnapshotRow = RouterOutputs["yearEnd"]["list"]["rows"][number];
type ReopenRequestRow = RouterOutputs["yearEnd"]["reopenRequests"]["rows"][number];

/** Only the latest company revision can enter the governed reopen workflow. */
export function yearEndReopenState(
  snapshot: {
    id: number;
    year: number;
    revision: number;
    branchId: number | null;
  },
  snapshots: ReadonlyArray<{
    id: number;
    year: number;
    revision: number;
    branchId: number | null;
  }>,
  requests: ReadonlyArray<{
    snapshotId: number;
    status: string;
    id: number;
  }>,
): YearEndReopenState {
  const latest = snapshots
    .filter((row) => row.year === snapshot.year && row.branchId == null)
    .sort(
      (left, right) => right.revision - left.revision || right.id - left.id,
    )[0];
  if (!latest || latest.id !== snapshot.id) return "HISTORICAL";
  const latestRequest = requests
    .filter((row) => Number(row.snapshotId) === snapshot.id)
    .sort((left, right) => right.id - left.id)[0];
  if (latestRequest?.status === "PENDING_APPROVAL") return "PENDING_APPROVAL";
  if (latestRequest?.status === "APPROVED") return "APPROVED";
  return "AVAILABLE";
}

/** Parse the explicit handoff without guessing a different fiscal year. */
export function yearEndSelectionFromSearch(
  search: string,
  fallbackYear: number,
): YearEndDeepLinkSelection {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const parsedYear = Number(params.get("year"));
  const parsedRequestId = Number(params.get("requestId"));
  return {
    year:
      Number.isInteger(parsedYear) && parsedYear >= 2020 && parsedYear <= 2100
        ? parsedYear
        : fallbackYear,
    requestId:
      Number.isSafeInteger(parsedRequestId) && parsedRequestId > 0
        ? parsedRequestId
        : null,
  };
}

function currentBaghdadYear(now = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Baghdad",
      year: "numeric",
    }).format(now),
  );
}

export default function YearEndPage() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const search = useSearch();
  const currentYear = currentBaghdadYear();
  const deepLinkSelection = useMemo(
    () => yearEndSelectionFromSearch(search, currentYear - 1),
    [currentYear, search],
  );
  const [year, setYear] = useState(deepLinkSelection.year);
  const [requestId, setRequestId] = useState<number | null>(
    deepLinkSelection.requestId,
  );

  const requests = trpc.periodLock.closeRequests.useQuery({
    pendingOnly: true,
  });
  const matchingRequests = useMemo(
    () => pendingDecemberRequests(requests.data, year),
    [requests.data, year],
  );
  const eligibleRequests = useMemo(
    () => checkerEligibleRequests(matchingRequests, me.data?.id),
    [matchingRequests, me.data?.id],
  );
  useEffect(() => {
    setYear(deepLinkSelection.year);
    setRequestId(deepLinkSelection.requestId);
  }, [deepLinkSelection.requestId, deepLinkSelection.year]);
  useEffect(() => {
    if (requests.isLoading || me.isLoading) return;
    setRequestId((current) =>
      eligibleRequests.some((row) => row.id === current)
        ? current
        : (eligibleRequests[0]?.id ?? null),
    );
  }, [eligibleRequests, me.isLoading, requests.isLoading]);

  // فلتر سجل «الإقفالات السابقة» مستقلّ عن نموذج «إقفال سنة جديدة» أعلاه.
  const [histYear, setHistYear] = useState("");
  const histFilters = {
    year: histYear.trim() ? Number(histYear) : undefined,
  };
  const histFiltered = histYear.trim() !== "";
  const list = trpc.yearEnd.list.useQuery(histFilters);
  const reopenRequests = trpc.yearEnd.reopenRequests.useQuery(
    histFiltered ? { year: Number(histYear) } : {},
  );
  const [reopenReason, setReopenReason] = useState("");
  const [decisionReason, setDecisionReason] = useState("");

  const closeMut = trpc.yearEnd.close.useMutation({
    onSuccess: (r) => {
      notify.ok(
        `أُقفلت السنة ${r.year} — صافي الربح ${formatIqd(r.netProfit)}`,
      );
      setRequestId(null);
      void Promise.all([
        utils.yearEnd.list.invalidate(),
        utils.periodLock.status.invalidate(),
        utils.periodLock.history.invalidate(),
        utils.periodLock.closeRequests.invalidate(),
      ]);
    },
    onError: (e) => notify.err(e),
  });

  const refreshYearEnd = () =>
    Promise.all([
      utils.yearEnd.list.invalidate(),
      utils.yearEnd.reopenRequests.invalidate(),
      utils.periodLock.status.invalidate(),
      utils.periodLock.history.invalidate(),
      utils.periodLock.closeRequests.invalidate(),
    ]);
  const requestReopenMut = trpc.yearEnd.requestReopen.useMutation({
    onSuccess: () => {
      notify.ok("سُجّل طلب فتح نهاية السنة بانتظار اعتماد مسؤول آخر.");
      setReopenReason("");
      void refreshYearEnd();
    },
    onError: (e) => notify.err(e),
  });
  const approveReopenMut = trpc.yearEnd.approveReopen.useMutation({
    onSuccess: (result) => {
      notify.ok(
        `فُتحت سنة ${result.year} بقيد عكس #${result.reversalEntryId}؛ أصبح ديسمبر مطلوباً لإعادة الإقفال.`,
      );
      setDecisionReason("");
      void refreshYearEnd();
    },
    onError: (e) => notify.err(e),
  });
  const rejectReopenMut = trpc.yearEnd.rejectReopen.useMutation({
    onSuccess: () => {
      notify.ok("رُفض طلب فتح نهاية السنة مع حفظ القرار.");
      setDecisionReason("");
      void refreshYearEnd();
    },
    onError: (e) => notify.err(e),
  });

  const closingMonth = `${year}-12`;
  const busy = closeMut.isPending || requests.isLoading || me.isLoading;
  const selectedRequest = eligibleRequests.find((row) => row.id === requestId);
  const canApprove = me.data?.role === "admin";

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <PageHeader
        title="الإقفال السنوي"
        description="يعيد فحص جاهزية ديسمبر، ثم يصفّر أرصدة الإيرادات والمصروفات في ٣١ كانون الأول ويرحّل صافي النتيجة إلى الأرباح المحتجزة ويقفل الفترة."
      />

      <Card>
        <CardHeader className="space-y-1">
          <h2 className="font-semibold">إقفال سنة جديدة</h2>
          <p className="text-sm text-muted-foreground">
            الإقفال رسمي على مستوى الشركة كلها، ويعتمد طلب إقفال ديسمبر نفسه بعد
            إعادة فحص الجاهزية.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <label className="text-sm font-medium">السنة</label>
              <input
                type="number"
                value={year}
                min={2020}
                max={2100}
                onChange={(e) =>
                  setYear(Number(e.target.value) || currentYear - 1)
                }
                className="h-9 px-3 rounded-md border bg-transparent text-sm"
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">نطاق الإقفال</label>
              <Input
                value="الشركة كلها"
                readOnly
                aria-label="نطاق الإقفال السنوي"
              />
            </div>
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="year-end-request">
              طلب إقفال ديسمبر ({closingMonth})
            </label>
            <AppSelect
              id="year-end-request"
              value={String(requestId ?? "")}
              onValueChange={(next) =>
                setRequestId(next ? Number(next) : null)
              }
              className="h-9 px-3 text-sm"
              disabled={busy || eligibleRequests.length === 0}
            >
              <option value="">اختر طلباً معلّقاً مطابقاً</option>
              {eligibleRequests.map((row) => (
                <option key={row.id} value={row.id}>
                  طلب #{row.id} — الطالب: {row.requestedByName} —{" "}
                  {fmtDate(row.requestedAt)}
                </option>
              ))}
            </AppSelect>
          </div>

          {requests.error && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 p-3 text-sm text-destructive">
              <span className="inline-flex items-center gap-2">
                <CircleAlert aria-hidden className="size-4" />
                تعذّر تحميل طلبات الإقفال؛ حُجب الإقفال السنوي حتى تُستعاد
                بيانات الحوكمة.
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => requests.refetch()}
              >
                إعادة المحاولة
              </Button>
            </div>
          )}

          {!requests.isLoading &&
            !requests.error &&
            matchingRequests.length === 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
                <span className="inline-flex items-center gap-2 text-muted-foreground">
                  <CircleAlert aria-hidden className="size-4" />
                  لا يوجد طلب إقفال معلّق لشهر {closingMonth}. أنشئ طلب ديسمبر
                  من الحزمة الشهرية أولاً.
                </span>
                <Button asChild size="sm" variant="outline">
                  <Link href="/closing?tab=monthly">فتح الحزمة الشهرية</Link>
                </Button>
              </div>
            )}

          {!me.isLoading &&
            matchingRequests.length > 0 &&
            eligibleRequests.length === 0 && (
              <div className="flex items-center gap-2 rounded-md border p-3 text-sm text-muted-foreground">
                <CircleAlert aria-hidden className="size-4 shrink-0" />
                أنشأ هذا الحساب طلب ديسمبر المعلّق؛ يلزم مسؤول آخر لاعتماد
                الإقفال السنوي تحقيقاً لفصل المهام.
              </div>
            )}

          <Button
            onClick={async () => {
              if (!selectedRequest) return;
              if (
                await confirm({
                  title: `إقفال سنة ${year}`,
                  description: `سيُعتمد طلب ديسمبر #${selectedRequest.id} وتُغلق الكتابة على الشركة كلها حتى 31/12/${year}. سيعيد الخادم فحص الجاهزية، ولا يمكن فتح الفترة إلا بإجراء إداري مدقّق.`,
                  variant: "danger",
                })
              ) {
                closeMut.mutate({ year, requestId: selectedRequest.id });
              }
            }}
            disabled={
              busy || !canApprove || !selectedRequest || !!requests.error
            }
            variant="destructive"
          >
            اعتماد الطلب وتطبيق الإقفال
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="space-y-1">
          <h2 className="font-semibold">فتح نهاية سنة وإعادة إقفالها</h2>
          <p className="text-sm text-muted-foreground">
            طلبٌ من صانع، واعتمادٌ من مسؤول آخر. الاعتماد يعكس قيد الإقفال
            السابق سطراً بسطر ويفتح ديسمبر؛ ثم يلزم طلب ديسمبر جديد لإصدار
            مراجعة وشهادة تاليتين دون تعديل السجل السابق.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2">
            <Label htmlFor="year-reopen-reason">سبب الطلب أو القرار</Label>
            <Input
              id="year-reopen-reason"
              value={reopenReason}
              onChange={(event) => setReopenReason(event.target.value)}
              placeholder="سبب تفصيلي لطلب فتح أحدث مراجعة (١٠ أحرف على الأقل)"
              maxLength={500}
            />
            <Input
              value={decisionReason}
              onChange={(event) => setDecisionReason(event.target.value)}
              placeholder="سبب اعتماد/رفض الطلب (٥ أحرف على الأقل)"
              maxLength={500}
              aria-label="سبب قرار فتح نهاية السنة"
            />
          </div>

          {(reopenRequests.data?.rows ?? []).filter(
            (row) => row.status === "PENDING_APPROVAL",
          ).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              لا توجد طلبات فتح معلّقة.
            </p>
          ) : (
            /* لوحةٌ صغيرة مُضمَّنة داخل بطاقة الطلبات ⇒ بلا شريط حالةٍ ولا منتقي أعمدة. */
            <DataTable<ReopenRequestRow>
              embedded
              searchable={false}
              bounded={false}
              pageSize={Infinity}
              data={(reopenRequests.data?.rows ?? []).filter(
                (row) => row.status === "PENDING_APPROVAL",
              )}
              emptyText="لا توجد طلبات فتح معلّقة."
              columns={[
                {
                  id: "id",
                  header: "الطلب",
                  accessorFn: (row) => `#${row.id}`,
                  meta: { kind: "code", width: "id" },
                  cell: ({ row }) => `#${row.original.id}`,
                },
                {
                  id: "yearRevision",
                  header: "السنة/المراجعة",
                  accessorFn: (row) =>
                    `${row.year} / R${
                      list.data?.rows.find(
                        (snapshot) => Number(snapshot.id) === Number(row.snapshotId),
                      )?.revision ?? "—"
                    }`,
                  cell: ({ row }) => (
                    <>
                      {row.original.year} / R
                      {list.data?.rows.find(
                        (snapshot) => Number(snapshot.id) === Number(row.original.snapshotId),
                      )?.revision ?? "—"}
                    </>
                  ),
                },
                {
                  id: "requestedBy",
                  header: "الطالب",
                  accessorFn: (row) => row.requestedByName,
                  meta: { width: "actor" },
                  cell: ({ row }) => row.original.requestedByName,
                },
                {
                  id: "reason",
                  header: "السبب",
                  accessorFn: (row) => row.reason,
                  meta: { width: "wide", wrap: true },
                  cell: ({ row }) => row.original.reason,
                },
                {
                  id: "decision",
                  header: "القرار",
                  enableSorting: false,
                  meta: { align: "center" },
                  // فصلُ المهام كما كان: لا يعتمد الطالبُ طلبَه، ولا يعتمد غيرُ المخوَّل.
                  cell: ({ row }) =>
                    !canApprove || Number(row.original.requestedBy) === Number(me.data?.id) ? (
                      <span className="text-muted-foreground">يلزم أدمن آخر عن الطالب</span>
                    ) : (
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={
                            decisionReason.trim().length < 5 ||
                            approveReopenMut.isPending ||
                            rejectReopenMut.isPending
                          }
                          onClick={() =>
                            approveReopenMut.mutate({
                              requestId: Number(row.original.id),
                              decisionReason,
                            })
                          }
                        >
                          <Check aria-hidden className="size-3.5" />
                          اعتماد وفتح
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            decisionReason.trim().length < 5 ||
                            approveReopenMut.isPending ||
                            rejectReopenMut.isPending
                          }
                          onClick={() =>
                            rejectReopenMut.mutate({
                              requestId: Number(row.original.id),
                              decisionReason,
                            })
                          }
                        >
                          <X aria-hidden className="size-3.5" />
                          رفض
                        </Button>
                      </div>
                    ),
                },
              ]}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <span className="font-semibold">الإقفالات السابقة</span>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">السنة</Label>
              <Input
                type="number"
                value={histYear}
                onChange={(e) => setHistYear(e.target.value)}
                placeholder="كل السنوات"
                className="h-9 w-32"
              />
            </div>
            {histFiltered && (
              <Button variant="ghost" size="sm" onClick={() => setHistYear("")}>
                إعادة ضبط
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <DataTable<YearEndSnapshotRow>
            data={list.data?.rows ?? []}
            loading={list.isLoading}
            errorState={{ isError: list.isError, message: list.error?.message, onRetry: () => void list.refetch() }}
            /* فلتر السنة في رأس البطاقة (يغذّي الاستعلام) — بلا هذا تُعلَن «لا صفوف بعد» زوراً. */
            searchable={false}
            externalFiltersActive={histFiltered}
            emptyState="لا إقفالات سابقة"
            emptyFilteredState="لا إقفالات مطابقة للفلاتر"
            columns={[
              {
                id: "year",
                header: "السنة",
                accessorFn: (s) => s.year,
                meta: { kind: "number", align: "center" },
                cell: ({ row }) => <span className="font-medium">{row.original.year}</span>,
              },
              {
                id: "revision",
                header: "المراجعة",
                accessorFn: (s) => `R${s.revision}`,
                meta: { kind: "code", width: "id" },
                cell: ({ row }) => `R${row.original.revision}`,
              },
              {
                id: "scope",
                header: "النطاق",
                accessorFn: (s) => (s.branchId == null ? "الشركة كلها" : `إقفال فرعي قديم #${s.branchId}`),
                cell: ({ row }) =>
                  row.original.branchId == null ? "الشركة كلها" : `إقفال فرعي قديم #${row.original.branchId}`,
              },
              {
                id: "totalRevenue",
                header: "الإيراد",
                accessorFn: (s) => formatIqd(s.totalRevenue),
                meta: { kind: "money" },
                cell: ({ row }) => formatIqd(row.original.totalRevenue),
              },
              {
                id: "totalCogs",
                header: "التكلفة",
                accessorFn: (s) => formatIqd(s.totalCogs),
                meta: { kind: "money" },
                cell: ({ row }) => formatIqd(row.original.totalCogs),
              },
              {
                id: "totalExpenses",
                header: "المصاريف",
                accessorFn: (s) => formatIqd(s.totalExpenses),
                meta: { kind: "money" },
                cell: ({ row }) => formatIqd(row.original.totalExpenses),
              },
              {
                id: "netProfit",
                header: "صافي الربح",
                accessorFn: (s) => {
                  const net = D(s.netProfit);
                  return net.isNegative() ? `(${formatIqd(net.abs().toFixed(2))})` : formatIqd(net.toFixed(2));
                },
                meta: { kind: "money" },
                cell: ({ row }) => {
                  const net = D(row.original.netProfit);
                  const isProfit = !net.isNegative();
                  return (
                    <span
                      className={`inline-flex items-center gap-1.5 font-semibold ${isProfit ? "text-money-positive" : "text-money-negative"}`}
                      aria-label={isProfit ? "ربح" : "خسارة"}
                    >
                      {isProfit ? <TrendingUp className="size-4" aria-hidden="true" /> : <TrendingDown className="size-4" aria-hidden="true" />}
                      {isProfit ? formatIqd(net.toFixed(2)) : `(${formatIqd(net.abs().toFixed(2))})`}
                    </span>
                  );
                },
              },
              {
                /* أصل المخزون يُقرأ حيّاً بلا تاريخ ⇒ بلا هذه اللقطة تُحسب ميزانية السنة
                   المقفلة من مخزون اليوم لا من مخزون تاريخ إقفالها (تدقيق ٢٧/٧، H5). */
                id: "snapshotInventory",
                header: "المخزون لحظة الإقفال",
                accessorFn: (s) => {
                  const value = readSnapshotInventoryValue(s.snapshotData);
                  return value == null ? "غير مسجَّلة (إقفالٌ سابق للّقطة)" : formatIqd(value);
                },
                meta: { kind: "money" },
                cell: ({ row }) => {
                  const snapshotInventory = readSnapshotInventoryValue(row.original.snapshotData);
                  return snapshotInventory == null ? (
                    <span className="text-xs text-muted-foreground">غير مسجَّلة (إقفالٌ سابق للّقطة)</span>
                  ) : (
                    formatIqd(snapshotInventory)
                  );
                },
              },
              {
                id: "closedAt",
                header: "تاريخ الإقفال",
                accessorFn: (s) => fmtDate(s.closedAt),
                meta: { kind: "date" },
                cell: ({ row }) => <span className="text-muted-foreground">{fmtDate(row.original.closedAt)}</span>,
              },
              {
                id: "reopen",
                header: "فتح مدقّق",
                enableSorting: false,
                /* حالةُ الفتح بيانٌ لا إجراء في ثلاثٍ من أربع حالات ⇒ لها قيمةٌ تُنسَخ وتُصدَّر. */
                accessorFn: (s) => {
                  const state = yearEndReopenState(
                    s,
                    list.data?.rows ?? [],
                    reopenRequests.data?.rows ?? [],
                  );
                  if (state === "PENDING_APPROVAL") return "بانتظار الاعتماد";
                  if (state === "APPROVED") return "مفتوحة — أعد إقفال ديسمبر";
                  if (state === "HISTORICAL") return "مراجعة سابقة محفوظة";
                  return "قابلة لطلب الفتح";
                },
                meta: { align: "center" },
                cell: ({ row }) => {
                  const state = yearEndReopenState(
                    row.original,
                    list.data?.rows ?? [],
                    reopenRequests.data?.rows ?? [],
                  );
                  if (state === "PENDING_APPROVAL") return "بانتظار الاعتماد";
                  if (state === "APPROVED") return "مفتوحة — أعد إقفال ديسمبر";
                  if (state === "HISTORICAL") return "مراجعة سابقة محفوظة";
                  return (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={reopenReason.trim().length < 10 || requestReopenMut.isPending}
                      onClick={() =>
                        requestReopenMut.mutate({
                          snapshotId: Number(row.original.id),
                          reason: reopenReason,
                          clientRequestId: crypto.randomUUID(),
                        })
                      }
                    >
                      <LockOpen aria-hidden className="size-3.5" />
                      طلب فتح
                    </Button>
                  );
                },
              },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
