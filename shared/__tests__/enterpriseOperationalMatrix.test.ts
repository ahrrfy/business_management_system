import { describe, it, expect } from "vitest";
import {
  ATOMIC_PERMISSION_DEFINITIONS,
  ALL_ATOMIC_PERMISSION_KEYS,
  ATOMIC_PERMISSION_BY_KEY,
  RESOURCE_METADATA,
  DOMAIN_METADATA,
  searchAtomicPermissions,
  getAtomicPermissionsByDomain,
  getAtomicPermissionsByResource,
  type DomainKey,
} from "../atomicPermissions";

describe("Enterprise Comprehensive Permission Matrix Test Suite", () => {
  it("Every permission key strictly conforms to /^[a-z_]+\\.[a-z_]+\\.[a-z_]+$/", () => {
    const keyRegex = /^[a-z_]+\.[a-z_]+\.[a-z_]+$/;
    for (const def of ATOMIC_PERMISSION_DEFINITIONS) {
      expect(def.key).toMatch(keyRegex);
      expect(def.domain).toBe(def.key.split(".")[0]);
      expect(def.resource).toBe(def.key.split(".")[1]);
      expect(def.action).toBe(def.key.split(".")[2]);
    }
  });

  it("Contains zero duplicate keys across the catalog", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const key of ALL_ATOMIC_PERMISSION_KEYS) {
      if (seen.has(key)) {
        duplicates.push(key);
      }
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
    expect(ALL_ATOMIC_PERMISSION_KEYS.length).toBe(ATOMIC_PERMISSION_DEFINITIONS.length);
  });

  it("Every resource has corresponding rich metadata in RESOURCE_METADATA", () => {
    const missingMetadata = new Set<string>();
    for (const def of ATOMIC_PERMISSION_DEFINITIONS) {
      const resKey = `${def.domain}.${def.resource}`;
      if (!RESOURCE_METADATA[resKey]) {
        missingMetadata.add(resKey);
      }
    }
    expect(Array.from(missingMetadata)).toEqual([]);
  });

  it("Verifies required enterprise operational keys across all 10 domains", () => {
    const requiredKeys = [
      // pos
      "pos.invoice.void_line",
      "pos.drawer.open_no_sale",
      "pos.shift.handover",
      "pos.price.below_cost",
      "pos.return.cash_refund",
      "pos.return.store_credit",
      "pos.hold.park_bill",
      "pos.hold.resume_bill",
      "pos.split.split_bill",
      "pos.offline.sync",

      // reception
      "reception.specs.edit",
      "reception.deposit.exempt",
      "reception.proof.bypass",
      "reception.order.rush",
      "reception.order.split",
      "reception.customer.claim_reopen",
      "reception.quote.discount",

      // workshop
      "workshop.bom.modify_consumption",
      "workshop.reprint.authorize",
      "workshop.qc.inspect_pass",
      "workshop.qc.reject",
      "workshop.machine.calibrate",
      "workshop.job.assign_operator",

      // inventory
      "inventory.receipt.create",
      "inventory.issue.direct",
      "inventory.issue.internal_use",
      "inventory.count.blind_perform",
      "inventory.cost.view_wac",
      "inventory.valuation.override",
      "inventory.batch.expire_freeze",

      // purchasing
      "purchasing.requisition.create",
      "purchasing.requisition.approve",
      "purchasing.vendor.bank_edit",
      "purchasing.bill.match_variance",
      "purchasing.price.negotiate",
      "purchasing.vendor.blacklist",
      "purchasing.rfq.send",
      "purchasing.contract.sign",
      "purchasing.advance.disburse",

      // treasury
      "treasury.transfer.inter_safe",
      "treasury.bank.deposit",
      "treasury.bank.reconcile",
      "treasury.expense.approve_unbudgeted",
      "treasury.custody.issue",
      "treasury.custody.settle",
      "treasury.journal.post",
      "treasury.period.reopen",
      "treasury.cheque.endorse",
      "treasury.credit_note.issue",
      "treasury.debit_note.issue",
      "treasury.write_off.bad_debt",

      // fieldsales
      "fieldsales.customer.set_credit_limit",
      "fieldsales.customer.block_credit",
      "fieldsales.customer.export",
      "fieldsales.quote.convert_to_order",
      "fieldsales.discount.special_contract",
      "fieldsales.commission.calculate",
      "fieldsales.target.assign",
      "fieldsales.route.assign_plan",
      "fieldsales.contract.approve_term",

      // delivery
      "delivery.parcel.assign_courier",
      "delivery.cod.collect",
      "delivery.settlement.clear_driver",
      "delivery.fee.waive_shipping",
      "delivery.manifest.generate",
      "delivery.route.optimize",
      "delivery.failed.reschedule",
      "delivery.damage.compensate",
      "delivery.driver.block",

      // hr
      "hr.attendance.pull_logs",
      "hr.attendance.manual_entry",
      "hr.loan.approve",
      "hr.data.view_salaries",
      "hr.penalty.issue",
      "hr.overtime.approve",
      "hr.appraisal.submit",
      "hr.contract.renew",

      // governance
      "governance.audit.export_logs",
      "governance.session.terminate_all",
      "governance.integration.rotate_keys",
      "governance.permission.override_emergency",
      "governance.role.clone",
      "governance.ip_allowlist.modify",
      "governance.policy.update_security",
    ];

    for (const key of requiredKeys) {
      const def = ATOMIC_PERMISSION_BY_KEY[key];
      expect(def, `Missing key: ${key}`).toBeDefined();
      expect(def?.key).toBe(key);
      expect(def?.labelAr).toBeTruthy();
      expect(def?.descriptionAr).toBeTruthy();
      expect(["critical", "high", "medium", "normal"]).toContain(def?.sensitivity);
    }
  });

  it("searchAtomicPermissions: enables precise search by exact key, Arabic labels, and actions", () => {
    // Exact key search
    const voidLineMatches = searchAtomicPermissions("pos.invoice.void_line");
    expect(voidLineMatches).toHaveLength(1);
    expect(voidLineMatches[0].key).toBe("pos.invoice.void_line");

    // Arabic search
    const rushMatches = searchAtomicPermissions("مستعجل");
    expect(rushMatches.length).toBeGreaterThanOrEqual(1);
    expect(rushMatches.some((m) => m.key === "reception.order.rush")).toBe(true);

    // Partial domain search
    const qcMatches = searchAtomicPermissions("فحص الجودة");
    expect(qcMatches.length).toBeGreaterThanOrEqual(1);
  });

  it("Domain coverage spans all 10 domains with full metadata", () => {
    const domains: DomainKey[] = [
      "pos",
      "reception",
      "workshop",
      "inventory",
      "purchasing",
      "treasury",
      "fieldsales",
      "delivery",
      "hr",
      "governance",
    ];

    for (const d of domains) {
      expect(DOMAIN_METADATA[d]).toBeDefined();
      const perms = getAtomicPermissionsByDomain(d);
      expect(perms.length).toBeGreaterThanOrEqual(15);
    }
  });
});
