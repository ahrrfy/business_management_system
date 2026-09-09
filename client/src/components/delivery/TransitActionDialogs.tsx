// حوارات إجراءات التوصيل (قيد التوصيل) — مستخرجة من DeliveryHub.tsx لخفض حجم الصفحة.
import { useState } from "react";
import { CheckCircle2, ShieldCheck, Undo2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  SHORTFALL_REASONS,
  SHORTFALL_REASON_LABEL_AR,
  SHORTFALL_REASON_DESCRIPTION_AR,
  type ShortfallReason,
} from "@shared/shortfallReason";
import type { RouterOutputs } from "@/lib/trpc";

type InTransitRow = RouterOutputs["delivery"]["inTransit"]["rows"][number];

// ───────────────────────── تأكيد التسليم بيد الكاشير ─────────────────────────

/**
 * حوار تأكيد التسليم — مساران مغلقان:
 *   ١) «قَبَض المطلوب كاملاً» — زرٌّ رئيسٌ بلا حقول.
 *   ٢) «مبلغ مختلف» — مبلغ + سبب عجز إلزاميّ من enum.
 */
export function StaffConfirmDialog({ row, pending, onCancel, onConfirm }: { row: InTransitRow; pending: boolean; onCancel: () => void; onConfirm: (collectedAmount: string, evidence: string, shortfallReason: ShortfallReason | undefined) => void }) {
  const remaining = Math.max(0, Number(row.codAmount) - Number(row.collectedAmount ?? 0) - Number(row.counterSettledAmount ?? 0));
  const [mode, setMode] = useState<"exact" | "different">("exact");
  const [amount, setAmount] = useState(String(remaining));
  const [note, setNote] = useState("");
  const [shortfallReason, setShortfallReason] = useState<ShortfallReason | "">("");
  const QUICK_NOTES = ["اتصال المندوب", "رسالة واتساب من المندوب", "تأكيد من العميل"];
  const amountTrimmed = amount.trim();
  const amountNum = Number(amountTrimmed);
  const isAmountValid = amountTrimmed !== "" && Number.isFinite(amountNum) && amountNum >= 0;
  const effectiveAmount = mode === "exact" ? remaining : (isAmountValid ? amountNum : 0);
  const diff = remaining - effectiveAmount;
  const isShort = diff > 0.005;
  const isOver = diff < -0.005;
  const noteValid = note.trim().length >= 3;
  const reasonRequired = mode === "different" && isShort;
  const reasonValid = !reasonRequired || (shortfallReason !== "" && SHORTFALL_REASONS.includes(shortfallReason as ShortfallReason));
  const canConfirm =
    !pending &&
    noteValid &&
    (mode === "exact" || (isAmountValid && !isOver)) &&
    reasonValid;

  const handleConfirm = () => {
    onConfirm(
      effectiveAmount.toFixed(2),
      note.trim(),
      isShort && shortfallReason ? (shortfallReason as ShortfallReason) : undefined,
    );
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={onCancel} dir="rtl">
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2 text-base font-bold text-[var(--sem-pos)]">
          <CheckCircle2 aria-hidden className="size-5" />
          تم التسليم — {row.consignmentNumber}
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          سُلِّم الطردُ للزبون. المبلغُ يصير عهدةً على {row.partyName ?? "المندوب"} حتى تُوَرَّده لاحقاً في «تسوية المناديب». يُسجَّل التأكيدُ باسمك في سجلّ التدقيق.
        </p>
        <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-2 text-xs">
          <span className="text-muted-foreground">المطلوب تحصيله من الزبون</span>
          <span className="text-end font-black tabular-nums" dir="ltr">{fmt(String(remaining))} د.ع</span>
        </div>

        {/* اختيار المسار */}
        <div className="mb-3 grid grid-cols-2 gap-1.5 rounded-lg border bg-muted/20 p-1">
          <button
            type="button"
            onClick={() => { setMode("exact"); setAmount(String(remaining)); setShortfallReason(""); }}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-bold transition",
              mode === "exact" ? "bg-[var(--sem-pos)] text-background shadow-sm" : "text-muted-foreground hover:bg-accent",
            )}
          >
            قَبَض المطلوب كاملاً
          </button>
          <button
            type="button"
            onClick={() => setMode("different")}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-bold transition",
              mode === "different" ? "bg-[var(--sem-warn)] text-background shadow-sm" : "text-muted-foreground hover:bg-accent",
            )}
          >
            مبلغ مختلف
          </button>
        </div>

        {mode === "different" && (
          <>
            <Label htmlFor="staff-amount" className="text-xs">المبلغ الذي قبضه المندوب فعلاً</Label>
            <div className="mb-3">
              <MoneyInput id="staff-amount" value={amount} onChange={(v) => setAmount(v)} ariaLabel="المبلغ المقبوض" />
            </div>
            {isOver && (
              <p className="mb-3 rounded-md border border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] p-2 text-xs font-medium text-[var(--sem-neg)]">
                المبلغ أكبر من المطلوب — تحقّق من الرقم أو استعمل مسار الفائض المستقلّ.
              </p>
            )}
            {isShort && (
              <>
                <div className="mb-3 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2 text-xs">
                  <div className="font-bold text-[var(--sem-warn)]">
                    عجزٌ في التحصيل: {fmt(String(diff))} د.ع
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    سيُقيَّد هذا الفرق ذمّةً فوريّة على {row.partyName ?? "المندوب"} — لا يبقى على الزبون.
                  </div>
                </div>
                <Label className="text-xs">سبب العجز <span className="text-[var(--sem-neg)]">*</span></Label>
                <div className="mb-3 grid grid-cols-1 gap-1.5">
                  {SHORTFALL_REASONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setShortfallReason(r)}
                      className={cn(
                        "flex items-start gap-2 rounded-md border p-2 text-start text-xs transition",
                        shortfallReason === r
                          ? "border-[var(--sem-warn)] bg-[var(--sem-warn-bg)]"
                          : "border-muted bg-muted/20 hover:bg-accent",
                      )}
                    >
                      <span className="mt-0.5 inline-block size-3 shrink-0 rounded-full border-2"
                        style={{
                          borderColor: shortfallReason === r ? "var(--sem-warn)" : "var(--muted-foreground)",
                          backgroundColor: shortfallReason === r ? "var(--sem-warn)" : "transparent",
                        }}
                      />
                      <div className="flex-1">
                        <div className="font-bold">{SHORTFALL_REASON_LABEL_AR[r]}</div>
                        <div className="text-muted-foreground">{SHORTFALL_REASON_DESCRIPTION_AR[r]}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        <Label className="text-xs">مصدر التأكيد (اختصار سريع أو نصّ حرّ)</Label>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {QUICK_NOTES.map((n) => (
            <button key={n} type="button" onClick={() => setNote(n)} className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition",
              note === n ? "bg-[var(--sem-pos)] text-background" : "bg-muted text-muted-foreground hover:bg-accent",
            )}>{n}</button>
          ))}
        </div>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً: اتصال ٦:٤٥م من المندوب…" className="mb-4" />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>تراجع</Button>
          <Button size="sm" disabled={!canConfirm} onClick={handleConfirm}>
            {pending ? "جارٍ…" : "تأكيد التسليم"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── تعذّر التسليم ─────────────────────────

const FAIL_REASONS = [
  "رفض العميل الاستلام",
  "العميل غير متوفّر",
  "عنوان خاطئ",
  "تعذّر التواصل",
  "طلب تأجيل التسليم",
];

export function FailReasonDialog({ count, pending, onCancel, onConfirm }: { count: number; pending: boolean; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={onCancel} dir="rtl">
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2 text-base font-bold text-[var(--sem-danger)]">
          <XCircle aria-hidden className="size-5" />
          تعذّر تسليم {count > 1 ? `${count} طرداً` : "الطرد"}
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          يُسجَّل السبب على كل طرد ويُوسَم متعذّراً. لا حركة مخزون ولا عكس فاتورة الآن — استلامُ الطرد وفحصه لاحقاً هما ما يُشغّلان العكس الكامل.
        </p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {FAIL_REASONS.map((r) => (
            <button key={r} type="button" onClick={() => setReason(r)} className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition",
              reason === r ? "bg-[var(--sem-danger)] text-background" : "bg-muted text-muted-foreground hover:bg-accent",
            )}>{r}</button>
          ))}
        </div>
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="سبب تعذّر التسليم…"
          className="mb-4"
        />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>تراجع</Button>
          <Button
            size="sm"
            disabled={pending || reason.trim().length < 2}
            onClick={() => onConfirm(reason.trim())}
          >
            {pending ? "جارٍ…" : `تأكيد تعذّر ${count > 1 ? count : ""}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── إعلان رجوع ─────────────────────────

const DECLARE_REASONS = [
  "رفض العميل",
  "عنوان خاطئ",
  "لم يُعثر عليه",
  "تعذّر التواصل",
];

export function DeclareReturnDialog({ row, pending, onCancel, onConfirm }: { row: InTransitRow; pending: boolean; onCancel: () => void; onConfirm: (reason: string, statementNumber: string) => void }) {
  const [reason, setReason] = useState("");
  const [statementNumber, setStatementNumber] = useState("");
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={onCancel} dir="rtl">
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2 text-base font-bold text-[var(--sem-warn)]">
          <Undo2 aria-hidden className="size-5" />
          إعلان رجوع {row.consignmentNumber ?? `#${row.id}`}
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          يُغلق توقّع التحصيل على الجهة فوراً، ويضع الطرد في «بانتظار المرتجع». لا تعود البضاعة للمخزون ولا تُرجَع الفاتورة — ذلك يقع عند الاستلام والفحص في الفرع.
        </p>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {DECLARE_REASONS.map((r) => (
            <button key={r} type="button" onClick={() => setReason(r)} className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition",
              reason === r ? "bg-[var(--sem-warn)] text-background" : "bg-muted text-muted-foreground hover:bg-accent",
            )}>{r}</button>
          ))}
        </div>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="أو اكتب سبباً حرّاً…" className="mb-2" />
        <Label htmlFor="declare-stmt" className="text-xs">رقم كشف الشركة (اختياريّ)</Label>
        <Input id="declare-stmt" value={statementNumber} onChange={(e) => setStatementNumber(e.target.value)} dir="ltr" placeholder="STMT-…" className="mb-4" />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>تراجع</Button>
          <Button size="sm" disabled={pending || reason.trim().length < 3} onClick={() => onConfirm(reason.trim(), statementNumber.trim())}>
            {pending ? "جارٍ…" : "تأكيد إعلان الرجوع"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── إثبات تسليم يدويّ ─────────────────────────

export function ManualProofDialog({ row, pending, onCancel, onConfirm }: { row: InTransitRow; pending: boolean; onCancel: () => void; onConfirm: (collectedAmount: string, evidence: string) => void }) {
  const remaining = Math.max(0, Number(row.codAmount) - Number(row.collectedAmount ?? 0) - Number(row.counterSettledAmount ?? 0));
  const [amount, setAmount] = useState(String(remaining));
  const [evidence, setEvidence] = useState("");
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={onCancel} dir="rtl">
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2 text-base font-bold text-[var(--sem-info)]">
          <ShieldCheck aria-hidden className="size-5" />
          إثبات تسليم يدويّ — {row.consignmentNumber}
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          سلطةٌ استثنائية للمدير: لطرد لا بوّابة له ولا كشف بعد. يُثبَت التسليم بدليل مكتوب (مصدره: مكالمة/صورة/شهادة موظّف) وتُدوَّن هويّة الفاعل والدليل في سجلّ التدقيق. المبلغ المُعلَن تحصيله يُبرِئ ذمّة العميل بمقداره، والفرق يبقى ذمّةً حيّةً تُقبَض بالكاونتر.
        </p>
        <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-2 text-xs">
          <span className="text-muted-foreground">المطلوب تحصيله</span>
          <span className="text-end font-black tabular-nums" dir="ltr">{fmt(String(remaining))} د.ع</span>
        </div>
        <Label htmlFor="proof-amount" className="text-xs">المُعلَن تحصيله فعلاً</Label>
        <div className="mb-3">
          <MoneyInput id="proof-amount" value={amount} onChange={(v) => setAmount(v)} ariaLabel="المبلغ المُعلَن تحصيله" />
        </div>
        <Label htmlFor="proof-ev" className="text-xs">الدليل (إلزاميّ — ≥٤ حروف)</Label>
        <Input id="proof-ev" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="مصدر الدليل — مكالمة/صورة/شهادة…" className="mb-4" />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>تراجع</Button>
          <Button size="sm" disabled={pending || evidence.trim().length < 4 || Number(amount) < 0} onClick={() => onConfirm(String(Number(amount).toFixed(2)), evidence.trim())}>
            {pending ? "جارٍ…" : "تسجيل الإثبات"}
          </Button>
        </div>
      </div>
    </div>
  );
}
