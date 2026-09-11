/**
 * ReceptionCollectSection - قسم التحصيل والذمم في شاشة الاستقبال
 * تحصيل وذمم المناديب والشركات ومطابقة الكشوفات ومسح باركود الإرسالية
 */
import { useCallback, useEffect, useState } from "react";
import type { RouterOutputs } from "@/lib/trpc";
import { BarChart3, Building2, CheckCircle2, CheckSquare, Clock, Loader2, ScanLine, Square, User } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
import { MoneyInput } from "@/components/form/MoneyInput";
import { cn } from "@/lib/utils";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { confirm } from "@/lib/confirm";
import { printRemittanceReceipt } from "@/components/delivery/printRemittanceReceipt";
import { printCompanyStatementReceipt } from "@/lib/printing/printCompanyStatementReceipt";

export type PartyObligation = RouterOutputs["delivery"]["obligations"][number];

interface ActiveConsignmentInfo {
  id: number;
  consignmentNumber: string;
  partyId: number;
  partyName: string | null;
  partyType: "INDIVIDUAL" | "COMPANY" | null;
  parcelStatus: string;
  moneyStatus: string;
  codAmount: string;
  collectedAmount: string;
}

export interface ReceptionCollectSectionProps {
  branchId: number;
  shift: { id: number } | null;
  scannedBarcode?: string | null;
  onBarcodeConsumed?: () => void;
}

export function ReceptionCollectSection({
  branchId,
  shift,
  scannedBarcode,
  onBarcodeConsumed,
}: ReceptionCollectSectionProps) {
  const [selectedPartyId, setSelectedPartyId] = useState<number | null>(null);
  const [settleMode, setSettleMode] = useState<"courier" | "company">("courier");
  const [statementNumber, setStatementNumber] = useState("");
  const [statementDeductions, setStatementDeductions] = useState("");
  const [statementNotes, setStatementNotes] = useState("");
  const [selectedStatementLines, setSelectedStatementLines] = useState<Record<number, boolean>>({});
  const [countedCash, setCountedCash] = useState("");
  const [collectBarcodeInput, setCollectBarcodeInput] = useState("");
  const [isSearchingCollect, setIsSearchingCollect] = useState(false);
  const utils = trpc.useUtils();
  const partiesQ = trpc.delivery.listParties.useQuery({ activeOnly: true }, { staleTime: 60_000 });
  const obligationsQ = trpc.delivery.obligations.useQuery(undefined, { staleTime: 10_000, refetchInterval: 30_000 });
  const selectedParty = (obligationsQ.data ?? []).find((p: PartyObligation) => p.partyId === selectedPartyId);
  const partyInfo = (partiesQ.data ?? []).find((p) => p.id === selectedPartyId);
  const isCompany = partyInfo?.partyType === "COMPANY";
  const allCollectParties = partiesQ.data ?? [];
  const collectIndividualCouriers = allCollectParties.filter((p) => p.partyType === "INDIVIDUAL");
  const collectCompanyCouriers = allCollectParties.filter((p) => p.partyType === "COMPANY");
  const totalObligation = selectedParty ? Number(selectedParty.codDueTotal ?? 0) : 0;
  const inTransitAmount = selectedParty ? Number(selectedParty.parcelsInTransitAmount ?? 0) : 0;

  // الإرساليات المفتوحة للجهة المختارة — نحتاجها لبناء lines التوريد وتأكيد التسليم
  const openConsQ = trpc.delivery.openConsignments.useQuery(
    { partyId: selectedPartyId ?? 0, limit: 200 },
    { enabled: !!selectedPartyId, staleTime: 10_000, refetchInterval: 30_000 },
  );

  const openRows = openConsQ.data?.rows ?? [];
  const remittableRows = openRows.filter((r) => r.parcelStatus === "DELIVERED");
  const remittableTotal = remittableRows.reduce((sum, r) => {
    const due = Math.max(0, Number(r.codAmount ?? 0) - Number(r.collectedAmount ?? 0) - Number((r as { counterSettledAmount?: string | number }).counterSettledAmount ?? 0));
    return sum + due;
  }, 0);

  // حسابات وضع كشف الشركة:
  const statementSelectedRows = openRows.filter((r) => selectedStatementLines[r.id]);
  const statementSelectedCodTotal = statementSelectedRows.reduce((sum, r) => {
    const due = Math.max(0, Number(r.codAmount ?? 0) - Number(r.collectedAmount ?? 0) - Number((r as { counterSettledAmount?: string | number }).counterSettledAmount ?? 0));
    return sum + due;
  }, 0);
  const statementDeductionsNum = Number(statementDeductions || 0);
  const statementNetExpected = Math.max(0, statementSelectedCodTotal - statementDeductionsNum);

  const staffConfirmMut = trpc.delivery.staffConfirm.useMutation({
    onSuccess: () => {
      notify.ok("تم إثبات تسليم الطرد للزبون", "أصبح المبلغ بعهدة المندوب وجاهزاً للتوريد للدرج.");
      void obligationsQ.refetch(); void openConsQ.refetch(); void utils.delivery.invalidate();
    },
    onError: (e) => notify.err(e, "تعذّر تأكيد التسليم"),
  });

  const remitMut = trpc.delivery.recordRemittance.useMutation({
    onSuccess: (r) => {
      notify.ok("تم التحصيل والتوريد للدرج — " + r.remittanceNumber, "صاف " + fmt(r.netRemitted) + " د.ع");
      printRemittanceReceipt(selectedParty?.name ?? "المندوب", r);
      setCountedCash("");
      void obligationsQ.refetch(); void openConsQ.refetch(); void utils.delivery.invalidate();
    },
    onError: (e) => notify.err(e, "تعذّر التحصيل"),
  });

  const companyStatementMut = trpc.delivery.recordCompanyStatement.useMutation({
    onSuccess: (r) => {
      notify.ok(`سُجِّل كشف الشركة ${r.statementNumber}`, `سند التوريد ${r.remittanceNumber ?? ""} — صافٍ ${fmt(r.netRemitted)} د.ع`);
      const remainingOpen = openRows.filter((row) => !selectedStatementLines[row.id]);
      const remainingOpenAmount = remainingOpen.reduce((sum, row) => sum + Number(row.codAmount || 0), 0);
      printCompanyStatementReceipt({
        companyName: partyInfo?.name ?? selectedParty?.name ?? "شركة التوصيل",
        statementNumber: r.statementNumber,
        remittanceNumber: r.remittanceNumber,
        deliveriesConfirmed: r.deliveriesConfirmed,
        collectedTotal: r.collectedTotal,
        deductionsTotal: statementDeductions || "0",
        netRemitted: r.netRemitted,
        remainingOpenCount: remainingOpen.length,
        remainingOpenAmount: remainingOpenAmount.toFixed(2),
        settledAt: new Date(),
        notes: statementNotes.trim() || undefined,
      });
      setStatementNumber(""); setStatementDeductions(""); setStatementNotes(""); setCountedCash(""); setSelectedStatementLines({});
      void obligationsQ.refetch(); void openConsQ.refetch(); void utils.delivery.invalidate();
    },
    onError: (e) => notify.err(e, "تعذّر تسجيل كشف شركة التوصيل"),
  });

  async function handleConfirmDelivery(row: (typeof openRows)[number]) {
    const remaining = Math.max(0, Number(row.codAmount ?? 0) - Number(row.collectedAmount ?? 0) - Number((row as { counterSettledAmount?: string | number }).counterSettledAmount ?? 0));
    const ok = await confirm({
      title: "تأكيد تسليم الطرد للزبون",
      description: [
        `الإرسالية: ${row.consignmentNumber}`,
        `الفاتورة: #${row.invoiceNumber ?? row.invoiceId ?? ""}`,
        row.customerName ? `الزبون: ${row.customerName}` : "",
        `المبلغ المطلوب: ${fmt(String(remaining))} د.ع`,
        "سيُسجَّل أن المندوب سلّم الطلب للزبون وقبض المبلغ.",
      ].filter(Boolean).join("\n"),
      confirmText: "تأكيد التسليم",
    });
    if (!ok) return;

    staffConfirmMut.mutate({
      consignmentId: row.id,
      collectedAmount: remaining.toFixed(2),
      evidence: "تأكيد موظف الاستقبال / عودة المندوب",
      clientRequestId: crypto.randomUUID(),
    });
  }

  async function handleCollect() {
    if (!selectedPartyId || !countedCash || !shift) return;
    const amount = D(countedCash);
    if (amount.lte(0)) { notify.err("أدخل مبلغاً صحيحاً"); return; }

    if (remittableRows.length === 0) {
      notify.err("لا توجد طرود مسلّمة جاهزة للتوريد — تأكد من تأكيد تسليم الطرود أولاً");
      return;
    }

    // بناء lines تلقائياً: توزيع المبلغ بالترتيب الزمني على الإرساليات المُسلّمة فقط (DELIVERED)
    let remaining = amount;
    const lines: { consignmentId: number; collectedAmount: string }[] = [];
    for (const row of remittableRows) {
      if (remaining.lte(0)) break;
      const due = D(String(Math.max(0, Number(row.codAmount ?? 0) - Number(row.collectedAmount ?? 0) - Number((row as { counterSettledAmount?: string | number }).counterSettledAmount ?? 0))));
      if (due.lte(0)) continue;
      const take = round2(remaining.gte(due) ? due : remaining);
      lines.push({ consignmentId: row.id, collectedAmount: take.toFixed(2) });
      remaining = round2(remaining.minus(take));
    }

    if (lines.length === 0) { notify.err("لا مبالغ مستحقة للتوريد"); return; }

    const ok = await confirm({
      title: "تأكيد التحصيل والتوريد للدرج",
      description: [
        `الجهة: ${selectedParty?.name ?? ""}`,
        `المبلغ المستلَم: ${fmt(amount.toFixed(2))} د.ع`,
        `الذمة المسلّمة الجاهزة للتوريد: ${fmt(String(remittableTotal))} د.ع`,
        `عدد الإرساليات المُسوَّاة: ${lines.length}`,
        amount.lt(D(String(remittableTotal)))
          ? `تسوية جزئية — يبقى ${fmt(round2(D(String(remittableTotal)).minus(amount)).toFixed(2))} د.ع نقد بعهدة الجهة`
          : "تسوية كاملة للطرود المسلّمة — الأجرة معزولة تلقائياً",
      ].join("\n"),
      confirmText: "قبض وتوريد للدرج",
    });
    if (!ok) return;
    remitMut.mutate({ partyId: selectedPartyId, lines, countedCash: amount.toFixed(2), clientRequestId: crypto.randomUUID() });
  }

  async function handleCompanyStatementCollect() {
    if (!selectedPartyId || !shift) return;
    if (!statementNumber.trim()) {
      notify.err("يرجى إدخال رقم كشف الشركة");
      return;
    }
    const lines = statementSelectedRows.map((r) => {
      const due = Math.max(0, Number(r.codAmount ?? 0) - Number(r.collectedAmount ?? 0) - Number((r as { counterSettledAmount?: string | number }).counterSettledAmount ?? 0));
      return { consignmentId: r.id, collectedAmount: due.toFixed(2) };
    });
    if (lines.length === 0) {
      notify.err("يرجى تحديد طرد واحد على الأقل تم تسليمه في الكشف");
      return;
    }
    const cash = D(countedCash || String(statementNetExpected));
    if (cash.lte(0) && statementNetExpected > 0) {
      notify.err("أدخل المبلغ الصافي المستلم");
      return;
    }
    const ok = await confirm({
      title: "تأكيد تسوية كشف شركة التوصيل",
      description: [
        `الشركة: ${partyInfo?.name ?? ""}`,
        `رقم الكشف: ${statementNumber}`,
        `عدد الطرود المسلّمة بالكشف: ${lines.length}`,
        `إجمالي مبالغ الطرود (COD): ${fmt(String(statementSelectedCodTotal))} د.ع`,
        statementDeductionsNum > 0 ? `استقطاعات أجور الشركة: - ${fmt(String(statementDeductionsNum))} د.ع` : "",
        `صافي النقد المورّد للدرج: ${fmt(cash.toFixed(2))} د.ع`,
        openRows.length - lines.length > 0 ? `يبقى معلقاً بذمة الشركة: ${openRows.length - lines.length} طرود` : "تسوية شاملة لكل الطرود",
      ].filter(Boolean).join("\n"),
      confirmText: "تأكيد التسوية والقبض",
    });
    if (!ok) return;

    companyStatementMut.mutate({
      partyId: selectedPartyId,
      branchId,
      shiftType: "RECEPTION",
      statementNumber: statementNumber.trim(),
      statementDate: new Date().toISOString().slice(0, 10),
      deductionsTotal: statementDeductionsNum > 0 ? statementDeductionsNum.toFixed(2) : undefined,
      notes: statementNotes.trim() || undefined,
      lines,
      countedCash: cash.toFixed(2),
      clientRequestId: crypto.randomUUID(),
    });
  }

  const handleCollectBarcode = useCallback(async (raw: string) => {
    const code = raw.trim();
    if (!code) return;
    setIsSearchingCollect(true);
    try {
      const doc = await utils.workOrders.getByNumber.fetch({ orderNumber: code });
      if (!doc) {
        notify.err(`لم يتم العثور على أي طلب أو إرسالية للرمز: ${code}`);
        return;
      }
      const cn = (doc as { activeConsignment?: ActiveConsignmentInfo | null }).activeConsignment;
      if (!cn) {
        notify.warn(`الطلب #${doc.orderNumber} ليس له إرسالية توصيل نشطة حالياً.`);
        return;
      }
      setSelectedPartyId(cn.partyId);
      const pInfo = (partiesQ.data ?? []).find((p) => p.id === cn.partyId);
      if (pInfo?.partyType === "COMPANY") {
        setSettleMode("company");
        setSelectedStatementLines((prev) => ({ ...prev, [cn.id]: true }));
        notify.ok(`تم تحديد الإرسالية ${cn.consignmentNumber} لشركة ${pInfo.name}`);
      } else {
        setSettleMode("courier");
        const remaining = Math.max(0, Number(cn.codAmount ?? 0) - Number(cn.collectedAmount ?? 0));
        if (cn.parcelStatus !== "DELIVERED") {
          const ok = await confirm({
            title: "إثبات تسليم الطرد وقبض المبلغ",
            description: `الإرسالية: ${cn.consignmentNumber}\nالطلب: #${doc.orderNumber} — ${doc.customerName ?? ""}\nالمبلغ المطلوب: ${fmt(String(remaining))} د.ع\nالمندوب: ${pInfo?.name ?? ""}\n\nهل تود تأكيد تسليم الطرد للزبون وتجهيزه للتوريد للدرج؟`,
            confirmText: "إثبات التسليم",
          });
          if (ok) {
            staffConfirmMut.mutate({
              consignmentId: cn.id,
              collectedAmount: remaining.toFixed(2),
              evidence: "مسح باركود الاستقبال السريع",
              clientRequestId: crypto.randomUUID(),
            });
            setCountedCash(String(remaining));
          }
        } else {
          setCountedCash(String(remaining));
          notify.ok(`الإرسالية ${cn.consignmentNumber} مسلَّمة — المبلغ المطلوب للتوريد: ${fmt(String(remaining))} د.ع`);
        }
      }
      setCollectBarcodeInput("");
    } catch (e) {
      notify.err(e, "تعذّر البحث عن الإرسالية");
    } finally {
      setIsSearchingCollect(false);
    }
  }, [utils, partiesQ.data, staffConfirmMut]);

  useEffect(() => {
    if (scannedBarcode) {
      void handleCollectBarcode(scannedBarcode);
      onBarcodeConsumed?.();
    }
  }, [scannedBarcode, handleCollectBarcode, onBarcodeConsumed]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <ScanLine className="size-5 text-primary shrink-0" />
          <span className="text-sm font-extrabold text-primary">مسح باركود الإرسالية أو الفاتورة أو طلب المتجر للتحصيل</span>
        </div>
        <div className="flex gap-2">
          <Input
            value={collectBarcodeInput}
            onChange={(e) => setCollectBarcodeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && collectBarcodeInput.trim()) {
                void handleCollectBarcode(collectBarcodeInput.trim());
              }
            }}
            placeholder="امسح باركود الإرسالية (CNS-...) أو الفاتورة أو طلب المتجر (Enter)"
            className="flex-1 text-center font-bold text-sm h-11 bg-background"
            dir="ltr"
          />
          <Button
            variant="default"
            className="h-11 font-bold px-4 gap-1.5"
            onClick={() => void handleCollectBarcode(collectBarcodeInput.trim())}
            disabled={!collectBarcodeInput.trim() || isSearchingCollect}
          >
            {isSearchingCollect ? <Loader2 className="size-4 animate-spin" /> : "بحث وتحديد"}
          </Button>
        </div>
      </div>

      <Card className="gap-0 p-4">
        <h2 className="mb-3 font-extrabold flex items-center gap-2">
          <BarChart3 aria-hidden className="size-5" /> تحصيل وذمم المناديب والشركات
        </h2>
        <AppSelect
          value={selectedPartyId ? String(selectedPartyId) : ""}
          onValueChange={(v) => {
            const nextId = v ? Number(v) : null;
            setSelectedPartyId(nextId);
            setCountedCash("");
            setSelectedStatementLines({});
            const info = (partiesQ.data ?? []).find((p) => p.id === nextId);
            if (info?.partyType === "COMPANY") setSettleMode("company");
            else setSettleMode("courier");
          }}
          className="h-12 w-full text-base font-bold"
        >
          <option value="">— اختر المندوب أو شركة التوصيل —</option>
          {collectIndividualCouriers.length > 0 && (
            <optgroup label="── المناديب الداخليين (سائقون بعُهدة نقدية) ──">
              {collectIndividualCouriers.map((p) => {
                const bal = Number((obligationsQ.data ?? []).find((o: PartyObligation) => o.partyId === p.id)?.codDueTotal ?? 0);
                return <option key={p.id} value={String(p.id)}>{p.name} (مندوب){bal > 0 ? ` — عهدة: ${fmt(String(bal))} د.ع` : ""}</option>;
              })}
            </optgroup>
          )}
          {collectCompanyCouriers.length > 0 && (
            <optgroup label="── شركات ومكاتب التوصيل (مطابقة كشوفات دورية) ──">
              {collectCompanyCouriers.map((p) => {
                const bal = Number((obligationsQ.data ?? []).find((o: PartyObligation) => o.partyId === p.id)?.codDueTotal ?? 0);
                return <option key={p.id} value={String(p.id)}>{p.name} (شركة){bal > 0 ? ` — رصيد معلق: ${fmt(String(bal))} د.ع` : ""}</option>;
              })}
            </optgroup>
          )}
        </AppSelect>

        {selectedPartyId && isCompany && (
          <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
            <div className="flex items-center gap-2 text-xs font-extrabold text-blue-700">
              <Building2 className="size-4 shrink-0" />
              <span>نظام شركة التوصيل: مطابقة كشف الطلبات واستقطاعات الأجور وتوريد الصافي</span>
            </div>
            <Badge variant="outline" className="border-blue-500 text-blue-700 font-bold shrink-0">
              كشف شركة
            </Badge>
          </div>
        )}
        {selectedPartyId && !isCompany && (
          <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
            <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--sem-pos)]">
              <User className="size-4 shrink-0" />
              <span>نظام المندوب الفردي: عهدة نقدية ميدانية وتوريد مباشر للدرج (الأجرة معزولة)</span>
            </div>
            <Badge variant="outline" className="border-[var(--sem-pos)] text-[var(--sem-pos)] font-bold shrink-0">
              عهدة نقدية
            </Badge>
          </div>
        )}
      </Card>

      {selectedPartyId && (
        <Card className="gap-0 p-4 space-y-4">
          {obligationsQ.isLoading ? (
            <div className="py-8 text-center text-muted-foreground">جارٍ تحميل الذمة…</div>
          ) : (
            <>
              {/* ملخص الذمة */}
              <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-bold">إجمالي الذمة المسندة (COD)</span>
                    <p className="text-xs text-muted-foreground mt-0.5">مجموع قيمة الإرساليات غير المُسدَّدة — الأجرة معزولة</p>
                  </div>
                  <span className={cn("text-xl font-extrabold tabular-nums", totalObligation > 0 ? "text-destructive" : "text-[var(--sem-pos)]")}>
                    {fmt(String(totalObligation))} د.ع
                  </span>
                </div>

                {totalObligation > 0 && (
                  <div className="grid grid-cols-2 gap-2 pt-2 border-t text-xs">
                    <div className="rounded-lg border bg-background/60 p-2.5">
                      <div className="text-muted-foreground">طرود في الطريق</div>
                      <div className="text-base font-extrabold tabular-nums text-foreground mt-0.5">
                        {fmt(String(inTransitAmount))} د.ع
                      </div>
                      <div className="text-[11px] text-muted-foreground">بعهدة الجهة للتسليم</div>
                    </div>
                    <div className="rounded-lg border bg-background/60 p-2.5">
                      <div className="text-muted-foreground">نقد جاهز للتوريد</div>
                      <div className="text-base font-extrabold tabular-nums text-[var(--sem-pos)] mt-0.5">
                        {fmt(String(remittableTotal))} د.ع
                      </div>
                      <div className="text-[11px] text-muted-foreground">سُلِّم للزبون بانتظار التوريد</div>
                    </div>
                  </div>
                )}
              </div>

              {/* ─── وضع كشف شركة التوصيل ─── */}
              {settleMode === "company" ? (
                <div className="space-y-4">
                  <div className="rounded-xl border border-primary/20 bg-primary/5 p-3.5 space-y-3">
                    <div className="flex items-center gap-2">
                      <Building2 className="size-4 text-primary" />
                      <span className="text-sm font-extrabold text-primary">بيانات كشف شركة التوصيل</span>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs font-bold">رقم الكشف المسلَّم من الشركة <span className="text-destructive">*</span></label>
                        <Input
                          value={statementNumber}
                          onChange={(e) => setStatementNumber(e.target.value)}
                          placeholder="مثال: STMT-2026-09"
                          className="h-10 bg-background font-mono font-bold"
                          dir="ltr"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-bold">استقطاعات أجور الشركة (د.ع)</label>
                        <MoneyInput
                          value={statementDeductions}
                          onChange={setStatementDeductions}
                          placeholder="0"
                          className="h-10 bg-background"
                          ariaLabel="استقطاعات أجور الشركة"
                        />
                      </div>
                    </div>
                  </div>

                  {/* قائمة الطرود مع إمكانية التحديد بالمطابقة */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold text-muted-foreground">
                        الطرود المفتوحة للشركة ({openRows.length})
                      </h3>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-7 font-bold"
                          onClick={() => {
                            const next: Record<number, boolean> = {};
                            openRows.forEach((r) => { next[r.id] = true; });
                            setSelectedStatementLines(next);
                          }}
                        >
                          تحديد الكل
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-7 font-bold text-muted-foreground"
                          onClick={() => setSelectedStatementLines({})}
                        >
                          إلغاء التحديد
                        </Button>
                      </div>
                    </div>

                    {openRows.length === 0 ? (
                      <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                        لا توجد طرود مفتوحة لهذه الشركة
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {openRows.map((row) => {
                          const cod = Number(row.codAmount ?? 0);
                          const isSelected = !!selectedStatementLines[row.id];
                          return (
                            <div
                              key={row.id}
                              onClick={() => setSelectedStatementLines((prev) => ({ ...prev, [row.id]: !prev[row.id] }))}
                              className={cn(
                                "flex items-center justify-between gap-3 rounded-xl border p-3 cursor-pointer transition-colors shadow-xs",
                                isSelected ? "border-primary bg-primary/5" : "bg-background hover:bg-muted/20",
                              )}
                            >
                              <div className="flex items-center gap-3">
                                <div className="shrink-0 text-primary">
                                  {isSelected ? <CheckSquare className="size-5" /> : <Square className="size-5 text-muted-foreground" />}
                                </div>
                                <div className="space-y-0.5">
                                  <div className="flex items-center gap-2">
                                    <span className="font-extrabold text-sm">فاتورة #{row.invoiceNumber ?? row.invoiceId}</span>
                                    <span className="text-xs text-muted-foreground font-mono">{row.consignmentNumber}</span>
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {row.customerName && <span>الزبون: <strong className="text-foreground">{row.customerName}</strong></span>}
                                  </div>
                                </div>
                              </div>
                              <div className="text-end">
                                <span className="text-xs text-muted-foreground block">المطلوب (COD)</span>
                                <span className="font-extrabold text-sm tabular-nums text-foreground">{fmt(String(cod))} د.ع</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* حسابات التوريد والتأكيد */}
                  {shift && statementSelectedRows.length > 0 && (
                    <div className="rounded-xl border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)]/20 p-4 space-y-3">
                      <p className="text-sm font-extrabold text-[var(--sem-pos)]">مطابقة الكشف والقبض في الدرج</p>
                      <div className="grid grid-cols-3 gap-2 text-xs border-b border-[var(--sem-pos)]/20 pb-3">
                        <div>
                          <span className="text-muted-foreground block">طرود الكشف المسلّمة</span>
                          <span className="font-extrabold text-sm">{statementSelectedRows.length} طرود</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block">مجموع الـ COD</span>
                          <span className="font-extrabold text-sm">{fmt(String(statementSelectedCodTotal))} د.ع</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block">صافي النقد المتوقع</span>
                          <span className="font-extrabold text-sm text-[var(--sem-pos)]">{fmt(String(statementNetExpected))} د.ع</span>
                        </div>
                      </div>

                      {openRows.length - statementSelectedRows.length > 0 && (
                        <p className="text-xs text-[var(--sem-warn)] font-bold">
                          يبقى معلقاً بذمة الشركة: {openRows.length - statementSelectedRows.length} طرود (لم تُذكر بالكشف أو مؤجلة)
                        </p>
                      )}

                      <div className="flex gap-2 pt-1">
                        <MoneyInput
                          value={countedCash}
                          onChange={setCountedCash}
                          placeholder={"المبلغ الصافي المستلم (المتوقع: " + fmt(String(statementNetExpected)) + ")"}
                          className="flex-1 h-11 text-base font-bold bg-background"
                          ariaLabel="المبلغ الصافي المستلم"
                        />
                        <Button
                          className="bg-[var(--sem-pos)] hover:bg-[var(--sem-pos)]/90 text-background px-6 font-bold"
                          disabled={companyStatementMut.isPending || !statementNumber.trim()}
                          onClick={() => void handleCompanyStatementCollect()}
                        >
                          {companyStatementMut.isPending ? "جارٍ التوريد…" : "تسوية الكشف وتوريد النقد"}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                /* ─── وضع تسوية المندوب الفردي التقليدي ─── */
                <>
                  <div className="space-y-2">
                    <h3 className="text-xs font-bold text-muted-foreground flex items-center justify-between">
                      <span>الطرود والإرساليات المسندة ({openRows.length})</span>
                      {inTransitAmount > 0 && (
                        <span className="font-normal text-[var(--sem-warn)]">
                          {openRows.filter((r) => r.parcelStatus !== "DELIVERED").length} طرود في الطريق
                        </span>
                      )}
                    </h3>
                    {openConsQ.isLoading ? (
                      <div className="py-4 text-center text-xs text-muted-foreground">جارٍ تحميل الطرود…</div>
                    ) : openRows.length === 0 ? (
                      <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                        لا توجد طرود مفتوحة
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {openRows.map((row) => {
                          const cod = Number(row.codAmount ?? 0);
                          const isDelivered = row.parcelStatus === "DELIVERED";
                          const isInTransit = !isDelivered;
                          return (
                            <div key={row.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border bg-background p-3 shadow-xs">
                              <div className="min-w-0 space-y-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-extrabold text-sm">
                                    فاتورة #{row.invoiceNumber ?? row.invoiceId}
                                  </span>
                                  <span className="text-xs text-muted-foreground font-mono">
                                    {row.consignmentNumber}
                                  </span>
                                  {isInTransit && (
                                    <Badge variant="secondary" className="text-[11px] font-bold">
                                      في الطريق
                                    </Badge>
                                  )}
                                  {isDelivered && (
                                    <Badge className="bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-transparent text-[11px] font-bold">
                                      سلم — جاهز للتوريد
                                    </Badge>
                                  )}
                                </div>
                                <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                                  {row.customerName && <span>الزبون: <strong className="text-foreground">{row.customerName}</strong></span>}
                                  <span>المطلوب (COD): <strong className="text-foreground tabular-nums">{fmt(String(cod))} د.ع</strong></span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                                {isInTransit && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="font-bold text-xs h-8"
                                    disabled={staffConfirmMut.isPending}
                                    onClick={() => void handleConfirmDelivery(row)}
                                  >
                                    <CheckCircle2 aria-hidden className="size-3.5 ms-1 text-[var(--sem-pos)]" />
                                    تأكيد التسليم
                                  </Button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* قسم القبض والتوريد للدرج للمندوب */}
                  {shift && remittableTotal > 0 && (
                    <div className="rounded-xl border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)]/20 p-4 space-y-3">
                      <p className="text-sm font-extrabold text-[var(--sem-pos)]">قبض وتوريد النقد للدرج</p>
                      <p className="text-xs text-muted-foreground">توريد المبالغ المحصلة من الطرود المسلمة للوردية الحالية — الأجرة معزولة</p>
                      <div className="flex gap-2">
                        <MoneyInput
                          value={countedCash}
                          onChange={setCountedCash}
                          placeholder={"المبلغ المستلَم (الكامل: " + fmt(String(remittableTotal)) + ")"}
                          className="flex-1 h-11 text-base font-bold bg-background"
                          ariaLabel="المبلغ المستلَم"
                        />
                        <Button
                          className="bg-[var(--sem-pos)] hover:bg-[var(--sem-pos)]/90 text-background px-6 font-bold"
                          disabled={!countedCash || remitMut.isPending}
                          onClick={() => void handleCollect()}
                        >
                          {remitMut.isPending ? "…" : "قبض وتوريد"}
                        </Button>
                      </div>
                      {countedCash && D(String(remittableTotal)).gt(0) && D(countedCash).lt(D(String(remittableTotal))) && (
                        <p className="text-xs text-[var(--sem-warn)] font-bold">
                          تسوية جزئية — يبقى {fmt(round2(D(String(remittableTotal)).minus(D(countedCash))).toFixed(2))} د.ع بعهدة الجهة
                        </p>
                      )}
                    </div>
                  )}

                  {shift && remittableTotal === 0 && totalObligation > 0 && (
                    <div className="rounded-xl border bg-muted/40 p-4 space-y-2">
                      <div className="flex items-center gap-2 font-bold text-xs text-foreground">
                        <Clock aria-hidden className="size-4 text-muted-foreground" />
                        <span>الطرود لا تزال في الطريق مع المندوب</span>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        إجمالي مبالغ الطرود ({fmt(String(totalObligation))} د.ع) لا تزال بعهدة المندوب في الميدان.
                        عند عودة المندوب وتسليم الطلب، اضغط <strong>«تأكيد التسليم»</strong> على الطرد أعلاه، وسيظهر زر القبض والتوريد للدرج فوراً مع طباعة الإيصال.
                      </p>
                    </div>
                  )}
                </>
              )}

              {totalObligation === 0 && (
                <div className="rounded-xl border bg-[var(--sem-pos-bg)]/20 p-4 text-center text-[var(--sem-pos)] font-bold">
                  لا ذمة على هذه الجهة
                </div>
              )}

              {!shift && <p className="text-sm text-destructive text-center">افتح وردية استقبال لتسجيل التحصيل</p>}
            </>
          )}
        </Card>
      )}
    </div>
  );
}
