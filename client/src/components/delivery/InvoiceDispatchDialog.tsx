import { useEffect, useMemo, useRef, useState } from "react";
import Decimal from "decimal.js";
import { AlertTriangle, Truck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { isPartialDispatchRejection } from "@shared/partialDispatch";
import { notify } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { AnimatedDeliveryButton } from "@/components/delivery/AnimatedDeliveryButton";
import { WhatsAppStageActionsMenu } from "@/components/delivery/WhatsAppStageActionsMenu";
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
import { fmt, moneyInput } from "@/lib/money";
import { Checkbox } from "@/components/ui/checkbox";

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
  const [feeCollection, setFeeCollection] = useState<"COURIER" | "SHOP" | "COUNTER">(
    "COURIER",
  );
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [assignedUserId, setAssignedUserId] = useState("");
  const [externalTrackingRef, setExternalTrackingRef] = useState("");
  const feeValid = /^(?:\d+|\d*\.\d{1,2})$/.test(fee);
  const [invoiceIds, setInvoiceIds] = useState<number[]>([]);
  const request = useRef({ fingerprint: "", key: crypto.randomUUID() });
  const candidatesQ = trpc.delivery.invoiceCandidates.useQuery(
    { invoiceId: invoice?.id ?? 0 },
    { enabled: open && invoice != null, staleTime: 0, retry: false },
  );
  const availableInvoices = useMemo(() => {
    const data = candidatesQ.data;
    if (!data) return invoice ? [invoice] : [];
    return Array.from(new Map([data.anchor, ...data.candidates].map((row) => [row.id, row])).values());
  }, [candidatesQ.data, invoice]);
  useEffect(() => {
    if (open && candidatesQ.data?.requiredInvoiceIds.length) setInvoiceIds(candidatesQ.data.requiredInvoiceIds);
  }, [open, candidatesQ.data]);

  const parties = partiesQ.data ?? [];
  const party = parties.find((p) => String(p.id) === partyId);
  const remaining = useMemo(() => {
    return availableInvoices.filter((row) => invoiceIds.includes(row.id)).reduce(
      (sum, row) => sum.plus(Decimal.max(0, new Decimal(row.total || 0).minus(row.paidAmount || 0).minus(row.returnedTotal || 0))),
      new Decimal(0),
    );
  }, [availableInvoices, invoiceIds]);

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
        invoiceIds.length > 1 ? "تم إسناد الفواتير في شحنة واحدة" : "تم إسناد الفاتورة للتوصيل",
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
    if (!invoice || !feeValid) return;
    if (party?.partyType === "COMPANY" && !externalTrackingRef.trim()) {
      notify.err("رقم بوليصة شركة التوصيل مطلوب", "امسح الباركود المطبوع على البوليصة قبل الإسناد.");
      return;
    }
    const payload = {
      invoiceId: invoice.id,
      ...(invoiceIds.length > 1 ? { invoiceIds } : {}),
      partyId: Number(partyId),
      deliveryFee: new Decimal(fee || 0).toDecimalPlaces(2).toFixed(2),
      feeCollection,
      recipientName: name.trim(),
      recipientPhone: phone.trim(),
      deliveryAddress: address.trim(),
      assignedUserId: assignedUserId ? Number(assignedUserId) : undefined,
      externalTrackingRef: externalTrackingRef.trim() || undefined,
      ...(partialDispatchConfirmed ? { partialDispatchConfirmed: true } : {}),
    };
    const fingerprint = JSON.stringify(payload);
    if (request.current.fingerprint !== fingerprint) request.current = { fingerprint, key: crypto.randomUUID() };
    dispatch.mutate({ ...payload, clientRequestId: request.current.key });
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
    setExternalTrackingRef("");
    setInvoiceIds([invoice.id]);
    request.current = { fingerprint: "", key: crypto.randomUUID() };
  }, [invoice?.id, open]);

  function resetFromInvoice(nextOpen: boolean) {
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={resetFromInvoice}>
      <DialogContent dir="rtl" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck aria-hidden className="size-4" /> إسناد الفاتورة{" "}
            {invoice?.invoiceNumber ?? ""} للتوصيل
          </DialogTitle>
          <DialogDescription>
            اختر فواتير الزبون التي ستصل معاً. شحنة واحدة وبوليصة واحدة وأجرة واحدة، مع حفظ حساب كل فاتورة.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-1">
          {availableInvoices.length > 1 && (
            <fieldset className="space-y-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-bold">فواتير الزبون في الشحنة ({invoiceIds.length})</legend>
              <div className="max-h-40 space-y-2 overflow-y-auto">
                {availableInvoices.map((row) => (
                  <label key={row.id} className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                      checked={invoiceIds.includes(row.id)}
                      disabled={row.id === invoice?.id || candidatesQ.data?.requiredInvoiceIds.includes(row.id) || dispatch.isPending}
                      onCheckedChange={(checked) => {
                        setPartialNotice(null);
                        setInvoiceIds((ids) => checked === true ? [...ids, row.id] : ids.filter((id) => id !== row.id));
                      }}
                    />
                    <span className="font-mono" dir="ltr">{row.invoiceNumber}</span>
                    <span className="ms-auto tabular-nums" dir="ltr">{fmt(Decimal.max(0, new Decimal(row.total || 0).minus(row.paidAmount || 0).minus(row.returnedTotal || 0)).toFixed(2))} د.ع</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">المبالغ الظاهرة هي المتبقي للتحصيل. الأجرة أدناه تخص الشحنة كلها.</p>
            </fieldset>
          )}
          {candidatesQ.isError && <p className="text-xs text-destructive">تعذر تحميل فواتير الزبون. <Button variant="link" size="sm" onClick={() => void candidatesQ.refetch()}>إعادة المحاولة</Button></p>}
          <div className="space-y-1">
            <Label>جهة التوصيل</Label>
            <AppSelect
              value={partyId}
              onValueChange={(value) => {
                setPartyId(value);
                setAssignedUserId("");
                setExternalTrackingRef("");
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

          {party?.partyType === "COMPANY" && (
            <div className="space-y-1">
              <Label htmlFor="invoice-dispatch-tracking">
                رقم تتبّع / بوليصة الشركة <span className="text-destructive">*</span>
              </Label>
              <Input
                id="invoice-dispatch-tracking"
                value={externalTrackingRef}
                onChange={(event) => setExternalTrackingRef(event.target.value)}
                placeholder="امسح باركود بوليصة الشركة أو أدخل الرقم"
                maxLength={100}
                dir="ltr"
                className="font-mono"
              />
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
                onValueChange={(v) => setFeeCollection(v as "COURIER" | "SHOP" | "COUNTER")}
                aria-label="من يقبض أجرة التوصيل"
              >
                <option value="COURIER">المندوب من الزبون</option>
                <option value="SHOP">على المكتبة</option>
                <option value="COUNTER">مقبوضة مسبقاً في الاستقبال</option>
              </AppSelect>
              {feeCollection === "COUNTER" && <p className="text-xs text-muted-foreground">أدخل الأجرة المقبوضة سابقاً؛ تُطابق مع إيصالها ولا تُقبض مرة ثانية.</p>}
            </div>
          </div>
          <div className="rounded-md border bg-muted/35 p-2 text-xs leading-6 text-muted-foreground">
            {remaining.isZero() ? (
              <>
                الفاتورة <strong className="text-[var(--sem-pos)]">مدفوعة مسبقاً بالكامل</strong> (متبقي البضاعة: 0 د.ع).
                {feeCollection === "COURIER" ? (
                  <> المطلوب من الزبون عند الاستلام: <strong className="tabular-nums text-foreground" dir="ltr">{fmt(moneyInput(fee).toFixed(2))} د.ع</strong> (أجرة التوصيل فقط للمندوب).</>
                ) : feeCollection === "COUNTER" ? (
                  <> لا مبالغ مطلوبة عند الاستلام؛ الأجرة مقبوضة مسبقاً في الاستقبال.</>
                ) : (
                  <> لا مبالغ مطلوبة من الزبون عند الاستلام (الأجرة لا يدفعها الزبون).</>
                )}
              </>
            ) : (
              <>
                المتبقي الذي يحصله المندوب للمكتبة:{" "}
                <strong className="tabular-nums text-foreground" dir="ltr">
                  {fmt(remaining.toFixed(2))} د.ع
                </strong>
                . أجرة التوصيل مستقلة ولا تُضاف إلى إيراد الفاتورة.
                {feeCollection === "COURIER" && moneyInput(fee).gt(0) && (
                  <> إجمالي ما يدفعه الزبون للمندوب: <strong className="tabular-nums text-foreground" dir="ltr">{fmt(remaining.plus(moneyInput(fee)).toFixed(2))} د.ع</strong> شامل التوصيل.</>
                )}
              </>
            )}
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

        <div className="mb-2 flex justify-end">
          {invoice && (
            <WhatsAppStageActionsMenu
              data={{
                orderNumber: invoice.invoiceNumber,
                customerName: name || invoice.customerName,
                customerPhone: phone || invoice.customerPhone,
                deliveryAddress: address || invoice.deliveryAddress,
                courierName: party?.name,
                codAmount: remaining.toFixed(2),
                deliveryFee: fee,
                feeCollection: feeCollection,
              }}
              size="sm"
              label="معاينة رسائل واتساب"
            />
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-start">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={dispatch.isPending}
          >
            إلغاء
          </Button>
          <AnimatedDeliveryButton
            disabled={
              !invoice ||
              !feeValid ||
              !partyId ||
              !name.trim() ||
              !phone.trim() ||
              !address.trim() ||
              (party?.partyType === "COMPANY" && !externalTrackingRef.trim()) ||
              dispatch.isPending
            }
            isDispatching={dispatch.isPending}
            label={invoiceIds.length > 1 ? `إسناد ${invoiceIds.length} فواتير بشحنة واحدة` : "تأكيد التسليم للمندوب"}
            onClick={() => submit()}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
