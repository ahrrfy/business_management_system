// حساب البطاقة/البنك — رصيد أموال البطاقة (منفصل عن درج النقد) + حركاته + مطابقة كشف البنك.
// الرصيد مشتقّ من receipts (paymentMethod='CARD') — لا يمسّ الدرج/الخزينة. محصور بالمدير/المحاسب
// (reportViewerProcedure خادمياً). بلا إيموجي — أيقونات lucide فقط.
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/form/MoneyInput";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { notify } from "@/lib/notify";
import { fmtAr, formatIqd, D } from "@/lib/money";
import { exportRows } from "@/lib/export";
import {
  CreditCard,
  Landmark,
  ArrowDownCircle,
  ArrowUpCircle,
  Download,
  ScrollText,
  Scale,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const SOURCE_AR: Record<string, string> = {
  SALE: "بيع",
  INVOICE_PAYMENT: "فاتورة/دفعة",
  VOUCHER: "سند",
  WORK_ORDER: "أمر شغل",
  OTHER: "أخرى",
};

const PAGE = 50;
const todayStr = () => new Date().toISOString().slice(0, 10);

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

  const summary = trpc.cardAccount.summary.useQuery({ branchId: effBranch });

  // ── الحركات ──
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [direction, setDirection] = useState<"" | "IN" | "OUT">("");
  const [page, setPage] = useState(0);
  const movements = trpc.cardAccount.movements.useQuery({
    branchId: effBranch,
    from: from || undefined,
    to: to || undefined,
    direction: direction || undefined,
    limit: PAGE,
    offset: page * PAGE,
  });

  // ── المطابقة ──
  const recons = trpc.cardAccount.reconciliations.useQuery({ branchId: effBranch });
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
      asOfDate,
      statementBalance,
      statementLabel: statementLabel.trim() || undefined,
      note: note.trim() || undefined,
    });
  }

  const mv = movements.data;
  const [exporting, setExporting] = useState(false);
  async function onExport() {
    if (!mv || mv.count === 0) return;
    setExporting(true);
    try {
      // نجمع **كل** صفحات الفلتر الحاليّ (لا الصفحة المعروضة فقط) — تصدير ماليّ يجب أن يكون كاملاً.
      const all: NonNullable<typeof movements.data>["rows"] = [];
      let off = 0;
      for (let guard = 0; guard < 400; guard++) {
        const res = await utils.cardAccount.movements.fetch({
          branchId: effBranch,
          from: from || undefined,
          to: to || undefined,
          direction: direction || undefined,
          limit: 500,
          offset: off,
        });
        all.push(...res.rows);
        if (!res.hasMore) break;
        off += 500;
      }
      exportRows(all, {
        filename: `حساب-البطاقة-حركات-${from || "الكل"}-${to || todayStr()}`,
        columns: [
          { key: "createdAt", header: "التاريخ", map: (r) => (r.createdAt ? new Date(r.createdAt as string).toISOString().slice(0, 10) : "") },
          { key: "source", header: "النوع", map: (r) => SOURCE_AR[r.source] ?? r.source },
          { key: "partyName", header: "الطرف", map: (r) => r.partyName ?? "" },
          { key: "direction", header: "الاتجاه", map: (r) => (r.direction === "IN" ? "دخل" : "صرف") },
          { key: "amount", header: "المبلغ", map: (r) => Number(r.amount) },
          { key: "runningBalance", header: "الرصيد الجاري", map: (r) => (r.runningBalance != null ? Number(r.runningBalance) : "") },
          { key: "cardLastFour", header: "آخر ٤", map: (r) => r.cardLastFour ?? "" },
          { key: "voucherNumber", header: "المرجع", map: (r) => r.voucherNumber ?? r.referenceNumber ?? "" },
        ],
      });
    } catch (e) {
      notify.err(e);
    } finally {
      setExporting(false);
    }
  }

  const s = summary.data;

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4">
      <PageHeader
        title="حساب البطاقة/البنك"
        description="رصيد أموال البطاقة (مقبوضات البطاقة − مدفوعات المورّدين بالبطاقة) — منفصلٌ عن درج النقد والخزينة."
        icon={<CreditCard aria-hidden className="size-5" />}
        actions={
          canPickBranch ? (
            <select
              aria-label="الفرع"
              className={selectCls}
              value={branchId}
              onChange={(e) => {
                setBranchId(e.target.value ? Number(e.target.value) : "");
                setPage(0);
              }}
            >
              <option value="">كل الفروع</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          ) : undefined
        }
      />

      {/* ── بطاقات الملخّص ── */}
      {summary.isLoading ? (
        <LoadingState />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Card className="border-primary/30">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Landmark aria-hidden className="size-4" />
                الرصيد الجاري
              </div>
              <div className={`mt-1 text-2xl font-bold ${s && D(s.balance).lt(0) ? "text-red-600" : ""}`}>
                {formatIqd(s?.balance ?? "0")}
              </div>
              {s?.branchId == null && <div className="mt-0.5 text-xs text-muted-foreground">مجموع كل الفروع</div>}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <ArrowDownCircle aria-hidden className="size-4 text-green-600" />
                دخل اليوم
              </div>
              <div className="mt-1 text-xl font-semibold text-green-700">{fmtAr(s?.todayIn ?? "0")}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <ArrowUpCircle aria-hidden className="size-4 text-red-600" />
                صرف اليوم
              </div>
              <div className="mt-1 text-xl font-semibold text-red-700">{fmtAr(s?.todayOut ?? "0")}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-muted-foreground text-sm">إجمالي دخل/صرف البطاقة</div>
              <div className="mt-1 text-sm">
                <span className="text-green-700">{fmtAr(s?.totalIn ?? "0")}</span>
                <span className="mx-1 text-muted-foreground">/</span>
                <span className="text-red-700">{fmtAr(s?.totalOut ?? "0")}</span>
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
          <span className={`font-semibold ${D(s.lastReconciliation.difference).abs().gt(0) ? "text-amber-600" : "text-green-600"}`}>
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
              حركات حساب البطاقة
            </h2>
            <div className="flex flex-wrap items-center gap-2">
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
              <select
                aria-label="الاتجاه"
                className={selectCls}
                value={direction}
                onChange={(e) => {
                  setDirection(e.target.value as "" | "IN" | "OUT");
                  setPage(0);
                }}
              >
                <option value="">الكل</option>
                <option value="IN">دخل</option>
                <option value="OUT">صرف</option>
              </select>
              <Button variant="outline" size="sm" onClick={onExport} disabled={exporting || !mv || mv.count === 0}>
                <Download aria-hidden className="size-4" />
                {exporting ? "جارٍ التصدير…" : "تصدير"}
              </Button>
            </div>
          </div>

          {mv && (
            <div className="mb-2 flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span>دخل: <span className="font-medium text-green-700">{fmtAr(mv.totalIn)}</span></span>
              <span>صرف: <span className="font-medium text-red-700">{fmtAr(mv.totalOut)}</span></span>
              <span>الصافي: <span className="font-medium">{fmtAr(mv.net)}</span></span>
              <span>{fmtAr(String(mv.count))} حركة</span>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="p-2 text-start font-medium">التاريخ</th>
                  <th className="p-2 text-start font-medium">النوع</th>
                  <th className="p-2 text-start font-medium">الطرف</th>
                  <th className="p-2 text-start font-medium">المرجع</th>
                  <th className="p-2 text-center font-medium">الاتجاه</th>
                  <th className="p-2 text-end font-medium">المبلغ</th>
                  <th className="p-2 text-end font-medium">الرصيد الجاري</th>
                </tr>
              </thead>
              <tbody>
                {movements.isLoading ? (
                  <tr>
                    <td colSpan={7}>
                      <LoadingState />
                    </td>
                  </tr>
                ) : !mv || mv.rows.length === 0 ? (
                  <TableEmptyRow colSpan={7} message="لا حركات بطاقة في النطاق المحدَّد" />
                ) : (
                  mv.rows.map((r) => (
                    <tr key={r.receiptId} className={`border-b ${r.reversed ? "opacity-50" : ""}`}>
                      <td className="p-2 whitespace-nowrap">{r.createdAt ? new Date(r.createdAt as string).toISOString().slice(0, 10) : "—"}</td>
                      <td className="p-2">
                        {SOURCE_AR[r.source] ?? r.source}
                        {r.reversed && <span className="ms-1 text-xs text-muted-foreground">(ملغى)</span>}
                      </td>
                      <td className="p-2">{r.partyName ?? <span className="text-muted-foreground">—</span>}</td>
                      <td className="p-2 whitespace-nowrap text-xs text-muted-foreground">
                        {r.voucherNumber ?? r.referenceNumber ?? ""}
                        {r.cardLastFour && <span className="ms-1">•{r.cardLastFour}</span>}
                      </td>
                      <td className="p-2 text-center">
                        {r.direction === "IN" ? (
                          <span className="inline-flex items-center gap-1 text-green-700">
                            <ArrowDownCircle aria-hidden className="size-3.5" />دخل
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-red-700">
                            <ArrowUpCircle aria-hidden className="size-3.5" />صرف
                          </span>
                        )}
                      </td>
                      <td className={`p-2 text-end font-medium ${r.direction === "IN" ? "text-green-700" : "text-red-700"}`}>
                        {r.direction === "IN" ? "" : "−"}
                        {fmtAr(r.amount)}
                      </td>
                      <td className="p-2 text-end">{r.runningBalance != null ? fmtAr(r.runningBalance) : "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {mv && (mv.hasMore || page > 0) && (
            <div className="mt-3 flex items-center justify-between text-sm">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                السابق
              </Button>
              <span className="text-muted-foreground">صفحة {fmtAr(String(page + 1))}</span>
              <Button variant="outline" size="sm" disabled={!mv.hasMore} onClick={() => setPage((p) => p + 1)}>
                التالي
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── المطابقة ── */}
      <Card>
        <CardContent className="p-4">
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <Scale aria-hidden className="size-4" />
            مطابقة كشف البنك/البطاقة
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">
            يحسب النظام الرصيد المتوقَّع لحركات البطاقة حتى التاريخ المحدَّد، وتُدخِل رصيد كشف البنك الفعليّ ⇒ الفرق يكشف
            الصفقات غير المُسوَّاة أو الرسوم أو الأخطاء. سجلٌّ تدقيقيٌّ لا يمسّ أيّ رصيد.
          </p>

          {needsBranchForRecon && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
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
              <Label htmlFor="rec-bal">رصيد كشف البنك</Label>
              <MoneyInput id="rec-bal" value={statementBalance} onChange={setStatementBalance} placeholder="0" ariaLabel="رصيد كشف البنك" allowNegative />
            </div>
            <div>
              <Label htmlFor="rec-label">وصف الكشف (اختياري)</Label>
              <Input id="rec-label" value={statementLabel} onChange={(e) => setStatementLabel(e.target.value)} placeholder="كشف حزيران ٢٠٢٦" maxLength={120} />
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
          <div className="mt-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="p-2 text-start font-medium">حتى تاريخ</th>
                  {s?.branchId == null && <th className="p-2 text-start font-medium">الفرع</th>}
                  <th className="p-2 text-start font-medium">الوصف</th>
                  <th className="p-2 text-end font-medium">رصيد النظام</th>
                  <th className="p-2 text-end font-medium">كشف البنك</th>
                  <th className="p-2 text-end font-medium">الفرق</th>
                  <th className="p-2 text-start font-medium">بواسطة</th>
                </tr>
              </thead>
              <tbody>
                {recons.isLoading ? (
                  <tr>
                    <td colSpan={7}>
                      <LoadingState />
                    </td>
                  </tr>
                ) : !recons.data || recons.data.length === 0 ? (
                  <TableEmptyRow colSpan={7} message="لا سجلّات مطابقة بعد" />
                ) : (
                  recons.data.map((r) => (
                    <tr key={r.id} className="border-b">
                      <td className="p-2 whitespace-nowrap">{r.asOfDate}</td>
                      {s?.branchId == null && <td className="p-2">{r.branchName ?? r.branchId}</td>}
                      <td className="p-2">
                        {r.statementLabel ?? <span className="text-muted-foreground">—</span>}
                        {r.note && <div className="text-xs text-muted-foreground">{r.note}</div>}
                      </td>
                      <td className="p-2 text-end">{fmtAr(r.systemBalance)}</td>
                      <td className="p-2 text-end">{fmtAr(r.statementBalance)}</td>
                      <td className={`p-2 text-end font-semibold ${D(r.difference).abs().gt(0) ? "text-amber-600" : "text-green-600"}`}>
                        {fmtAr(r.difference)}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">{r.createdByName ?? "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
