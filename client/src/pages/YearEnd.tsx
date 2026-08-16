/**
 * إقفال سنوي + رولوفر Retained Earnings — adminProcedure.
 */
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { D, formatIqd } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
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
            <select
              id="year-end-request"
              value={requestId ?? ""}
              onChange={(e) =>
                setRequestId(e.target.value ? Number(e.target.value) : null)
              }
              className="h-9 rounded-md border bg-transparent px-3 text-sm"
              disabled={busy || eligibleRequests.length === 0}
            >
              <option value="">اختر طلباً معلّقاً مطابقاً</option>
              {eligibleRequests.map((row) => (
                <option key={row.id} value={row.id}>
                  طلب #{row.id} — الطالب: {row.requestedByName} —{" "}
                  {fmtDate(row.requestedAt)}
                </option>
              ))}
            </select>
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
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="p-2 text-right">الطلب</th>
                    <th className="p-2 text-right">السنة/المراجعة</th>
                    <th className="p-2 text-right">الطالب</th>
                    <th className="p-2 text-right">السبب</th>
                    <th className="p-2 text-right">القرار</th>
                  </tr>
                </thead>
                <tbody>
                  {(reopenRequests.data?.rows ?? [])
                    .filter((row) => row.status === "PENDING_APPROVAL")
                    .map((row) => (
                      <tr key={row.id} className="border-t">
                        <td className="p-2">#{row.id}</td>
                        <td className="p-2">
                          {row.year} / R
                          {list.data?.rows.find(
                            (snapshot) =>
                              Number(snapshot.id) === Number(row.snapshotId),
                          )?.revision ?? "—"}
                        </td>
                        <td className="p-2">{row.requestedByName}</td>
                        <td className="p-2">{row.reason}</td>
                        <td className="p-2">
                          {!canApprove ||
                          Number(row.requestedBy) === Number(me.data?.id) ? (
                            <span className="text-muted-foreground">
                              يلزم أدمن آخر عن الطالب
                            </span>
                          ) : (
                            <div className="flex flex-wrap gap-2">
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
                                    requestId: Number(row.id),
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
                                    requestId: Number(row.id),
                                    decisionReason,
                                  })
                                }
                              >
                                <X aria-hidden className="size-3.5" />
                                رفض
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </ScrollTableShell>
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
          {list.isLoading ? (
            <LoadingState />
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm border-collapse">
                <thead className="bg-muted">
                  <tr>
                    <th className="text-right p-2 border">السنة</th>
                    <th className="text-right p-2 border">المراجعة</th>
                    <th className="text-right p-2 border">النطاق</th>
                    <th className="text-right p-2 border">الإيراد</th>
                    <th className="text-right p-2 border">التكلفة</th>
                    <th className="text-right p-2 border">المصاريف</th>
                    <th className="text-right p-2 border">صافي الربح</th>
                    <th className="text-right p-2 border">تاريخ الإقفال</th>
                    <th className="text-right p-2 border">فتح مدقّق</th>
                  </tr>
                </thead>
                <tbody>
                  {(list.data?.rows.length ?? 0) === 0 ? (
                    <TableEmptyRow
                      colSpan={9}
                      message={
                        histFiltered
                          ? "لا إقفالات مطابقة للفلاتر"
                          : "لا إقفالات سابقة"
                      }
                    />
                  ) : (
                    list.data!.rows.map((s: any) => {
                      const net = D(s.netProfit);
                      const isProfit = !net.isNegative();
                      const branchName =
                        s.branchId == null
                          ? "الشركة كلها"
                          : `إقفال فرعي قديم #${s.branchId}`;
                      return (
                        <tr key={s.id} className="hover:bg-accent/40">
                          <td className="p-2 border font-medium">{s.year}</td>
                          <td className="p-2 border">R{s.revision}</td>
                          <td className="p-2 border">{branchName}</td>
                          <td className="p-2 border">
                            {formatIqd(s.totalRevenue)}
                          </td>
                          <td className="p-2 border">
                            {formatIqd(s.totalCogs)}
                          </td>
                          <td className="p-2 border">
                            {formatIqd(s.totalExpenses)}
                          </td>
                          <td
                            className={`p-2 border font-semibold ${isProfit ? "text-money-positive" : "text-money-negative"}`}
                          >
                            <span
                              className="inline-flex items-center gap-1.5"
                              aria-label={isProfit ? "ربح" : "خسارة"}
                            >
                              {isProfit ? (
                                <TrendingUp
                                  className="size-4"
                                  aria-hidden="true"
                                />
                              ) : (
                                <TrendingDown
                                  className="size-4"
                                  aria-hidden="true"
                                />
                              )}
                              {isProfit
                                ? formatIqd(net.toFixed(2))
                                : `(${formatIqd(net.abs().toFixed(2))})`}
                            </span>
                          </td>
                          <td className="p-2 border text-muted-foreground">
                            {fmtDate(s.closedAt)}
                          </td>
                          <td className="p-2 border">
                            {(() => {
                              const state = yearEndReopenState(
                                s,
                                list.data!.rows,
                                reopenRequests.data?.rows ?? [],
                              );
                              if (state === "PENDING_APPROVAL")
                                return "بانتظار الاعتماد";
                              if (state === "APPROVED")
                                return "مفتوحة — أعد إقفال ديسمبر";
                              if (state === "HISTORICAL")
                                return "مراجعة سابقة محفوظة";
                              return (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={
                                    reopenReason.trim().length < 10 ||
                                    requestReopenMut.isPending
                                  }
                                  onClick={() =>
                                    requestReopenMut.mutate({
                                      snapshotId: Number(s.id),
                                      reason: reopenReason,
                                      clientRequestId: crypto.randomUUID(),
                                    })
                                  }
                                >
                                  <LockOpen aria-hidden className="size-3.5" />
                                  طلب فتح
                                </Button>
                              );
                            })()}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </ScrollTableShell>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
