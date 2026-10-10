/**
 * نافذة إصدار قسيمة هدية فورية للزبون (Instant Gift Voucher Modal)
 * تُستخدم للإهداء الفوري وترضية الشكاوى ومكافأة كبار العملاء (VIP).
 *
 * تتضمن خيارات فورية:
 * 1. توليد الكوبون أصولياً في النظام.
 * 2. إرسال الكوبون فوراً عبر واتساب بنص عراقي راقٍ ومفهوم.
 * 3. طباعة إيصال القسيمة على الطابعات الحرارية (80mm).
 *
 * صفر إيموجي — يعتمد أيقونات lucide-react حصراً.
 */

import { useState, useEffect } from "react";
import Decimal from "decimal.js";
import {
  Gift,
  CheckCircle2,
  Copy,
  Printer,
  MessageCircle,
  RefreshCw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { MoneyInput } from "@/components/form/MoneyInput";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmtAr } from "@/lib/money";
import { buildInstantGiftWhatsAppMessage, openWhatsApp } from "@/lib/whatsapp";
import { printGiftVoucher } from "@/lib/printing/giftVoucherPrint";

export interface InstantGiftModalProps {
  isOpen?: boolean;
  open?: boolean;
  onClose: () => void;
  customerId: number;
  customerName: string;
  customerPhone?: string | null;
  feedbackId?: number | null;
  onSuccess?: () => void;
}

const PRESET_AMOUNTS = ["5000", "10000", "15000", "25000", "50000"];

const REASON_OPTIONS = [
  { value: "COMPENSATION", label: "ترضية عتب أو شكوى جودة" },
  { value: "VIP_GIFT", label: "مكافأة تقديرية لزبون مميز (VIP)" },
  { value: "WELCOME", label: "هدية ترحيب وتشجيع للزبون الجديد" },
  { value: "LOYALTY", label: "هدية ولاء وتكرار التعامل" },
];

export function InstantGiftModal({
  isOpen,
  open,
  onClose,
  customerId,
  customerName,
  customerPhone,
  feedbackId,
  onSuccess,
}: InstantGiftModalProps) {
  const modalOpen = open ?? isOpen ?? false;
  const [amount, setAmount] = useState<string>("10000");
  const [reason, setReason] = useState<string>("COMPENSATION");
  const [notes, setNotes] = useState<string>("");
  const [daysValid, setDaysValid] = useState<number>(30);
  const [issuedCoupon, setIssuedCoupon] = useState<{
    code: string;
    amount: string;
    validTo: string;
    reason: string;
  } | null>(null);

  const utils = trpc.useUtils();

  useEffect(() => {
    if (modalOpen) {
      if (feedbackId) {
        setReason("COMPENSATION");
      }
    }
  }, [modalOpen, feedbackId]);

  const issueMutation = trpc.customers.issueInstantGift.useMutation({
    onSuccess: (data) => {
      notify.ok("تم إصدار قسيمة الهدية بنجاح");
      setIssuedCoupon({
        code: data.code,
        amount: data.amount,
        validTo: data.validTo,
        reason: data.reason,
      });
      utils.customers.dossier360.invalidate({ customerId });
      utils.customers.feedbackList.invalidate();
      onSuccess?.();
    },
    onError: (err) => {
      notify.err(err.message || "تعذر إصدار قسيمة الهدية");
    },
  });

  const handleIssue = () => {
    let amountDec: Decimal;
    try {
      amountDec = new Decimal(amount?.trim() || "0");
    } catch {
      notify.err("يرجى إدخال مبلغ صحيح وموجب للقسيمة");
      return;
    }

    if (!amountDec.isFinite() || !amountDec.greaterThan(0)) {
      notify.err("يرجى إدخال مبلغ صحيح وموجب للقسيمة");
      return;
    }

    const selectedReasonLabel =
      REASON_OPTIONS.find((r) => r.value === reason)?.label || reason;

    issueMutation.mutate({
      customerId,
      amount: amountDec.toFixed(2),
      reason: selectedReasonLabel,
      feedbackId: feedbackId ?? undefined,
      notes: notes.trim() || undefined,
      daysValid,
    });
  };

  const handleCopyCode = async () => {
    if (!issuedCoupon) return;
    try {
      await navigator.clipboard.writeText(issuedCoupon.code);
      notify.ok("تم نسخ رمز الكوبون إلى الحافظة");
    } catch {
      notify.err("تعذر النسخ للحافظة");
    }
  };

  const handleSendWhatsApp = () => {
    if (!issuedCoupon) return;
    const msg = buildInstantGiftWhatsAppMessage({
      customerName,
      code: issuedCoupon.code,
      amount: issuedCoupon.amount,
      validUntil: issuedCoupon.validTo,
      reason: issuedCoupon.reason,
    });
    openWhatsApp(customerPhone, msg);
  };

  const handlePrint = async () => {
    if (!issuedCoupon) return;
    try {
      const res = await printGiftVoucher({
        code: issuedCoupon.code,
        amount: issuedCoupon.amount,
        customerName,
        customerPhone,
        reason: issuedCoupon.reason,
        validUntil: issuedCoupon.validTo,
        terms: "تُخصم لمرة واحدة على أي فاتورة مبيعات أو أمر شغل داخل فروعنا.",
      });
      if (res && !res.ok) {
        if (res.reason === "popup-blocked") {
          notify.err("تم حظر نافذة الطباعة من قبل المتصفح، يرجى السماح بالنوافذ المنبثقة للموقع");
        } else {
          notify.err("تعذر إرسال القسيمة إلى الطابعة");
        }
        return;
      }
      notify.ok("تم إرسال قسيمة الهدية للطباعة");
    } catch {
      notify.err("تعذر إرسال القسيمة إلى الطابعة");
    }
  };

  const handleResetAndClose = () => {
    setIssuedCoupon(null);
    setAmount("10000");
    setReason("COMPENSATION");
    setNotes("");
    onClose();
  };

  return (
    <Dialog
      open={modalOpen}
      onOpenChange={(open) => !open && handleResetAndClose()}
    >
      <DialogContent className="sm:max-w-lg" dir="rtl">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold flex items-center gap-2">
            <Gift aria-hidden className="size-5 text-emerald-600 shrink-0" />
            <span>إهداء قسيمة هدية فورية للزبون</span>
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            إصدار قسيمة رصيد مالي للزبون {customerName} مع إمكانية إرسالها
            بالواتساب فوراً أو طباعتها.
          </DialogDescription>
        </DialogHeader>

        {feedbackId && (
          <div className="flex items-center gap-1.5 p-2 rounded-md bg-amber-50 border border-amber-200 text-amber-800 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-300 text-xs">
            <Gift
              aria-hidden
              className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
            />
            <span>
              قسيمة ترضية مرتبطة بالشكوى رقم:{" "}
              <strong className="font-mono font-bold">#{feedbackId}</strong>{" "}
              (سيتم إغلاق الشكوى واعتبارها معالجة فور إصدار القسيمة)
            </span>
          </div>
        )}

        {!issuedCoupon ? (
          <div className="space-y-4 py-2">
            {/* اختيار المبالغ السريعة */}
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground">
                المبالغ السريعة المقترحة (د.ع):
              </Label>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
                {PRESET_AMOUNTS.map((amt) => (
                  <Button
                    key={amt}
                    type="button"
                    variant={amount === amt ? "default" : "outline"}
                    size="sm"
                    className="h-8 text-xs font-medium"
                    onClick={() => setAmount(amt)}
                  >
                    {fmtAr(amt)}
                  </Button>
                ))}
              </div>
            </div>

            {/* إدخال مبلغ مخصص */}
            <div className="space-y-1.5">
              <Label htmlFor="custom-amount" className="text-xs font-semibold">
                مبلغ القسيمة (دينار عراقي):
              </Label>
              <MoneyInput
                id="custom-amount"
                value={amount}
                onChange={setAmount}
                placeholder="10,000"
                ariaLabel="مبلغ القسيمة"
                decimals={0}
              />
            </div>

            {/* سبب الإهداء */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">
                سبب الإهداء أو المناسبة:
              </Label>
              <AppSelect
                value={reason}
                onValueChange={(val: string) => setReason(val)}
              >
                {REASON_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </AppSelect>
            </div>

            {/* مدة الصلاحية */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="days-valid" className="text-xs font-semibold">
                  الصلاحية (أيام):
                </Label>
                <Input
                  id="days-valid"
                  type="number"
                  min="1"
                  max="365"
                  value={daysValid}
                  onChange={(e) => setDaysValid(Number(e.target.value) || 30)}
                  className="text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">هاتف الإرسال:</Label>
                <div className="text-xs font-mono p-2 rounded border bg-muted text-muted-foreground">
                  {customerPhone || "لا يوجد هاتف مسجل"}
                </div>
              </div>
            </div>

            {/* ملاحظات داخلية */}
            <div className="space-y-1.5">
              <Label htmlFor="gift-notes" className="text-xs font-semibold">
                ملاحظة إدارية داخلية (اختياري):
              </Label>
              <Textarea
                id="gift-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="سبب ترضية الزبون أو الملاحظات التشغيلية..."
                rows={2}
                className="text-xs resize-none"
              />
            </div>
          </div>
        ) : (
          /* شاشة النجاح وعرض القسيمة الصادرة */
          <div className="space-y-4 py-3">
            <div className="rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20 p-4 text-center space-y-3">
              <div className="size-10 rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400 mx-auto flex items-center justify-center">
                <CheckCircle2 aria-hidden className="size-6" />
              </div>
              <div>
                <h4 className="font-bold text-base text-foreground">
                  تم إصدار قسيمة الهدية أصولياً
                </h4>
                <p className="text-xs text-muted-foreground mt-0.5">
                  قسيمة بقيمة{" "}
                  <strong className="text-emerald-700 dark:text-emerald-400 font-bold">
                    {fmtAr(issuedCoupon.amount)} دينار عراقي
                  </strong>{" "}
                  صالحة لغاية {issuedCoupon.validTo}
                </p>
              </div>

              {/* رمز الكوبون */}
              <div className="inline-flex items-center justify-between gap-3 bg-background border rounded-lg px-4 py-2 shadow-xs max-w-xs mx-auto">
                <span className="font-mono text-lg font-black tracking-wider text-emerald-600 dark:text-emerald-400 select-all">
                  {issuedCoupon.code}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleCopyCode}
                  className="h-8 px-2 text-xs gap-1"
                >
                  <Copy aria-hidden className="size-3.5" />
                  <span>نسخ</span>
                </Button>
              </div>
            </div>

            {/* أزرار الإجراءات السريعة (واتساب وطباعة حرارية) */}
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-10 text-xs font-semibold gap-1.5 border-emerald-400 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
                onClick={handleSendWhatsApp}
              >
                <MessageCircle
                  aria-hidden
                  className="size-4 text-emerald-600"
                />
                <span>إرسال عبر واتساب</span>
              </Button>

              <Button
                type="button"
                variant="outline"
                className="h-10 text-xs font-semibold gap-1.5"
                onClick={handlePrint}
              >
                <Printer aria-hidden className="size-4" />
                <span>طباعة إيصال حراري</span>
              </Button>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {!issuedCoupon ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={handleResetAndClose}
              >
                إلغاء
              </Button>
              <Button
                type="button"
                className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={handleIssue}
                disabled={issueMutation.isPending}
              >
                {issueMutation.isPending ? (
                  <>
                    <RefreshCw aria-hidden className="size-4 animate-spin" />
                    <span>جارٍ التوليد...</span>
                  </>
                ) : (
                  <>
                    <Gift aria-hidden className="size-4" />
                    <span>إصدار القسيمة فوراً</span>
                  </>
                )}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              className="w-full"
              onClick={handleResetAndClose}
            >
              إغلاق ومتابعة العمل
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
