import { useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { AlertTriangle, Truck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { isPartialDispatchRejection } from "@shared/partialDispatch";
import { notify } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { MoneyInput } from "@/components/form/MoneyInput";
import { fmt } from "@/lib/money";

export interface DispatchableInvoice {
  id: number;
  invoiceNumber: string;
  total: string | number;
  paidAmount?: string | number | null;
  returnedTotal?: string | number | null;
  customerName?: string | null;
  customerPhone?: string | null;
  deliveryAddress?: string | null;
}

export function InvoiceDispatchDialog({
  invoice,
  open,
  onOpenChange,
  onCompleted,
}: {
  invoice: DispatchableInvoice | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted?: () => void;
}) {
  const utils = trpc.useUtils();
  const partiesQ = trpc.delivery.listParties.useQuery(
    { activeOnly: true },
    { enabled: open, staleTime: 60_000, retry: false },
  );
  const [partyId, setPartyId] = useState("");
  const [fee, setFee] = useState("0");
  const [feeCollection, setFeeCollection] = useState<"COURIER" | "SHOP">(
    "COURIER",
  );
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [assignedUserId, setAssignedUserId] = useState("");

  const parties = partiesQ.data ?? [];
  const party = parties.find((p) => String(p.id) === partyId);
  const remaining = useMemo(() => {
    if (!invoice) return new Decimal(0);
    return Decimal.max(
      0,
      new Decimal(invoice.total || 0)
        .minus(invoice.paidAmount || 0)
        .minus(invoice.returnedTotal || 0),
    );
  }, [invoice]);

  /**
   * ش٥: الخادم يرفض إرسالَ فاتورةٍ لطلبٍ إخوتُه لم يجهزوا. لا نُظهر خانةَ إقرارٍ **مسبقاً**
   * (فتُنقَر بلا قراءة ويصير الحارس شكلياً) — بل نُظهر رسالته بأرقام الإخوة، ثمّ زرَّ إقرارٍ
   * صريحاً بجوارها. الحمولة لا تحمل العَلَم إلّا بعد أن يقرأ الموظّف ماذا يترك خلفه.
   */
  const [partialNotice, setPartialNotice] = useState<string | null>(null);

  const dispatch = trpc.delivery.dispatchInvoice.useMutation({
    onSuccess: async (result) => {
      setPartialNotice(null);
      notify.ok(
        "تم إسناد الفاتورة للتوصيل",
        `الإرسالية ${result.consignmentNumber}`,
      );
      await Promise.all([
        utils.sales.list.invalidate(),
        utils.sales.listPage.invalidate(),
        utils.delivery.invalidate(),
      ]);
      onOpenChange(false);
      onCompleted?.();
    },
    onError: (error) => {
      if (isPartialDispatchRejection(error)) {
        setPartialNotice(error.message);
        return;
      }
      notify.err(error);
    },
  });

  const submit = (partialDispatchConfirmed?: boolean) => {
    if (!invoice) return;
    dispatch.mutate({
      invoiceId: invoice.id,
      partyId: Number(partyId),
      deliveryFee: new Decimal(fee || 0).toDecimalPlaces(2).toFixed(2),
      feeCollection,
      recipientName: name.trim(),
      recipientPhone: phone.trim(),
      deliveryAddress: address.trim(),
      assignedUserId: assignedUserId ? Number(assignedUserId) : undefined,
      clientRequestId: crypto.randomUUID(),
      ...(partialDispatchConfirmed ? { partialDispatchConfirmed: true } : {}),
    });
  };

  useEffect(() => {
    if (!open || !invoice) return;
    setPartialNotice(null);
    setPartyId("");
    setFee("0");
    setFeeCollection("COURIER");
    setName(invoice.customerName ?? "");
    setPhone(invoice.customerPhone ?? "");
    setAddress(invoice.deliveryAddress ?? "");
    setAssignedUserId("");
  }, [invoice, open]);

  function resetFromInvoice(nextOpen: boolean) {
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={resetFromInvoice}>
      <DialogContent dir="rtl" className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck aria-hidden className="size-4" /> إسناد الفاتورة{" "}
            {invoice?.invoiceNumber ?? ""} للتوصيل
          </DialogTitle>
          <DialogDescription>
            ينشئ النظام إرسالية مرتبطة بالفاتورة، ويثبت المتبقي عهدةً على جهة
            التوصيل. لا يتغير المخزون أو مبلغ الفاتورة.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-1">
          <div className="space-y-1">
            <Label>جهة التوصيل</Label>
            <AppSelect
              value={partyId}
              onValueChange={(value) => {
                setPartyId(value);
                setAssignedUserId("");
                const selected = parties.find((p) => String(p.id) === value);
                if (selected) setFee(selected.defaultFee ?? "0");
              }}
              aria-label="جهة التوصيل"
              disabled={partiesQ.isLoading}
            >
              <option value="">
                {partiesQ.isLoading
                  ? "جارٍ تحميل الجهات…"
                  : "اختر مندوباً أو شركة"}
              </option>
              {parties.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name}
                </option>
              ))}
            </AppSelect>
          </div>

          {party?.partyType === "COMPANY" &&
            (party.drivers?.length ?? 0) > 0 && (
              <div className="space-y-1">
                <Label>السائق داخل الشركة</Label>
                <AppSelect
                  value={assignedUserId}
                  onValueChange={setAssignedUserId}
                  aria-label="السائق داخل الشركة"
                >
                  <option value="">طابور الشركة — يطالب به أول سائق</option>
                  {party.drivers?.map((driver) => (
                    <option key={driver.userId} value={String(driver.userId)}>
                      {driver.name}
                    </option>
                  ))}
                </AppSelect>
              </div>
            )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>اسم المستلم</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>هاتف المستلم</Label>
              <IntlPhoneInput
                value={phone}
                onChange={setPhone}
                ariaLabel="هاتف المستلم"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>عنوان التوصيل</Label>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>أجرة التوصيل</Label>
              <MoneyInput
                value={fee}
                onChange={setFee}
                ariaLabel="أجرة التوصيل"
              />
            </div>
            <div className="space-y-1">
              <Label>من يقبض الأجرة؟</Label>
              <AppSelect
                value={feeCollection}
                onValueChange={(v) => setFeeCollection(v as "COURIER" | "SHOP")}
                aria-label="من يقبض أجرة التوصيل"
              >
                <option value="COURIER">المندوب من الزبون</option>
                <option value="SHOP">على المكتبة</option>
              </AppSelect>
            </div>
          </div>
          <div className="rounded-md border bg-muted/35 p-2 text-xs leading-6 text-muted-foreground">
            المتبقي الذي يحصله المندوب للمكتبة:{" "}
            <strong className="tabular-nums text-foreground" dir="ltr">
              {fmt(remaining.toFixed(2))} د.ع
            </strong>
            . أجرة التوصيل مستقلة ولا تُضاف إلى إيراد الفاتورة.
          </div>
        </div>

        {partialNotice && (
          <div className="rounded-md border border-[var(--sem-warn)] bg-[var(--sem-warn-bg)] p-3">
            <p className="flex items-start gap-2 text-2xs font-bold leading-relaxed text-[var(--sem-warn)]">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
              {partialNotice}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={dispatch.isPending}
              onClick={() => submit(true)}
            >
              أقرّ الإرسال الجزئيّ وأرسل الآن
            </Button>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-start">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={dispatch.isPending}
          >
            إغلاق
          </Button>
          <Button
            disabled={
              !invoice ||
              !partyId ||
              !name.trim() ||
              !phone.trim() ||
              !address.trim() ||
              dispatch.isPending
            }
            onClick={() => submit()}
          >
            {dispatch.isPending ? "جارٍ الإسناد…" : "تأكيد الإسناد"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
