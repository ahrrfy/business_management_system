// نافذة «السحب النقديّ أثناء الوردية» (cash drop) — نقلُ نقدٍ من درج الكاشير إلى الخزينة في منتصف
// الوردية لتقليل مخاطرة تكدّس النقد. تستدعي shifts.cashDrop؛ الخادم يفرض حدّ الدرج والحوكمة.
// مصدرُ حقيقةٍ واحدٌ للأوضاع الثلاثة (POS/PrintPOS/Reception) — نافذةٌ مستقلّة كـShiftCloseDialog.
import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { D, round2 } from "@/lib/money";
import type { PosTokens } from "@/components/pos/ShiftHandoverSection";

export function CashDropDialog({
  C,
  shiftId,
  onClose,
  onDone,
}: {
  C: PosTokens;
  shiftId: number;
  onClose: () => void;
  onDone?: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [dropTo, setDropTo] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const amountRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();

  const recipientsQ = trpc.shifts.handoverRecipients.useQuery();

  useEffect(() => {
    amountRef.current?.focus();
  }, []);

  const drop = trpc.shifts.cashDrop.useMutation({
    onSuccess: (r) => {
      notify.ok(`تمّ السحب — سند ${r.dropNumber}`, `المتبقّي في الدرج: ${r.drawerAfter} د.ع`);
      void utils.shifts.report.invalidate();
      onDone?.();
      onClose();
    },
    onError: (e) => notify.err(e),
  });

  const amt = D(amount || 0);
  const valid = amt.gt(0);

  function submit() {
    if (!valid || drop.isPending) return;
    drop.mutate({
      shiftId,
      amount: round2(amt).toFixed(2),
      dropTo: dropTo ?? undefined,
      notes: notes.trim() || undefined,
    });
  }

  const fieldBase: React.CSSProperties = {
    width: "100%",
    border: `1.5px solid ${C.border}`,
    borderRadius: 8,
    background: C.card,
    color: C.fg,
    fontFamily: "inherit",
    padding: "0 12px",
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgb(0 0 0/.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="سحب نقديّ من الدرج"
        style={{ background: C.card, borderRadius: 18, padding: "26px 30px", width: 420, boxShadow: "0 24px 64px rgb(0 0 0/.32)", animation: "popIn .2s ease", maxHeight: "90vh", overflowY: "auto" }}
      >
        <div style={{ fontWeight: 900, fontSize: 19, marginBottom: 4, color: C.fg }}>سحب نقديّ من الدرج #{shiftId}</div>
        <div style={{ fontSize: 12.5, color: C.mutedFg, marginBottom: 18 }}>
          نقلُ نقدٍ من الدرج إلى الخزينة أثناء الوردية (لا يؤثّر على فرق الإقفال — النقد يغادر الدرج فعلاً).
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <label htmlFor="cd-amount" style={{ fontSize: 12, color: C.mutedFg, display: "block", marginBottom: 4 }}>المبلغ المسحوب (د.ع)</label>
            <input
              id="cd-amount"
              ref={amountRef}
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              dir="ltr"
              inputMode="decimal"
              placeholder="0"
              disabled={drop.isPending}
              style={{ ...fieldBase, height: 44, fontSize: 17, fontWeight: 800, textAlign: "right" }}
            />
          </div>

          <div>
            <label htmlFor="cd-recipient" style={{ fontSize: 12, color: C.mutedFg, display: "block", marginBottom: 4 }}>المستلِم (اختياري — مدير/إداري)</label>
            <select
              id="cd-recipient"
              value={dropTo ?? ""}
              disabled={drop.isPending || recipientsQ.isLoading}
              onChange={(e) => setDropTo(e.target.value ? Number(e.target.value) : null)}
              style={{ ...fieldBase, height: 40, fontSize: 14 }}
            >
              <option value="">{recipientsQ.isLoading ? "جارٍ التحميل…" : "— بلا مستلِم (درج أمان) —"}</option>
              {(recipientsQ.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>

          <div>
            <label htmlFor="cd-notes" style={{ fontSize: 12, color: C.mutedFg, display: "block", marginBottom: 4 }}>ملاحظة (اختياري)</label>
            <input
              id="cd-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={drop.isPending}
              maxLength={500}
              style={{ ...fieldBase, height: 38, fontSize: 13 }}
            />
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={drop.isPending}
            style={{ flex: 1, height: 46, background: C.muted, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700 }}
          >
            إلغاء
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!valid || drop.isPending}
            style={{ flex: 2, height: 46, background: !valid || drop.isPending ? C.muted : C.primary, color: !valid || drop.isPending ? C.mutedFg : "#fff", border: "none", borderRadius: 9, cursor: !valid || drop.isPending ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 800 }}
          >
            {drop.isPending ? "جارٍ السحب…" : "تنفيذ السحب"}
          </button>
        </div>
      </div>
    </div>
  );
}
