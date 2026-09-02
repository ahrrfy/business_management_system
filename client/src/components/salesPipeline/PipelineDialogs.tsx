import { useEffect, useMemo, useState } from "react";
import {
  SALES_LEAD_SOURCES,
  SALES_LEAD_SOURCE_LABELS,
  SALES_LEAD_STATUS_LABELS,
  SALES_OPPORTUNITY_STAGE_LABELS,
  type SalesLeadSource,
  type SalesLeadStatus,
  type SalesOpportunityStage,
} from "@shared/salesPipeline";
import { MoneyInput } from "@/components/form/MoneyInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { AppSelect } from "@/components/ui/AppSelect";
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
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Textarea } from "@/components/ui/textarea";
import type { LeadRow, OpportunityRow, PipelineOptions } from "./types";

function localDateTime(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function dateOnly(value: Date | string | null | undefined): string {
  if (!value) return "";
  return String(value).slice(0, 10);
}

export type LeadFormValue = {
  branchId: number | null;
  source: SalesLeadSource;
  contactName: string;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  customerId: number | null;
  ownerId: number | null;
  nextFollowUpAt: Date | null;
  reason?: string;
};

export function LeadFormDialog({
  open,
  onOpenChange,
  options,
  initial,
  pending,
  onBranchChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: PipelineOptions;
  initial?: LeadRow | null;
  pending: boolean;
  onBranchChange: (branchId: number) => void;
  onSubmit: (value: LeadFormValue) => void;
}) {
  const [branchId, setBranchId] = useState("");
  const [source, setSource] = useState<SalesLeadSource>("WALK_IN");
  const [contactName, setContactName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [nextFollowUpAt, setNextFollowUpAt] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (!open) return;
    const selectedBranch =
      initial?.branchId ??
      options.selectedBranchId ??
      options.branches[0]?.id ??
      null;
    setBranchId(selectedBranch == null ? "" : String(selectedBranch));
    setSource(initial?.source ?? "WALK_IN");
    setContactName(initial?.contactName ?? "");
    setCompanyName(initial?.companyName ?? "");
    setPhone(initial?.phone ?? "");
    setEmail(initial?.email ?? "");
    setCustomerId(
      initial?.customerId == null ? "" : String(initial.customerId),
    );
    setOwnerId(initial?.ownerId == null ? "" : String(initial.ownerId));
    setNextFollowUpAt(localDateTime(initial?.nextFollowUpAt));
    setReason("");
    if (selectedBranch != null) onBranchChange(selectedBranch);
  }, [open, initial, options.selectedBranchId]);
  const canSave =
    contactName.trim() &&
    branchId &&
    (initial ? reason.trim().length >= 3 : true);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {initial ? "تعديل العميل المحتمل" : "عميل محتمل جديد"}
          </DialogTitle>
          <DialogDescription>
            بيانات الاتصال والمالك وموعد المتابعة. لا يوجد حذف صلب؛ كل تعديل
            موثق بنسخة وسبب.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="lead-branch">الفرع</Label>
            <AppSelect
              id="lead-branch"
              value={branchId}
              disabled={!!initial}
              onValueChange={(value) => {
                setBranchId(value);
                onBranchChange(Number(value));
              }}
            >
              <option value="">اختر الفرع</option>
              {options.branches.map((item) => (
                <option key={item.id} value={String(item.id)}>
                  {item.name}
                </option>
              ))}
            </AppSelect>
          </div>
          <div>
            <Label htmlFor="lead-owner">مسؤول المتابعة</Label>
            <AppSelect
              id="lead-owner"
              value={ownerId}
              onValueChange={setOwnerId}
            >
              <option value="">المستخدم الحالي</option>
              {options.owners.map((item) => (
                <option key={item.id} value={String(item.id)}>
                  {item.name || `مستخدم ${item.id}`}
                </option>
              ))}
            </AppSelect>
          </div>
          <div>
            <Label htmlFor="lead-name">اسم جهة الاتصال</Label>
            <Input
              id="lead-name"
              value={contactName}
              onChange={(event) => setContactName(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="lead-company">الجهة / الشركة</Label>
            <Input
              id="lead-company"
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="lead-source">المصدر</Label>
            <AppSelect
              id="lead-source"
              value={source}
              onValueChange={(value) => setSource(value as SalesLeadSource)}
            >
              {SALES_LEAD_SOURCES.map((item) => (
                <option key={item} value={item}>
                  {SALES_LEAD_SOURCE_LABELS[item]}
                </option>
              ))}
            </AppSelect>
          </div>
          <div>
            <Label htmlFor="lead-customer">عميل مسجل (اختياري)</Label>
            <AppSelect
              id="lead-customer"
              value={customerId}
              onValueChange={setCustomerId}
            >
              <option value="">غير مرتبط</option>
              {options.customers.map((item) => (
                <option key={item.id} value={String(item.id)}>
                  {item.name}
                  {item.phone ? ` · ${item.phone}` : ""}
                </option>
              ))}
            </AppSelect>
          </div>
          <div>
            <Label htmlFor="lead-phone">الهاتف</Label>
            <IntlPhoneInput
              id="lead-phone"
              value={phone}
              onChange={setPhone}
            />
          </div>
          <div>
            <Label htmlFor="lead-email">البريد</Label>
            <Input
              id="lead-email"
              dir="ltr"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="lead-follow">موعد المتابعة التالي</Label>
            <Input
              id="lead-follow"
              type="datetime-local"
              value={nextFollowUpAt}
              onChange={(event) => setNextFollowUpAt(event.target.value)}
            />
          </div>
          {initial && (
            <div className="sm:col-span-2">
              <Label htmlFor="lead-edit-reason">سبب التعديل</Label>
              <Textarea
                id="lead-edit-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            إلغاء
          </Button>
          <SubmitButton
            pending={pending}
            disabled={!canSave}
            onClick={() =>
              onSubmit({
                branchId: Number(branchId) || null,
                source,
                contactName,
                companyName: companyName.trim() || null,
                phone: phone.trim() || null,
                email: email.trim() || null,
                customerId: Number(customerId) || null,
                ownerId: Number(ownerId) || null,
                nextFollowUpAt: nextFollowUpAt
                  ? new Date(nextFollowUpAt)
                  : null,
                ...(initial ? { reason } : {}),
              })
            }
          >
            حفظ
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type OpportunityFormValue = {
  branchId: number | null;
  customerId: number | null;
  ownerId: number | null;
  title: string;
  expectedValue: string;
  probability: string;
  expectedCloseDate: string;
  quotationId: number | null;
  reason?: string;
};

export function OpportunityFormDialog({
  open,
  onOpenChange,
  options,
  initial,
  lead,
  pending,
  onBranchChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: PipelineOptions;
  initial?: OpportunityRow | null;
  lead?: LeadRow | null;
  pending: boolean;
  onBranchChange: (branchId: number) => void;
  onSubmit: (value: OpportunityFormValue) => void;
}) {
  const mode = lead ? "CONVERT" : initial ? "EDIT" : "CREATE";
  const [branchId, setBranchId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [title, setTitle] = useState("");
  const [expectedValue, setExpectedValue] = useState("");
  const [probability, setProbability] = useState("25");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [quotationId, setQuotationId] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (!open) return;
    const selectedBranch =
      initial?.branchId ??
      lead?.branchId ??
      options.selectedBranchId ??
      options.branches[0]?.id ??
      null;
    setBranchId(selectedBranch == null ? "" : String(selectedBranch));
    setCustomerId(String(initial?.customerId ?? lead?.customerId ?? ""));
    setOwnerId(String(initial?.ownerId ?? lead?.ownerId ?? ""));
    setTitle(initial?.title ?? (lead ? `فرصة — ${lead.contactName}` : ""));
    setExpectedValue(initial?.expectedValue ?? "");
    setProbability(initial?.probability ?? "25");
    setExpectedCloseDate(dateOnly(initial?.expectedCloseDate));
    setQuotationId(String(initial?.quotationId ?? ""));
    setReason("");
    if (selectedBranch != null) onBranchChange(selectedBranch);
  }, [open, initial, lead, options.selectedBranchId]);
  const availableQuotes = useMemo(
    () =>
      options.quotations.filter(
        (item) =>
          !customerId ||
          item.customerId == null ||
          item.customerId === Number(customerId),
      ),
    [options.quotations, customerId],
  );
  const needsReason = mode !== "CREATE";
  const canSave =
    branchId &&
    title.trim() &&
    expectedValue !== "" &&
    probability !== "" &&
    expectedCloseDate &&
    (mode === "CONVERT" || customerId) &&
    (!needsReason || reason.trim().length >= 3);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "CONVERT"
              ? "تحويل العميل المحتمل إلى فرصة"
              : mode === "EDIT"
                ? "تعديل الفرصة"
                : "فرصة جديدة"}
          </DialogTitle>
          <DialogDescription>
            القيمة والاحتمال والتاريخ تغذي توقعات المبيعات. إغلاق الفوز يتطلب
            فاتورة في إجراء المرحلة.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="opp-branch">الفرع</Label>
            <AppSelect
              id="opp-branch"
              value={branchId}
              disabled={mode !== "CREATE"}
              onValueChange={(value) => {
                setBranchId(value);
                onBranchChange(Number(value));
              }}
            >
              <option value="">اختر الفرع</option>
              {options.branches.map((item) => (
                <option key={item.id} value={String(item.id)}>
                  {item.name}
                </option>
              ))}
            </AppSelect>
          </div>
          <div>
            <Label htmlFor="opp-owner">مالك الفرصة</Label>
            <AppSelect
              id="opp-owner"
              value={ownerId}
              onValueChange={setOwnerId}
            >
              <option value="">المستخدم الحالي</option>
              {options.owners.map((item) => (
                <option key={item.id} value={String(item.id)}>
                  {item.name || `مستخدم ${item.id}`}
                </option>
              ))}
            </AppSelect>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="opp-title">عنوان الفرصة</Label>
            <Input
              id="opp-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="opp-customer">العميل</Label>
            <AppSelect
              id="opp-customer"
              value={customerId}
              disabled={mode === "CONVERT" && lead?.customerId != null}
              onValueChange={setCustomerId}
            >
              <option value="">
                {mode === "CONVERT" ? "يبقى على العميل المحتمل" : "اختر العميل"}
              </option>
              {options.customers.map((item) => (
                <option key={item.id} value={String(item.id)}>
                  {item.name}
                </option>
              ))}
            </AppSelect>
          </div>
          <div>
            <Label htmlFor="opp-quote">عرض السعر (اختياري)</Label>
            <AppSelect
              id="opp-quote"
              value={quotationId}
              onValueChange={setQuotationId}
            >
              <option value="">بلا عرض مرتبط</option>
              {availableQuotes.map((item) => (
                <option key={item.id} value={String(item.id)}>
                  {item.quoteNumber} · {item.total}
                </option>
              ))}
            </AppSelect>
          </div>
          <div>
            <Label htmlFor="opp-value">القيمة المتوقعة</Label>
            <MoneyInput
              id="opp-value"
              value={expectedValue}
              onChange={setExpectedValue}
              ariaLabel="قيمة الفرصة المتوقعة"
            />
          </div>
          <div>
            <Label htmlFor="opp-probability">احتمال الفوز (%)</Label>
            <MoneyInput
              id="opp-probability"
              value={probability}
              onChange={setProbability}
              decimals={2}
              ariaLabel="احتمال فوز الفرصة"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="opp-close">تاريخ الإغلاق المتوقع</Label>
            <Input
              id="opp-close"
              type="date"
              value={expectedCloseDate}
              onChange={(event) => setExpectedCloseDate(event.target.value)}
            />
          </div>
          {needsReason && (
            <div className="sm:col-span-2">
              <Label htmlFor="opp-reason">
                سبب {mode === "CONVERT" ? "التحويل" : "التعديل"}
              </Label>
              <Textarea
                id="opp-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            إلغاء
          </Button>
          <SubmitButton
            pending={pending}
            disabled={!canSave}
            onClick={() =>
              onSubmit({
                branchId: Number(branchId) || null,
                customerId: Number(customerId) || null,
                ownerId: Number(ownerId) || null,
                title,
                expectedValue,
                probability,
                expectedCloseDate,
                quotationId: Number(quotationId) || null,
                ...(needsReason ? { reason } : {}),
              })
            }
          >
            حفظ
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PipelineTransitionDialog({
  open,
  onOpenChange,
  kind,
  leadStatus,
  opportunityStage,
  options,
  customerId,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "LEAD" | "OPPORTUNITY";
  leadStatus?: SalesLeadStatus;
  opportunityStage?: SalesOpportunityStage;
  options: PipelineOptions;
  customerId?: number | null;
  pending: boolean;
  onSubmit: (value: { reason: string; invoiceId: number | null }) => void;
}) {
  const [reason, setReason] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  useEffect(() => {
    if (open) {
      setReason("");
      setInvoiceId("");
    }
  }, [open]);
  const won = kind === "OPPORTUNITY" && opportunityStage === "WON";
  const invoices = options.invoices.filter(
    (item) =>
      customerId == null ||
      item.customerId == null ||
      item.customerId === customerId,
  );
  const label =
    kind === "LEAD" && leadStatus
      ? SALES_LEAD_STATUS_LABELS[leadStatus]
      : opportunityStage
        ? SALES_OPPORTUNITY_STAGE_LABELS[opportunityStage]
        : "الحالة";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>نقل إلى «{label}»</DialogTitle>
          <DialogDescription>
            يسجل السبب في خط الأحداث ولا يمكن محوه. تأكد من واقعية الحالة قبل
            الحفظ.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {won && (
            <div>
              <Label htmlFor="transition-invoice">فاتورة الفوز</Label>
              <AppSelect
                id="transition-invoice"
                value={invoiceId}
                onValueChange={setInvoiceId}
              >
                <option value="">اختر الفاتورة</option>
                {invoices.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.invoiceNumber} · {item.total}
                  </option>
                ))}
              </AppSelect>
            </div>
          )}
          <div>
            <Label htmlFor="transition-reason">سبب الانتقال</Label>
            <Textarea
              id="transition-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            إلغاء
          </Button>
          <SubmitButton
            pending={pending}
            disabled={reason.trim().length < 3 || (won && !invoiceId)}
            onClick={() =>
              onSubmit({ reason, invoiceId: Number(invoiceId) || null })
            }
          >
            تأكيد الانتقال
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PipelineHistoryDialog({
  open,
  onOpenChange,
  title,
  loading,
  error,
  onRetry,
  events,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  events: Array<{
    id: number;
    eventType: string;
    reason: string;
    actorName: string | null;
    occurredAt: Date | string;
  }>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>سجل {title}</DialogTitle>
          <DialogDescription>
            خط زمني تراكمي لكل إنشاء وتعديل وانتقال.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            جارٍ تحميل السجل…
          </p>
        ) : error ? (
          <div className="py-8 text-center">
            <p className="text-sm text-destructive">تعذّر تحميل السجل.</p>
            <Button
              className="mt-3"
              variant="outline"
              size="sm"
              onClick={onRetry}
            >
              إعادة المحاولة
            </Button>
          </div>
        ) : (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto">
            {events.map((event) => (
              <div key={event.id} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <b className="text-sm">{event.eventType}</b>
                  <span className="text-2xs text-muted-foreground">
                    {new Date(event.occurredAt).toLocaleString(
                      "ar-IQ-u-nu-latn",
                    )}
                  </span>
                </div>
                <p className="mt-1 text-xs">{event.reason}</p>
                <p className="mt-1 text-2xs text-muted-foreground">
                  بواسطة {event.actorName || "مستخدم"}
                </p>
              </div>
            ))}
            {!events.length && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                لا أحداث.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
