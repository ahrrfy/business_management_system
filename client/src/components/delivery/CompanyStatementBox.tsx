/**
 * صندوق «كشف شركة التوصيل» في تبويب تسوية المناديب (مُستخرَج من DeliveryHub — م١ PR-C):
 * رقم الكشف يقلب الأهلية إلى opt-in، ومعه تاريخه واستقطاعاته وملاحظته؛ وحين يُفعَّل الوضع تظهر
 * **مطابقةُ الكشف** حيّةً قبل التأكيد: مطابق · مختلف · مفقود (المنطق النقيّ في
 * `companyStatementReconciliation.ts`) — إيقاعُ الشركة: كشفٌ ورقيّ يُستورَد ونتيجةٌ تُرى لا تُكتشَف بعد التوريد.
 */
import { useMemo } from "react";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  STATEMENT_VERDICT_HINT_AR,
  STATEMENT_VERDICT_LABEL_AR,
  reconcileCompanyStatement,
  verdictNumbers,
  type StatementLineVerdict,
  type StatementReconcileLine,
} from "./companyStatementReconciliation";

export interface CompanyStatementBoxProps {
  statementNumber: string;
  onStatementNumberChange: (v: string) => void;
  statementDate: string;
  onStatementDateChange: (v: string) => void;
  deductions: number;
  onDeductionsChange: (v: number) => void;
  notes: string;
  onNotesChange: (v: string) => void;
  /** الطرود القابلة للتسوية كما يراها النظام + ما حدّده الموظّف منها (للمطابقة). */
  lines: StatementReconcileLine[];
  onSelectAll: () => void;
  onClearSelection: () => void;
}

const VERDICT_CLS: Record<StatementLineVerdict, string> = {
  MATCHED: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
  MISMATCH: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
  MISSING: "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
};
const VERDICTS: readonly StatementLineVerdict[] = ["MATCHED", "MISMATCH", "MISSING"];

export function CompanyStatementBox({
  statementNumber, onStatementNumberChange, statementDate, onStatementDateChange, deductions, onDeductionsChange,
  notes, onNotesChange, lines, onSelectAll, onClearSelection,
}: CompanyStatementBoxProps) {
  const statementMode = statementNumber.trim().length > 0;
  const rec = useMemo(() => (statementMode ? reconcileCompanyStatement(lines) : null), [statementMode, lines]);
  const selectedCount = lines.filter((l) => l.selected).length;

  return (
    <div className="rounded-xl border border-[var(--sem-info)]/40 bg-[var(--sem-info-bg)]/40 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-black text-[var(--sem-info)]">
          <FileText aria-hidden className="size-4" />
          كشف شركة التوصيل (اختياريّ)
        </div>
        {statementMode && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-card px-2 py-1 font-bold">المحدَّد: <span className="tabular-nums">{selectedCount}</span> من {lines.length}</span>
            <Button size="sm" variant="outline" onClick={onSelectAll}>تحديد الكل</Button>
            <Button size="sm" variant="ghost" onClick={onClearSelection}>مسح التحديد</Button>
          </div>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="stmt-no" className="text-xs">رقم الكشف</Label>
          <Input id="stmt-no" value={statementNumber} maxLength={64} dir="ltr"
            onChange={(e) => onStatementNumberChange(e.target.value)} placeholder="STMT-…" className="h-9" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="stmt-date" className="text-xs">تاريخ الكشف</Label>
          <Input id="stmt-date" type="date" value={statementDate}
            onChange={(e) => onStatementDateChange(e.target.value)} className="h-9" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="stmt-deduct" className="text-xs">استقطاعات الشركة (إفصاح)</Label>
          <MoneyInput id="stmt-deduct" value={String(deductions || "")}
            onChange={(v) => onDeductionsChange(Number(v) || 0)} ariaLabel="استقطاعات الشركة" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="stmt-notes" className="text-xs">ملاحظة</Label>
          <Input id="stmt-notes" value={notes} maxLength={500}
            onChange={(e) => onNotesChange(e.target.value)} placeholder="سبب الفرق مثلاً…" className="h-9" />
        </div>
      </div>
      {statementMode && (
        <p className="mt-2 text-[11px] font-bold text-[var(--sem-info)]">
          وضعُ الكشف مُفعَّل: الصفوف تبدأ **غير محدَّدة** (opt-in). حدّد ما ورد في الكشف الورقيّ يدوياً — الأسطر الصفرية تُثبِت التسليم بلا نقد.
        </p>
      )}
      {rec && (
        <div className="mt-3 space-y-1.5 rounded-lg border bg-card p-2.5" role="status" aria-label="نتيجة مطابقة الكشف">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-black">مطابقة الكشف:</span>
            {VERDICTS.map((v) => (
              <span key={v} className={cn("inline-flex items-center gap-1 rounded px-2 py-0.5 font-black tabular-nums", VERDICT_CLS[v])} title={STATEMENT_VERDICT_HINT_AR[v]}>
                {STATEMENT_VERDICT_LABEL_AR[v]} {v === "MATCHED" ? rec.matched : v === "MISMATCH" ? rec.mismatch : rec.missing}
              </span>
            ))}
          </div>
          {(["MISMATCH", "MISSING"] as const).map((v) => {
            const n = verdictNumbers(rec, v);
            if (n.shown.length === 0) return null;
            return (
              <p key={v} className="text-[11px] text-muted-foreground">
                <span className="font-bold">{STATEMENT_VERDICT_LABEL_AR[v]}:</span>{" "}
                {v === "MISMATCH"
                  ? rec.lines.filter((l) => l.verdict === "MISMATCH").slice(0, 5).map((l) => (
                      <span key={l.consignmentId} className="me-2 tabular-nums" dir="ltr">{l.consignmentNumber} ({fmt(l.collected)} / {fmt(l.remaining)})</span>
                    ))
                  : n.shown.map((num) => <span key={num} className="me-2 tabular-nums" dir="ltr">{num}</span>)}
                {n.more > 0 && <span>+{n.more}</span>}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}
