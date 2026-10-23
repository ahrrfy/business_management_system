import { useVoucherFormState } from "./useVoucherFormState";
import { useVoucherFormQueries } from "./useVoucherFormQueries";
import { useVoucherFormSubmission } from "./useVoucherFormSubmission";
import { useVoucherLedgerPreview } from "./useVoucherLedgerPreview";
import type { VoucherFormProps } from "./voucherFormTypes";
export function useVoucherForm(props: VoucherFormProps) {
  const state = useVoucherFormState(props);
  const queries = useVoucherFormQueries({ ...state });
  const submission = useVoucherFormSubmission({ ...state, ...queries });
  const ledger = useVoucherLedgerPreview({ ...state, ...queries, ...submission });
  return { ...state, ...queries, ...submission, ...ledger };
}
export type VoucherFormModel = ReturnType<typeof useVoucherForm>;
