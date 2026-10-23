import { useSalesReturnState } from "./useSalesReturnState";
import { useSalesReturnSettlement } from "./useSalesReturnSettlement";
import { useSalesReturnInvoiceLookup } from "./useSalesReturnInvoiceLookup";
import { useSalesReturnCartActions } from "./useSalesReturnCartActions";
import { useSalesReturnScan } from "./useSalesReturnScan";
import { useSalesReturnSubmission } from "./useSalesReturnSubmission";
import type { SalesReturnPortalProps } from "./salesReturnPortalTypes";
export function useSalesReturnPortal(props: SalesReturnPortalProps) {
  const state = useSalesReturnState(props);
  const settlement = useSalesReturnSettlement({ ...state });
  const lookup = useSalesReturnInvoiceLookup({ ...state, ...settlement });
  const cart = useSalesReturnCartActions({ ...state, ...settlement, ...lookup });
  const scan = useSalesReturnScan({ ...state, ...settlement, ...lookup, ...cart });
  const submission = useSalesReturnSubmission({
    ...state,
    ...settlement,
    ...lookup,
    ...cart,
    ...scan,
  });
  return { ...state, ...settlement, ...lookup, ...cart, ...scan, ...submission };
}
export type SalesReturnPortalModel = ReturnType<typeof useSalesReturnPortal>;
