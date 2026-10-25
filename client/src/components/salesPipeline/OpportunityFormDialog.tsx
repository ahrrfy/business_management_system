import { useMemo, useState } from "react";
import { MoneyInput } from "@/components/form/MoneyInput";
import { dateOnly, usePipelineFormSession } from "./pipelineFormSession";
import type { LeadRow, OpportunityRow, PipelineOptions } from "./types";
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
  const defaultBranchId =
    initial?.branchId ??
    lead?.branchId ??
    options.selectedBranchId ??
    options.branches[0]?.id ??
    null;
  const optionsReady =
    branchId !== "" && Number(branchId) === options.selectedBranchId;
  usePipelineFormSession({
    open,
    recordKey: `${mode}:${initial?.id ?? lead?.id ?? "new"}`,
    branchId,
    defaultBranchId,
    setBranchId,
    onBranchChange,
    initialize: () => {
      setBranchId(defaultBranchId == null ? "" : String(defaultBranchId));
      setCustomerId(String(initial?.customerId ?? lead?.customerId ?? ""));
      setOwnerId(String(initial?.ownerId ?? lead?.ownerId ?? ""));
      setTitle(initial?.title ?? (lead ? `فرصة — ${lead.contactName}` : ""));
      setExpectedValue(initial?.expectedValue ?? "");
      setProbability(initial?.probability ?? "25");
      setExpectedCloseDate(dateOnly(initial?.expectedCloseDate));
      setQuotationId(String(initial?.quotationId ?? ""));
      setReason("");
      if (defaultBranchId != null) onBranchChange(defaultBranchId);
    },
  });
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
    optionsReady &&
    branchId &&
    title.trim() &&
    expectedValue !== "" &&
    probability !== "" &&
    expectedCloseDate &&
    (mode === "CONVERT" || customerId) &&
    (!needsReason || reason.trim().length >= 3);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 sm:max-w-2xl">
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
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 [&>div]:min-w-0">
          <div>
            <Label htmlFor="opp-branch">الفرع</Label>
            <AppSelect
              id="opp-branch"
              value={branchId}
              disabled={mode !== "CREATE"}
              onValueChange={(value) => {
                setBranchId(value);
                setOwnerId("");
                setQuotationId("");
                onBranchChange(Number(value));
              }}
            >
              <option value="" disabled>
                اختر الفرع
              </option>
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
              disabled={!optionsReady}
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
              onValueChange={(value) => {
                setCustomerId(value);
                setQuotationId("");
              }}
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
              disabled={!optionsReady}
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
