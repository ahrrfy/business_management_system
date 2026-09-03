import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../DeliveryPartyDetail.tsx", import.meta.url),
  "utf8",
);

describe("DeliveryPartyDetail operational permission parity", () => {
  it("mirrors deliveryManagerProcedure instead of checking raw roles", () => {
    expect(source).toContain("const canManageParty = !!me.data?.role && moduleAccessAllowed(");
    expect(source).toContain('"store",');
    expect(source).toContain('"FULL",');
    expect(source).toContain('["manager"],');
    expect(source).not.toContain('["admin", "manager"].includes');
  });

  it("uses the same capability for every governed party control", () => {
    expect(source).toContain("<ConsignmentsTab partyId={party.id} canEdit={canManageParty}");
    expect(source).toContain("<PartyMembersTab partyId={party.id} canEdit={canManageParty}");
    expect(source).toContain("<CommissionRuleTab partyId={party.id} canEdit={canManageParty}");
    expect(source).toContain("<SettingsTab party={party} canManage={canManageParty}");
    expect(source).toContain("const canRecover = canManageParty;");
  });
});
