// برميل حزمة خدمات محطة خدمة الزبائن (Reception) — ش١+ش٢+ش٣+ش٤.
// البنية المرجعية في docs/reception-cashier-system-design-2026-08-05.md §٧.
export { listReceptionInvoices } from "./queries";
export { collectOnReceptionInvoice } from "./collect";
// كتّابُ الإيصالات (قبضٌ/ردٌّ على مسوّدة) — محوِّلُ الاستقبال فوق نواة العرابين.
export { collectDeposit, refundDeposit, type CollectDepositInput, type RefundDepositInput } from "./deposits";
// دفترُ المال المحتجَز — نواة العرابين (م٣): `server/services/deposits` هي المصدر، لا هذا البرميل.
export {
  listDraftPayments,
  heldNetOfDraft,
  heldDepositsOfShift,
  allocateAtCommit,
  appliedCollectionsForWorkOrder,
  type DepositMethod,
} from "../deposits";
export { isPreInvoiceHoldReceiptCond, entryNotHoldReceiptCond } from "./holdReceipts";
export {
  cancelDraft,
  getDraft,
  listDrafts,
  promoteDraft,
  sweepExpiredDrafts,
  syncDraft,
  type DraftHeaderInput,
  type DraftLineInput,
} from "./draft";
export { commitDraft, type CommitDraftInput, type CommitDraftResult } from "./commit";
export type {
  CollectOnInvoiceInput,
  ReceptionDeliveryState,
  ReceptionInvoiceQueueInput,
  ReceptionPayMethod,
  ReceptionPaymentState,
} from "./types";
