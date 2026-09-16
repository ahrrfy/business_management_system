import type { PosColors as C, Receipt, ShiftData } from "./posShared";
import { ReceiptOverlay } from "@/components/pos/ReceiptOverlay";
import { ShiftCloseDialog } from "@/components/pos/ShiftCloseDialog";
import { CashDropDialog } from "@/components/pos/CashDropDialog";
import { CreditApprovalDialog } from "@/components/pos/CreditApprovalDialog";

export interface POSOverlaysProps {
  C: C;
  receipt: Receipt | null;
  onDismissReceipt: () => void;
  onPrintReceipt: () => void;
  shifting: boolean;
  shift: ShiftData | null | undefined;
  branchId: number;
  onCloseShifting: () => void;
  onClosedShifting: () => void;
  me: any;
  branches: any;
  cashDropping: boolean;
  onCloseCashDropping: () => void;
  creditPrompt: string | null;
  mgrEmail: string;
  setMgrEmail: (s: string) => void;
  mgrPwd: string;
  setMgrPwd: (s: string) => void;
  isSalePending: boolean;
  onApproveCredit: () => void;
  onCancelCredit: () => void;
}

export function POSOverlays({
  C,
  receipt,
  onDismissReceipt,
  onPrintReceipt,
  shifting,
  shift,
  branchId,
  onCloseShifting,
  onClosedShifting,
  me,
  branches,
  cashDropping,
  onCloseCashDropping,
  creditPrompt,
  mgrEmail,
  setMgrEmail,
  mgrPwd,
  setMgrPwd,
  isSalePending,
  onApproveCredit,
  onCancelCredit,
}: POSOverlaysProps) {
  return (
    <>
      {receipt && (
        <ReceiptOverlay
          C={C}
          receipt={receipt}
          onDismiss={onDismissReceipt}
          onPrint={onPrintReceipt}
        />
      )}
      {shifting && (
        <ShiftCloseDialog
          C={C}
          shift={shift ?? null}
          branchId={branchId}
          onClose={onCloseShifting}
          onClosed={onClosedShifting}
          me={me}
          branches={branches}
        />
      )}
      {cashDropping && shift && (
        <CashDropDialog C={C} shiftId={shift.id} onClose={onCloseCashDropping} />
      )}
      {creditPrompt && (
        <CreditApprovalDialog
          C={C}
          message={creditPrompt}
          mgrEmail={mgrEmail}
          setMgrEmail={setMgrEmail}
          mgrPwd={mgrPwd}
          setMgrPwd={setMgrPwd}
          isPending={isSalePending}
          onApprove={onApproveCredit}
          onCancel={onCancelCredit}
        />
      )}
    </>
  );
}
