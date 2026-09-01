// شاشة «تذكيرات الذمم الآجلة» — مراجعة يومية للعملاء المتأخّرين ≥٧ أيام + إرسال واتساب يدوي.
//
// القرار السياسي (المالك، ٤/٧/٢٦): مراجعة يدوية ⇒ إرسال يدوي عبر واتساب — لا cron ولا أوتوماتيك.
// كل تذكير مُرسَل يُسجَّل في `arReminders` مع snapshots اللحظية (مبلغ + أقدم فاتورة + نصّ الرسالة).
// نافذة التبريد ٧ أيام تمنع تكرار العميل في القائمة قبل استحقاق تذكير جديد.
import { useMemo, useState } from "react";
import { FILTER_LABELS } from "@shared/uiContracts";
import { Send, SkipForward, Clock, Search, RotateCcw, History, CalendarClock, Landmark, Info, Bot, Printer, Download } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { sum } from "@/lib/money";
import { openWhatsApp, sanitizeForWhatsApp } from "@/lib/whatsapp";
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

const COMPANY_NAME = "المكتبة العربية للطباعة والقرطاسية";

/** بناء رسالة تذكير ودّية بالعربية — نفس نبرة `buildStatementMessage` القائمة، مركّزة على المبلغ + أقدم فاتورة. */
function buildReminderMessage(row: {
  customerName: string;
  totalUnpaid: string;
  oldestInvoiceDate: string;
  daysOverdue: number;
  isOpeningBalance?: boolean;
}): string {
  const amount = Number(row.totalUnpaid).toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 2 });
  const lines: string[] = [
    `السلام عليكم ${row.customerName}،`,
    `تذكير ودّي بمستحقات لدى ${COMPANY_NAME}.`,
    "",
    // «المبلغ المستحقّ عن الفواتير المتأخّرة» لا «الرصيد» — القيمة = min(متبقّي الفواتير، الرصيد
    // الجاري)، وقد تقلّ عن رصيد كشف الحساب (افتتاحي مدين فوق الفواتير) فتسمية «الرصيد» تكون كاذبة.
    // مدين الرصيد الافتتاحي (بلا فواتير نظام): المبلغ = كامل الرصيد المُدوَّر، والصياغة تناسبه.
    row.isOpeningBalance ? `الرصيد المستحقّ (رصيد سابق مُدوَّر):` : `المبلغ المستحقّ عن الفواتير المتأخّرة:`,
    `*${amount} د.ع.*`,
    "",
    row.isOpeningBalance
      ? `الرصيد قائم منذ: ${row.oldestInvoiceDate} (${row.daysOverdue} يوماً)`
      : `أقدم فاتورة غير مدفوعة: ${row.oldestInvoiceDate} (${row.daysOverdue} يوماً)`,
    "",
    "يرجى مراجعة الرصيد والتسديد في أقرب وقت ممكن.",
    "إن كان هناك أيّ فرق أو استفسار، تواصلوا معنا.",
    "",
    "شكراً لتعاونكم.",
    COMPANY_NAME,
  ];
  return sanitizeForWhatsApp(lines.join("\n"));
}

function fmtAmount(v: string | number): string {
  return Number(v).toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 2 });
}

/** أَسباب تَخطّي flowNotify (رُموز إنجليزية — راجِع server/services/whatsapp/flowNotify.ts) مُترجَمة
 *  لِلعَربية. بَعض الأَسباب المُرسَلة مِن الخادِم عَربية جاهِزة أَصلاً (مِثلاً «لا رَقم هاتف...») ⇒
 *  تَمُرّ كَما هي (fallback). */
const SEND_VIA_API_REASON_AR: Record<string, string> = {
  kill_switch: "الإرسال الآلي مُوقَف مؤقّتاً (إيقاف الطوارئ) — فعِّله من إعدادات مركز واتساب.",
  disabled: "الإرسال الآلي معطّل — فعِّله من إعدادات المركز (مفتاح تذكير الذمم).",
  no_integration: "لا تكامل واتساب فعّال على هذا الفرع.",
  no_phone: "لا رقم هاتف مسجَّل.",
  opted_out: "العميل ألغى الاشتراك في رسائل واتساب.",
  template_unavailable: "القالب غير معتمَد بعد عند Meta — زامنه من إعدادات المركز.",
  error: "تعذّر الإرسال — حاول لاحقاً.",
};
function sendViaApiReasonAr(reason: string): string {
  return SEND_VIA_API_REASON_AR[reason] ?? reason;
}

function daysBadgeCls(days: number): string {
  if (days >= 90) return "bg-destructive/15 text-destructive font-semibold";
  if (days >= 60) return "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] font-semibold";
  if (days >= 30) return "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]";
  return "bg-muted text-muted-foreground";
}

/** فلتر شريحة التقادم — نفس حدود daysBadgeCls (٧ أدنى القائمة أصلاً — REMINDER_MIN_DAYS_OVERDUE). */
function matchesAgingBracket(days: number, bracket: "7-30" | "31-60" | "61-90" | "90+"): boolean {
  if (bracket === "7-30") return days < 31;
  if (bracket === "31-60") return days >= 31 && days < 61;
  if (bracket === "61-90") return days >= 61 && days < 91;
  return days >= 91;
}

type QueueRow = RouterOutputs["arReminders"]["queue"][number];
type HistoryRow = RouterOutputs["arReminders"]["history"][number];

type Tab = "queue" | "history";

export default function ARReminders() {
  const [tab, setTab] = useState<Tab>("queue");
  const utils = trpc.useUtils();

  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: isAdmin });
  const accountBranchId = dashboardActionBranchId(me.data?.branchId);
  const requestedBranchId = useMemo(
    () => dashboardActionBranchId(typeof window === "undefined" ? undefined : new URLSearchParams(window.location.search).get("branch")),
    [],
  );
  // نطاق العرض: فرع محدَّد (رقم) | مدينو الرصيد الافتتاحي ("opening") | undefined (فرع المستخدم لغير الأدمن).
  const [scope, setScope] = useState<number | "opening" | undefined>(undefined);
  const effectiveScope: number | "opening" | undefined =
    scope ?? (isAdmin ? requestedBranchId ?? accountBranchId ?? branches.data?.[0]?.id : undefined);
  const queueInput =
    effectiveScope === "opening"
      ? { openingScope: true }
      : typeof effectiveScope === "number"
        ? { branchId: effectiveScope }
        : undefined;
  // فرع الكتابة: للنطاق الفرعيّ = الفرع نفسه (يطابق القراءة)؛ للنطاق الافتتاحي = undefined (الخادم يحلّه بلا عزل).
  const writeBranchId = typeof effectiveScope === "number" ? effectiveScope : undefined;
  // السجلّ يتبع النطاق نفسه بدقّة (كان يسقط صامتاً لأوّل فرع نشط عند نطاق «الافتتاحي» — تحقّق
  // عدائي ٥/٧): فرع محدَّد ⇒ سجلّ ذلك الفرع؛ نطاق الافتتاحي ⇒ openingScope (سجلّ مجمَّع)؛ غير الأدمن
  // بلا نطاق محدَّد ⇒ undefined (الخادم يحلّه لفرعه).
  const historyInput =
    effectiveScope === "opening"
      ? { openingScope: true as const }
      : typeof effectiveScope === "number"
        ? { branchId: effectiveScope }
        : undefined;

  const queue = trpc.arReminders.queue.useQuery(queueInput, { staleTime: 30_000 });
  const history = trpc.arReminders.history.useQuery(historyInput, {
    enabled: tab === "history",
    staleTime: 30_000,
  });

  const logSent = trpc.arReminders.logSent.useMutation({
    onSuccess: async () => {
      notify.ok("سُجِّل التذكير في القائمة");
      await utils.arReminders.queue.invalidate();
      await utils.arReminders.history.invalidate();
    },
    onError: (e) => notify.err(e.message || "تعذّر تسجيل التذكير"),
  });
  const sendViaApi = trpc.arReminders.sendViaApi.useMutation({
    onSuccess: async (r) => {
      if (r.sent) {
        notify.ok("أُرسِل التذكير عبر واتساب (API)");
      } else {
        notify.warn("لم يُرسَل عبر API", sendViaApiReasonAr(r.reason));
      }
      await utils.arReminders.queue.invalidate();
      await utils.arReminders.history.invalidate();
    },
    onError: (e) => notify.err(e.message || "تعذّر الإرسال عبر API"),
  });
  const logSkipped = trpc.arReminders.logSkipped.useMutation({
    onSuccess: async () => {
      notify.ok("تمّ التخطّي");
      await utils.arReminders.queue.invalidate();
      await utils.arReminders.history.invalidate();
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
      list = list.filter((r) => r.customerName.toLowerCase().includes(s) || (r.phone ?? "").includes(s));
    }
    if (agingBracket) list = list.filter((r) => matchesAgingBracket(r.daysOverdue, agingBracket));
    return list;
  }, [queue.data, search, agingBracket]);

  const totalUnpaidSum = useMemo(
    () => sum(filteredQueue.map((r) => r.totalUnpaid)),
    [filteredQueue],
  );

  /** طباعة/تصدير قائمة اليوم (بعد فلاتر البحث/شريحة التقادم) — للمشاركة الورقية أو مراجعة خارج النظام. */
  function printTodayList() {
    const opened = printReportDoc({
      title: "تذكيرات الذمم الآجلة — قائمة اليوم",
      headerExtra: [{ label: "عدد العملاء", value: String(filteredQueue.length) }],
      columns: [
        { key: "customerName", label: "العميل" },
        { key: "phone", label: "الهاتف" },
        { key: "amount", label: "الرصيد الآجل", align: "left" },
        { key: "days", label: "أيام التأخّر", align: "center" },
      ],
      rows: filteredQueue.map((r) => ({
        customerName: r.customerName,
        phone: r.phone ?? "—",
        amount: `${fmtAmount(r.totalUnpaid)} د.ع`,
        days: String(r.daysOverdue),
      })),
      summary: [{ label: "إجمالي الذمم", value: `${fmtAmount(totalUnpaidSum)} د.ع`, bold: true, large: true }],
    });
    if (!opened) notify.err("حجب المتصفح نافذة الطباعة");
  }

  function exportTodayList() {
    void exportRows(filteredQueue, {
      filename: "تذكيرات-الذمم-اليوم",
      title: "تذكيرات الذمم الآجلة — قائمة اليوم",
      columns: [
        { key: "customerName", header: "العميل" },
        { key: "phone", header: "الهاتف", map: (r) => r.phone ?? "" },
        { key: "totalUnpaid", header: "الرصيد الآجل", money: true, map: (r) => Number(r.totalUnpaid) },
        { key: "daysOverdue", header: "أيام التأخّر" },
        { key: "oldestInvoiceDate", header: "متأخّر منذ" },
      ],
    });
  }

  function handleSend(row: QueueRow) {
    if (!row.phone) {
      notify.err("لا رقم هاتف مسجَّل لهذا العميل — أضف الهاتف من صفحة العميل أولاً.");
      return;
    }
    const message = buildReminderMessage(row);
    // نفتح واتساب ثم نُسجِّل الإرسال. المستخدم في واتساب سيؤكّد الإرسال يدوياً؛ التسجيل هنا يعني
    // «قرَّرَ الإرسال» (تفتح النافذة)، لا أنّه ضغط زرّ الإرسال داخل واتساب — لكن هذا مقبول لأن
    // البديل (تأكيد لاحق) يفتح باب نسيان التسجيل مع التبريد المفقود ⇒ إغراق العميل بتذكيرات.
    openWhatsApp(row.phone, message);
    logSent.mutate({
      customerId: row.customerId,
      totalUnpaidSnapshot: row.totalUnpaid,
      oldestInvoiceDate: row.oldestInvoiceDate,
      daysOverdue: row.daysOverdue,
      messageBody: message,
      isOpeningBalance: row.isOpeningBalance || undefined,
      branchId: writeBranchId,
    });
  }

  function handleSendViaApi(row: QueueRow) {
    if (!row.phone) {
      notify.err("لا رقم هاتف مسجَّل لهذا العميل — أضف الهاتف من صفحة العميل أولاً.");
      return;
    }
    sendViaApi.mutate({
      customerId: row.customerId,
      totalUnpaidSnapshot: row.totalUnpaid,
      oldestInvoiceDate: row.oldestInvoiceDate,
      daysOverdue: row.daysOverdue,
      isOpeningBalance: row.isOpeningBalance || undefined,
      branchId: writeBranchId,
    });
  }

  function handleSkipConfirm() {
    if (!skipTarget) return;
    if (!skipReason.trim()) {
      notify.err("سبب التخطّي مطلوب");
      return;
    }
    // منتقي التاريخ HTML يعيد نصّاً YYYY-MM-DD أو فراغاً — الفارغ يعني «بلا وعد» ⇒ تخطٍّ عاديّ.
    const promise = promisedDate.trim();
    if (promise) {
      const todayYmd = new Date().toISOString().slice(0, 10);
      if (promise < todayYmd) {
        notify.err("تاريخ الوعد يجب ألّا يكون في الماضي");
        return;
      }
    }
    logSkipped.mutate({
      customerId: skipTarget.customerId,
      totalUnpaidSnapshot: skipTarget.totalUnpaid,
      oldestInvoiceDate: skipTarget.oldestInvoiceDate,
      daysOverdue: skipTarget.daysOverdue,
      skipReason: skipReason.trim(),
      promisedDate: promise || null,
      isOpeningBalance: skipTarget.isOpeningBalance || undefined,
      branchId: writeBranchId,
    });
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="تذكيرات الذمم الآجلة"
        description="قائمة العملاء المتأخّرين ≥٧ أيام. راجع، ثم أرسل تذكيراً عبر واتساب أو تخطَّ برأي مُوثَّق."
      />

      {/* منتقي النطاق — للأدمن حصراً: عبور الفروع + نطاق مدينِي الرصيد الافتتاحي المجمَّع. */}
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">النطاق:</span>
          <AppSelect
            value={effectiveScope === "opening" ? "opening" : String(effectiveScope ?? "")}
            onValueChange={(value) => setScope(value === "opening" ? "opening" : Number(value))}
            className="h-9 border-input px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {(branches.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
            <option value="opening">مدينو الرصيد الافتتاحي (كل الفروع)</option>
          </AppSelect>
          {effectiveScope === "opening" && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Landmark className="size-3.5" aria-hidden />
              أرصدة سابقة مُدوَّرة بلا فواتير نظام — للمتابعة والتحصيل.
            </span>
          )}
          {scope === undefined && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Info className="size-3.5" aria-hidden />
              يبدأ العرض بفرع الحساب، أو أول فرع فعّال عند غياب التعيين.
            </span>
          )}
        </div>
      )}

      {/* شريط الملخّص */}
      {tab === "queue" && queue.data && queue.data.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardContent className="flex items-center justify-between p-4">
              <span className="text-sm text-muted-foreground">عملاء بحاجة تذكير</span>
              <span className="text-xl font-bold tabular-nums">{queue.data.length}</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center justify-between p-4">
              <span className="text-sm text-muted-foreground">إجمالي الذمم</span>
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
          onSend={handleSend}
          onSendViaApi={handleSendViaApi}
          onSkip={setSkipTarget}
          onPrint={printTodayList}
          onExport={exportTodayList}
          sendingId={logSent.isPending ? logSent.variables?.customerId ?? null : null}
          sendingViaApiId={sendViaApi.isPending ? sendViaApi.variables?.customerId ?? null : null}
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
            <DialogTitle>تخطّي تذكير — {skipTarget?.customerName}</DialogTitle>
            <DialogDescription>
              سيُسجَّل التخطّي في السجلّ. بلا وعد: يختفي ٧ أيام. مع تاريخ وعد: يعود يوم الوعد نفسه بشارة «موعود» ليُذكَّرك بالمتابعة.
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
                placeholder="مثال: العميل وعد بالدفع، أو خارج البلد هذا الأسبوع"
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
                تاريخ الوعد بالدفع
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
                  ? `سيعود العميل لقائمة اليوم بتاريخ ${promisedDate} بشارة «موعود»، متجاوزاً تبريد ٧ أيام.`
                  : "اترك فارغاً لتخطٍّ عاديّ (يخضع لتبريد ٧ أيام)."}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSkipTarget(null)}>إلغاء</Button>
            <Button onClick={handleSkipConfirm} disabled={logSkipped.isPending || !skipReason.trim()}>
              {logSkipped.isPending ? "جارٍ…" : (promisedDate ? "تخطَّ + سجِّل الوعد" : "تخطَّ الآن")}
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
  sendingId: number | null;
  sendingViaApiId: number | null;
}) {
  if (isLoading) return <LoadingState />;
  if (isError) {
    return <ErrorState message="تعذّر تحميل قائمة التذكيرات." onRetry={refetch} />;
  }
  if (data.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <Clock className="size-10 text-muted-foreground" aria-hidden />
          <p className="text-lg font-semibold">لا تذكيرات مستحقّة اليوم</p>
          <p className="text-sm text-muted-foreground">جميع الذمم إمّا حديثة (&lt;٧ أيام) أو ذُكِّرت مؤخّراً.</p>
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
                <TableHead className="text-right">العميل</TableHead>
                <TableHead className="text-right">الهاتف</TableHead>
                <TableHead className="text-left">الرصيد الآجل</TableHead>
                {/* «متأخّر منذ» لا «أقدم فاتورة» — القيمة لصفوف الرصيد الافتتاحي هي تاريخ قيد
                    OPENING لا فاتورة، فالتسمية السابقة كانت مضلِّلة لهذه الصفوف (تحقّق عدائي ٥/٧). */}
                <TableHead className="text-center">متأخّر منذ</TableHead>
                <TableHead className="text-center">أيام التأخّر</TableHead>
                <TableHead className="text-center">آخر تذكير</TableHead>
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
                  <TableRow key={row.customerId} className={row.isPromiseDue ? "bg-[var(--sem-warn-bg)]/60" : ""}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span>{row.customerName}</span>
                        {row.isPromiseDue && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-[var(--sem-warn-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--sem-warn)]">
                            <CalendarClock className="size-3" aria-hidden />
                            موعود{row.promisedDate ? ` (${row.promisedDate})` : ""}
                          </span>
                        )}
                        {row.isOpeningBalance && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-[var(--sem-info-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--sem-info)]">
                            <Landmark className="size-3" aria-hidden />
                            رصيد مُدوَّر
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell dir="ltr" className="text-xs text-muted-foreground tabular-nums">{row.phone ?? "—"}</TableCell>
                    <TableCell className="text-left font-bold tabular-nums text-money-negative" dir="ltr">
                      {fmtAmount(row.totalUnpaid)}
                    </TableCell>
                    <TableCell className="text-center text-xs tabular-nums" dir="ltr">{row.oldestInvoiceDate}</TableCell>
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
                            key: "send",
                            kind: "other",
                            label: "أرسل",
                            icon: Send,
                            disabled: !row.phone || sendingId === row.customerId,
                            disabledReason: !row.phone ? "لا رقم هاتف مسجّل" : "الإرسال قيد التنفيذ",
                            onSelect: () => onSend(row),
                            gate: { roles: ["manager", "accountant"], module: "collections", level: "FULL" },
                          },
                          {
                            key: "send-api",
                            kind: "other",
                            label: "أرسل عبر API",
                            icon: Bot,
                            disabled: !row.phone || sendingViaApiId === row.customerId,
                            disabledReason: !row.phone ? "لا رقم هاتف مسجّل" : "الإرسال قيد التنفيذ",
                            onSelect: () => onSendViaApi(row),
                            gate: { roles: ["manager", "accountant"], module: "collections", level: "FULL" },
                          },
                          {
                            key: "skip",
                            kind: "approve",
                            label: "تخطَّ",
                            icon: SkipForward,
                            onSelect: () => onSkip(row),
                            gate: { roles: ["manager", "accountant"], module: "collections", level: "FULL" },
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
  // فلاتر السجلّ (بحث + حالة + مدى تاريخ) — تصفية عميلة على النافذة المجلوبة أصلاً (٣٠ يوماً، حدّ
  // ١٠٠٠ صفّ) لأن توسيع النافذة نفسها يتطلّب تعديل arRemindersService.ts (خارج نطاق هذه الشريحة).
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | "SENT" | "SKIPPED">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const filtered = useMemo(() => {
    let rows = data;
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      rows = rows.filter((r) => r.customerName.toLowerCase().includes(s));
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
          <p className="text-lg font-semibold">لا تذكيرات في آخر ٣٠ يوماً</p>
          <p className="text-sm text-muted-foreground">سيظهر هنا كل تذكير أُرسل أو تُخطّي فور تسجيله.</p>
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
            <option value="SENT">أُرسل</option>
            <option value="SKIPPED">تُخطّي/وعد</option>
          </AppSelect>
          <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-36" aria-label="من تاريخ" />
          <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-36" aria-label="إلى تاريخ" />
          {(search || status || from || to) && (
            <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setStatus(""); setFrom(""); setTo(""); }}>{FILTER_LABELS.reset}</Button>
          )}
        </div>
        <ScrollTableShell bordered={false}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">التاريخ</TableHead>
                <TableHead className="text-right">العميل</TableHead>
                <TableHead className="text-left">الرصيد وقت التذكير</TableHead>
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
                  <TableCell className="font-medium">{r.customerName}</TableCell>
                  <TableCell className="text-left tabular-nums" dir="ltr">{fmtAmount(r.totalUnpaidSnapshot)}</TableCell>
                  <TableCell className="text-center tabular-nums">{r.daysOverdue}</TableCell>
                  <TableCell className="text-center">
                    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs ${r.status === "SENT" ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : r.promisedDate ? "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]" : "bg-muted text-muted-foreground"}`}>
                      {r.status === "SENT" ? "أُرسل" : r.promisedDate ? "وعد" : "تُخطّي"}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <div className="flex flex-col gap-0.5">
                      <span>{r.skipReason ?? (r.status === "SENT" ? "رسالة واتساب" : "—")}</span>
                      {r.promisedDate && (
                        <span className="text-[11px] text-[var(--sem-warn)] inline-flex items-center gap-1">
                          <CalendarClock className="size-3" aria-hidden />
                          موعود بالدفع: <span dir="ltr" className="tabular-nums">{r.promisedDate}</span>
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
