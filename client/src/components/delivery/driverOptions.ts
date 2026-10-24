type Driver = { userId: number; name: string; branchId: number | null };
type Party = {
  partyType: string;
  name: string;
  userId: number | null;
  drivers: Driver[];
  hasActiveDriverMembership: boolean;
  linkedUserDriverEligible: boolean;
  linkedUserBranchId: number | null;
  linkedUserName: string | null;
};

export function requiresDeliveryDriver(party: Party | null | undefined): boolean {
  return party?.partyType === "INDIVIDUAL" && (party.userId != null || party.hasActiveDriverMembership);
}

/** Readonly server metadata excludes inactive/expired users; never select a default. */
export function deliveryDriverOptions(party: Party | null | undefined, branchId: number): Driver[] {
  const options = (party?.drivers ?? []).filter(driver => driver.branchId === branchId);
  if (party?.linkedUserDriverEligible && party.linkedUserBranchId === branchId && party.userId != null && !options.some(driver => driver.userId === party.userId)) {
    options.push({userId: party.userId, name: party.linkedUserName ?? party.name, branchId});
  }
  return options;
}
