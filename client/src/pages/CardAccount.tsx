// حساب البطاقة/البنك — رصيد أموال البطاقة (منفصل عن درج النقد) + حركاته + مطابقة كشف البنك.
// الرصيد مشتقّ من receipts (paymentMethod='CARD') — لا يمسّ الدرج/الخزينة. محصور بالمدير/المحاسب
// (reportViewerProcedure خادمياً). بلا إيموجي — أيقونات lucide فقط.
import { useEffect, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/form/MoneyInput";
import { LoadingState } from "@/components/PageState";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { notify } from "@/lib/notify";
import { fmtAr, formatIqd, D } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { selectCls } from "@/lib/ui/formStyles";
import {
  CreditCard,
  Landmark,
  ArrowDownCircle,
  ArrowUpCircle,
  Download,
  Printer,
  ScrollText,
  Scale,
  Search,
  Smartphone,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";


const SOURCE_AR: Record<string, string> = {
  SALE: "بيع",
  INVOICE_PAYMENT: "فاتورة/دفعة",
  VOUCHER: "سند",
  WORK_ORDER: "أمر شغل",
  // ش٤: عربون طلبٍ محفوظ (بطاقةً) — قبل التثبيت؛ بعده يصير الإيصال INVOICE_PAYMENT أو يبقى هنا لأوامر الشغل.
  DRAFT_DEPOSIT: "عربون طلب محفوظ",
  OTHER: "أخرى",
};

const PAGE = 50;
const todayStr = () => new Date().toISOString().slice(0, 10);

/** صفوفٌ مشتقّة من عقد الخادم فلا تنجرف عنه. */
type MovementRow = RouterOutputs["cardAccount"]["movements"]["rows"][number];
type ReconRow = RouterOutputs["cardAccount"]["reconciliations"][number];

export default function CardAccount() {
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";
  // منتقي الفرع للأدمن فقط: reportViewerProcedure يرفض طلبَ غير-الأدمن أيَّ branchId (حتى للمدير
  // متعدّد الفروع بـbranchId=null) ⇒ لا نعرض خياراً يرفضه الخادم. غير-الأدمن يُثبَّت خادمياً بفرعه
  // (ذو الفرع يطابق فرعه، ومتعدّد الفروع يرى المجموع بلا تقييد فرعٍ بعينه).
  const canPickBranch = isAdmin;
  const branches = trpc.branches.list.useQuery(undefined, { enabled: canPickBranch });

  const [branchId, setBranchId] = useState<number | "">("");
  const effBranch = branchId ? Number(branchId) : undefined;

  // ش٥ — تبويب الحساب: بطاقة/بنك (افتراضيّ) أو رصيد زين. نواة خدمةٍ واحدة معمَّمة بمعامل.
  const [accountKind, setAccountKind] = useState<"CARD" | "TELECOM">("CARD");
  // كل تسميات الأقسام/الطباعة/التصدير تتبع التبويب — «حساب البطاقة» على كشف زين تسميةٌ كاذبة.
  const isTelecom = accountKind === "TELECOM";
  const acctLabel = isTelecom ? "رصيد زين" : "البطاقة/البنك";
  const stmtLabel = isTelecom ? "كشف تسوية وكيل زين" : "كشف البنك";

  const summary = trpc.cardAccount.summary.useQuery({ branchId: effBranch, accountKind });

  // ── الحركات ──
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [direction, setDirection] = useState<"" | "IN" | "OUT">("");
  // بحث نصّي — وظيفة الشاشة الأساسية (مطابقة كشف البنك بحثاً عن حركة بعينها بمرجعها/رقم سندها/طرفها).
  const [q, setQ] = useState("");
  const qDebounced = useDebouncedValue(q.trim(), 300);
  const [sourceType, setSourceType] = useState<"" | "VOUCHER" | "INVOICE_PAYMENT" | "WORK_ORDER" | "DRAFT_DEPOSIT" | "OTHER">("");
  const [page, setPage] = useState(0);
  const movementsInput = {
    branchId: effBranch,
    accountKind,
    from: from || undefined,
    to: to || undefined,
    direction: direction || undefined,
    q: qDebounced || undefined,
    sourceType: sourceType || undefined,
  };
  const movements = trpc.cardAccount.movements.useQuery({
    ...movementsInput,
    limit: PAGE,
    offset: page * PAGE,
  });
  // أي تغيير في فلاتر الحركات يعيد الصفحة الأولى (وإلا offset قديم على مجموعة أصغر = صفحة فارغة).
  const movementsFilterKey = JSON.stringify(movementsInput);
  useEffect(() => { setPage(0); }, [movementsFilterKey]);

  // ── المطابقة ──
  const recons = trpc.cardAccount.reconciliations.useQuery({ branchId: effBranch, accountKind });
  const [asOfDate, setAsOfDate] = useState(todayStr());
  const [statementBalance, setStatementBalance] = useState("");
  const [statementLabel, setStatementLabel] = useState("");
  const [note, setNote] = useState("");
  const utils = trpc.useUtils();
  const createRec = trpc.cardAccount.createReconciliation.useMutation({
    onSuccess: (r) => {
      const diff = D(r.difference);
      notify.ok("سُجِّلت المطابقة", `رصيد النظام ${formatIqd(r.systemBalance)} — الفرق ${formatIqd(r.difference)}${diff.abs().gt(0) ? " (يستدعي المراجعة)" : ""}`);
      utils.cardAccount.reconciliations.invalidate();
      utils.cardAccount.summary.invalidate();
      setStatementBalance("");
      setStatementLabel("");
      setNote("");
    },
    onError: (e) => notify.err(e),
  });

  const needsBranchForRecon = canPickBranch && !effBranch;
  function submitRecon() {
    if (needsBranchForRecon) {
      notify.warn("اختر الفرع أوّلاً لتسجيل المطابقة");
      return;
    }
    if (!statementBalance) {
      notify.warn("أدخل رصيد كشف البنك");
      return;
    }
    createRec.mutate({
      branchId: effBranch,
      accountKind,
      asOfDate,
      statementBalance,
      statementLabel: statementLabel.trim() || undefined,
      note: note.trim() || undefined,
    });
  }

  const mv = movements.data;
  type MvRow = NonNullable<typeof movements.data>["rows"][number];

  // نجمع **كل** صفحات الفلتر الحاليّ (لا الصفحة المعروضة فقط) — للتصدير/الطباعة الماليّين معاً.
  function fetchAllMovements(): Promise<MvRow[]> {
    return fetchAllPaged<MvRow>(
      (offset, limit) =>
        utils.cardAccount.movements
          .fetch({ ...movementsInput, limit, offset })
          .then((res) => ({ rows: res.rows, total: res.count })),
      { pageSize: 500 },
    );
  }

  const [exporting, setExporting] = useState(false);
  async function onExport() {
    if (!mv || mv.count === 0) return;
    setExporting(true);
    try {
      const all = await fetchAllMovements();
      exportRows(all, {
        filename: `حساب-${isTelecom ? "رصيد-زين" : "البطاقة"}-حركات-${from || "الكل"}-${to || todayStr()}`,
        columns: [
          { key: "createdAt", header: "التاريخ", map: (r) => (r.createdAt ? new Date(r.createdAt as string).toISOString().slice(0, 10) : "") },
          { key: "source", header: "النوع", map: (r) => SOURCE_AR[r.source] ?? r.source },
          { key: "partyName", header: "الطرف", map: (r) => r.partyName ?? "" },
          { key: "direction", header: "الاتجاه", map: (r) => (r.direction === "IN" ? "دخل" : "صرف") },
          { key: "amount", header: "المبلغ", map: (r) => Number(r.amount) },
          { key: "runningBalance", header: "الرصيد بعد الحركة", map: (r) => (r.runningBalance != null ? Number(r.runningBalance) : "") },
          { key: "cardLastFour", header: "آخر 4", map: (r) => r.cardLastFour ?? "" },
          { key: "voucherNumber", header: "المرجع", map: (r) => r.voucherNumber ?? r.referenceNumber ?? "" },
        ],
      });
    } catch (e) {
      notify.err(e);
    } finally {
      setExporting(false);
    }
  }

  const [printing, setPrinting] = useState(false);
  async function onPrint() {
    if (!mv || mv.count === 0) return;
    setPrinting(true);
    try {
      const all = await fetchAllMovements();
      const filterLabels = [
        from || to ? `الفترة: ${from || "البداية"} — ${to || "اليوم"}` : null,
        direction ? `الاتجاه: ${direction === "IN" ? "دخل" : "صرف"}` : null,
        sourceType ? `النوع: ${SOURCE_AR[sourceType] ?? sourceType}` : null,
        qDebounced ? `بحث: ${qDebounced}` : null,
      ].filter(Boolean).join(" · ");
      const opened = printReportDoc({
        title: `حساب ${acctLabel} — حركات`,
        headerExtra: [
          { label: "الفرع", value: mv.branchId != null ? branches.data?.find((b) => b.id === mv.branchId)?.name ?? String(mv.branchId) : "كل الفروع" },
          ...(filterLabels ? [{ label: "الفلاتر", value: filterLabels }] : []),
        ],
        orientation: "landscape",
        columns: [
          { key: "date", label: "التاريخ" },
          { key: "source", label: "النوع" },
          { key: "party", label: "الطرف" },
          { key: "ref", label: "المرجع" },
          { key: "direction", label: "الاتجاه" },
          { key: "amount", label: "المبلغ", align: "left" },
          { key: "balance", label: "الرصيد بعد الحركة", align: "left" },
        ],
        rows: all.map((r) => ({
          date: r.createdAt ? new Date(r.createdAt as string).toISOString().slice(0, 10) : "—",
          source: SOURCE_AR[r.source] ?? r.source,
          party: r.partyName ?? "—",
          ref: r.voucherNumber ?? r.referenceNumber ?? "—",
          direction: r.direction === "IN" ? "دخل" : "صرف",
          amount: `${r.direction === "IN" ? "" : "−"}${fmtAr(r.amount)}`,
          balance: r.runningBalance != null ? fmtAr(r.runningBalance) : "—",
        })),
        summary: [
          { label: "دخل", value: fmtAr(mv.totalIn) },
          { label: "صرف", value: fmtAr(mv.totalOut) },
          { label: "الصافي", value: fmtAr(mv.net), large: true, bold: true },
        ],
      });
      if (!opened) notify.err("حجب المتصفح نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة.");
    } catch (e) {
      notify.err(e);
    } finally {
      setPrinting(false);
    }
  }

  const s = summary.data;

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4">
      <PageHeader
        title={accountKind === "TELECOM" ? "حساب رصيد زين" : "حساب البطاقة/البنك"}
        description={
          accountKind === "TELECOM"
            ? "رصيد اتصال زين المتراكم (أكواد كروت الشحن المقبوضة − التسويات) — لا يلمس الدرج، ويُسوّى دورياً."
            : "رصيد أموال البطاقة (مقبوضات البطاقة − مدفوعات المورّدين بالبطاقة) — منفصلٌ عن درج النقد والخزينة."
        }
        icon={accountKind === "TELECOM" ? <Smartphone aria-hidden className="size-5" /> : <CreditCard aria-hidden className="size-5" />}
        actions={
          canPickBranch ? (
            <AppSelect
              aria-label="الفرع"
              className="h-9"
              value={String(branchId)}
              onValueChange={(value) => {
                setBranchId(value ? Number(value) : "");
                setPage(0);
              }}
            >
              <option value="">كل الفروع</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </AppSelect>
          ) : undefined
        }
      />

      {/* ── ش٥: تبويب نوع الحساب المشتقّ ── */}
      <div className="flex gap-1.5" role="tablist" aria-label="نوع الحساب">
        {([["CARD", "بطاقة/بنك"], ["TELECOM", "رصيد زين"]] as const).map(([v, label]) => (
          <button
            key={v}
            role="tab"
            aria-selected={accountKind === v}
            onClick={() => { setAccountKind(v); setPage(0); }}
            className={
              accountKind === v
                ? "rounded-lg border-2 border-primary bg-primary px-4 py-1.5 text-xs font-extrabold text-primary-foreground"
                : "rounded-lg border-2 bg-card px-4 py-1.5 text-xs font-extrabold hover:bg-muted"
            }
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── بطاقات الملخّص ── */}
      {summary.isLoading ? (
        <LoadingState />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Card className="border-primary/30">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Landmark aria-hidden className="size-4" />
                الرصيد الحالي
              </div>
              <div className={`mt-1 text-2xl font-bold ${s && D(s.balance).lt(0) ? "text-[var(--money-negative)]" : ""}`}>
                {formatIqd(s?.balance ?? "0")}
              </div>
              {s?.branchId == null && <div className="mt-0.5 text-xs text-muted-foreground">مجموع كل الفروع</div>}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <ArrowDownCircle aria-hidden className="size-4 text-[var(--money-positive)]" />
                دخل اليوم
              </div>
              <div className="mt-1 text-xl font-semibold text-[var(--money-positive)]">{fmtAr(s?.todayIn ?? "0")}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <ArrowUpCircle aria-hidden className="size-4 text-[var(--money-negative)]" />
                صرف اليوم
              </div>
              <div className="mt-1 text-xl font-semibold text-[var(--money-negative)]">{fmtAr(s?.todayOut ?? "0")}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-muted-foreground text-sm">إجمالي دخل/صرف {isTelecom ? "رصيد زين" : "البطاقة"}</div>
              <div className="mt-1 text-sm">
                <span className="text-[var(--money-positive)]">{fmtAr(s?.totalIn ?? "0")}</span>
                <span className="mx-1 text-muted-foreground">/</span>
                <span className="text-[var(--money-negative)]">{fmtAr(s?.totalOut ?? "0")}</span>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{fmtAr(String(s?.movementCount ?? 0))} حركة</div>
            </CardContent>
          </Card>
        </div>
      )}

      {s?.lastReconciliation && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <Scale aria-hidden className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">آخر مطابقة ({s.lastReconciliation.asOfDate}):</span>
          <span>النظام {fmtAr(s.lastReconciliation.systemBalance)}</span>
          <span className="text-muted-foreground">مقابل الكشف {fmtAr(s.lastReconciliation.statementBalance)}</span>
          <span className={`font-semibold ${D(s.lastReconciliation.difference).abs().gt(0) ? "text-[var(--sem-warn)]" : "text-[var(--money-positive)]"}`}>
            الفرق {fmtAr(s.lastReconciliation.difference)}
          </span>
        </div>
      )}

      {/* ── الحركات ── */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold">
              <ScrollText aria-hidden className="size-4" />
              حركات حساب {acctLabel}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search aria-hidden className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="بحث بالمرجع أو رقم السند أو اسم الطرف"
                  placeholder="بحث بالمرجع/السند/الطرف…"
                  className="h-9 w-48 pr-8"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              <Input
                type="date"
                aria-label="من تاريخ"
                className="h-9 w-auto"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(0);
                }}
              />
              <Input
                type="date"
                aria-label="إلى تاريخ"
                className="h-9 w-auto"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPage(0);
                }}
              />
              <AppSelect
                aria-label="الاتجاه"
                className="h-9"
                value={direction}
                onValueChange={(value) => {
                  setDirection(value as "" | "IN" | "OUT");
                  setPage(0);
                }}
              >
                <option value="">الكل</option>
                <option value="IN">دخل</option>
                <option value="OUT">صرف</option>
              </AppSelect>
              <AppSelect
                aria-label="نوع الحركة"
                className="h-9 w-40"
                value={sourceType}
                onValueChange={(v) => { setSourceType(v as typeof sourceType); setPage(0); }}
                placeholder="كل الأنواع"
              >
                <option value="">كل الأنواع</option>
                <option value="VOUCHER">سند</option>
                <option value="INVOICE_PAYMENT">فاتورة/دفعة</option>
                <option value="WORK_ORDER">أمر شغل</option>
                <option value="DRAFT_DEPOSIT">عربون طلب محفوظ</option>
                <option value="OTHER">أخرى</option>
              </AppSelect>
              <Button variant="outline" size="sm" onClick={() => void onPrint()} disabled={printing || !mv || mv.count === 0}>
                <Printer aria-hidden className="size-4" />
                {printing ? "جارٍ التحضير…" : "طباعة A4"}
              </Button>
              <Button variant="outline" size="sm" onClick={onExport} disabled={exporting || !mv || mv.count === 0}>
                <Download aria-hidden className="size-4" />
                {exporting ? ACTION_LABELS.exporting : "تصدير"}
              </Button>
            </div>
          </div>

          {mv && (
            <div className="mb-2 flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span>دخل: <span className="font-medium text-[var(--money-positive)]">{fmtAr(mv.totalIn)}</span></span>
              <span>صرف: <span className="font-medium text-[var(--money-negative)]">{fmtAr(mv.totalOut)}</span></span>
              <span>الصافي: <span className="font-medium">{fmtAr(mv.net)}</span></span>
              <span>{fmtAr(String(mv.count))} حركة</span>
            </div>
          )}

          <DataTable<MovementRow>
            data={mv?.rows ?? []}
            loading={movements.isLoading}
            errorState={{ isError: movements.isError, message: movements.error?.message, onRetry: () => void movements.refetch() }}
            /* البحث والفلاتر في شريط الأدوات أعلاه (يغذّيان الاستعلام) — بلا هذا يظهر حقلا بحثٍ متجاوران. */
            searchable={false}
            externalFiltersActive={q.trim() !== "" || !!from || !!to || direction !== "" || sourceType !== ""}
            bounded={false}
            /* الترقيم خادميّ (limit/offset) والإجمالي حقيقيّ من استعلام المجاميع ⇒ شريطٌ واحد بدل شريطٍ يدويّ تحته. */
            serverPagination={{
              page,
              onPageChange: setPage,
              pageSize: PAGE,
              total: mv?.count,
              isFetching: movements.isFetching,
            }}
            getRowClassName={(r) => (r.reversed ? "opacity-50" : undefined)}
            emptyText={isTelecom ? "لا حركات رصيد زين في النطاق المحدَّد" : "لا حركات بطاقة في النطاق المحدَّد"}
            columns={[
              {
                id: "createdAt",
                header: "التاريخ",
                accessorFn: (r) => (r.createdAt ? new Date(r.createdAt as string).toISOString().slice(0, 10) : "—"),
                meta: { kind: "date" },
                cell: ({ row }) => (row.original.createdAt ? new Date(row.original.createdAt as string).toISOString().slice(0, 10) : "—"),
              },
              {
                id: "source",
                header: "النوع",
                // التسمية المعروضة لا الرمز الخامّ — «نسخ القيمة» يجب أن يطابق ما يقرأه المستعمِل.
                accessorFn: (r) => `${SOURCE_AR[r.source] ?? r.source}${r.reversed ? " (ملغى)" : ""}`,
                cell: ({ row }) => (
                  <>
                    {SOURCE_AR[row.original.source] ?? row.original.source}
                    {row.original.reversed && <span className="ms-1 text-xs text-muted-foreground">(ملغى)</span>}
                  </>
                ),
              },
              {
                id: "party",
                header: "الطرف",
                accessorFn: (r) => r.partyName ?? "—",
                cell: ({ row }) => row.original.partyName ?? <span className="text-muted-foreground">—</span>,
              },
              {
                id: "reference",
                header: "المرجع",
                accessorFn: (r) => `${r.voucherNumber ?? r.referenceNumber ?? ""}${r.cardLastFour ? ` •${r.cardLastFour}` : ""}`,
                cell: ({ row }) => (
                  <span className="text-xs text-muted-foreground">
                    {row.original.voucherNumber ?? row.original.referenceNumber ?? ""}
                    {row.original.cardLastFour && <span className="ms-1">•{row.original.cardLastFour}</span>}
                  </span>
                ),
              },
              {
                id: "direction",
                header: "الاتجاه",
                accessorFn: (r) => (r.direction === "IN" ? "دخل" : "صرف"),
                meta: { align: "center" },
                cell: ({ row }) =>
                  row.original.direction === "IN" ? (
                    <span className="inline-flex items-center gap-1 text-[var(--money-positive)]">
                      <ArrowDownCircle aria-hidden className="size-3.5" />دخل
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[var(--money-negative)]">
                      <ArrowUpCircle aria-hidden className="size-3.5" />صرف
                    </span>
                  ),
              },
              {
                id: "amount",
                header: "المبلغ",
                accessorFn: (r) => `${r.direction === "IN" ? "" : "−"}${fmtAr(r.amount)}`,
                meta: { kind: "money" },
                cell: ({ row }) => (
                  <span className={`font-medium ${row.original.direction === "IN" ? "text-[var(--money-positive)]" : "text-[var(--money-negative)]"}`}>
                    {row.original.direction === "IN" ? "" : "−"}
                    {fmtAr(row.original.amount)}
                  </span>
                ),
              },
              {
                id: "runningBalance",
                header: "الرصيد بعد الحركة",
                accessorFn: (r) => (r.runningBalance != null ? fmtAr(r.runningBalance) : "—"),
                meta: { kind: "money" },
                cell: ({ row }) => (row.original.runningBalance != null ? fmtAr(row.original.runningBalance) : "—"),
              },
            ]}
          />
        </CardContent>
      </Card>

      {/* ── المطابقة ── */}
      <Card>
        <CardContent className="p-4">
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <Scale aria-hidden className="size-4" />
            مطابقة {stmtLabel}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">
            يحسب النظام الرصيد المتوقَّع لحركات {acctLabel} حتى التاريخ المحدَّد، وتُدخِل رصيد {stmtLabel} الفعليّ ⇒ الفرق يكشف
            الصفقات غير المُسوَّاة أو الرسوم أو الأخطاء. سجلٌّ تدقيقيٌّ لا يمسّ أيّ رصيد.
          </p>

          {needsBranchForRecon && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-3 py-2 text-sm text-[var(--sem-warn)]">
              <AlertTriangle aria-hidden className="size-4" />
              اختر فرعاً محدَّداً (من الأعلى) لتسجيل مطابقة.
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label htmlFor="rec-date">حتى تاريخ</Label>
              <Input id="rec-date" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} max={todayStr()} />
            </div>
            <div>
              <Label htmlFor="rec-bal">رصيد {stmtLabel}</Label>
              <MoneyInput id="rec-bal" value={statementBalance} onChange={setStatementBalance} placeholder="0" ariaLabel={`رصيد ${stmtLabel}`} allowNegative />
            </div>
            <div>
              <Label htmlFor="rec-label">وصف الكشف (اختياري)</Label>
              <Input id="rec-label" value={statementLabel} onChange={(e) => setStatementLabel(e.target.value)} placeholder="كشف حزيران 2026" maxLength={120} />
            </div>
            <div className="flex items-end">
              <Button className="w-full" onClick={submitRecon} disabled={createRec.isPending || needsBranchForRecon}>
                <CheckCircle2 aria-hidden className="size-4" />
                {createRec.isPending ? "جارٍ التسجيل…" : "سجِّل المطابقة"}
              </Button>
            </div>
          </div>
          <div className="mt-3">
            <Label htmlFor="rec-note">ملاحظة (اختياري)</Label>
            <Textarea id="rec-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} placeholder="سبب الفرق إن وُجد…" />
          </div>

          {/* سجلّ المطابقات */}
          <div className="mt-5">
            {/* سجلٌّ مُضمَّن داخل بطاقة المطابقة ⇒ بلا شريط حالةٍ ولا منتقي أعمدة (ضجيجٌ هنا). */}
            <DataTable<ReconRow>
              embedded
              searchable={false}
              bounded={false}
              pageSize={Infinity}
              data={recons.data ?? []}
              loading={recons.isLoading}
              errorState={{ isError: recons.isError, message: recons.error?.message, onRetry: () => void recons.refetch() }}
              emptyText="لا سجلّات مطابقة بعد"
              columns={[
                {
                  id: "asOfDate",
                  header: "حتى تاريخ",
                  accessorFn: (r) => r.asOfDate,
                  meta: { kind: "date" },
                  cell: ({ row }) => row.original.asOfDate,
                },
                // عمود الفرع يظهر فقط في العرض العابر للفروع — كما كان بالضبط.
                ...(s?.branchId == null
                  ? ([
                      {
                        id: "branch",
                        header: "الفرع",
                        accessorFn: (r) => r.branchName ?? String(r.branchId),
                        cell: ({ row }) => row.original.branchName ?? row.original.branchId,
                      },
                    ] as ColumnDef<ReconRow, unknown>[])
                  : []),
                {
                  id: "statementLabel",
                  header: "الوصف",
                  accessorFn: (r) => r.statementLabel ?? "—",
                  meta: { width: "wide", wrap: true },
                  cell: ({ row }) => (
                    <>
                      {row.original.statementLabel ?? <span className="text-muted-foreground">—</span>}
                      {row.original.note && <div className="text-xs text-muted-foreground">{row.original.note}</div>}
                    </>
                  ),
                },
                {
                  id: "systemBalance",
                  header: "رصيد النظام",
                  accessorFn: (r) => fmtAr(r.systemBalance),
                  meta: { kind: "money" },
                  cell: ({ row }) => fmtAr(row.original.systemBalance),
                },
                {
                  id: "statementBalance",
                  header: "كشف البنك",
                  accessorFn: (r) => fmtAr(r.statementBalance),
                  meta: { kind: "money" },
                  cell: ({ row }) => fmtAr(row.original.statementBalance),
                },
                {
                  id: "difference",
                  header: "الفرق",
                  accessorFn: (r) => fmtAr(r.difference),
                  meta: { kind: "money" },
                  cell: ({ row }) => (
                    <span className={`font-semibold ${D(row.original.difference).abs().gt(0) ? "text-[var(--sem-warn)]" : "text-[var(--money-positive)]"}`}>
                      {fmtAr(row.original.difference)}
                    </span>
                  ),
                },
                {
                  id: "createdBy",
                  header: "بواسطة",
                  accessorFn: (r) => r.createdByName ?? "—",
                  meta: { width: "actor" },
                  cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.createdByName ?? "—"}</span>,
                },
              ]}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
