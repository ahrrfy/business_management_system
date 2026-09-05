import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// موجة D6 (٢/٩/٢٦): قاموسا وسيلة المتابعة ونتيجتها نُقلا إلى `@shared/customerFollowUp`.
// السبب ليس الترتيب: نصُّ الملاحظة المحفوظ يُركَّب منهما، فهما عقدُ قراءةٍ لكلّ من سيصنّف
// نتائج المتابعة لاحقاً — وقاموسٌ داخل مكوّنٍ يدعو القارئ الثاني لاختراع تصنيفٍ موازٍ.
import {
  CUSTOMER_FOLLOW_UP_KINDS,
  CUSTOMER_FOLLOW_UP_KIND_LABEL,
  CUSTOMER_FOLLOW_UP_OUTCOMES,
  CUSTOMER_FOLLOW_UP_OUTCOME_LABEL,
  type CustomerFollowUpKind,
  type CustomerFollowUpOutcome,
} from "@shared/customerFollowUp";

export interface FollowUpValue {
  note: string;
  followUpDate: string | null;
  createTask: boolean;
  taskPriority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
}

export function CustomerFollowUpDialog({
  open,
  onOpenChange,
  customerName,
  defaultAmount,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerName: string;
  defaultAmount?: string | null;
  submitting?: boolean;
  onSubmit: (value: FollowUpValue) => void;
}) {
  const [kind, setKind] = useState<CustomerFollowUpKind>("CALL");
  const [outcome, setOutcome] = useState<CustomerFollowUpOutcome>("REACHED");
  const [amount, setAmount] = useState(defaultAmount ?? "");
  const [date, setDate] = useState("");
  const [details, setDetails] = useState("");
  const [createTask, setCreateTask] = useState(false);
  const [priority, setPriority] = useState<FollowUpValue["taskPriority"]>("NORMAL");

  useEffect(() => {
    if (!open) return;
    setAmount(defaultAmount ?? "");
    setKind("CALL");
    setOutcome("REACHED");
    setDate("");
    setDetails("");
    setCreateTask(false);
    setPriority("NORMAL");
  }, [open, defaultAmount]);

  const note = useMemo(() => {
    const parts = [
      `نوع المتابعة: ${CUSTOMER_FOLLOW_UP_KIND_LABEL[kind]}`,
      `النتيجة: ${CUSTOMER_FOLLOW_UP_OUTCOME_LABEL[outcome]}`,
      amount.trim() ? `المبلغ: ${amount.trim()} د.ع` : "",
      details.trim() ? `التفاصيل: ${details.trim()}` : "",
    ].filter(Boolean);
    return parts.join(" — ");
  }, [kind, outcome, amount, details]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>تسجيل متابعة — {customerName}</DialogTitle>
          <DialogDescription>
            تُحفظ النتيجة في سجل العميل، ويمكن إنشاء مهمة متابعة مرتبطة به في الوقت نفسه.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="follow-kind">نوع المتابعة</Label>
            <select id="follow-kind" className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value as CustomerFollowUpKind)}>
              {CUSTOMER_FOLLOW_UP_KINDS.map((value) => <option key={value} value={value}>{CUSTOMER_FOLLOW_UP_KIND_LABEL[value]}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="follow-outcome">النتيجة</Label>
            <select id="follow-outcome" className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm" value={outcome} onChange={(e) => setOutcome(e.target.value as CustomerFollowUpOutcome)}>
              {CUSTOMER_FOLLOW_UP_OUTCOMES.map((value) => <option key={value} value={value}>{CUSTOMER_FOLLOW_UP_OUTCOME_LABEL[value]}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="follow-amount">المبلغ المرتبط</Label>
            <MoneyInput id="follow-amount" value={amount} onChange={setAmount} ariaLabel="مبلغ المتابعة" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="follow-date">تاريخ المتابعة/الوعد</Label>
            <Input id="follow-date" type="date" dir="ltr" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="follow-details">تفاصيل</Label>
            <Textarea id="follow-details" rows={3} maxLength={1200} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="ما الذي تم الاتفاق عليه؟" />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" className="size-4" checked={createTask} onChange={(e) => setCreateTask(e.target.checked)} />
            إنشاء مهمة متابعة مرتبطة بالعميل
          </label>
          {createTask && (
            <div className="space-y-1">
              <Label htmlFor="follow-priority">أولوية المهمة</Label>
              <select id="follow-priority" className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm" value={priority} onChange={(e) => setPriority(e.target.value as FollowUpValue["taskPriority"])}>
                <option value="LOW">منخفضة</option>
                <option value="NORMAL">عادية</option>
                <option value="HIGH">عالية</option>
                <option value="URGENT">عاجلة</option>
              </select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>إلغاء</Button>
          <Button onClick={() => onSubmit({ note, followUpDate: date || null, createTask, taskPriority: priority })} disabled={submitting || !note}>
            {submitting ? "جارٍ الحفظ…" : "حفظ المتابعة"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
