import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirm } from "@/lib/confirm";
import { iqd } from "@/lib/hr/ui";
import { D } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useState } from "react";

type PaymentMethod = "CASH" | "CARD" | "TRANSFER" | "WALLET";

export function PayrollPaymentDialog({
  open,
  run,
  onClose,
  onPaid,
}: {
  open: boolean;
  run: { id: number; period: string; totalNet: string; employeeCount: number; createdBy?: number | null } | null;
  onClose: () => void;
  onPaid: () => Promise<void> | void;
}) {
  const me = trpc.auth.me.useQuery(undefined, { enabled: open });
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [paymentDate, setPaymentDate] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const pay = trpc.payroll.pay.useMutation({
    onSuccess: async () => {
      notify.ok(D(run?.totalNet ?? 0).isZero()
        ? "أُقفل المسيّر ذو الصافي الصفري بلا إيصال نقدي"
        : "تم صرف صافي الرواتب وتسوية التزامات الموظفين");
      onClose();
      await onPaid();
    },
    onError: (error) => notify.err(error),
  });
  const isNonCash = method !== "CASH";
  const referenceValid = !isNonCash || (method === "CARD"
    ? /^\d{4}$/.test(referenceNumber.trim())
    : !!referenceNumber.trim());
  const owner = me.data?.isOwner === true;
  const independent = !!run && Number(me.data?.id ?? 0) !== Number(run.createdBy ?? 0);
  const canSubmit = !!run && owner && independent && referenceValid && !pay.isPending;

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>صرف صافي مسيّر {run?.period}</DialogTitle></DialogHeader>
        <div className="space-y-3 py-1">
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">صافي التزامات الموظفين</span>
              <strong className="tabular-nums" dir="ltr">{iqd(run?.totalNet ?? 0)} د.ع</strong>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              المصروف سُجّل عند اعتماد الاستحقاق. هذه العملية تسوّي التزام الصافي فقط ولا تسجّل مصروفاً جديداً.
            </p>
            {D(run?.totalNet ?? 0).isZero() && (
              <p className="mt-2 text-xs text-primary">الصافي صفر: سيُقفل المسيّر تدقيقياً بلا إيصال أو حركة خزينة.</p>
            )}
          </div>
          {(!owner || !independent) && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive" role="alert">
              {!owner ? "صرف الرواتب محصور بحساب مالك نشط." : "لا يجوز لمن أنشأ المسيّر أن يصرفه؛ يلزم مالك مستقل."}
            </p>
          )}
          <div>
            <Label htmlFor="payroll-payment-method">طريقة الدفع</Label>
            <AppSelect id="payroll-payment-method" value={method} onValueChange={(value) => setMethod(value as PaymentMethod)} className="w-full">
              <option value="CASH">نقداً من خزينة الفرع</option>
              <option value="TRANSFER">تحويل مصرفي</option>
              <option value="CARD">بطاقة/حساب مصرفي</option>
              <option value="WALLET">محفظة دفع</option>
            </AppSelect>
          </div>
          <div>
            <Label htmlFor="payroll-payment-date">تاريخ الدفع الفعلي</Label>
            <Input id="payroll-payment-date" type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} dir="ltr" />
            <p className="mt-1 text-xs text-muted-foreground">اتركه فارغاً لاستعمال تاريخ بغداد اليوم. لا يجوز أن يسبق تاريخ الاستحقاق.</p>
          </div>
          <div>
            <Label htmlFor="payroll-payment-ref">{method === "CARD" ? "آخر أربعة أرقام للبطاقة (إلزامي)" : `مرجع الدفع ${isNonCash ? "(إلزامي)" : "(اختياري)"}`}</Label>
            <Input
              id="payroll-payment-ref"
              value={referenceNumber}
              onChange={(event) => setReferenceNumber(method === "CARD" ? event.target.value.replace(/\D/g, "").slice(0, 4) : event.target.value)}
              inputMode={method === "CARD" ? "numeric" : undefined}
              maxLength={method === "CARD" ? 4 : 100}
              dir="ltr"
              placeholder={method === "CARD" ? "آخر 4 أرقام" : "رقم التحويل أو الحركة"}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button
            disabled={!canSubmit}
            onClick={async () => {
              if (!run) return;
              const approved = await confirm({
                variant: "danger",
                title: `صرف مسيّر ${run.period}`,
                description: D(run.totalNet).isZero()
                  ? "سيُقفل المسيّر بلا حركة نقدية لأن صافي الالتزامات صفر."
                  : `سيُصرف ${iqd(run.totalNet)} د.ع وتسوى التزامات ${run.employeeCount} موظف بحسب لقطة فروعهم.`,
                confirmText: "تنفيذ الصرف",
                requireText: "صرف",
              });
              if (!approved) return;
              pay.mutate({
                id: Number(run.id),
                paymentMethod: method,
                paymentDate: paymentDate || null,
                referenceNumber: referenceNumber.trim() || null,
              });
            }}
          >
            {pay.isPending ? "جارٍ الصرف…" : "تنفيذ الصرف"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
