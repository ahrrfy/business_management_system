import { useState } from "react";
import {
  SALES_LEAD_SOURCES,
  SALES_LEAD_SOURCE_LABELS,
  type SalesLeadSource,
} from "@shared/salesPipeline";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { localDateTime, usePipelineFormSession } from "./pipelineFormSession";
import type { LeadRow, PipelineOptions } from "./types";
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
  const defaultBranchId =
    initial?.branchId ??
    options.selectedBranchId ??
    options.branches[0]?.id ??
    null;
  const optionsReady =
    branchId !== "" && Number(branchId) === options.selectedBranchId;
  usePipelineFormSession({
    open,
    recordKey: `LEAD:${initial?.id ?? "new"}`,
    branchId,
    defaultBranchId,
    setBranchId,
    onBranchChange,
    initialize: () => {
      setBranchId(defaultBranchId == null ? "" : String(defaultBranchId));
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
      if (defaultBranchId != null) onBranchChange(defaultBranchId);
    },
  });
  const canSave =
    optionsReady &&
    contactName.trim() &&
    branchId &&
    (initial ? reason.trim().length >= 3 : true);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {initial ? "تعديل العميل المحتمل" : "عميل محتمل جديد"}
          </DialogTitle>
          <DialogDescription>
            بيانات الاتصال والمالك وموعد المتابعة. لا يوجد حذف صلب؛ كل تعديل
            موثق بنسخة وسبب.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 [&>div]:min-w-0">
          <div>
            <Label htmlFor="lead-branch">الفرع</Label>
            <AppSelect
              id="lead-branch"
              value={branchId}
              disabled={!!initial}
              onValueChange={(value) => {
                setBranchId(value);
                setOwnerId("");
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
            <Label htmlFor="lead-owner">مسؤول المتابعة</Label>
            <AppSelect
              id="lead-owner"
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
            <IntlPhoneInput id="lead-phone" value={phone} onChange={setPhone} />
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
