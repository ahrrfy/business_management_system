import {
  canViewOperationData,
  hasOperationPolicy,
  operationDecision,
  type OperationUser,
} from "@shared/operationPermissions";
import type { InvoiceActionKind } from "@/components/invoice/ActionButtons";

export function salesOperationAllowed(
  user: OperationUser | null | undefined,
  path: string,
  legacyAllowed?: boolean,
): boolean {
  if (!user) return false;
  if (hasOperationPolicy(user) || user.isOwner)
    return operationDecision(user, path).allowed;
  return legacyAllowed ?? operationDecision(user, path).allowed;
}

export function salesCostVisible(
  user: OperationUser | null | undefined,
): boolean {
  if (!user) return false;
  return hasOperationPolicy(user) || user.isOwner
    ? canViewOperationData(user, "purchaseCost")
    : user.role === "manager" || user.role === "admin";
}

export type SalesCorrectionKind = "REISSUE" | "EXCHANGE";
export function salesExternalPaymentAllowed(
  user: OperationUser | null | undefined,
  hasInitiatedAttempt: boolean,
): boolean {
  return (
    salesOperationAllowed(user, "sales.confirmExternalPayment", true) &&
    (hasInitiatedAttempt ||
      salesOperationAllowed(user, "sales.initiateExternalPayment", true))
  );
}
export function salesCorrectionKinds(
  user: OperationUser | null | undefined,
): SalesCorrectionKind[] {
  return (["REISSUE", "EXCHANGE"] as const).filter((kind) =>
    salesOperationAllowed(
      user,
      kind === "REISSUE" ? "sales.reissue" : "salesControl.requestExchange",
      true,
    ),
  );
}

export function salesEditorActions(
  user: OperationUser | null | undefined,
  isCorrection: boolean,
  kind: SalesCorrectionKind,
  hasDigitalItems = false,
): InvoiceActionKind[] {
  const submitPath = isCorrection
    ? kind === "EXCHANGE"
      ? "salesControl.requestExchange"
      : "sales.reissue"
    : "sales.create";
  if (
    !isCorrection && hasDigitalItems
      ? !salesDigitalAllowed(user)
      : !salesOperationAllowed(user, submitPath, true)
  )
    return [];
  if (isCorrection) return ["save"];
  const actions: InvoiceActionKind[] = ["save", "duplicate", "paste"];
  if (salesOperationAllowed(user, "sales.get", true)) {
    if (salesOperationAllowed(user, "invoicePrinting.requestPrint", true))
      actions.push("print", "pdf");
    if (salesOperationAllowed(user, "documentDelivery.sendWhatsAppPdf", true))
      actions.push("send");
  }
  if (salesOperationAllowed(user, "returns.create", true))
    actions.push("return");
  return actions;
}

export function salesDigitalAllowed(
  user: OperationUser | null | undefined,
): boolean {
  return [
    "digitalCards.sales.prepare",
    "digitalCards.sales.getIntent",
    "digitalCards.sales.claimExecution",
    "digitalCards.sales.markExecution",
    "digitalCards.sales.finalize",
  ].every((path) => salesOperationAllowed(user, path, true));
}

export function salesEditorShortcuts(
  actions: readonly InvoiceActionKind[],
  isCorrection: boolean,
) {
  return [
    { key: "F2", label: "بحث" },
    ...(actions.includes("save")
      ? [{ key: "F4", label: isCorrection ? "إرسال الطلب" : "حفظ" }]
      : []),
    ...(actions.includes("print") ? [{ key: "F9", label: "حفظ وطباعة" }] : []),
    { key: "F12", label: "تفريغ" },
    { key: "Esc", label: "إلغاء" },
  ];
}
