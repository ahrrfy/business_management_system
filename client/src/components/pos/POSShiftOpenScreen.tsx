import { AppSelect } from "@/components/ui/AppSelect";
import { ACTION_LABELS } from "@shared/actionLabels";
import { isWebUsbSupported } from "@/lib/printing/print";
import { Check, Printer } from "lucide-react";
import { Link } from "wouter";
import type { PosColors as C } from "./posShared";

export interface POSShiftOpenScreenProps {
  C: C;
  isLoading: boolean;
  noAssignedBranch: boolean;
  isElevatedRole: boolean;
  pickedBranch: number | null;
  setPickedBranch: (id: number | null) => void;
  branches: Array<{ id: number; name: string }>;
  opening: string;
  setOpening: (val: string) => void;
  bridgeEnabled: boolean;
  printerReady: boolean;
  connectPrinter: () => void;
  openPending: boolean;
  needsBranchChoice: boolean;
  onOpenShift: () => void;
}

export function POSShiftOpenScreen({
  C,
  isLoading,
  noAssignedBranch,
  isElevatedRole,
  pickedBranch,
  setPickedBranch,
  branches,
  opening,
  setOpening,
  bridgeEnabled,
  printerReady,
  connectPrinter,
  openPending,
  needsBranchChoice,
  onOpenShift,
}: POSShiftOpenScreenProps) {
  if (isLoading) {
    return (
      <div style={{ minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, color: C.mutedFg, fontFamily: "'Cairo', system-ui, sans-serif", direction: "rtl" }}>
        {ACTION_LABELS.loading}
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif" }}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: "32px 36px", width: 380, boxShadow: "0 8px 32px rgb(0 0 0/.16)" }}>
        <div style={{ fontWeight: 900, fontSize: 22, marginBottom: 6, color: C.fg }}>افتح وردية للبدء</div>
        <div style={{ fontSize: 13, color: C.mutedFg, marginBottom: 22 }}>لا يمكن البيع بدون وردية مفتوحة</div>
        {noAssignedBranch && isElevatedRole && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 8, padding: "8px 12px", background: C.amberSoft, border: `1px solid ${C.amber}`, borderRadius: 9, fontSize: 12, color: C.fg, fontWeight: 700 }}>
              حسابك بلا فرعٍ مُسنَد — اختر الفرع الذي تعمل منه كي لا تُنسَب المبيعات لفرعٍ خاطئ.
            </div>
            <label style={{ fontSize: 13.5, fontWeight: 700, display: "block", marginBottom: 6, color: C.fg }}>الفرع</label>
            <AppSelect
              value={String(pickedBranch ?? "")}
              onValueChange={(value) => setPickedBranch(value ? Number(value) : null)}
              style={{ width: "100%", height: 48, border: `1.5px solid ${pickedBranch == null ? C.danger : C.border}`, borderRadius: 10, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 15, fontWeight: 700, padding: "0 12px", outline: "none", boxSizing: "border-box" }}
            >
              <option value="">— اختر الفرع —</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </AppSelect>
          </div>
        )}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13.5, fontWeight: 700, display: "block", marginBottom: 6, color: C.fg }}>الرصيد الافتتاحي للصندوق (د.ع)</label>
          <input
            dir="ltr" value={opening}
            onChange={(e) => setOpening(e.target.value)}
            style={{ width: "100%", height: 48, border: `1.5px solid ${C.border}`, borderRadius: 10, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 18, fontWeight: 800, padding: "0 14px", outline: "none", textAlign: "right", boxSizing: "border-box" }}
          />
        </div>
        {isWebUsbSupported() && !bridgeEnabled && (
          <button
            type="button" onClick={connectPrinter}
            title={printerReady ? "الطابعة الحرارية مربوطة — اضغط لتبديلها" : "اربط طابعة حرارية كي يُطبع إيصال فتح الوردية عليها مباشرة"}
            style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, height: 40, marginBottom: 12, borderRadius: 9, fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, cursor: "pointer", background: "none", border: `1.5px solid ${printerReady ? C.success : C.border}`, color: printerReady ? C.success : C.mutedFg }}
          >
            <Printer size={14} aria-hidden />
            {printerReady
              ? <>الطابعة الحرارية مربوطة <Check size={13} aria-hidden strokeWidth={3} /></>
              : "اربط الطابعة الحرارية لطباعة إيصال الوردية"}
          </button>
        )}
        <button
          disabled={openPending || needsBranchChoice}
          onClick={onOpenShift}
          style={{ width: "100%", height: 52, background: openPending || needsBranchChoice ? C.muted : C.primary, color: openPending || needsBranchChoice ? C.mutedFg : C.primaryFg, border: "none", borderRadius: 10, fontFamily: "inherit", fontSize: 15, fontWeight: 800, cursor: openPending || needsBranchChoice ? "not-allowed" : "pointer" }}
        >
          {openPending ? "جارٍ الفتح…" : needsBranchChoice ? "اختر الفرع أولاً" : "فتح الوردية"}
        </button>
        <Link href="/" style={{ display: "block", textAlign: "center", marginTop: 14, fontSize: 13, color: C.mutedFg }}>← الرئيسية</Link>
      </div>
    </div>
  );
}
