import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../DeliveryPartyDetail.tsx", import.meta.url),
  "utf8",
).replace(/\s+/g, " ");
const columns = readFileSync(
  new URL(
    "../../components/delivery/companyConsignmentColumns.tsx",
    import.meta.url,
  ),
  "utf8",
).replace(/\s+/g, " ");

describe("DeliveryPartyDetail operational permission parity", () => {
  it("retains the legacy module gate while delegating canonical party editing independently", () => {
    expect(source).toContain(
      'const canManageParty = lifecycleActionAllowed(me.data, "delivery.updateParty", !!me.data?.role && moduleAccessAllowed(',
    );
    expect(source).toContain('"store",');
    expect(source).toContain('"FULL",');
    expect(source).toContain('["manager"],');
    expect(source).not.toContain('["admin", "manager"].includes');
  });

  it("keeps independent grants for party, membership, commission and parcel actions", () => {
    expect(source).toContain(
      "<ConsignmentsTab party={party} canEdit={canManageParty} canSettle={canSettle}",
    );
    expect(source).toContain(
      "<PartyMembersTab partyId={party.id} canEdit={canManageParty}",
    );
    expect(source).toContain(
      "<CommissionRuleTab partyId={party.id} canEdit={canManageParty}",
    );
    expect(source).toContain(
      "<SettingsTab party={party} canManage={canManageParty}",
    );
    for (const path of ["recoverWriteOff", "addPartyMember", "removePartyMember", "saveCommissionRule", "deleteCommissionRule", "setPartyActive"]) {
      expect(source).toContain(`"delivery.${path}"`);
    }
    expect(source).toContain('["cashier", "manager"],');
    expect(columns).toContain('lifecycleActionAllowed(me.data, "delivery.recordRemittance", canSettle) && canRemit');
    expect(columns).toContain('lifecycleActionAllowed(me.data, "delivery.cancelAssignment", canEdit) && canCancel');
    expect(columns).toContain('lifecycleActionAllowed(me.data, "delivery.reassignConsignment", canEdit)');
    expect(columns).toContain('lifecycleActionAllowed(me.data, "delivery.returnConsignment", canEdit)');
    expect(columns).toContain("D(c.collectedAmount).isZero()");
    expect(columns).toContain("D(c.counterSettledAmount).isZero()");
    expect(columns).toContain("D(c.shortfallAssigned).isZero()");
  });
});
