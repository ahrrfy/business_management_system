import { useState, useEffect } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Lock,
  MessageSquare,
  PhoneCall,
  ShieldAlert,
  Sparkles,
  X,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ManagerApprovalDialog, type ManagerApprovalInput } from "@/components/reception/ManagerApprovalDialog";
import { cn } from "@/lib/utils";

interface StrictCancelOrderDialogProps {
  order: { id: number; orderNumber: string; customerName?: string | null; customerPhone?: string | null };
  pending: boolean;
  onClose: () => void;
  onConfirm: (reason: string, approval?: ManagerApprovalInput) => void;
}

const CANCEL_REASONS = [
  "رفض العميل بعد عرض البدائل والتسهيلات",
  "تعذر الاتصال بالعميل نهائياً (3 محاولات + واتساب)",
  "طلب مكرر معتمد سابقاً للعميل",
  "خارج نطاق التغطية الجغرافية لشركات الشحن",
  "نفد المخزون بالكامل وعدم توفر بديل تجاري",
];

export function StrictCancelOrderDialog({
  order,
  pending,
  onClose,
  onConfirm,
}: StrictCancelOrderDialogProps) {
  const [step, setStep] = useState<"SAVING_STEPS" | "REASON_DETAILS">("SAVING_STEPS");
  const [calledTwice, setCalledTwice] = useState(false);
  const [whatsappSent, setWhatsappSent] = useState(false);
  const [alternativeOffered, setAlternativeOffered] = useState(false);

  const [selectedReason, setSelectedReason] = useState("");
  const [notes, setNotes] = useState("");
  const [showApprovalDialog, setShowApprovalDialog] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending && !showApprovalDialog) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, showApprovalDialog, onClose]);

  const canProceedToReason = calledTwice && whatsappSent;
  const isReasonValid = selectedReason.trim().length > 0 && notes.trim().length >= 5;

  function handleFinalSubmit(approval?: ManagerApprovalInput) {
    const fullAuditReason = `[بروتوكول حماية المبيعات: تم الاتصال + واتساب + عرض بدائل] [السبب: ${selectedReason}] [التفاصيل: ${notes.trim()}]${
      approval?.barcode ? ` [معتمد بباركود المدير: ${approval.barcode}]` : ""
    }${approval?.pin ? ` [معتمد برمز PIN للمدير: ${approval.identifier}]` : ""}`;

    onConfirm(fullAuditReason, approval);
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
        aria-label="بروتوكول التحقق الصارم قبل إلغاء الطلب"
        onClick={() => !pending && onClose()}
        dir="rtl"
      >
        <div
          className="w-full max-w-lg space-y-4 rounded-2xl bg-card p-5 shadow-2xl border-2 border-border"
          onClick={(e) => e.stopPropagation()}
        >
          {/* رأس النافذة */}
          <div className="flex items-center justify-between border-b pb-3">
            <div className="flex items-center gap-2 text-[var(--sem-neg)] font-black text-sm sm:text-base">
              <ShieldAlert aria-hidden className="size-5" />
              <span>بروتوكول منع الإلغاء وحماية المبيعات: طلب #{order.orderNumber}</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onClose}
              disabled={pending}
            >
              <X aria-hidden className="size-4" />
            </Button>
          </div>

          {step === "SAVING_STEPS" ? (
            /* الخطوة الأولى: محاولات إنقاذ الطلب */
            <div className="space-y-4">
              <div className="rounded-xl border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/30 p-3 text-xs leading-relaxed text-foreground">
                <div className="flex items-center gap-1.5 font-bold text-[var(--sem-warn)] mb-1">
                  <AlertTriangle aria-hidden className="size-4 shrink-0" />
                  <span>تنبيه نظامي صارم:</span>
                </div>
                إلغاء الطلبات يكلف الشركة مبيعات وسمعة تجارية. لا يُسمح بإلغاء أي طلب قبل تجربة خيارات الاستبقاء والتواصل التالية إجبارياً:
              </div>

              <div className="space-y-2.5">
                <label className="flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer hover:bg-muted/40 transition">
                  <input
                    type="checkbox"
                    checked={calledTwice}
                    onChange={(e) => setCalledTwice(e.target.checked)}
                    className="mt-0.5 size-4 rounded border-border text-primary focus:ring-primary"
                  />
                  <div className="text-xs">
                    <span className="font-bold text-foreground block">
                      ١. تم الاتصال برقم هاتف العميل ({order.customerPhone || "المسجل"}) مرتين على الأقل
                    </span>
                    <span className="text-muted-foreground">
                      في أوقات متباعدة للتأكد من عدم انشغال العميل.
                    </span>
                  </div>
                </label>

                <label className="flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer hover:bg-muted/40 transition">
                  <input
                    type="checkbox"
                    checked={whatsappSent}
                    onChange={(e) => setWhatsappSent(e.target.checked)}
                    className="mt-0.5 size-4 rounded border-border text-primary focus:ring-primary"
                  />
                  <div className="text-xs">
                    <span className="font-bold text-foreground block">
                      ٢. تم إرسال رسالة واتساب رسمية للعميل
                    </span>
                    <span className="text-muted-foreground">
                      تتضمن تفاصيل طلبه وتأكيد جاهزية التجهيز أو السؤال عن سبب التردد.
                    </span>
                  </div>
                </label>

                <label className="flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer hover:bg-muted/40 transition">
                  <input
                    type="checkbox"
                    checked={alternativeOffered}
                    onChange={(e) => setAlternativeOffered(e.target.checked)}
                    className="mt-0.5 size-4 rounded border-border text-primary focus:ring-primary"
                  />
                  <div className="text-xs">
                    <span className="font-bold text-foreground block">
                      ٣. تم عرض منتج بديل أو تسهيلات (توصيل مجاني أو خصم)
                    </span>
                    <span className="text-muted-foreground">
                      في حال كان العميل متردداً بسبب السعر أو نفاد إحدى السلع.
                    </span>
                  </div>
                </label>
              </div>

              <div className="flex items-center justify-between pt-2 border-t">
                <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
                  تراجع والعودة لخدمة العميل
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  disabled={!canProceedToReason || pending}
                  onClick={() => setStep("REASON_DETAILS")}
                >
                  استمرار إلى توثيق سبب الإلغاء
                </Button>
              </div>
            </div>
          ) : (
            /* الخطوة الثانية: توثيق سبب الإلغاء الصارم واعتماد المدير */
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-bold">اختر سبب الإلغاء المعتمد:</Label>
                <div className="flex flex-wrap gap-1.5">
                  {CANCEL_REASONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setSelectedReason(r)}
                      className={cn(
                        "rounded-lg px-2.5 py-1 text-xs font-bold transition text-right border",
                        selectedReason === r
                          ? "bg-[var(--sem-neg)] text-background border-[var(--sem-neg)]"
                          : "bg-muted/60 text-muted-foreground hover:bg-muted border-border",
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cancel-notes" className="text-xs font-bold">
                  تفاصيل المحادثة ومحاولات الاستبقاء (مطلوب للتدقيق الرقابي):
                </Label>
                <Textarea
                  id="cancel-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="مثال: تم الاتصال الساعة 11:30 و 12:15 بلا رد، وأرسلنا رسالة واتساب، ثم رد العميل بأنه اشترى من مكان آخر..."
                  rows={3}
                  className="text-xs"
                />
              </div>

              <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <Lock aria-hidden className="size-4 text-primary" />
                  <span className="font-bold text-foreground">
                    اعتماد المشرف الميداني (PIN أو مسح الشارة)
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs border-primary/40 text-primary"
                  onClick={() => setShowApprovalDialog(true)}
                >
                  طلب اعتماد المشرف
                </Button>
              </div>

              <div className="flex items-center justify-between pt-2 border-t">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setStep("SAVING_STEPS")}
                  disabled={pending}
                >
                  الرجوع للخطوة السابقة
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={!isReasonValid || pending}
                  onClick={() => handleFinalSubmit()}
                >
                  {pending ? (
                    <Loader2 aria-hidden className="size-3.5 animate-spin" />
                  ) : (
                    <X aria-hidden className="size-3.5" />
                  )}
                  تأكيد الإلغاء مع التدقيق الرقابي
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showApprovalDialog && (
        <ManagerApprovalDialog
          title="اعتماد إلغاء طلب مبيعات"
          description={`إلغاء الطلب #${order.orderNumber} يتطلب تصريح المشرف لمنع خسارة المبيعات غير المبررة.`}
          onApprove={(approval) => {
            setShowApprovalDialog(false);
            handleFinalSubmit(approval);
          }}
          onCancel={() => setShowApprovalDialog(false)}
        />
      )}
    </>
  );
}
