import type { PayrollLegalSettingsView } from "../payrollLegalService";
import { payrollHash } from "./helpers";

export function buildPayrollLegalPolicySnapshot(settings: PayrollLegalSettingsView) {
  return {
    version: 1,
    basis: "EXPLICIT_APPROVED_ITEM_AMOUNTS",
    settings,
  } as const;
}

export function buildPayrollLegalPolicyEvidence(settings: PayrollLegalSettingsView) {
  const snapshot = buildPayrollLegalPolicySnapshot(settings);
  return { snapshot, hash: payrollHash(snapshot) };
}
