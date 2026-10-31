import { RejectedReturnProposal } from "./returnException";
import { canViewOperationData } from "@shared/operationPermissions";
import { moduleAccessAllowed, type PermissionMap } from "@shared/permissions";
import { withOperationAuthority } from "../authorization/operationExecutionScope";
import type { Actor } from "../tx";
import { getPurchaseReturn } from "../purchaseReturnsService";
import { requestPurchaseReturn } from "./returnGovernance";
import { returnConflict } from "./returnEvidence";
import type { ExceptionReturnInput } from "./returnException";

export type ReturnCartInput = {
  supplierId: number;
  branchId?: number;
  reference?: string | null;
  evidenceType: ExceptionReturnInput["evidenceType"];
  items: Array<{
    variantId: number;
    productUnitId?: number;
    productName: string;
    quantity: number;
    unitCost: string;
    barcode?: string | null;
  }>;
  settlement: {
    method: "CREDIT_OFFSET" | "CASH_IN" | "CARD_TRANSFER";
    totalAmount: string;
    shiftId?: number | null;
    reference?: string | null;
  };
  reason: string;
  clientRequestId: string;
};
export async function executeGovernedReturnCart(
  input: ReturnCartInput,
  actor: Actor,
) {
  const branchId = input.branchId ?? actor.branchId;
  if (!branchId) returnConflict("اختر الفرع الفعلي للمرتجع");
  return withOperationAuthority(
    {
      actor,
      path: "returns.executePurchaseReturnCart",
      legacyAllowed: (current) =>
        moduleAccessAllowed(
          current.role ?? "user",
          current.permissionsOverride as PermissionMap | null,
          "sales",
          "FULL",
          ["manager"],
        ) &&
        canViewOperationData(current, "purchaseCost") &&
        canViewOperationData(current, "profitMargin"),
    },
    () =>
      withOperationAuthority(
        {
          actor,
          path: "purchaseReturnGovernance.requestReturn",
          legacyAllowed: (current) =>
            moduleAccessAllowed(
              current.role ?? "user",
              current.permissionsOverride as PermissionMap | null,
              "purchases",
              "FULL",
              ["manager", "purchasing"],
            ),
        },
        async () => {
          const result = await requestPurchaseReturn(
            {
              sourceKind: "OWNER_EXCEPTION",
              supplierId: input.supplierId,
              branchId,
              requestKey: input.clientRequestId,
              settlement:
                input.settlement.method === "CREDIT_OFFSET" ? "CREDIT" : "CASH",
              paymentMethod:
                input.settlement.method === "CARD_TRANSFER"
                  ? "TRANSFER"
                  : "CASH",
              cashRoute:
                input.settlement.method === "CASH_IN"
                  ? {
                      cashBucket: "DRAWER",
                      shiftId: input.settlement.shiftId ?? 0,
                    }
                  : undefined,
              externalReference:
                input.settlement.reference?.trim() || undefined,
              evidenceType: input.evidenceType,
              evidenceReference: input.reference ?? "",
              reason: input.reason,
              expectedTotal: input.settlement.totalAmount,
              lines: input.items.map((item) => ({
                variantId: item.variantId,
                productUnitId: item.productUnitId,
                quantity: item.quantity,
                agreedUnitPrice: item.unitCost,
              })),
            },
            actor,
          ).catch((error) => {
            if (error instanceof RejectedReturnProposal)
              return {
                mode: "INVALID_PROPOSAL" as const,
                message: error.message,
              };
            throw error;
          });
          if ("mode" in result) return result;
          if (result.status !== "APPROVED" || !result.purchaseReturnId)
            return {
              mode: "REQUESTED" as const,
              requestId: result.requestId,
              status: result.status,
            };
          const document = await getPurchaseReturn(
            result.purchaseReturnId,
            branchId,
          );
          return {
            mode: "EXECUTED" as const,
            requestId: result.requestId,
            purchaseReturnId: result.purchaseReturnId,
            document,
          };
        },
      ),
  );
}
