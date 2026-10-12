import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOperationPermission } from "@shared/operationPermissions";
import type { OperationRecordScope } from "@shared/operationPermissions";
import type { Tx } from "../../db";
import {
  loadOperationUserTx,
  routeOperationAuthority,
  type ServiceOperationAuthority,
  type StoredOperationSnapshot,
} from "../authorization/operationAuthority";
import {
  assertDigitalIntentScope,
  digitalIntentCanRecover,
  digitalIntentCanRetry,
  digitalIntentCanUseOtherShift,
  DIGITAL_REVIEW_PARENT,
  loadDigitalIntentScopeTx,
  resolveDigitalIntentScope,
} from "../digitalCards/intentOperationScope";

vi.mock("../authorization/operationAuthority", async (original) => ({
  ...(await original<typeof import("../authorization/operationAuthority")>()),
  loadOperationUserTx: vi.fn(),
}));

const FINALIZE = "digitalCards.sales.finalize";
const RECOVER = "digitalCards.sales.recover";
const CLAIM = "digitalCards.sales.claimExecution";
const actor = (role = "cashier", userId = 7, branchId = 1) => ({
  userId,
  role,
  branchId,
});
const intent = (createdBy = 7, branchId = 1) => ({ createdBy, branchId });
function canonical(
  role: string,
  paths: string[],
  scope: OperationRecordScope = "OWN",
): StoredOperationSnapshot {
  return {
    role,
    branchId: 1,
    operationPolicyEnabled: true,
    resolvedOperationPolicy: {
      version: 1,
      grants: Object.fromEntries(
        paths.map((path) => [getOperationPermission(path)!.key, true]),
      ),
      recordScopes: Object.fromEntries(
        paths.map((path) => [getOperationPermission(path)!.key, scope]),
      ),
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("digital intent exact operation and record scope", () => {
  it.each(["cashier", "manager", "warehouse", "admin"])(
    "applies OWN equally for canonical %s",
    (role) => {
      const authority = resolveDigitalIntentScope(
        canonical(role, [FINALIZE]),
        actor(role),
        FINALIZE,
      );
      expect(() => assertDigitalIntentScope(authority, intent())).not.toThrow();
      expect(() => assertDigitalIntentScope(authority, intent(8))).toThrow(
        /نطاق/,
      );
      expect(digitalIntentCanUseOtherShift(authority)).toBe(false);
    },
  );

  it.each(["cashier", "manager", "warehouse", "admin"])(
    "delegates BRANCH equally for canonical %s",
    (role) => {
      const authority = resolveDigitalIntentScope(
        canonical(role, [CLAIM], "BRANCH"),
        actor(role),
        CLAIM,
      );
      expect(() =>
        assertDigitalIntentScope(authority, intent(8)),
      ).not.toThrow();
      if (role === "admin")
        expect(() =>
          assertDigitalIntentScope(authority, intent(8, 2)),
        ).not.toThrow();
      else
        expect(() => assertDigitalIntentScope(authority, intent(8, 2))).toThrow(
          /نطاق/,
        );
      expect(digitalIntentCanUseOtherShift(authority)).toBe(true);
      expect(digitalIntentCanRetry(authority)).toBe(true);
    },
  );

  it("rejects manager/admin exact-operation denial and non-admin branch assignment drift", () => {
    for (const role of ["manager", "admin"]) {
      expect(() =>
        resolveDigitalIntentScope(canonical(role, []), actor(role), FINALIZE),
      ).toThrow(/التفويض/);
      const changedBranch = () =>
        resolveDigitalIntentScope(
          canonical(role, [FINALIZE], "BRANCH"),
          actor(role, 7, 2),
          FINALIZE,
        );
      if (role === "admin") expect(changedBranch).not.toThrow();
      else expect(changedBranch).toThrow(/تغيّر/);
    }
  });

  it("retains fixed admin cross-branch identity without widening canonical OWN", () => {
    const authority = resolveDigitalIntentScope(
      canonical("admin", [FINALIZE]),
      actor("admin"),
      FINALIZE,
    );
    expect(() =>
      assertDigitalIntentScope(authority, intent(7, 2)),
    ).not.toThrow();
    expect(() => assertDigitalIntentScope(authority, intent(8, 2))).toThrow(
      /نطاق/,
    );
  });

  it("requires independent recovery permission, including its narrower OWN scope", () => {
    const current = canonical("cashier", [FINALIZE, RECOVER], "BRANCH");
    current.resolvedOperationPolicy!.recordScopes![
      getOperationPermission(RECOVER)!.key
    ] = "OWN";
    const authority = resolveDigitalIntentScope(current, actor(), FINALIZE);
    expect(digitalIntentCanRecover(authority, intent())).toBe(true);
    expect(digitalIntentCanRecover(authority, intent(8))).toBe(false);
    const ordinary = resolveDigitalIntentScope(
      canonical("manager", [FINALIZE], "BRANCH"),
      actor("manager"),
      FINALIZE,
    );
    expect(digitalIntentCanRecover(ordinary, intent())).toBe(false);
  });

  it("does not turn a retry grant into a recovery grant", () => {
    const authority = resolveDigitalIntentScope(
      canonical("cashier", [CLAIM]),
      actor(),
      CLAIM,
    );
    expect(digitalIntentCanRetry(authority)).toBe(true);
    expect(digitalIntentCanRecover(authority, intent())).toBe(false);
  });

  it("continues a guarded recovery without an unrelated finalize grant", () => {
    const current = canonical("cashier", [RECOVER], "BRANCH");
    const approver = {
      ...actor(),
      operationAuthority: routeOperationAuthority(
        { ...current, id: 7 },
        RECOVER,
      ),
    };
    const authority = resolveDigitalIntentScope(current, approver, FINALIZE, [
      RECOVER,
      DIGITAL_REVIEW_PARENT,
    ]);
    expect(authority.path).toBe(RECOVER);
    expect(() => assertDigitalIntentScope(authority, intent(8))).not.toThrow();
    expect(digitalIntentCanRecover(authority, intent(8))).toBe(true);
    expect(() => resolveDigitalIntentScope(current, actor(), FINALIZE)).toThrow(
      /التفويض/,
    );
  });

  it("binds OWN to the actual approver, independently of original accounting attribution", () => {
    const current = canonical("cashier", [RECOVER]);
    const approver = {
      ...actor("cashier", 9),
      operationAuthority: routeOperationAuthority(
        { ...current, id: 9 },
        RECOVER,
      ),
    };
    const authority = resolveDigitalIntentScope(current, approver, FINALIZE, [
      RECOVER,
    ]);
    expect(authority.userId).toBe(9);
    expect(() => assertDigitalIntentScope(authority, intent(7))).toThrow(
      /نطاق/,
    );
    expect(() => assertDigitalIntentScope(authority, intent(9))).not.toThrow();
  });

  it("accepts only the guarded review parent and preserves its existing branch boundary", () => {
    const current = canonical("cashier", [DIGITAL_REVIEW_PARENT], "BRANCH");
    const reviewer = {
      ...actor(),
      operationAuthority: routeOperationAuthority(
        { ...current, id: 7 },
        DIGITAL_REVIEW_PARENT,
      ),
    };
    const authority = resolveDigitalIntentScope(current, reviewer, RECOVER, [
      DIGITAL_REVIEW_PARENT,
    ]);
    expect(() => assertDigitalIntentScope(authority, intent(8))).not.toThrow();
    expect(() => assertDigitalIntentScope(authority, intent(8, 2))).toThrow(
      /نطاق/,
    );
    expect(() => resolveDigitalIntentScope(current, reviewer, CLAIM)).toThrow(
      /التفويض/,
    );
  });

  it("rejects fabricated and other-user continuation proofs", () => {
    const current = canonical("cashier", [RECOVER], "BRANCH");
    const fake = { userId: 7, path: RECOVER } as ServiceOperationAuthority;
    const otherUser = routeOperationAuthority({ ...current, id: 8 }, RECOVER);
    for (const operationAuthority of [fake, otherUser]) {
      expect(() =>
        resolveDigitalIntentScope(
          current,
          { ...actor(), operationAuthority },
          FINALIZE,
          [RECOVER],
        ),
      ).toThrow(/التفويض/);
    }
  });

  it("preserves NULL-policy cashier, manager and global-admin behavior", () => {
    for (const role of ["cashier", "manager", "admin"]) {
      const authority = resolveDigitalIntentScope(
        { role, branchId: 1 },
        actor(role),
        CLAIM,
      );
      if (role === "cashier")
        expect(() => assertDigitalIntentScope(authority, intent(8))).toThrow(
          /نطاق/,
        );
      else
        expect(() =>
          assertDigitalIntentScope(authority, intent(8)),
        ).not.toThrow();
      expect(digitalIntentCanRetry(authority)).toBe(role !== "cashier");
      expect(digitalIntentCanRecover(authority, intent())).toBe(
        role !== "cashier",
      );
      if (role === "admin")
        expect(() =>
          assertDigitalIntentScope(authority, intent(8, 2)),
        ).not.toThrow();
      else
        expect(() => assertDigitalIntentScope(authority, intent(7, 2))).toThrow(
          /نطاق/,
        );
    }
  });

  it("preserves owner authority when the stored base role differs from normalized admin", () => {
    const authority = resolveDigitalIntentScope(
      { role: "admin", isOwner: true, branchId: 1 },
      { ...actor("manager"), isOwner: true },
      RECOVER,
      [],
      false,
    );
    expect(() =>
      assertDigitalIntentScope(authority, intent(8, 2)),
    ).not.toThrow();
    expect(digitalIntentCanRecover(authority, intent(8, 2))).toBe(true);
  });

  it("preserves fixed owner authority and rejects missing canonical branch assignments", () => {
    const owner = resolveDigitalIntentScope(
      { role: "admin", isOwner: true, branchId: null },
      actor("admin", 7, 0),
      FINALIZE,
    );
    expect(() => assertDigitalIntentScope(owner, intent(8, 2))).not.toThrow();
    const current = {
      ...canonical("cashier", [FINALIZE], "BRANCH"),
      branchId: null,
    };
    const authority = resolveDigitalIntentScope(
      current,
      actor("cashier", 7, 0),
      FINALIZE,
    );
    expect(() => assertDigitalIntentScope(authority, intent())).toThrow(/نطاق/);
  });

  it("loads fresh grants before each service decision and rejects revoked parent authority", async () => {
    const granted = canonical("cashier", [RECOVER], "BRANCH");
    const reviewer = {
      ...actor(),
      operationAuthority: routeOperationAuthority(
        { ...granted, id: 7 },
        RECOVER,
      ),
    };
    vi.mocked(loadOperationUserTx)
      .mockResolvedValueOnce(granted)
      .mockResolvedValueOnce(canonical("cashier", []));
    const tx = {} as Tx;
    await expect(
      loadDigitalIntentScopeTx(tx, reviewer, FINALIZE, [RECOVER]),
    ).resolves.toMatchObject({ path: RECOVER });
    await expect(
      loadDigitalIntentScopeTx(tx, reviewer, FINALIZE, [RECOVER]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(loadOperationUserTx).toHaveBeenCalledTimes(2);
    expect(loadOperationUserTx).toHaveBeenCalledWith(tx, 7);
  });
});
