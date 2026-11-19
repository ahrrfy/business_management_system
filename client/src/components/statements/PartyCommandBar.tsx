import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorState, LoadingState } from "@/components/PageState";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { usePrintAudit } from "@/hooks/usePrintAudit";
import { fmtDate } from "@/lib/date";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printInvoicesBatch, type BatchInvoiceItem, type SplitPrintDocument } from "@/lib/printing/batchInvoicePrint";
import { getStatementPeriodPresets } from "@/lib/statementPeriodLedger";
import { trpc } from "@/lib/trpc";
import { toIraqiIntl } from "@/lib/whatsapp";
import { ArrowDownLeft, ArrowUpRight, Download, FileStack, Files, List, Phone, Printer, UserCheck } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

export type StatementDetailLevel = "normal" | "detailed";

export function StatementPeriodDetailBar({
  from,
  to,
  onRangeChange,
  detailLevel,
  onDetailLevelChange,
  allowAllEmpty = true,
  extra,
}: {
  from: string;
  to: string;
  onRangeChange: (next: { from: string; to: string }) => void;
  detailLevel: StatementDetailLevel;
  onDetailLevelChange: (lvl: StatementDetailLevel) => void;
  allowAllEmpty?: boolean;
  extra?: ReactNode;
}) {
  const presets = useMemo(() => getStatementPeriodPresets(allowAllEmpty), [allowAllEmpty]);

  return (
    <div className="flex flex-wrap items-end justify-between gap-2.5">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1 w-36">
          <Label className="text-[11px] text-muted-foreground">من تاريخ</Label>
          <Input type="date" dir="ltr" className="h-8 text-xs" value={from} onChange={(e) => onRangeChange({ from: e.target.value, to })} />
        </div>
        <div className="space-y-1 w-36">
          <Label className="text-[11px] text-muted-foreground">إلى تاريخ</Label>
          <Input type="date" dir="ltr" className="h-8 text-xs" value={to} onChange={(e) => onRangeChange({ from, to: e.target.value })} />
        </div>
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => {
            const r = p.get();
            const active = from === r.from && to === r.to;
            return (
              <Button key={p.key} type="button" variant={active ? "default" : "secondary"} size="sm" className="h-8 px-2.5 text-xs" onClick={() => onRangeChange(r)}>
                {p.label}
              </Button>
            );
          })}
        </div>
        {extra}
      </div>

      <div className="inline-flex items-center rounded-md border bg-muted/40 p-0.5" role="group" aria-label="مستوى التفصيل">
        <Button type="button" size="sm" variant={detailLevel === "normal" ? "default" : "ghost"} className="h-7 px-2.5 text-xs gap-1" onClick={() => onDetailLevelChange("normal")}>
          <List aria-hidden className="size-3.5" />
          <span>عادي (ملخص)</span>
        </Button>
        <Button type="button" size="sm" variant={detailLevel === "detailed" ? "default" : "ghost"} className="h-7 px-2.5 text-xs gap-1" onClick={() => onDetailLevelChange("detailed")}>
          <Files aria-hidden className="size-3.5" />
          <span>مفصل بالبنود</span>
        </Button>
      </div>
    </div>
  );
}

export interface PartyCommandBarProps {
  partyType: "SUPPLIER" | "CUSTOMER";
  partyName: string;
  phone?: string | null;
  whatsappMessage?: string;
  canWriteVoucher?: boolean;
  onOpenQuickVoucher: (type: "PAYMENT" | "RECEIPT") => void;
  onOpenDossier?: () => void;
  onOpenBatchPrint?: () => void;
}

export function PartyCommandBar({
  partyType,
  phone,
  whatsappMessage,
  canWriteVoucher = true,
  onOpenQuickVoucher,
  onOpenDossier,
  onOpenBatchPrint,
}: PartyCommandBarProps) {
  const intlPhone = toIraqiIntl(phone);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {canWriteVoucher && (
        <>
          <Button type="button" size="sm" variant={partyType === "SUPPLIER" ? "default" : "outline"} className="h-8 gap-1 text-xs" onClick={() => onOpenQuickVoucher("PAYMENT")}>
            <ArrowUpRight aria-hidden className="size-3.5" />
            <span>{partyType === "SUPPLIER" ? "سند صرف للمورد" : "سند صرف"}</span>
          </Button>
          <Button type="button" size="sm" variant={partyType === "CUSTOMER" ? "default" : "outline"} className="h-8 gap-1 text-xs" onClick={() => onOpenQuickVoucher("RECEIPT")}>
            <ArrowDownLeft aria-hidden className="size-3.5" />
            <span>{partyType === "CUSTOMER" ? "سند قبض من العميل" : "سند قبض من المورد"}</span>
          </Button>
        </>
      )}
      {onOpenBatchPrint && (
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={onOpenBatchPrint}>
          <FileStack aria-hidden className="size-3.5" />
          <span>طباعة فواتير الفترة</span>
        </Button>
      )}
      {onOpenDossier && (
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={onOpenDossier}>
          <UserCheck aria-hidden className="size-3.5" />
          <span>الملف الشامل 360°</span>
        </Button>
      )}
      {intlPhone && (
        <Button asChild type="button" size="sm" variant="outline" className="h-8 gap-1 text-xs">
          <a href={`tel:${intlPhone}`} dir="ltr">
            <Phone aria-hidden className="size-3.5" />
            <span>{phone}</span>
          </a>
        </Button>
      )}
      {phone && whatsappMessage && <WhatsAppShare phone={phone} message={whatsappMessage} label="واتساب" />}
    </div>
  );
}

export function BatchInvoicePrintDialog({
  open,
  onOpenChange,
  partyType,
  partyId,
  partyName,
  partyPhone,
  from,
  to,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partyType: "CUSTOMER" | "SUPPLIER";
  partyId: number;
  partyName: string;
  partyPhone?: string | null;
  from: string;
  to: string;
}) {
  const printAudit = usePrintAudit();
  const [mode, setMode] = useState<"merged" | "split">("merged");
  const [detailLevel, setDetailLevel] = useState<StatementDetailLevel>("detailed");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [splitDocs, setSplitDocs] = useState<SplitPrintDocument[]>([]);

  const q = trpc.reports.batchInvoicesData.useQuery(
    { partyType, partyId, from: from || undefined, to: to || undefined, includeItems: true, statusFilter: "COMPLETED_ONLY" },
    { enabled: open && partyId > 0 },
  );

  const invoices: BatchInvoiceItem[] = q.data?.invoices ?? [];

  useEffect(() => {
    if (open && invoices.length > 0) {
      setSelectedIds(invoices.map((i) => i.id));
      setSplitDocs([]);
    }
  }, [open, invoices.length]);

  const toggleId = (id: number) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  function downloadDocHtml(doc: SplitPrintDocument) {
    const blob = new Blob([doc.html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleRunPrint() {
    if (selectedIds.length === 0) return notify.err("اختر فاتورة واحدة على الأقل");
    try {
      await printAudit.run({
        documentType: partyType === "CUSTOMER" ? "CUSTOMER_STATEMENT" : "SUPPLIER_STATEMENT",
        documentId: partyId,
        channel: "PDF",
        open: async (audit) => {
          const res = await printInvoicesBatch({
            partyType, partyName, partyPhone, from, to, invoices, selectedIds, mode, detailLevel, printedByName: audit.actorName,
          });
          if (mode === "split") setSplitDocs(res.documents);
          return res.ok;
        },
      });
    } catch (e) {
      notify.err(e instanceof Error ? e.message : "تعذرت طباعة الفواتير");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="w-full sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>طباعة فواتير الفترة — {partyName}</DialogTitle>
          <DialogDescription>النطاق: {from || "البداية"} — {to || "الآن"}</DialogDescription>
        </DialogHeader>

        {q.isLoading && <LoadingState />}
        {q.isError && <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />}

        {q.data && (
          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-2">
              <div className="flex flex-wrap gap-1.5">
                <Button type="button" size="sm" variant={mode === "merged" ? "default" : "outline"} className="h-7 text-xs" onClick={() => setMode("merged")}>ملف PDF واحد مجمّع</Button>
                <Button type="button" size="sm" variant={mode === "split" ? "default" : "outline"} className="h-7 text-xs" onClick={() => setMode("split")}>مجزأ (فواتير مستقلة)</Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button type="button" size="sm" variant={detailLevel === "normal" ? "default" : "outline"} className="h-7 text-xs" onClick={() => setDetailLevel("normal")}>عادي</Button>
                <Button type="button" size="sm" variant={detailLevel === "detailed" ? "default" : "outline"} className="h-7 text-xs" onClick={() => setDetailLevel("detailed")}>مفصل بالبنود</Button>
              </div>
            </div>

            {invoices.length === 0 ? (
              <p className="py-6 text-center text-muted-foreground">لا فواتير مكتملة في هذه الفترة.</p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">المحدد: {selectedIds.length} من {invoices.length}</span>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setSelectedIds(invoices.map((i) => i.id))}>تحديد الكل</Button>
                    <Button type="button" size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setSelectedIds([])}>إلغاء التحديد</Button>
                  </div>
                </div>
                <div className="max-h-56 overflow-y-auto divide-y rounded-md border">
                  {invoices.map((inv) => (
                    <label key={inv.id} className="flex items-center justify-between gap-2 p-2 hover:bg-muted/30 cursor-pointer">
                      <div className="flex items-center gap-2">
                        <Checkbox checked={selectedIds.includes(inv.id)} onCheckedChange={() => toggleId(inv.id)} />
                        <span className="font-mono font-semibold" dir="ltr">{inv.documentNumber}</span>
                        <span className="text-muted-foreground">{fmtDate(inv.date)}</span>
                        <span className="text-muted-foreground">({inv.items.length} بند)</span>
                      </div>
                      <span className="font-semibold tabular-nums" dir="ltr">{fmt(inv.total)} د.ع</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {splitDocs.length > 0 && (
              <div className="rounded-md border bg-muted/20 p-2.5 space-y-1.5">
                <div className="font-semibold">تنزيل المستندات المجزأة منفردة:</div>
                <div className="flex flex-wrap gap-1.5">
                  {splitDocs.map((doc) => (
                    <Button key={doc.id} type="button" size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => downloadDocHtml(doc)}>
                      <Download aria-hidden className="size-3" />
                      <span>{doc.title}</span>
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>إغلاق</Button>
          <Button type="button" disabled={selectedIds.length === 0 || printAudit.pending} onClick={() => void handleRunPrint()} className="gap-1.5">
            <Printer aria-hidden className="size-3.5" />
            <span>{mode === "merged" ? "طباعة ملف PDF مجمّع" : "طباعة الفواتير مجزأة"}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
