/**
 * **شاشة «الطلبات المحفوظة والمسودات»** — شاشةٌ قائمةٌ بذاتها في مركز عمليات الاستقبال.
 *
 * متابعة وإدارة ومعالجة كافة المسودات والطلبات المحفوظة:
 * - فرز الطلبات الممولة التي عليها عربون محتجز (moneyLocked).
 * - فرز الطلبات المعلقة لأكثر من 24 ساعة (Stale Drafts).
 * - إكمال الطلب ونقله إلى الكاشير للتثبيت إلى فواتير وأوامر شغل.
 * - معاينة بنود الطلب وإيصالات العرابين ورد العربون أو إلغاء المسودة.
 */
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Banknote,
  Calendar,
  Clock,
  ExternalLink,
  Eye,
  Phone,
  RefreshCw,
  Search,
  Trash2,
  User,
  X,
} from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import StationPageHeader from "@/components/StationPageHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { useSearch } from "wouter";

type DraftItem = RouterOutputs["reception"]["draftList"]["rows"][number];

export default function ReceptionDraftsPage() {
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId != null ? Number(me.data.branchId) : null;
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";

  const searchStr = useSearch();
  const urlParams = useMemo(() => new URLSearchParams(searchStr), [searchStr]);
  const initialDraftId = urlParams.get("draftId") ? Number(urlParams.get("draftId")) : null;

  // فلاتر القائمة
  const [filterTab, setFilterTab] = useState<"ALL" | "FUNDED" | "STALE" | "MINE">("FUNDED");
  const [statusFilter, setStatusFilter] = useState<"OPEN" | "COMMITTED" | "CANCELLED">("OPEN");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDraftId, setSelectedDraftId] = useState<number | null>(initialDraftId);

  const draftsQ = trpc.reception.draftList.useQuery(
    {
      branchId: branchId ?? 0,
      status: statusFilter,
      mine: filterTab === "MINE" ? true : undefined,
      fundedOnly: filterTab === "FUNDED" ? true : undefined,
      staleOnly: filterTab === "STALE" ? true : undefined,
      q: searchQuery.trim() || undefined,
      limit: 50,
    },
    { enabled: branchId != null, staleTime: 10_000, refetchInterval: 30_000 },
  );

  const drafts = draftsQ.data?.rows ?? [];

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-5 space-y-4">
      <StationPageHeader
        title="الطلبات المحفوظة والمسودات"
        description="متابعة ومعالجة الطلبات المحفوظة والمسودات المعلقة — افتح الطلب في الكاشير لإكماله، عاين تفاصيل العرابين المقبوضة، أو رد العربون وألغِ الطلب."
        Icon={Archive}
        count={drafts.length}
        countLabel="طلباً في القائمة"
      />

      {branchId == null ? (
        <NoBranchNotice />
      ) : (
        <>
          {/* شريط أدوات الفرز والبحث */}
          <Card className="flex flex-row flex-wrap items-center justify-between gap-3 p-3 shadow-xs">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg border bg-muted/50 p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setFilterTab("FUNDED")}
                  className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 transition-colors ${
                    filterTab === "FUNDED" ? "bg-background text-foreground shadow-xs font-bold" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Banknote className="size-3.5 text-[var(--sem-warn)]" />
                  الممولة (عليها عربون)
                </button>
                <button
                  type="button"
                  onClick={() => setFilterTab("STALE")}
                  className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 transition-colors ${
                    filterTab === "STALE" ? "bg-background text-foreground shadow-xs font-bold" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Clock className="size-3.5 text-destructive" />
                  المعلقة (+24 ساعة)
                </button>
                <button
                  type="button"
                  onClick={() => setFilterTab("ALL")}
                  className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 transition-colors ${
                    filterTab === "ALL" ? "bg-background text-foreground shadow-xs font-bold" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  الكل
                </button>
                <button
                  type="button"
                  onClick={() => setFilterTab("MINE")}
                  className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 transition-colors ${
                    filterTab === "MINE" ? "bg-background text-foreground shadow-xs font-bold" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  مسوداتي
                </button>
              </div>

              {/* فلتر حالة المسودة */}
              <div className="inline-flex rounded-lg border bg-muted/30 p-0.5 text-xs">
                {(["OPEN", "COMMITTED", "CANCELLED"] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setStatusFilter(st)}
                    className={`rounded-md px-2 py-1 transition-colors ${
                      statusFilter === st
                        ? "bg-primary text-primary-foreground font-bold shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {st === "OPEN" ? "مفتوحة" : st === "COMMITTED" ? "مثبتة" : "ملغاة"}
                  </button>
                ))}
              </div>
            </div>

            {/* حقل البحث وزر التحديث */}
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute right-2.5 top-2.5 size-3.5 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="بحث برقم الطلب، اسم العميل، الهاتف..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-9 w-64 pr-8 text-xs"
                />
              </div>

              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1"
                onClick={() => void draftsQ.refetch()}
                disabled={draftsQ.isFetching}
              >
                <RefreshCw className={`size-3.5 ${draftsQ.isFetching ? "animate-spin" : ""}`} />
                تحديث
              </Button>
            </div>
          </Card>

          {/* جدول الطلبات */}
          <Card className="shadow-xs overflow-hidden py-0 gap-0">
            {draftsQ.isLoading ? (
              <div className="p-12 text-center text-sm text-muted-foreground">جاري تحميل الطلبات المحفوظة...</div>
            ) : drafts.length === 0 ? (
              <div className="p-12 text-center text-sm text-muted-foreground">لا توجد طلبات تطابق الفلاتر المحددة.</div>
            ) : (
              <div className="overflow-x-auto">
                <Table className="text-xs">
                  <TableHeader className="bg-muted/40 font-semibold text-muted-foreground">
                    <TableRow>
                      <TableHead className="p-3 text-right">رقم الطلب</TableHead>
                      <TableHead className="p-3 text-right">العميل</TableHead>
                      <TableHead className="p-3 text-right">تاريخ الإنشاء / العمر</TableHead>
                      <TableHead className="p-3 text-right">المنشئ</TableHead>
                      <TableHead className="p-3 text-right">البنود</TableHead>
                      <TableHead className="p-3 text-right">إجمالي الطلب</TableHead>
                      <TableHead className="p-3 text-right">العربون المحتجز</TableHead>
                      <TableHead className="p-3 text-center">الإجراءات</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {drafts.map((d) => {
                      const hasHeld = Number(d.heldTotal) > 0;
                      const createdAtDate = new Date(d.createdAt);
                      const ageHours = Math.floor((Date.now() - createdAtDate.getTime()) / (1000 * 60 * 60));
                      const isStale = ageHours >= 24 && d.status === "OPEN";

                      return (
                        <TableRow
                          key={d.id}
                          className={`hover:bg-muted/30 transition-colors ${
                            hasHeld ? "bg-[var(--sem-warn-bg)]/40" : ""
                          }`}
                        >
                          <TableCell className="p-3">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono font-bold">{d.draftNumber}</span>
                              {d.moneyLocked && (
                                <span className="inline-flex items-center gap-0.5 rounded bg-[var(--sem-warn-bg)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--sem-warn)]">
                                  <Banknote className="size-2.5" />
                                  ممول
                                </span>
                              )}
                            </div>
                          </TableCell>

                          <TableCell className="p-3">
                            <div>
                              <p className="font-medium text-foreground">{d.contactName || "عميل نقدي"}</p>
                              {d.contactPhone && (
                                <a
                                  href={`tel:${d.contactPhone}`}
                                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary dir-ltr"
                                >
                                  <Phone className="size-2.5" />
                                  <span>{d.contactPhone}</span>
                                </a>
                              )}
                            </div>
                          </TableCell>

                          <TableCell className="p-3">
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-1 text-muted-foreground">
                                <Calendar className="size-3" />
                                <span>{createdAtDate.toLocaleDateString("ar-IQ")}</span>
                              </div>
                              <div className={`flex items-center gap-1 text-[11px] ${isStale ? "text-destructive font-bold" : "text-muted-foreground"}`}>
                                <Clock className="size-3" />
                                <span>منذ {ageHours} ساعة</span>
                                {isStale && <AlertTriangle className="size-3" />}
                              </div>
                            </div>
                          </TableCell>

                          <TableCell className="p-3 text-muted-foreground">
                            <div className="flex items-center gap-1">
                              <User className="size-3" />
                              <span>{d.ownerName || "غير معروف"}</span>
                            </div>
                          </TableCell>

                          <TableCell className="p-3">
                            <span className="font-mono">{d.linesCount}</span> صنف
                          </TableCell>

                          <TableCell className="p-3 font-bold font-mono">
                            {fmtAr(d.total)}
                          </TableCell>

                          <TableCell className="p-3 font-mono">
                            {hasHeld ? (
                              <span className="font-bold text-destructive bg-destructive/10 px-2 py-0.5 rounded">
                                {fmtAr(d.heldTotal)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">0.00 د.ع</span>
                            )}
                          </TableCell>

                          <TableCell className="p-3">
                            <div className="flex items-center justify-center gap-1">
                              {d.status === "OPEN" && (
                                <Button
                                  variant="default"
                                  size="sm"
                                  className="h-7 px-2 text-[11px] gap-1"
                                  onClick={() => {
                                    window.location.href = `/reception?draftId=${d.id}`;
                                  }}
                                  title="فتح في الكاشير لإكمال وتثبيت الطلب"
                                >
                                  <ExternalLink className="size-3" />
                                  إكمال بالكاشير
                                </Button>
                              )}

                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-[11px] gap-1"
                                onClick={() => setSelectedDraftId(d.id)}
                                title="معاينة تفاصيل الطلب والعرابين"
                              >
                                <Eye className="size-3" />
                                تفاصيل
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
        </>
      )}

      {/* نافذة تفاصيل ومعالجة المسودة */}
      {selectedDraftId != null && (
        <DraftDetailsModal
          draftId={selectedDraftId}
          onClose={() => setSelectedDraftId(null)}
          onActionSuccess={() => {
            void draftsQ.refetch();
          }}
          isElevated={isElevated}
        />
      )}
    </div>
  );
}

/** نافذة تفاصيل ومعالجة المسودة مع العرابين */
export function DraftDetailsModal({
  draftId,
  onClose,
  onActionSuccess,
  isElevated,
}: {
  draftId: number;
  onClose: () => void;
  onActionSuccess: () => void;
  isElevated?: boolean;
}) {
  const utils = trpc.useUtils();
  const draftQ = trpc.reception.draftGet.useQuery({ draftId });
  const paymentsQ = trpc.reception.paymentsOf.useQuery({ draftId });

  const [refundPaymentId, setRefundPaymentId] = useState<number | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");

  const refundM = trpc.reception.refundDeposit.useMutation({
    onSuccess: () => {
      notify.ok("تم رد العربون بنجاح وتسجيل الإيصال");
      setRefundPaymentId(null);
      setRefundAmount("");
      setRefundReason("");
      void paymentsQ.refetch();
      void draftQ.refetch();
      void utils.reception.draftList.invalidate();
      onActionSuccess();
    },
    onError: (e) => notify.err(e),
  });

  const cancelM = trpc.reception.draftCancel.useMutation({
    onSuccess: () => {
      notify.ok("أُلغيت المسودة بنجاح");
      void utils.reception.draftList.invalidate();
      onActionSuccess();
      onClose();
    },
    onError: (e) => notify.err(e),
  });

  const draft = draftQ.data;
  const payments = paymentsQ.data?.rows ?? [];
  const heldNet = paymentsQ.data?.heldNet ?? "0.00";

  async function handleCancel() {
    if (!draft) return;
    const ok = await confirm({
      variant: "danger",
      title: `إلغاء الطلب المحفوظ ${draft.draftNumber}`,
      description: Number(heldNet) > 0
        ? `تنبيه: هذا الطلب محتجز عليه عربون (${fmtAr(heldNet)}). يفضل رد العربون أولاً قبل الإلغاء، أو سيتم إلغاؤه إدارياً.`
        : "هل أنت متأكد من إلغاء هذا الطلب نهائياً؟",
      confirmText: "تأكيد الإلغاء",
    });
    if (!ok) return;

    cancelM.mutate({
      draftId: draft.id,
      version: draft.version,
      reason: "إلغاء من شاشة إدارة الطلبات المحفوظة",
    });
  }

  function handleRefundSubmit(paymentId: number) {
    if (!refundAmount || Number(refundAmount) <= 0) {
      notify.warn("يرجى إدخال مبلغ الرد بشكل صحيح");
      return;
    }
    if (!refundReason || refundReason.trim().length < 5) {
      notify.warn("يرجى كتابة سبب رد العربون (5 أحرف على الأقل)");
      return;
    }

    refundM.mutate({
      paymentId,
      amount: refundAmount,
      reason: refundReason.trim(),
      clientRequestId: `ref-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border bg-background shadow-2xl overflow-hidden">
        {/* رأس النافذة */}
        <div className="flex items-center justify-between border-b px-5 py-3.5 bg-muted/30">
          <div className="flex items-center gap-2">
            <Archive className="size-5 text-primary" />
            <span className="font-bold text-base">
              معاينة ومعالجة الطلب: <span className="font-mono">{draft?.draftNumber ?? `#${draftId}`}</span>
            </span>
            {draft?.status && (
              <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${
                draft.status === "OPEN" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
              }`}>
                {draft.status === "OPEN" ? "مفتوح" : draft.status === "COMMITTED" ? "مثبت" : "ملغى"}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* محتوى النافذة */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {draftQ.isLoading ? (
            <div className="p-8 text-center text-muted-foreground">جاري تحميل بيانات الطلب...</div>
          ) : !draft ? (
            <div className="p-8 text-center text-destructive">تعذر العثور على الطلب المطلوب.</div>
          ) : (
            <>
              {/* بطاقة ملخص العميل والمال */}
              <Card className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3.5 shadow-xs">
                <div>
                  <span className="text-muted-foreground block">العميل:</span>
                  <span className="font-bold text-foreground text-sm">{draft.contactName || "عميل نقدي"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">الهاتف:</span>
                  <span className="font-mono text-foreground dir-ltr block">{draft.contactPhone || "—"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">إجمالي الطلب:</span>
                  <span className="font-bold text-foreground text-sm">{fmtAr(draft.total)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">العربون المحتجز:</span>
                  <span className="font-bold text-destructive text-sm">{fmtAr(heldNet)}</span>
                </div>
              </Card>

              {/* بنود الطلب */}
              <div className="space-y-2">
                <h4 className="font-bold text-foreground text-xs flex items-center justify-between">
                  <span>بنود المسودة ({draft.lines?.length ?? 0}):</span>
                </h4>
                <div className="rounded-lg border overflow-hidden">
                  <Table className="text-xs">
                    <TableHeader className="bg-muted/40 font-semibold text-muted-foreground">
                      <TableRow>
                        <TableHead className="p-2 text-right">الصنف / التفاصيل</TableHead>
                        <TableHead className="p-2 text-right">الكمية</TableHead>
                        <TableHead className="p-2 text-right">السعر</TableHead>
                        <TableHead className="p-2 text-right">الإجمالي</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(draft.lines ?? []).map((l, i) => (
                        <TableRow key={l.id ?? i}>
                          <TableCell className="p-2">
                            <p className="font-medium text-foreground">{l.title || "بند مخصص"}</p>
                            {l.customizationText && (
                              <p className="text-[11px] text-muted-foreground">{l.customizationText}</p>
                            )}
                          </TableCell>
                          <TableCell className="p-2 font-mono">{l.quantity}</TableCell>
                          <TableCell className="p-2 font-mono">{fmtAr(l.unitPrice)}</TableCell>
                          <TableCell className="p-2 font-mono font-bold">{fmtAr(l.lineTotal)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* المقبوضات والعرابين */}
              <div className="space-y-2">
                <h4 className="font-bold text-foreground text-xs flex items-center gap-1.5">
                  <Banknote className="size-4 text-[var(--sem-warn)]" />
                  <span>سجل العرابين والمقبوضات:</span>
                </h4>

                {payments.length === 0 ? (
                  <p className="text-muted-foreground p-3 rounded-lg border border-dashed text-center">
                    لا توجد مقبوضات مسجلة على هذا الطلب.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {payments.map((p) => {
                      const isHeld = p.status === "HELD";
                      return (
                        <div
                          key={p.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 bg-muted/20"
                        >
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-2">
                              <span className="font-bold font-mono text-sm">{fmtAr(p.amount)}</span>
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                                {p.method === "TRANSFER" ? "تحويل" : p.method === "CARD" ? "بطاقة" : p.method === "CASH" ? "نقداً" : p.method}
                              </span>
                              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                isHeld ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"
                              }`}>
                                {p.status === "HELD" ? "محتجز (عربون)" : p.status === "APPLIED" ? "مطبق على فاتورة" : "مردود"}
                              </span>
                            </div>
                            <div className="text-[11px] text-muted-foreground flex items-center gap-3">
                              <span>إيصال #{p.receiptId}</span>
                              {p.referenceNumber && <span>مرجع: {p.referenceNumber}</span>}
                              <span>{new Date(p.createdAt).toLocaleDateString("ar-IQ")}</span>
                            </div>
                          </div>

                          {isHeld && draft.status === "OPEN" && (
                            <div>
                              {refundPaymentId === p.id ? (
                                <div className="space-y-2 p-2 rounded-lg border bg-background">
                                  <div className="flex items-center gap-2">
                                    <MoneyInput
                                      value={refundAmount}
                                      onChange={setRefundAmount}
                                      className="h-8 w-28 text-xs font-mono"
                                      placeholder="مبلغ الرد"
                                      ariaLabel="مبلغ الرد"
                                    />
                                    <Input
                                      type="text"
                                      placeholder="سبب الرد (إلزامي)..."
                                      value={refundReason}
                                      onChange={(e) => setRefundReason(e.target.value)}
                                      className="h-8 w-44 text-xs"
                                    />
                                    <Button
                                      size="sm"
                                      variant="destructive"
                                      className="h-8 px-2.5 text-xs"
                                      disabled={refundM.isPending}
                                      onClick={() => handleRefundSubmit(p.id)}
                                    >
                                      تأكيد الرد
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-8 px-1.5"
                                      onClick={() => setRefundPaymentId(null)}
                                    >
                                      إلغاء
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs text-destructive hover:bg-destructive/10 border-destructive/30"
                                  onClick={() => {
                                    setRefundPaymentId(p.id);
                                    setRefundAmount(p.amount);
                                    setRefundReason("رد عربون بناءً على رغبة العميل وإلغاء الطلب");
                                  }}
                                >
                                  رد العربون
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* تذييل الإجراءات */}
        {draft && (
          <div className="flex items-center justify-between border-t px-5 py-3 bg-muted/20">
            <div className="flex items-center gap-2">
              {draft.status === "OPEN" && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="gap-1 text-xs"
                  onClick={handleCancel}
                  disabled={cancelM.isPending}
                >
                  <Trash2 className="size-3.5" />
                  إلغاء المسودة
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2">
              {draft.status === "OPEN" && (
                <Button
                  variant="default"
                  size="sm"
                  className="gap-1 text-xs"
                  onClick={() => {
                    window.location.href = `/reception?draftId=${draft.id}`;
                  }}
                >
                  <ExternalLink className="size-3.5" />
                  فتح في الكاشير للتثبيت
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={onClose} className="text-xs">
                إغلاق
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function NoBranchNotice() {
  return (
    <div className="rounded-xl border border-dashed p-8 text-center">
      <p className="text-sm font-bold">لا فرع مُسنَد لحسابك</p>
      <p className="mt-1 text-xs text-muted-foreground">
        هذه الشاشة تعرض طلبات فرعٍ بعينه — راجع المدير لإسناد فرعك، أو افتح الشاشة من محطّة الفرع.
      </p>
    </div>
  );
}
