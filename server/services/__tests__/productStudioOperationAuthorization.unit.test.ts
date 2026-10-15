import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "../../db";
import type { OperationUser } from "@shared/operationPermissions";

const mocks = vi.hoisted(() => ({
  assertOperationAuthorityTx: vi.fn(),
  loadOperationUserTx: vi.fn(),
  task: {} as Record<string, unknown>,
  select: vi.fn(),
}));

vi.mock("../authorization/operationAuthority", async (importActual) => ({
  ...(await importActual<
    typeof import("../authorization/operationAuthority")
  >()),
  assertOperationAuthorityTx: mocks.assertOperationAuthorityTx,
  loadOperationUserTx: mocks.loadOperationUserTx,
}));
vi.mock("../tx", () => ({
  withTx: async (run: (tx: unknown) => Promise<unknown>) =>
    run({ select: mocks.select }),
  requireDb: vi.fn(),
}));

import { routeOperationAuthority } from "../authorization/operationAuthority";
import {
  assertStudioOperationBinding,
  assertStudioOperationTx,
  canAutoApproveStudioTx,
  canStudioPhotographTx,
  isStudioManager,
  type StudioOperationActor,
} from "../authorization/studioOperationAuthority";
import {
  approveStudioTask,
  type ProductStudioActor,
} from "../productStudioService";

function actor(path: string, role = "cashier"): ProductStudioActor {
  const user: OperationUser & { id: number } = {
    id: 20,
    role,
    operationPolicyEnabled: true,
    resolvedOperationPolicy: {
      version: 1,
      grants: { [`operation.${path}`]: true },
    },
  };
  return {
    userId: 20,
    role,
    branchId: 1,
    operationAuthority: routeOperationAuthority(user, path),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertOperationAuthorityTx.mockResolvedValue(true);
  mocks.task = {
    id: 51,
    assignedTo: 8,
    branchId: 1,
    status: "PENDING_REVIEW",
    revision: 1,
    submittedBy: 8,
  };
  mocks.select.mockImplementation(() => {
    const query: Record<string, unknown> = {};
    for (const key of ["from", "where", "limit", "for"])
      query[key] = () => query;
    query.then = (resolve: (rows: unknown[]) => unknown) =>
      Promise.resolve([mocks.task]).then(resolve);
    return query;
  });
});

describe("exact Product Studio delegation reaches business authority", () => {
  it("allows the selected managerial operation without changing the actor role", () => {
    const delegated = actor("productStudio.approve");
    expect(isStudioManager(delegated)).toBe(true);
    expect(delegated.role).toBe("cashier");
    expect(() =>
      assertStudioOperationBinding(delegated, "productStudio.approve"),
    ).not.toThrow();
  });

  it("does not reuse approval for cancellation or account provisioning", () => {
    const delegated = actor("productStudio.approve");
    for (const path of [
      "productStudio.cancel",
      "productStudio.grantStudioAccess",
      "productStudio.createTemporaryPhotographer",
      "productStudio.revokeTemporaryPhotographers",
    ]) {
      expect(() => assertStudioOperationBinding(delegated, path)).toThrow();
    }
  });

  it("does not accept a client-shaped fake proof or another actor's proof", () => {
    const proof = actor("productStudio.approve").operationAuthority;
    expect(
      isStudioManager({
        userId: 21,
        role: "cashier",
        operationAuthority: proof,
      }),
    ).toBe(false);
    const fake = {
      userId: 20,
      role: "cashier",
      operationAuthority: { userId: 20, path: "productStudio.approve" },
    } as StudioOperationActor;
    expect(isStudioManager(fake)).toBe(false);
    expect(() =>
      assertStudioOperationBinding(fake, "productStudio.approve"),
    ).toThrow();
  });

  it("keeps ordinary capture permission separate from managerial authority", () => {
    expect(isStudioManager(actor("productStudio.submitCandidate"))).toBe(false);
    expect(isStudioManager(actor("productStudio.tasks"))).toBe(false);
  });

  it("keeps identical canonical task scopes independent of the base role", () => {
    for (const role of ["cashier", "manager", "admin"]) {
      expect(isStudioManager(actor("productStudio.tasks", role))).toBe(false);
      expect(isStudioManager(actor("productStudio.candidatePreview", role))).toBe(false);
    }
    expect(isStudioManager({ userId: 20, role: "manager" })).toBe(true);
  });

  it("allows branch task review only with a real management proof for the same user", () => {
    const reader = actor("productStudio.tasks");
    reader.managementAuthority = actor(
      "productStudio.approve",
    ).operationAuthority;
    expect(isStudioManager(reader)).toBe(true);
    reader.userId = 21;
    expect(isStudioManager(reader)).toBe(false);
  });

  it("rechecks authority in the actual transaction before the business write", async () => {
    const delegated = actor("productStudio.approve");
    const tx = {} as Tx;
    await assertStudioOperationTx(tx, delegated, "productStudio.approve");
    expect(mocks.assertOperationAuthorityTx).toHaveBeenCalledWith(
      tx,
      delegated,
      "productStudio.approve",
      false,
      delegated.operationAuthority,
    );
  });

  it("stops before reading or writing the task when authority was revoked", async () => {
    mocks.assertOperationAuthorityTx.mockRejectedValueOnce(
      new Error("revoked"),
    );
    await expect(
      approveStudioTask(actor("productStudio.approve"), 51, undefined, 1),
    ).rejects.toThrow("revoked");
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("the selected non-manager reviewer reaches the real business-state guard", async () => {
    await expect(
      approveStudioTask(actor("productStudio.approve"), 51, undefined, 1),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("preserves assigned-branch isolation after delegation", async () => {
    mocks.task.branchId = 2;
    await expect(
      approveStudioTask(actor("productStudio.approve"), 51, undefined, 1),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("preserves independent review for a delegated user's own submission", async () => {
    mocks.task.submittedBy = 20;
    await expect(
      approveStudioTask(actor("productStudio.approve"), 51, undefined, 1),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not auto-publish a delegated reviewer's own quick capture", async () => {
    mocks.loadOperationUserTx.mockResolvedValue({
      role: "cashier",
      operationPolicyEnabled: true,
      resolvedOperationPolicy: {
        version: 1,
        grants: { "operation.productStudio.approve": true },
      },
    });
    expect(
      await canAutoApproveStudioTx(
        {} as Tx,
        actor("productStudio.quickSaveBarcodeProductImage"),
      ),
    ).toBe(false);
  });

  it("retains untouched legacy manager authority without introducing policy reads", async () => {
    const legacy = { userId: 20, role: "manager" };
    expect(isStudioManager(legacy)).toBe(true);
    await assertStudioOperationTx({} as Tx, legacy, "productStudio.approve");
    expect(mocks.assertOperationAuthorityTx).not.toHaveBeenCalled();
  });

  it("validates photographer assignment against the selected task lifecycle", async () => {
    mocks.loadOperationUserTx.mockResolvedValue({
      role: "courier",
      operationPolicyEnabled: true,
      resolvedOperationPolicy: {
        version: 1,
        grants: {
          "operation.productStudio.tasks": true,
          "operation.productStudio.claimByBarcode": true,
          "operation.productStudio.submitCandidate": true,
        },
      },
    });
    expect(await canStudioPhotographTx({} as Tx, 20)).toBe(true);
  });

  it("does not treat an unrelated Studio grant as permission to photograph tasks", async () => {
    mocks.loadOperationUserTx.mockResolvedValue({
      role: "manager",
      operationPolicyEnabled: true,
      resolvedOperationPolicy: {
        version: 1,
        grants: { "operation.productStudio.approve": true },
      },
    });
    expect(await canStudioPhotographTx({} as Tx, 20)).toBe(false);
  });

  it("does not auto-publish under an ordinary admin role when approval was removed", async () => {
    mocks.loadOperationUserTx.mockResolvedValue({
      role: "admin",
      operationPolicyEnabled: true,
      resolvedOperationPolicy: {
        version: 1,
        grants: {
          "operation.productStudio.quickSaveBarcodeProductImage": true,
        },
      },
    });
    expect(
      await canAutoApproveStudioTx(
        {} as Tx,
        actor("productStudio.quickSaveBarcodeProductImage", "admin"),
      ),
    ).toBe(false);
  });

  it("a composite drain does not obtain distribution implicitly", async () => {
    const delegated = actor("productStudio.drainCampaignBacklog");
    mocks.assertOperationAuthorityTx
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("distribution denied"));
    await expect(
      assertStudioOperationTx(
        {} as Tx,
        delegated,
        "productStudio.distributeCampaignTasks",
      ),
    ).rejects.toThrow("distribution denied");
    expect(
      mocks.assertOperationAuthorityTx.mock.calls.map((call) => call[2]),
    ).toEqual([
      "productStudio.drainCampaignBacklog",
      "productStudio.distributeCampaignTasks",
    ]);
  });
});
