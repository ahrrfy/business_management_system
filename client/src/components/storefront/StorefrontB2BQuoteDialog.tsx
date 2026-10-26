import React, { useMemo, useRef, useState } from "react";
import { Building2, Check, Copy, FileCheck2, Loader2, Send } from "lucide-react";
import { GOVERNORATES } from "@shared/governorates";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { TurnstileWidget } from "@/components/storefront/TurnstileWidget";
import { summarizeStorefrontCustomization } from "@/components/storefront/storefrontCustomizationModel";
import { trpc } from "@/lib/trpc";

export type B2BQuoteRequestType = "BULK" | "CUSTOM_PRINT" | "BUSINESS" | "GENERAL";
export type B2BQuoteContactPreference = "PHONE" | "WHATSAPP";

export interface B2BQuoteCartLineInput {
  cartKey: string;
  productUnitId: number;
  name: string;
  qty: number;
  price: string | number;
  variantLabel?: string;
  unitName?: string;
  customization?: unknown;
}

export interface StorefrontB2BQuoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cartLines: B2BQuoteCartLineInput[];
  orderingEnabled?: boolean;
  turnstileSiteKey?: string | null;
  customerSessionToken?: string | null;
}

interface QuoteRequestSuccessState {
  requestNumber: string;
  guestTrackingToken: string | null;
  guestTrackingExpiresAt: Date | string | null;
}

const REQUEST_TYPE_OPTIONS: ReadonlyArray<{ value: B2BQuoteRequestType; label: string }> = [
  { value: "BUSINESS", label: "تجهيز شركات ومؤسسات" },
  { value: "BULK", label: "كميات وجملة" },
  { value: "CUSTOM_PRINT", label: "طباعة وتخصيص شعارات" },
  { value: "GENERAL", label: "استفسار تسعير عام" },
];

function createClientRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `sq-${crypto.randomUUID()}`;
  }
  return `sq-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
}

export function aggregateB2BQuoteLines(
  cartLines: ReadonlyArray<B2BQuoteCartLineInput>,
): Array<{ productUnitId: number; quantity: number }> {
  const byUnit = new Map<number, number>();
  for (const line of cartLines) {
    const unitId = Math.floor(Number(line.productUnitId));
    const qty = Math.floor(Number(line.qty));
    if (!Number.isSafeInteger(unitId) || unitId <= 0 || qty <= 0) continue;
    byUnit.set(unitId, Math.min(10_000, (byUnit.get(unitId) ?? 0) + qty));
  }
  return Array.from(byUnit.entries())
    .slice(0, 30)
    .map(([productUnitId, quantity]) => ({ productUnitId, quantity }));
}

export default function StorefrontB2BQuoteDialog({
  open,
  onOpenChange,
  cartLines,
  orderingEnabled = true,
  turnstileSiteKey = null,
  customerSessionToken = null,
}: StorefrontB2BQuoteDialogProps) {
  const hasCustomItems = useMemo(
    () => cartLines.some((l) => Boolean(summarizeStorefrontCustomization(l.customization as never))),
    [cartLines],
  );

  const [requestType, setRequestType] = useState<B2BQuoteRequestType>(
    hasCustomItems ? "CUSTOM_PRINT" : "BUSINESS",
  );
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [governorate, setGovernorate] = useState("baghdad");
  const [contactPreference, setContactPreference] = useState<B2BQuoteContactPreference>("WHATSAPP");
  const [note, setNote] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<QuoteRequestSuccessState | null>(null);
  const [copiedField, setCopiedField] = useState<"number" | "token" | null>(null);

  const attemptRef = useRef<{ fingerprint: string; clientRequestId: string } | null>(null);

  const normalizedLines = useMemo(() => aggregateB2BQuoteLines(cartLines), [cartLines]);
  const canSubmitOnline = Boolean(orderingEnabled && turnstileSiteKey);

  const createQuoteM = trpc.storefront.createQuoteRequest.useMutation({
    onSuccess: (res) => {
      setFormError(null);
      setSubmitted({
        requestNumber: res.requestNumber,
        guestTrackingToken: res.guestTrackingToken ?? null,
        guestTrackingExpiresAt: res.guestTrackingExpiresAt ?? null,
      });
    },
    onError: (err) => {
      setTurnstileToken(null);
      setTurnstileResetKey((k) => k + 1);
      setFormError(err.message || "تعذّر إرسال طلب عرض السعر — يرجى المحاولة مرة أخرى.");
    },
  });

  async function copyValue(value: string, kind: "number" | "token") {
    try {
      await navigator.clipboard?.writeText(value);
      setCopiedField(kind);
      window.setTimeout(() => setCopiedField(null), 2000);
    } catch {
      /* ignore clipboard denial */
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);

    if (normalizedLines.length === 0) {
      setFormError("السلة لا تحتوي على وحدات صالحة لطلب عرض السعر.");
      return;
    }
    const cleanName = customerName.trim();
    if (!cleanName) {
      setFormError("يرجى إدخال الاسم الكامل لمقدم الطلب.");
      return;
    }
    const cleanPhone = customerPhone.replace(/\s+/g, " ").trim();
    const phoneDigits = cleanPhone.replace(/\D/g, "");
    if (phoneDigits.length < 10 || cleanPhone.length > 20) {
      setFormError("يرجى إدخال رقم هاتف صحيح للتواصل.");
      return;
    }

    const customSummaries = cartLines
      .map((line) => {
        const summary = summarizeStorefrontCustomization(line.customization as never);
        return summary ? `${line.name}: ${summary}` : null;
      })
      .filter((v): v is string => Boolean(v));

    const userNote = note.trim();
    const combinedNote =
      customSummaries.length > 0 && !userNote.includes(customSummaries[0]!)
        ? [userNote, `تفاصيل التخصيص: ${customSummaries.join(" | ")}`].filter(Boolean).join("\n")
        : userNote;

    if (combinedNote.length < 5) {
      setFormError("يرجى كتابة وصف مختصر لاحتياجكم أو شروط التوريد (5 أحرف على الأقل).");
      return;
    }
    if (!canSubmitOnline) {
      setFormError("استقبال الطلبات متوقف مؤقتاً؛ يمكنك تنزيل عرض السعر التقديري (PDF) أو التواصل عبر واتساب.");
      return;
    }
    if (!turnstileToken) {
      setFormError("أكمل التحقق الأمني قبل إرسال طلب عرض السعر.");
      return;
    }

    const cleanCompany = companyName.trim() || undefined;
    const cleanGovernorate = governorate.trim() || undefined;
    const cleanSession =
      customerSessionToken && customerSessionToken.trim().length >= 40
        ? customerSessionToken.trim()
        : undefined;
    const finalNote = combinedNote.slice(0, 2000);

    const fingerprint = JSON.stringify({
      cleanName,
      cleanPhone,
      cleanCompany,
      cleanGovernorate,
      contactPreference,
      requestType,
      finalNote,
      normalizedLines,
    });

    if (!attemptRef.current || attemptRef.current.fingerprint !== fingerprint) {
      attemptRef.current = {
        fingerprint,
        clientRequestId: createClientRequestId(),
      };
    }

    createQuoteM.mutate({
      customerSessionToken: cleanSession,
      customerName: cleanName,
      customerPhone: cleanPhone,
      companyName: cleanCompany,
      governorate: cleanGovernorate,
      contactPreference,
      requestType,
      note: finalNote,
      clientRequestId: attemptRef.current.clientRequestId,
      turnstileToken,
      lines: normalizedLines,
    });
  }

  const formattedExpiry = useMemo(() => {
    if (!submitted?.guestTrackingExpiresAt) return null;
    const dt = new Date(submitted.guestTrackingExpiresAt);
    if (Number.isNaN(dt.getTime())) return null;
    return new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(dt);
  }, [submitted?.guestTrackingExpiresAt]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-black text-foreground">
            <Building2 className="size-5 text-primary" aria-hidden />
            <span>طلب عرض سعر رسمي للشركات والمؤسسات</span>
          </DialogTitle>
          <DialogDescription className="text-right text-xs leading-relaxed text-muted-foreground">
            يُرسل هذا الطلب كاستفسار رسمي لفريق المبيعات لمراجعة التوفر والتخصيص وإصدار عرض سعر معتمد برقم مرجعي، دون حجز مخزون أو إنشاء فاتورة فورية.
          </DialogDescription>
        </DialogHeader>

        {submitted ? (
          <div className="space-y-4 py-2 text-xs">
            <div className="rounded-xl border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] p-4 space-y-2">
              <div className="flex items-center gap-2 font-black text-sm text-[var(--sem-pos)]">
                <FileCheck2 className="size-5 shrink-0" aria-hidden />
                <span>تم استلام طلب عرض السعر بنجاح</span>
              </div>
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <div className="text-[11px] text-muted-foreground">رقم المتابعة المرجعي</div>
                  <div className="font-mono text-sm font-black text-foreground" dir="ltr">
                    {submitted.requestNumber}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void copyValue(submitted.requestNumber, "number")}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2.5 py-1 text-[11px] font-bold text-foreground transition hover:bg-accent"
                >
                  {copiedField === "number" ? (
                    <>
                      <Check className="size-3.5 text-[var(--sem-pos)]" aria-hidden />
                      <span>تم النسخ</span>
                    </>
                  ) : (
                    <>
                      <Copy className="size-3.5" aria-hidden />
                      <span>نسخ الرقم</span>
                    </>
                  )}
                </button>
              </div>

              {submitted.guestTrackingToken && (
                <div className="rounded-lg border border-border bg-background px-3 py-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-bold text-foreground">
                      رمز التتبع السري للضيف {formattedExpiry ? `(صالح حتى ${formattedExpiry})` : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() => void copyValue(submitted.guestTrackingToken!, "token")}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] font-bold text-foreground transition hover:bg-accent"
                    >
                      {copiedField === "token" ? "تم النسخ" : "نسخ الرمز"}
                    </button>
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground" dir="ltr">
                    {submitted.guestTrackingToken}
                  </div>
                </div>
              )}

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                احتفظ برقم المتابعة أعلاه؛ سيقوم فريق مبيعات الشركات بمراجعة الأصناف والكميات والتواصل معكم لإصدار العرض الرسمي المعتمد.
              </p>
            </div>

            <DialogFooter>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="w-full rounded-xl bg-primary px-4 py-2.5 text-xs font-black text-primary-foreground transition hover:opacity-90"
              >
                إغلاق
              </button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3 py-1 text-xs">
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 flex items-center justify-between">
              <span className="text-muted-foreground">عدد بنود السلة المشمولة بالطلب</span>
              <span className="font-black text-foreground tabular-nums">{normalizedLines.length} صنف</span>
            </div>

            <div className="space-y-1">
              <label className="block font-bold text-foreground" htmlFor="b2b-quote-request-type">
                نوع الطلب
              </label>
              <select
                id="b2b-quote-request-type"
                value={requestType}
                onChange={(e) => setRequestType(e.target.value as B2BQuoteRequestType)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground"
              >
                {REQUEST_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="block font-bold text-foreground" htmlFor="b2b-quote-customer-name">
                  الاسم الكامل
                </label>
                <input
                  id="b2b-quote-customer-name"
                  type="text"
                  required
                  maxLength={255}
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="الاسم الثلاثي أو المخوّل"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
                />
              </div>

              <div className="space-y-1">
                <label className="block font-bold text-foreground" htmlFor="b2b-quote-customer-phone">
                  رقم الهاتف
                </label>
                <IntlPhoneInput
                  id="b2b-quote-customer-phone"
                  value={customerPhone}
                  onChange={setCustomerPhone}
                  ariaLabel="رقم الهاتف"
                  placeholder="770 123 4567"
                  className="bg-background"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="block font-bold text-foreground" htmlFor="b2b-quote-company-name">
                  اسم الشركة / الجهة (اختياري)
                </label>
                <input
                  id="b2b-quote-company-name"
                  type="text"
                  maxLength={255}
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="شركة / مؤسسة / دائرة"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
                />
              </div>

              <div className="space-y-1">
                <label className="block font-bold text-foreground" htmlFor="b2b-quote-governorate">
                  المحافظة
                </label>
                <select
                  id="b2b-quote-governorate"
                  value={governorate}
                  onChange={(e) => setGovernorate(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground"
                >
                  {GOVERNORATES.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <span className="block font-bold text-foreground">طريقة التواصل المفضلة</span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setContactPreference("WHATSAPP")}
                  className={`rounded-lg border px-3 py-2 text-xs font-bold transition ${
                    contactPreference === "WHATSAPP"
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-accent"
                  }`}
                >
                  واتساب
                </button>
                <button
                  type="button"
                  onClick={() => setContactPreference("PHONE")}
                  className={`rounded-lg border px-3 py-2 text-xs font-bold transition ${
                    contactPreference === "PHONE"
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-accent"
                  }`}
                >
                  اتصال هاتفي
                </button>
              </div>
            </div>

            <div className="space-y-1">
              <label className="block font-bold text-foreground" htmlFor="b2b-quote-note">
                تفاصيل الطلب أو شروط التجهيز
              </label>
              <textarea
                id="b2b-quote-note"
                rows={3}
                required
                minLength={5}
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="اذكر تفاصيل الكميات، مواعيد التوريد المطلوبة، أو ملاحظات الطباعة والتغليف..."
                className="w-full rounded-lg border border-border bg-background p-2.5 text-xs leading-relaxed text-foreground"
              />
            </div>

            {canSubmitOnline ? (
              <TurnstileWidget
                siteKey={turnstileSiteKey!}
                resetKey={turnstileResetKey}
                onTokenChange={setTurnstileToken}
              />
            ) : (
              <p
                role="alert"
                className="rounded-xl bg-[var(--sem-neg)]/5 px-3 py-2 text-xs font-medium text-[var(--sem-neg)]"
              >
                استقبال الطلبات متوقف مؤقتاً؛ يمكنك تنزيل عرض السعر التقديري (PDF) أو التواصل عبر واتساب.
              </p>
            )}

            {formError && (
              <p
                role="alert"
                className="rounded-xl bg-[var(--sem-neg)]/5 px-3 py-2 text-xs font-semibold text-[var(--sem-neg)]"
              >
                {formError}
              </p>
            )}

            <DialogFooter className="gap-2 pt-1">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-xl border border-border bg-background px-4 py-2.5 text-xs font-bold text-muted-foreground transition hover:bg-accent"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={createQuoteM.isPending || !canSubmitOnline || normalizedLines.length === 0}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary px-5 py-2.5 text-xs font-black text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {createQuoteM.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    <span>جارٍ الإرسال…</span>
                  </>
                ) : (
                  <>
                    <Send className="size-3.5" aria-hidden />
                    <span>إرسال طلب عرض السعر</span>
                  </>
                )}
              </button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
