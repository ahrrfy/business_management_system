// شاشة «متابعة الذمم الدائنة» — قائمة داخلية بحتة للموردين الذين ندين لهم ≥٧ أيام (بلا مراسلة للمورد).
// الموظف يسجّل «تمّت المتابعة» (يُخفيه ٧ أيام) أو يؤجّل بتاريخ وعد سداد. كل فعل يُسجَّل في `apReminders`
// مع snapshots لحظية للتدقيق. تبريد ٧ أيام يمنع تكرار المورد. لا cron ولا أيّ مراسلة خارجية.
import { useMemo, useState } from "react";
import { CheckCircle2, SkipForward, Clock, Search, RotateCcw, History, CalendarClock, Info, Bot, Printer, Download } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { sum } from "@/lib/money";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fmtDateTime } from "@/lib/date";
import { RowActions } from "@/components/list";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { exportRows } from "@/lib/export";
import { dashboardActionBranchId } from "@/lib/dashboardActionScope";

function fmtAmount(v: string | number): string {
  return Number(v).toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 2 });
}

/** أَسباب تَخطّي flowNotify (رُموز إنجليزية — راجِع server/services/whatsapp/flowNotify.ts) مُترجَمة
 *  لِلعَربية. بَعض الأَسباب المُرسَلة مِن الخادِم عَربية جاهِزة أَصلاً (مِثلاً «لا رَقم هاتف...») ⇒
 *  تَمُرّ كَما هي (fallback). مِرآة ARReminders.tsx. */
const SEND_VIA_API_REASON_AR: Record<string, string> = {
  kill_switch: "الإرسال الآلي مُوقَف مؤقّتاً (إيقاف الطوارئ) — فعِّله من إعدادات مركز واتساب.",
  disabled: "الإرسال الآلي معطّل — فعِّله من إعدادات المركز (مفتاح تذكير الذمم).",
  no_integration: "لا تكامل واتساب فعّال على هذا الفرع.",
  no_phone: "لا رقم هاتف مسجَّل.",
  opted_out: "المورّد ألغى الاشتراك في رسائل واتساب.",
  template_unavailable: "القالب غير معتمَد بعد عند Meta — زامنه من إعدادات المركز.",
  error: "تعذّر الإرسال — حاول لاحقاً.",
};
function sendViaApiReasonAr(reason: string): string {
  return SEND_VIA_API_REASON_AR[reason] ?? reason;
}

function daysBadgeCls(days: number): string {
  if (days >= 90) return "bg-destructive/15 text-destructive font-semibold";
  if (days >= 60) return "bg-amber-500/15 text-amber-700 font-semibold";
  if (days >= 30) return "bg-orange-500/15 text-orange-700";
  return "bg-muted text-muted-foreground";
}

/** فلتر شريحة التقادم — مرآة ARReminders.tsx. */
function matchesAgingBracket(days: number, bracket: "7-30" | "31-60" | "61-90" | "90+"): boolean {
  if (bracket === "7-30") return days < 31;
  if (bracket === "31-60") return days >= 31 && days < 61;
  if (bracket === "61-90") return days >= 61 && days < 91;
  return days >= 91;
}

type QueueRow = RouterOutputs["apReminders"]["queue"][number];
type HistoryRow = RouterOutputs["apReminders"]["history"][number];

type Tab = "queue" | "history";

export default function APReminders() {
  const [tab, setTab] = useState<Tab>("queue");
  const utils = trpc.useUtils();

  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: isAdmin });
  const accountBranchId = dashboardActionBranchId(me.data?.branchId);
  // نطاق العرض: فرع الحساب أولاً، ثم أول فرع فعّال للأدمن غير المرتبط بفرع.
  const [scope, setScope] = useState<number | undefined>(undefined);
  const effectiveScope: number | undefined =
    scope ?? (isAdmin ? accountBranchId ?? branches.data?.[0]?.id : undefined);
  // «كل الفروع» — أدمن حصراً، قراءة مجمَّعة فقط (apRemindersRouter.queue/history.allBranches). لا
  // معنى لكتابة «كل الفروع» (assertSupplierHasBranchPO يتحقّق من فرعٍ واحدٍ محدَّد) فنُعطّل إجراءات
  // الصفّ (متابعة/API/تأجيل) في هذا الوضع — الواجهة أدناه تُوضّح السبب بدل إخفائها بلا تفسير.
  const [allBranches, setAllBranches] = useState(false);
  const queueInput = allBranches
    ? { allBranches: true as const }
    : typeof effectiveScope === "number"
      ? { branchId: effectiveScope }
      : undefined;
  // فرع الكتابة: نطاق القراءة نفسه دائماً (اتفاقية scopedBranch — قراءة مجمَّعة مع كتابة مثبَّتة على
  // فرع واحد تجعل صفوف الفروع الأخرى غير قابلة للتنفيذ، مثل AR). null صراحةً في وضع «كل الفروع».
  const writeBranchId = allBranches
    ? undefined
    : typeof effectiveScope === "number"
      ? effectiveScope
      : undefined;

  const queue = trpc.apReminders.queue.useQuery(queueInput, { staleTime: 30_000 });
  const history = trpc.apReminders.history.useQuery(queueInput, {
    enabled: tab === "history",
    staleTime: 30_000,
  });

  const logSent = trpc.apReminders.logSent.useMutation({
    onSuccess: async () => {
      notify.ok("سُجِّلت المتابعة");
      await utils.apReminders.queue.invalidate();
      await utils.apReminders.history.invalidate();
    },
    onError: (e) => notify.err(e.message || "تعذّر تسجيل المتابعة"),
  });
  const sendViaApi = trpc.apReminders.sendViaApi.useMutation({
    onSuccess: async (r) => {
      if (r.sent) {
        notify.ok("أُرسِل التذكير عبر واتساب (API)");
      } else {
        notify.warn("لم يُرسَل عبر API", sendViaApiReasonAr(r.reason));
      }
      await utils.apReminders.queue.invalidate();
      await utils.apReminders.history.invalidate();
    },
    onError: (e) => notify.err(e.message || "تعذّر الإرسال عبر API"),
  });
  const logSkipped = trpc.apReminders.logSkipped.useMutation({
    onSuccess: async () => {
      notify.ok("تمّ التخطّي");
      await utils.apReminders.queue.invalidate();
      await utils.apReminders.history.invalidate();
      setSkipTarget(null);
      setSkipReason("");
      setPromisedDate("");
    },
    onError: (e) => notify.err(e.message || "تعذّر تسجيل التخطّي"),
  });

  const [search, setSearch] = useState("");
  const [agingBracket, setAgingBracket] = useState<"" | "7-30" | "31-60" | "61-90" | "90+">("");
  const [skipTarget, setSkipTarget] = useState<QueueRow | null>(null);
  const [skipReason, setSkipReason] = useState("");
  const [promisedDate, setPromisedDate] = useState("");

  const filteredQueue = useMemo(() => {
    let list = queue.data ?? [];
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      list = list.filter((r) => r.supplierName.toLowerCase().includes(s) || (r.phone ?? "").includes(s));
    }
    if (agingBracket) list = list.filter((r) => matchesAgingBracket(r.daysOverdue, agingBracket));
    return list;
  }, [queue.data, search, agingBracket]);

  const totalUnpaidSum = useMemo(
    () => sum(filteredQueue.map((r) => r.totalUnpaid)),
    [filteredQueue],
  );

  /** طباعة/تصدير قائمة اليوم (بعد الفلاتر) — مرآة ARReminders.tsx. */
  function printTodayList() {
    const opened = printReportDoc({
      title: "متابعة الذمم الدائنة — قائمة اليوم",
      headerExtra: [{ label: "عدد الموردين", value: String(filteredQueue.length) }],
      columns: [
        { key: "supplierName", label: "المورّد" },
        { key: "phone", label: "الهاتف" },
        { key: "amount", label: "المستحقّ علينا", align: "left" },
        { key: "days", label: "أيام التأخّر", align: "center" },
      ],
      rows: filteredQueue.map((r) => ({
        supplierName: r.supplierName,
        phone: r.phone ?? "—",
        amount: `${fmtAmount(r.totalUnpaid)} د.ع`,
        days: String(r.daysOverdue),
      })),
      summary: [{ label: "إجمالي المستحقّات علينا", value: `${fmtAmount(totalUnpaidSum)} د.ع`, bold: true, large: true }],
    });
    if (!opened) notify.err("حجب المتصفح نافذة الطباعة");
  }

  function exportTodayList() {
    void exportRows(filteredQueue, {
      filename: "متابعة-الذمم-الدائنة-اليوم",
      title: "متابعة الذمم الدائنة — قائمة اليوم",
      columns: [
        { key: "supplierName", header: "المورّد" },
        { key: "phone", header: "الهاتف", map: (r) => r.phone ?? "" },
        { key: "totalUnpaid", header: "المستحقّ علينا", money: true, map: (r) => Number(r.totalUnpaid) },
        { key: "daysOverdue", header: "أيام التأخّر" },
        { key: "oldestPoDate", header: "أقدم أمر شراء" },
      ],
    });
  }

  function handleFollowUp(row: QueueRow) {
    // في وضع «كل الفروع» لا فرع محدَّد لنسبة المتابعة إليه (الأزرار مُعطَّلة أصلاً في هذا الوضع —
    // حارسٌ دفاعيّ ثانٍ يمنع أيّ استدعاء برمجي مباشر من الالتفاف حول التعطيل).
    if (allBranches) { notify.err("بدِّل لفرع محدَّد أولاً — لا يمكن تسجيل متابعة في عرض «كل الفروع»."); return; }
    // قائمة داخلية بحتة: نسجّل «تمّت المتابعة» فقط (يُطبّق تبريد ٧ أيام) — بلا أيّ مراسلة للمورد.
    logSent.mutate({
      supplierId: row.supplierId,
      totalUnpaidSnapshot: row.totalUnpaid,
      oldestPoDate: row.oldestPoDate,
      daysOverdue: row.daysOverdue,
      messageBody: "متابعة داخلية (بلا مراسلة للمورد)",
      branchId: writeBranchId,
    });
  }

  function handleSendViaApi(row: QueueRow) {
    if (allBranches) { notify.err("بدِّل لفرع محدَّد أولاً — لا يمكن الإرسال في عرض «كل الفروع»."); return; }
    if (!row.phone) {
      notify.err("لا رقم هاتف مسجَّل لهذا المورّد — أضف الهاتف من صفحة المورّد أولاً.");
      return;
    }
    sendViaApi.mutate({
      supplierId: row.supplierId,
      totalUnpaidSnapshot: row.totalUnpaid,
      oldestPoDate: row.oldestPoDate,
      daysOverdue: row.daysOverdue,
      branchId: writeBranchId,
    });
  }

  function handleSkipConfirm() {
    if (!skipTarget) return;
    if (allBranches) { notify.err("بدِّل لفرع محدَّد أولاً — لا يمكن التأجيل في عرض «كل الفروع»."); return; }
    if (!skipReason.trim()) {
      notify.err("سبب التخطّي مطلوب");
      return;
    }
    const promise = promisedDate.trim();
    if (promise) {
      const todayYmd = new Date().toISOString().slice(0, 10);
      if (promise < todayYmd) {
        notify.err("تاريخ الوعد يجب ألّا يكون في الماضي");
        return;
      }
    }
    logSkipped.mutate({
      supplierId: skipTarget.supplierId,
      totalUnpaidSnapshot: skipTarget.totalUnpaid,
      oldestPoDate: skipTarget.oldestPoDate,
      daysOverdue: skipTarget.daysOverdue,
      skipReason: skipReason.trim(),
      promisedDate: promise || null,
      branchId: writeBranchId,
    });
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="متابعة الذمم الدائنة"
        description="قائمة داخلية للموردين الذين ندين لهم منذ ≥٧ أيام. سجّل «تمّت المتابعة» أو حدّد موعد سداد — بلا مراسلة للمورد."
      />

      {/* منتقي الفرع — للأدمن حصراً (عبور الفروع، نظير AR). */}
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">الفرع:</span>
          <AppSelect
            value={String(effectiveScope ?? "")}
            onValueChange={(v) => { setScope(Number(v)); setAllBranches(false); }}
            disabled={allBranches}
            className="h-9 w-44"
          >
            {(branches.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </AppSelect>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={allBranches}
              onChange={(e) => setAllBranches(e.target.checked)}
            />
            كل الفروع (قراءة فقط)
          </label>
          {scope === undefined && !allBranches && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Info className="size-3.5" aria-hidden />
              يبدأ العرض بفرع الحساب، أو أول فرع فعّال عند غياب التعيين.
            </span>
          )}
          {allBranches && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Info className="size-3.5" aria-hidden />
              عرضٌ مجمَّع للقراءة فقط — بدِّل لفرع محدَّد لتسجيل متابعة/تأجيل/إرسال.
            </span>
          )}
        </div>
      )}

      {/* شريط الملخّص */}
      {tab === "queue" && queue.data && queue.data.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardContent className="flex items-center justify-between p-4">
              <span className="text-sm text-muted-foreground">موردون بحاجة متابعة</span>
              <span className="text-xl font-bold tabular-nums">{queue.data.length}</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center justify-between p-4">
              <span className="text-sm text-muted-foreground">إجمالي المستحقّات علينا</span>
              <span className="text-xl font-bold tabular-nums text-money-negative" dir="ltr">{fmtAmount(totalUnpaidSum)} د.ع</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center justify-between p-4">
              <span className="text-sm text-muted-foreground">أقدم تأخّر</span>
              <span className="text-xl font-bold tabular-nums">{queue.data[0]?.daysOverdue ?? 0} يوماً</span>
            </CardContent>
          </Card>
        </div>
      )}

      {/* تبويبات */}
      <div className="flex gap-1 rounded-lg border p-1 bg-muted/30 w-fit">
        <button
          type="button"
          onClick={() => setTab("queue")}
          className={tab === "queue" ? "px-4 py-1.5 text-sm font-bold rounded-md bg-background shadow-sm" : "px-4 py-1.5 text-sm text-muted-foreground"}
        >
          قائمة اليوم
        </button>
        <button
          type="button"
          onClick={() => setTab("history")}
          className={tab === "history" ? "px-4 py-1.5 text-sm font-bold rounded-md bg-background shadow-sm inline-flex items-center gap-1" : "px-4 py-1.5 text-sm text-muted-foreground inline-flex items-center gap-1"}
        >
          <History className="size-3.5" aria-hidden /> السجلّ (٣٠ يوماً)
        </button>
      </div>

      {tab === "queue" ? (
        <QueueTab
          data={queue.data ?? []}
          isLoading={queue.isLoading}
          isError={queue.isError}
          refetch={() => queue.refetch()}
          filtered={filteredQueue}
          search={search}
          setSearch={setSearch}
          agingBracket={agingBracket}
          setAgingBracket={setAgingBracket}
          onSend={handleFollowUp}
          onSendViaApi={handleSendViaApi}
          onSkip={setSkipTarget}
          onPrint={printTodayList}
          onExport={exportTodayList}
          actionsDisabled={allBranches}
          sendingId={logSent.isPending ? logSent.variables?.supplierId ?? null : null}
          sendingViaApiId={sendViaApi.isPending ? sendViaApi.variables?.supplierId ?? null : null}
        />
      ) : (
        <HistoryTab
          data={history.data ?? []}
          isLoading={history.isLoading}
          isError={history.isError}
          refetch={() => history.refetch()}
        />
      )}

      {/* حوار التخطّي */}
      <Dialog open={skipTarget != null} onOpenChange={(o) => { if (!o) { setSkipTarget(null); setSkipReason(""); setPromisedDate(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>تأجيل متابعة — {skipTarget?.supplierName}</DialogTitle>
            <DialogDescription>
              سيُسجَّل التخطّي في السجلّ. بلا وعد: يختفي ٧ أيام. مع تاريخ وعد بالسداد: يعود يوم الوعد نفسه بشارة «موعود» ليُذكَّرك بالمتابعة.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="block text-sm font-medium">
                سبب التخطّي
                <span className="text-destructive"> *</span>
              </label>
              <Textarea
                value={skipReason}
                onChange={(e) => setSkipReason(e.target.value)}
                placeholder="مثال: بانتظار كشف الحساب، أو السداد مجدوَل نهاية الشهر"
                maxLength={255}
                rows={3}
                autoFocus
              />
              <div className="text-xs text-muted-foreground">
                {skipReason.length}/255 حرفاً
              </div>
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium inline-flex items-center gap-1.5">
                <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
                تاريخ وعدنا بالسداد
                <span className="text-xs font-normal text-muted-foreground">(اختياري)</span>
              </label>
              <Input
                type="date"
                value={promisedDate}
                min={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setPromisedDate(e.target.value)}
                className="max-w-[220px]"
                dir="ltr"
              />
              <p className="text-xs text-muted-foreground">
                {promisedDate
                  ? `سيعود المورد لقائمة اليوم بتاريخ ${promisedDate} بشارة «موعود»، متجاوزاً تبريد ٧ أيام.`
                  : "اترك فارغاً لتخطٍّ عاديّ (يخضع لتبريد ٧ أيام)."}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSkipTarget(null)}>إلغاء</Button>
            <Button onClick={handleSkipConfirm} disabled={logSkipped.isPending || !skipReason.trim()}>
              {logSkipped.isPending ? "جارٍ…" : (promisedDate ? "أجّل + سجِّل الوعد" : "أجّل الآن")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function QueueTab({
  data,
  isLoading,
  isError,
  refetch,
  filtered,
  search,
  setSearch,
  agingBracket,
  setAgingBracket,
  onSend,
  onSendViaApi,
  onSkip,
  onPrint,
  onExport,
  actionsDisabled,
  sendingId,
  sendingViaApiId,
}: {
  data: QueueRow[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  filtered: QueueRow[];
  search: string;
  setSearch: (v: string) => void;
  agingBracket: "" | "7-30" | "31-60" | "61-90" | "90+";
  setAgingBracket: (v: "" | "7-30" | "31-60" | "61-90" | "90+") => void;
  onSend: (row: QueueRow) => void;
  onSendViaApi: (row: QueueRow) => void;
  onSkip: (row: QueueRow) => void;
  onPrint: () => void;
  onExport: () => void;
  /** true في وضع «كل الفروع» (قراءة مجمَّعة) — لا فرع محدَّد لنسبة الإجراء إليه. */
  actionsDisabled: boolean;
  sendingId: number | null;
  sendingViaApiId: number | null;
}) {
  if (isLoading) return <LoadingState />;
  if (isError) {
    return <ErrorState message="تعذّر تحميل القائمة." onRetry={refetch} />;
  }
  if (data.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <Clock className="size-10 text-muted-foreground" aria-hidden />
          <p className="text-lg font-semibold">لا متابعات مستحقّة اليوم</p>
          <p className="text-sm text-muted-foreground">جميع الذمم الدائنة إمّا حديثة (&lt;٧ أيام) أو تُوبعت مؤخّراً.</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative flex-1 max-w-md">
            <span aria-hidden className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground">
              <Search className="size-4" />
            </span>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث بالاسم أو الهاتف…"
              className="h-9 pe-9"
            />
          </div>
          <AppSelect
            value={agingBracket}
            onValueChange={(v) => setAgingBracket(v as typeof agingBracket)}
            className="h-9 w-44"
            aria-label="شريحة التقادم"
            placeholder="كل شرائح التقادم"
          >
            <option value="7-30">٧-٣٠ يوماً</option>
            <option value="31-60">٣١-٦٠ يوماً</option>
            <option value="61-90">٦١-٩٠ يوماً</option>
            <option value="90+">أكثر من ٩٠ يوماً</option>
          </AppSelect>
          <Button variant="outline" size="sm" onClick={refetch} className="gap-1.5">
            <RotateCcw className="size-3.5" aria-hidden /> تحديث
          </Button>
          <Button variant="outline" size="sm" onClick={onExport} className="gap-1.5">
            <Download className="size-3.5" aria-hidden /> تصدير Excel
          </Button>
          <Button variant="outline" size="sm" onClick={onPrint} className="gap-1.5">
            <Printer className="size-3.5" aria-hidden /> طباعة القائمة
          </Button>
        </div>
        <ScrollTableShell bordered={false}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">المورد</TableHead>
                <TableHead className="text-right">الهاتف</TableHead>
                <TableHead className="text-left">المستحقّ علينا</TableHead>
                <TableHead className="text-center">أقدم أمر شراء</TableHead>
                <TableHead className="text-center">أيام التأخّر</TableHead>
                <TableHead className="text-center">آخر متابعة</TableHead>
                <TableHead className="text-center">إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    {search ? `لا نتائج للبحث «${search}»` : "لا نتائج مطابقة لشريحة التقادم المختارة"}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((row) => (
                  <TableRow key={row.supplierId} className={row.isPromiseDue ? "bg-amber-50/60" : ""}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span>{row.supplierName}</span>
                        {row.isPromiseDue && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold text-amber-800">
                            <CalendarClock className="size-3" aria-hidden />
                            موعود{row.promisedDate ? ` (${row.promisedDate})` : ""}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell dir="ltr" className="text-xs text-muted-foreground tabular-nums">{row.phone ?? "—"}</TableCell>
                    <TableCell className="text-left font-bold tabular-nums text-money-negative" dir="ltr">
                      {fmtAmount(row.totalUnpaid)}
                    </TableCell>
                    <TableCell className="text-center text-xs tabular-nums" dir="ltr">{row.oldestPoDate}</TableCell>
                    <TableCell className="text-center">
                      <span className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs tabular-nums ${daysBadgeCls(row.daysOverdue)}`}>
                        {row.daysOverdue}
                      </span>
                    </TableCell>
                    <TableCell className="text-center text-xs text-muted-foreground">
                      {row.lastReminderAt ? fmtDateTime(row.lastReminderAt) : "—"}
                    </TableCell>
                    <TableCell className="text-center whitespace-nowrap">
                      <RowActions
                        mode="menu"
                        actions={[
                          {
                            key: "followed",
                            kind: "approve",
                            label: "تمّت المتابعة",
                            icon: CheckCircle2,
                            disabled: actionsDisabled || sendingId === row.supplierId,
                            disabledReason: actionsDisabled ? "بدِّل لفرع محدَّد أولاً" : "توجد عملية تسجيل قيد التنفيذ",
                            onSelect: () => onSend(row),
                            gate: { roles: ["manager", "warehouse", "purchasing"], module: "suppliers", level: "FULL" },
                          },
                          {
                            key: "send-api",
                            kind: "other",
                            label: "أرسل عبر API",
                            icon: Bot,
                            disabled: actionsDisabled || !row.phone || sendingViaApiId === row.supplierId,
                            disabledReason: actionsDisabled ? "بدِّل لفرع محدَّد أولاً" : !row.phone ? "لا رقم هاتف مسجّل" : "الإرسال قيد التنفيذ",
                            onSelect: () => onSendViaApi(row),
                            gate: { roles: ["manager", "warehouse", "purchasing"], module: "suppliers", level: "FULL" },
                          },
                          {
                            key: "skip",
                            kind: "approve",
                            label: "أجّل",
                            icon: SkipForward,
                            disabled: actionsDisabled,
                            disabledReason: actionsDisabled ? "بدِّل لفرع محدَّد أولاً" : undefined,
                            onSelect: () => onSkip(row),
                            gate: { roles: ["manager", "warehouse", "purchasing"], module: "suppliers", level: "FULL" },
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </ScrollTableShell>
      </CardContent>
    </Card>
  );
}

function HistoryTab({
  data,
  isLoading,
  isError,
  refetch,
}: {
  data: HistoryRow[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}) {
  // فلاتر السجلّ (بحث + حالة + مدى تاريخ) — مرآة ARReminders.tsx؛ تصفية عميلة على النافذة المجلوبة
  // أصلاً (٣٠ يوماً) لأن توسيعها يتطلّب تعديل apRemindersService.ts (خارج نطاق هذه الشريحة).
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | "SENT" | "SKIPPED">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const filtered = useMemo(() => {
    let rows = data;
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      rows = rows.filter((r) => r.supplierName.toLowerCase().includes(s));
    }
    if (status) rows = rows.filter((r) => r.status === status);
    if (from) rows = rows.filter((r) => new Date(r.createdAt).toISOString().slice(0, 10) >= from);
    if (to) rows = rows.filter((r) => new Date(r.createdAt).toISOString().slice(0, 10) <= to);
    return rows;
  }, [data, search, status, from, to]);

  if (isLoading) return <LoadingState />;
  if (isError) {
    return <ErrorState message="تعذّر تحميل السجلّ." onRetry={refetch} />;
  }
  if (data.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <History className="size-10 text-muted-foreground" aria-hidden />
          <p className="text-lg font-semibold">لا متابعات في آخر ٣٠ يوماً</p>
          <p className="text-sm text-muted-foreground">سيظهر هنا كل متابعة أو تأجيل فور تسجيله.</p>
        </CardContent>
      </Card>
    );
  }
  const rows = filtered;
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative flex-1 max-w-xs">
            <span aria-hidden className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground">
              <Search className="size-4" />
            </span>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث بالاسم…" className="h-9 pe-9" />
          </div>
          <AppSelect
            value={status}
            onValueChange={(v) => setStatus(v as typeof status)}
            className="h-9 w-36"
            aria-label="الحالة"
            placeholder="كل الحالات"
          >
            <option value="SENT">متابَع</option>
            <option value="SKIPPED">تأجيل/وعد</option>
          </AppSelect>
          <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-36" aria-label="من تاريخ" />
          <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-36" aria-label="إلى تاريخ" />
          {(search || status || from || to) && (
            <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setStatus(""); setFrom(""); setTo(""); }}>مسح الفلاتر</Button>
          )}
        </div>
        <ScrollTableShell bordered={false}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">التاريخ</TableHead>
                <TableHead className="text-right">المورد</TableHead>
                <TableHead className="text-left">الرصيد وقت المتابعة</TableHead>
                <TableHead className="text-center">أيام التأخّر</TableHead>
                <TableHead className="text-center">الحالة</TableHead>
                <TableHead className="text-right">السبب/الملاحظة</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">لا نتائج مطابقة للفلاتر.</TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs text-muted-foreground tabular-nums" dir="ltr">{fmtDateTime(r.createdAt)}</TableCell>
                  <TableCell className="font-medium">{r.supplierName}</TableCell>
                  <TableCell className="text-left tabular-nums" dir="ltr">{fmtAmount(r.totalUnpaidSnapshot)}</TableCell>
                  <TableCell className="text-center tabular-nums">{r.daysOverdue}</TableCell>
                  <TableCell className="text-center">
                    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs ${r.status === "SENT" ? "bg-emerald-100 text-emerald-700" : r.promisedDate ? "bg-amber-500/15 text-amber-800" : "bg-muted text-muted-foreground"}`}>
                      {r.status === "SENT" ? "متابَع" : r.promisedDate ? "وعد" : "تأجيل"}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <div className="flex flex-col gap-0.5">
                      <span>{r.skipReason ?? (r.status === "SENT" ? "متابعة داخلية" : "—")}</span>
                      {r.promisedDate && (
                        <span className="text-[11px] text-amber-800 inline-flex items-center gap-1">
                          <CalendarClock className="size-3" aria-hidden />
                          موعود بالسداد: <span dir="ltr" className="tabular-nums">{r.promisedDate}</span>
                        </span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollTableShell>
      </CardContent>
    </Card>
  );
}
