import { lifecycleActionAllowed } from "@/lib/lifecycleActionPermission";
import {
  hasModuleAccess,
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import type { OperationUser } from "@shared/operationPermissions";

/** Permission decisions only; invoice status and custody checks stay in the page. */
export function useInvoiceActionPermissions(
  user: OperationUser | null | undefined,
) {
  const role = user?.role as RoleKey;
  const override = (user?.permissionsOverride ?? null) as PermissionMap | null;
  const legacy = (module: string, level: "READ" | "FULL", roles: RoleKey[]) =>
    !!user?.role && moduleAccessAllowed(role, override, module, level, roles);
  const cashier = legacy("sales", "FULL", ["cashier", "manager"]);
  const manager = legacy("sales", "FULL", ["manager"]);
  const delivery = legacy("store", "FULL", ["manager", "cashier"]);
  const allowed = (path: string, before: boolean) =>
    lifecycleActionAllowed(user, path, before);
  return {
    canFirstPrint: allowed("invoicePrinting.requestPrint", !!user),
    canReprint: allowed("invoicePrinting.requestReprint", !!user),
    canOpenStatement: allowed(
      "reports.customerStatement",
      legacy("reports", "READ", ["admin", "manager", "accountant", "auditor"]),
    ),
    canOpenVouchers: allowed(
      "vouchers.get",
      legacy("treasury", "READ", ["admin", "manager", "accountant"]),
    ),
    canCorrectInvoice: allowed("sales.correct", manager),
    canReadCorrectionHistory: allowed("sales.correctionHistory", manager),
    canLookupFullCorrection: allowed("sales.lookupForCorrection", cashier),
    canFullReissue:
      allowed("sales.reissue", cashier) ||
      allowed("salesControl.requestExchange", cashier),
    canRecordPayment: allowed("sales.pay", cashier),
    canInitiatePayment: allowed("sales.initiateExternalPayment", cashier),
    canConfirmPayment: allowed("sales.confirmExternalPayment", cashier),
    canReadDigital: allowed(
      "digitalCards.sales.printDetails",
      !!user?.role && hasModuleAccess(role, override, "digital_cards", "READ"),
    ),
    canCancelInvoice: allowed("sales.cancel", cashier),
    canDispatch: allowed("delivery.dispatchInvoice", delivery),
    canCancelAssignment: allowed("delivery.cancelAssignment", delivery),
    canReverseWorkOrder: allowed(
      "workOrders.requestControl",
      legacy("workorders", "FULL", ["cashier", "manager"]),
    ),
    canRequestDueDateChange: allowed(
      "salesControl.requestDueDateChange",
      manager,
    ),
    canReturnInvoice:
      allowed("returns.create", cashier) ||
      allowed("returns.executeSalesReturnCart", cashier),
    canDownloadPdf: allowed("documentDelivery.downloadPdf", !!user),
  };
}
