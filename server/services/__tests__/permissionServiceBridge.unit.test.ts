import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../../db";
import {
  assertOperationAuthorityTx,
  assertServiceOperationTx,
  canonicalOperationAllowed,
  hasServiceOperationAuthority,
  loadOperationUserTx,
  routeOperationAuthority,
  storedOperationUser,
  type ServiceOperationAuthority,
} from "../authorization/operationAuthority";
import { resolvePermissions } from "@shared/permissions";
import type { OperationPolicy } from "@shared/operationPermissions";

const paths = ["delivery.cancelAssignment", "salesControl.approve", "salesControl.reject", "returns.create", "supplierPayments.cashSources"];

function policy(...grantedPaths: string[]): OperationPolicy {
  return { version: 1, grants: Object.fromEntries(grantedPaths.map((path) => [`operation.${path}`, true])) };
}

function account(operationPolicy: OperationPolicy | null = null) {
  return { id: 4, role: "warehouse", isActive: true, isOwner: false, customRoleId: null as number | null,
    permissionsOverride: null, operationPolicy };
}

function fakeTx(results: unknown[][]): Tx {
  let offset = 0;
  const select = vi.fn(() => {
    const rows = results[offset++] ?? [];
    const query = { from: () => query, where: () => query, for: () => query, limit: async () => rows };
    return query;
  });
  return { select } as unknown as Tx;
}

describe("transactional operation service bridge", () => {
  it("preserves individual old revocations after role conversion and replaces them on explicit user conversion", async () => {
    const role = { baseRole: "warehouse", isActive: true, permissions: resolvePermissions("warehouse", null), operationPolicy: policy("sales.create", "sales.list", "returns.create") };
    const unrestricted = { ...account(), customRoleId: 9 };
    expect(canonicalOperationAllowed(storedOperationUser(unrestricted, role), "sales.create")).toBe(true);
    const atomicDenied = { ...unrestricted, atomicPermissions: { "pos.return.create": false } };
    expect(canonicalOperationAllowed(storedOperationUser(atomicDenied, role), "returns.create")).toBe(false);
    expect(canonicalOperationAllowed(storedOperationUser(atomicDenied, role), "sales.create")).toBe(true);
    const readOnly = { ...unrestricted, permissionsOverride: { sales: "READ" as const } };
    expect(canonicalOperationAllowed(storedOperationUser(readOnly, role), "sales.list")).toBe(true);
    expect(canonicalOperationAllowed(storedOperationUser(readOnly, role), "sales.create")).toBe(false);
    const denied = { ...unrestricted, permissionsOverride: { sales: "NONE" as const, workorders: "NONE" as const, pos: "NONE" as const } };
    expect(canonicalOperationAllowed(storedOperationUser(denied, role), "sales.list")).toBe(false);
    const proof = routeOperationAuthority({ ...storedOperationUser(unrestricted, role), id: 4 }, "returns.create");
    await expect(assertOperationAuthorityTx(fakeTx([[{ customRoleId: 9 }], [role], [atomicDenied]]), { userId: 4 }, "returns.create", true, proof)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(canonicalOperationAllowed(storedOperationUser({ ...atomicDenied, operationPolicy: policy() }, role), "returns.create")).toBe(true);
  });

  it("rebuilds a seeded cashier preset during the locked service recheck", async () => {
    const user = { ...account(), role: "cashier", customRoleId: 9 };
    const role = {
      key: "print_cashier", baseRole: "cashier", isActive: true,
      permissions: resolvePermissions("cashier", null), operationPolicy: null,
    };
    const current = storedOperationUser(user, role);
    expect(current.operationPolicyEnabled).toBe(true);
    expect(canonicalOperationAllowed(current, "returns.create")).toBe(true);
    await expect(assertOperationAuthorityTx(
      fakeTx([[{ customRoleId: 9 }], [role], [user]]),
      { userId: 4, role: "cashier" },
      "returns.create",
      false,
    )).resolves.toBe(true);
  });
  it("delegates only the selected real operation, without expanding another action", () => {
    const user = storedOperationUser(account(policy(paths[0]!)));
    expect(canonicalOperationAllowed(user, paths[0]!)).toBe(true);
    for (const path of paths.slice(1)) expect(canonicalOperationAllowed(user, path)).toBe(false);
  });

  it("binds server proofs to exactly one account and path", () => {
    const user = { ...storedOperationUser(account(policy(paths[0]!))), id: 4 };
    const authority = routeOperationAuthority(user, paths[0]!);
    expect(hasServiceOperationAuthority(authority, 4, paths[0]!)).toBe(true);
    expect(hasServiceOperationAuthority(authority, 5, paths[0]!)).toBe(false);
    expect(hasServiceOperationAuthority(authority, 4, paths[1]!)).toBe(false);
    expect(hasServiceOperationAuthority({ userId: 4, path: paths[0]! } as ServiceOperationAuthority, 4, paths[0]!)).toBe(false);
    expect(Object.isFrozen(authority)).toBe(true);
  });

  it("fails closed when a default preset does not grant the requested operation", () => {
    expect(() => routeOperationAuthority({ ...storedOperationUser(account()), id: 4 }, paths[0]!)).toThrow();
  });

  it("accepts a granted warehouse operation on fresh persisted policy", async () => {
    const saved = account(policy(paths[0]!));
    const authority = routeOperationAuthority({ ...storedOperationUser(saved), id: 4 }, paths[0]!);
    await expect(assertOperationAuthorityTx(fakeTx([[{ customRoleId: null }], [saved]]), { userId: 4 }, paths[0]!, false, authority)).resolves.toBe(true);
  });

  it("rejects intervening revocation despite a previously valid router proof", async () => {
    const authority = routeOperationAuthority({ ...storedOperationUser(account(policy(paths[0]!))), id: 4 }, paths[0]!);
    const revoked = account(policy());
    await expect(assertOperationAuthorityTx(fakeTx([[{ customRoleId: null }], [revoked]]), { userId: 4 }, paths[0]!, true, authority)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not let a proof for another actor/action satisfy a service gate", async () => {
    const authority = routeOperationAuthority({ ...storedOperationUser(account(policy(paths[0]!))), id: 4 }, paths[0]!);
    await expect(assertOperationAuthorityTx(fakeTx([]), { userId: 5 }, paths[0]!, true, authority)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(assertOperationAuthorityTx(fakeTx([]), { userId: 4 }, paths[1]!, true, authority)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("preserves legacy service authority without enabling canonical policy", async () => {
    const legacy = { ...account(), customRoleId: 9 };
    const legacyRole = { key: "legacy_warehouse", baseRole: "warehouse", isActive: true,
      permissions: resolvePermissions("warehouse", null), operationPolicy: null };
    await expect(assertOperationAuthorityTx(fakeTx([[{ customRoleId: 9 }], [legacyRole], [legacy]]), { userId: 4 }, paths[0]!, true)).resolves.toBe(false);
    await expect(assertOperationAuthorityTx(fakeTx([[{ customRoleId: 9 }], [legacyRole], [legacy]]), { userId: 4 }, paths[0]!, false)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("applies an individual deny without changing the shared role", () => {
    const sharedRole = { baseRole: "warehouse", isActive: true, permissions: resolvePermissions("warehouse", null), operationPolicy: policy(paths[0]!) };
    const denied = account({ version: 1, grants: { [`operation.${paths[0]}`]: false } });
    denied.customRoleId = 9;
    expect(canonicalOperationAllowed(storedOperationUser(denied, sharedRole), paths[0]!)).toBe(false);
    const colleague = account(); colleague.customRoleId = 9;
    expect(canonicalOperationAllowed(storedOperationUser(colleague, sharedRole), paths[0]!)).toBe(true);
    expect(sharedRole.operationPolicy.grants[`operation.${paths[0]}`]).toBe(true);
  });

  it("requires independent source-selection authority instead of request permission", () => {
    const requester = storedOperationUser(account(policy("supplierPayments.requestPayment")));
    expect(canonicalOperationAllowed(requester, "supplierPayments.cashSources")).toBe(false);
    const sourceSelector = storedOperationUser(account(policy("supplierPayments.cashSources")));
    expect(canonicalOperationAllowed(sourceSelector, "supplierPayments.cashSources")).toBe(true);
    expect(canonicalOperationAllowed(sourceSelector, "supplierPayments.requestPayment")).toBe(false);
  });

  it("fails closed for missing/inactive roles and invalid stored policies", () => {
    const user = account(policy(paths[0]!)); user.customRoleId = 9;
    expect(canonicalOperationAllowed(storedOperationUser(user, null), paths[0]!)).toBe(false);
    expect(() => storedOperationUser(account({ version: 1, grants: { "operation.fake.path": true } }))).toThrow();
    expect(() => storedOperationUser({ ...account(), isActive: false })).toThrow();
  });

  it("does not read a different role after an assignment changes during locking", async () => {
    const user = account(policy(paths[0]!)); user.customRoleId = 10;
    const role = { baseRole: "warehouse", isActive: true, permissions: {}, operationPolicy: policy(paths[0]!) };
    await expect(loadOperationUserTx(fakeTx([[{ customRoleId: 9 }], [role], [user]]), 4)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("retains owner invariant and refuses protected/unknown proof minting", () => {
    expect(storedOperationUser({ ...account(policy()), isOwner: true }).role).toBe("admin");
    expect(routeOperationAuthority({ ...storedOperationUser(account(policy())), id: 4 }, "fake.path")).toBeUndefined();
  });

  it("normalizes the persisted owner before comparing an older base-role actor", async () => {
    const owner = { ...account(policy()), role: "manager", isOwner: true };
    await expect(assertOperationAuthorityTx(fakeTx([[{ customRoleId: null }], [owner]]),
      { userId: 4, role: "manager", branchId: 1 }, "workOrders.approveControl", true)).resolves.toBe(false);
  });

  it("carries a saved role's atomic denial into an individual canonical override", () => {
    const user = account(policy(paths[0]!)); user.customRoleId = 9;
    const role = { baseRole: "manager", isActive: true, permissions: resolvePermissions("manager", null), operationPolicy: null,
      atomicPermissions: { "pos.return.create": false } };
    expect(canonicalOperationAllowed(storedOperationUser(user, role), "returns.create")).toBe(false);
    expect(canonicalOperationAllowed(storedOperationUser(user, { ...role, atomicPermissions: null }), "returns.create")).toBe(true);
  });

  it("rechecks account expiry before transaction authorization", async () => {
    const expired = { ...account(policy(paths[0]!)), accessExpiresAt: new Date(0) };
    await expect(assertOperationAuthorityTx(fakeTx([[{ customRoleId: null }], [expired]]), { userId: 4 }, paths[0]!, true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(() => storedOperationUser({ ...account(), accessExpiresAt: new Date(Date.now() + 60_000) })).not.toThrow();
  });

  it("continues a nested review step only with its exact guarded parent proof", async () => {
    const parentPath = "digitalCards.sales.approveReviewResolution";
    const saved = account(policy(parentPath));
    const actor = { userId: 4, role: "warehouse", operationAuthority: routeOperationAuthority({ ...storedOperationUser(saved), id: 4 }, parentPath) };
    await expect(assertServiceOperationTx(fakeTx([[{ customRoleId: null }], [saved]]), actor, "digitalCards.sales.approveWriteoff", [parentPath])).resolves.toBe(true);
    await expect(assertServiceOperationTx(fakeTx([]), actor, "digitalCards.sales.approveWriteoff")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(assertServiceOperationTx(fakeTx([[{ customRoleId: null }], [account(policy())]]), actor, "digitalCards.sales.approveWriteoff", [parentPath])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects stale admin or branch snapshots before their service bypasses can run", async () => {
    const current = { ...account(policy(paths[0]!)), branchId: 3 };
    await expect(assertOperationAuthorityTx(fakeTx([[{ customRoleId: null }], [current]]), { userId: 4, role: "admin", branchId: 3 }, paths[0]!, true)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(assertOperationAuthorityTx(fakeTx([[{ customRoleId: null }], [current]]), { userId: 4, role: "warehouse", branchId: 2 }, paths[0]!, true)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(assertOperationAuthorityTx(fakeTx([[{ customRoleId: null }], [current]]), { userId: 4, role: "warehouse", branchId: 3 }, paths[0]!, false)).resolves.toBe(true);
  });
});
