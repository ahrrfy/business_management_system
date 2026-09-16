import { useState } from "react";
import { Ban, CircleDollarSign, Undo2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { D, fmt } from "@/lib/money";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { RowActions } from "@/components/list";
import { buildOperationalContactMessage } from "@/lib/whatsapp";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type PlanLine,
  PLAN_STATUS_AR,
  LINE_STATUS_AR,
  StatusBadge,
} from "./installmentTypes";

interface PlanDetailDialogProps {
  planId: number;
  onClose: () => void;
  onPay: (line: PlanLine, branchId: number) => void;
  onChanged: () => Promise<void> | void;
}

export function PlanDetailDialog({
  planId,
  onClose,
  onPay,
  onChanged,
}: PlanDetailDialogProps) {
  const plan = trpc.installments.get.useQuery({ planId });
  const [bounceTarget, setBounceTarget] = useState<PlanLine | null>(null);
  const [bounceNote, setBounceNote] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelClientRequestId, setCancelClientRequestId] = useState(() => crypto.randomUUID());

  const bounce = trpc.installments.bounce.useMutation({
    onSuccess: async (res) => {
      notify.ok(res.reversed ? "سُجِّل ارتجاع الصك وعُكِس التحصيل (رُدَّ رصيد العميل)" : "سُجِّل ارتجاع الصك");
      setBounceTarget(null);
      setBounceNote("");
      await plan.refetch();
      await onChanged();
    },
    onError: (e) => notify.err(e.message || "تعذّر تسجيل الارتجاع"),
  });
  const cancel = trpc.installments.cancel.useMutation({
    onSuccess: async () => {
      notify.ok("أُلغيت الخطة");
      setCancelOpen(false);
      await plan.refetch();
      await onChanged();
    },
    onError: (e) => notify.err(e.message || "تعذّر إلغاء الخطة"),
  });

  const p = plan.data;
  const hasPaid = (p?.lines ?? []).some((l) => l.status === "PAID");

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>خطة الأقساط #{planId}</DialogTitle>
          {p && (
            <DialogDescription>
              {p.customerName} — الإجمالي <span dir="ltr" className="tabular-nums">{fmt(p.totalAmount)}</span> د.ع
              {D(p.downPayment).gt(0) && <> (دفعة أولى <span dir="ltr" className="tabular-nums">{fmt(p.downPayment)}</span>)</>}
              {p.invoiceId != null && <> — مرتبطة بالفاتورة #{p.invoiceId}</>}
            </DialogDescription>
          )}
        </DialogHeader>

        {plan.isLoading && <LoadingState />}
        {plan.isError && <ErrorState message="تعذّر تحميل الخطة." onRetry={() => plan.refetch()} />}

        {p && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge map={PLAN_STATUS_AR} value={p.status} />
              {p.notes && <span className="text-xs text-muted-foreground">{p.notes}</span>}
            </div>

            <ScrollTableShell maxHeightClass="max-h-80">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-center">#</TableHead>
                    <TableHead className="text-center">الاستحقاق</TableHead>
                    <TableHead className="text-left">المبلغ</TableHead>
                    <TableHead className="text-center">النوع</TableHead>
                    <TableHead className="text-center">الحالة</TableHead>
                    <TableHead className="text-right">ملاحظة/سند</TableHead>
                    <TableHead className="text-center">إجراءات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="text-center tabular-nums">{l.seq}</TableCell>
                      <TableCell className="text-center text-xs tabular-nums" dir="ltr">{l.dueDate}</TableCell>
                      <TableCell className="text-left font-semibold tabular-nums" dir="ltr">{fmt(l.amount)}</TableCell>
                      <TableCell className="text-center text-xs">
                        {l.kind === "CHECK" ? `صك ${l.checkNumber ?? ""}${l.bankName ? ` — ${l.bankName}` : ""}` : "نقدي"}
                      </TableCell>
                      <TableCell className="text-center"><StatusBadge map={LINE_STATUS_AR} value={l.status} /></TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {l.receiptId != null && <span className="tabular-nums">سند #{l.receiptId}</span>}
                        {l.receiptId != null && l.note ? " — " : ""}
                        {l.note ?? ""}
                      </TableCell>
                      <TableCell className="text-center whitespace-nowrap">
                        <RowActions
                          mode="inline"
                          contact={{
                            phone: p.customerPhone,
                            label: `واتساب ${p.customerName}`,
                            message: buildOperationalContactMessage({
                              entityLabel: "قسط",
                              reference: `${p.id}-${l.seq}`,
                              partyName: p.customerName,
                              title: `قيمة القسط: ${fmt(l.amount)} د.ع`,
                              dueAt: l.dueDate,
                              status: LINE_STATUS_AR[l.status]?.label ?? l.status,
                              nextAction: "يرجى تأكيد حالة السداد.",
                            }),
                            gate: { module: "treasury", level: "READ" },
                          }}
                          actions={[
                            {
                              key: "pay",
                              kind: "pay",
                              label: "سداد",
                              icon: CircleDollarSign,
                              hidden: p.status !== "ACTIVE" || (l.status !== "PENDING" && l.status !== "BOUNCED"),
                              onSelect: () => onPay(l, Number(p.branchId)),
                              gate: { roles: ["manager", "accountant"], module: "treasury", level: "FULL" },
                            },
                            {
                              key: "bounce",
                              kind: "reverse",
                              label: "ارتجاع",
                              icon: Undo2,
                              variant: "destructive",
                              hidden:
                                p.status === "CANCELLED"
                                || l.kind !== "CHECK"
                                || (l.status !== "PENDING" && !(l.status === "PAID" && l.receiptPaymentMethod === "CHECK")),
                              onSelect: () => setBounceTarget(l),
                              gate: { roles: ["manager", "accountant"], module: "treasury", level: "FULL" },
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollTableShell>

            {p.status === "ACTIVE" && (
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  className="gap-1 text-destructive"
                  disabled={hasPaid}
                  title={hasPaid ? "لا يمكن إلغاء خطة سُدِّد منها قسط" : undefined}
                  onClick={() => {
                    setCancelClientRequestId(crypto.randomUUID());
                    setCancelOpen(true);
                  }}
                >
                  <Ban className="size-4" aria-hidden /> إلغاء الخطة
                </Button>
              </div>
            )}
          </div>
        )}

        {/* حوار الارتجاع */}
        <Dialog open={bounceTarget != null} onOpenChange={(o) => { if (!o) { setBounceTarget(null); setBounceNote(""); } }}>
          <DialogContent className="z-[100] sm:max-w-md">
            <DialogHeader>
              <DialogTitle>ارتجاع صك — القسط رقم {bounceTarget?.seq}</DialogTitle>
              <DialogDescription>
                {bounceTarget?.status === "PAID"
                  ? "الصك مُحصَّل — سيُصدَر إيصال صرف معاكس (خزينة) ويُستعاد رصيد العميل بمقدار القسط، ثم يُوسم «صك مرتجع» قابلاً للسداد لاحقاً."
                  : "يُوسم القسط «صك مرتجع» بلا أي حركة مالية (الصك لم يُحصَّل أصلاً)، ويبقى قابلاً للسداد لاحقاً."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <Label>سبب الارتجاع</Label>
              <Textarea value={bounceNote} onChange={(e) => setBounceNote(e.target.value)} rows={2} maxLength={255} placeholder="مثال: رصيد غير كافٍ" />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setBounceTarget(null)}>تراجع</Button>
              <Button
                variant="destructive"
                disabled={bounce.isPending}
                onClick={() => bounceTarget && bounce.mutate({ lineId: bounceTarget.id, note: bounceNote.trim() || undefined })}
              >
                {bounce.isPending ? "جارٍ…" : "تسجيل الارتجاع"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* حوار الإلغاء */}
        <Dialog open={cancelOpen} onOpenChange={(o) => { if (!o) setCancelOpen(false); }}>
          <DialogContent className="z-[100] sm:max-w-md">
            <DialogHeader>
              <DialogTitle>إلغاء خطة الأقساط #{planId}</DialogTitle>
              <DialogDescription>تُلغى الخطة وكل أقساطها المعلَّقة — متاح فقط لخطة بلا أي قسط مسدَّد.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <Label>سبب الإلغاء</Label>
              <Textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={2} maxLength={500} placeholder="اختياري" />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCancelOpen(false)}>تراجع</Button>
              <Button
                variant="destructive"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate({
                  planId,
                  reason: cancelReason.trim() || undefined,
                  clientRequestId: cancelClientRequestId,
                })}
              >
                {cancel.isPending ? "جارٍ…" : "تأكيد الإلغاء"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
