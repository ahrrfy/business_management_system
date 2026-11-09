import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLE_TEMPLATES, SECTION_CASHIER_ROLES } from "@shared/permissions";
import { buildDefaultRoleOperationPolicy } from "@shared/roleOperationPresets";
import { operationDecision, type OperationUser } from "@shared/operationPermissions";
import { useInvoiceActionPermissions } from "@/hooks/useInvoiceActionPermissions";
import { receptionInvoiceActions } from "@/lib/receptionOperationAccess";

const readClientFile = (rel: string) =>
  readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");

describe("Reception Return & Cancel — Authorization Parity & Frictionless UX", () => {
  it("grants reception_clerk and cashier full daily return, cancel, COD cancel, workOrder control, and refundRails.preflight permissions", () => {
    const receptionPreset = SECTION_CASHIER_ROLES.find((r) => r.key === "reception_clerk")!;
    const fullReceptionRoles = [
      { key: receptionPreset.key, baseRole: receptionPreset.baseRole, permissions: receptionPreset.permissions },
      { key: "cashier", baseRole: "cashier" as const, permissions: ROLE_TEMPLATES.cashier },
    ];
    for (const c of fullReceptionRoles) {
      const policy = buildDefaultRoleOperationPolicy(c.key, c.baseRole, c.permissions);
      const user: OperationUser = {
        role: c.baseRole,
        permissionsOverride: c.permissions,
        operationPolicyEnabled: true,
        roleOperationPolicy: policy,
      };
      expect(operationDecision(user, "returns.create").allowed, `${c.key}: returns.create`).toBe(true);
      expect(operationDecision(user, "returns.executeSalesReturnCart").allowed, `${c.key}: executeSalesReturnCart`).toBe(true);
      expect(operationDecision(user, "refundRails.preflight").allowed, `${c.key}: refundRails.preflight`).toBe(true);
      expect(operationDecision(user, "sales.cancel").allowed, `${c.key}: sales.cancel`).toBe(true);
      expect(operationDecision(user, "sales.cancelUnpaidCod").allowed, `${c.key}: sales.cancelUnpaidCod`).toBe(true);
      expect(operationDecision(user, "workOrders.requestControl").allowed, `${c.key}: workOrders.requestControl`).toBe(true);
      expect(operationDecision(user, "workOrders.controlPreflight").allowed, `${c.key}: workOrders.controlPreflight`).toBe(true);

      const uiPerms = useInvoiceActionPermissions(user);
      expect(uiPerms.canReturnInvoice).toBe(true);
      expect(uiPerms.canCancelInvoice).toBe(true);
      expect(uiPerms.canCancelUnpaidCodInvoice).toBe(true);
      expect(uiPerms.canReverseWorkOrder).toBe(true);

      const queuePerms = receptionInvoiceActions(user);
      expect(queuePerms.canRequestReturn).toBe(true);
      expect(queuePerms.canCancelInvoice).toBe(true);
      expect(queuePerms.canCancelUnpaidCod).toBe(true);
      expect(queuePerms.canReverseWorkOrder).toBe(true);
      expect(queuePerms.canCancelWorkOrder).toBe(true);
    }

    for (const sectionKey of ["retail_cashier", "print_cashier"] as const) {
      const preset = SECTION_CASHIER_ROLES.find((r) => r.key === sectionKey)!;
      const policy = buildDefaultRoleOperationPolicy(preset.key, preset.baseRole, preset.permissions);
      const user: OperationUser = {
        role: preset.baseRole,
        permissionsOverride: preset.permissions,
        operationPolicyEnabled: true,
        roleOperationPolicy: policy,
      };
      expect(operationDecision(user, "returns.create").allowed, `${sectionKey}: returns.create`).toBe(true);
      expect(operationDecision(user, "returns.executeSalesReturnCart").allowed, `${sectionKey}: executeSalesReturnCart`).toBe(true);
      expect(operationDecision(user, "refundRails.preflight").allowed, `${sectionKey}: refundRails.preflight`).toBe(true);
      expect(operationDecision(user, "sales.cancel").allowed, `${sectionKey}: sales.cancel`).toBe(true);
    }

    const printOpPolicy = buildDefaultRoleOperationPolicy(
      "print_operator",
      "print_operator",
      ROLE_TEMPLATES.print_operator,
    );
    const printOpUser: OperationUser = {
      role: "print_operator",
      permissionsOverride: ROLE_TEMPLATES.print_operator,
      operationPolicyEnabled: true,
      roleOperationPolicy: printOpPolicy,
    };
    expect(operationDecision(printOpUser, "workOrders.cancel").allowed).toBe(true);
    expect(operationDecision(printOpUser, "workOrders.requestControl").allowed).toBe(true);
    expect(operationDecision(printOpUser, "workOrders.controlPreflight").allowed).toBe(true);
    expect(operationDecision(printOpUser, "refundRails.preflight").allowed).toBe(true);
  });

  it("supports custom admin-created reception roles and print_operator with workorders: FULL without false blocks", () => {
    for (const user of [
      { role: "reception_custom" as never, permissionsOverride: { workorders: "FULL" as const, sales: "READ" as const } },
      { role: "print_operator" as const, permissionsOverride: { workorders: "FULL" as const } },
    ]) {
      expect(operationDecision(user, "returns.create").allowed).toBe(true);
      expect(operationDecision(user, "sales.cancel").allowed).toBe(true);
      expect(operationDecision(user, "refundRails.preflight").allowed).toBe(true);

      const uiPerms = useInvoiceActionPermissions(user);
      expect(uiPerms.canReturnInvoice).toBe(true);
      expect(uiPerms.canCancelInvoice).toBe(true);
    }
  });

  it("exposes inline return & cancel across Reception POS header, ReceptionInvoicesPage (default ALL), ReceptionHandoverPage, and ReceptionOrderQueue", () => {
    const posHeader = readClientFile("components/reception/ReceptionWorkspaceHeader.tsx");
    expect(posHeader).toContain("مرتجع / إلغاء");
    expect(posHeader).toContain("ReceptionQuickReturnCancelModal");

    const quickModal = readClientFile("components/reception/ReceptionQuickReturnCancelModal.tsx");
    expect(quickModal).toContain("<SalesReturnDrawer");
    expect(quickModal).toContain("<QuickCancelInvoiceDialog");
    expect(quickModal).toContain("<WorkOrderQuickCancelDialog");
    expect(quickModal).toContain("<ReverseDeliveryRequestDialog");

    const recInvoicesPage = readClientFile("pages/reception/ReceptionInvoicesPage.tsx");
    expect(recInvoicesPage).toContain('defaultPayChip="ALL"');

    const recInvoiceQueue = readClientFile("components/reception/ReceptionInvoiceQueue.tsx");
    expect(recInvoiceQueue).toContain("<InvoiceDetailDrawer");
    expect(recInvoiceQueue).toContain("<SalesReturnDrawer");
    expect(recInvoiceQueue).toContain("<QuickCancelInvoiceDialog");
    expect(recInvoiceQueue).toContain("sinceDays: 90");
    expect(recInvoiceQueue).not.toContain('target="_blank"');
    expect(recInvoiceQueue).not.toContain("function ReturnRequestDialog");

    const quickCancel = readClientFile("components/invoice/QuickCancelInvoiceDialog.tsx");
    expect(quickCancel).toContain('"تراجع الزبون"');
    expect(quickCancel).not.toContain("cancelConfirmText");

    const invoiceDetail = readClientFile("pages/InvoiceDetail.tsx");
    expect(invoiceDetail).toContain('"تراجع الزبون"');
    expect(invoiceDetail).not.toContain("cancelConfirmText");

    const handover = readClientFile("pages/reception/ReceptionHandoverPage.tsx");
    expect(handover).toContain("alreadyCompleted: true");
    expect(handover).toContain("<SalesReturnDrawer");
    expect(handover).toContain("<QuickCancelInvoiceDialog");
    expect(handover).toContain("<WorkOrderQuickCancelDialog");
    expect(handover).toContain("<ReverseDeliveryRequestDialog");

    const orderQueue = readClientFile("components/reception/ReceptionOrderQueue.tsx");
    expect(orderQueue).toContain('key: "cancel-wo"');
    expect(orderQueue).toContain('key: "reverse-wo"');
  });

  it("eliminates internal developer/forensic jargon from user-facing return and cancel screens", () => {
    const moduleReg = readClientFile("lib/moduleRegistry.ts");
    const opsHub = readClientFile("lib/receptionOperationsHub.ts");
    const settlementPanel = readClientFile("components/returns/SalesReturnSettlementPanel.tsx");
    const lookupHook = readClientFile("components/returns/useSalesReturnInvoiceLookup.ts");
    const refundPanel = readClientFile("components/returns/ReturnComposerRefundPanel.tsx");
    const reverseDialog = readClientFile("components/workorder/ReverseDeliveryRequestDialog.tsx");

    expect(moduleReg).not.toContain("وتحرٍّ جنائي");
    expect(opsHub).not.toContain("فواتير التحصيل");
    expect(settlementPanel).not.toContain("تفصيل التسوية الذرية المركبة");
    expect(lookupHook).not.toContain("عبر التحري الذكي");
    expect(refundPanel).not.toContain("تقييد كامل المرتجع بحساب العميل");
    expect(reverseDialog).not.toContain("نسخة الأمر التي ستُراجع");
    expect(reverseDialog).toContain('"رفض الزبون الاستلام"');
  });
});
