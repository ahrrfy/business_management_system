import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const limit = vi.fn(async () => []);
  const orderBy = vi.fn(() => ({ limit }));
  const whereRead = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where: whereRead }));
  const select = vi.fn(() => ({ from }));
  const whereWrite = vi.fn(async () => ({ affectedRows: 1 }));
  const set = vi.fn(() => ({ where: whereWrite }));
  const update = vi.fn(() => ({ set }));
  return {
    getDb: vi.fn(() => ({ select, update })),
    select,
    update,
    whereWrite,
  };
});
const auditMocks = vi.hoisted(() => ({ logAudit: vi.fn(async () => undefined) }));

vi.mock("../../db", () => ({ getDb: dbMocks.getDb }));
vi.mock("../../services/auditService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/auditService")>()),
  logAudit: auditMocks.logAudit,
}));

import { deliveryRouter } from "../deliveryRouter";

function caller(role: string, permissionsOverride: Record<string, "NONE" | "READ" | "FULL"> | null = null) {
  return deliveryRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: role === "admin" ? 1 : 2,
      role,
      branchId: 1,
      permissionsOverride,
      totpEnabledAt: new Date(),
    },
  } as never);
}

describe("delivery dead-letter authority", () => {
  beforeEach(() => vi.clearAllMocks());

  it("يرفض المدير والدور المخصّص حتى مع store=FULL قبل لمس قاعدة البيانات", async () => {
    for (const denied of [caller("manager"), caller("user", { store: "FULL" })]) {
      await expect(denied.listDeadLetterOutbox({ limit: 20 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(denied.requeueDeadLetter({ id: 7 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }

    expect(dbMocks.select).not.toHaveBeenCalled();
    expect(dbMocks.update).not.toHaveBeenCalled();
    expect(auditMocks.logAudit).toHaveBeenCalledTimes(2);
    expect(auditMocks.logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "FAILURE" }),
    );
  });

  it("يسمح للأدمن وحده بالقراءة وإعادة الطابور مع أثر تدقيق", async () => {
    const admin = caller("admin");

    await expect(admin.listDeadLetterOutbox({ limit: 20 })).resolves.toEqual([]);
    await expect(admin.requeueDeadLetter({ id: 7 })).resolves.toEqual({ requeued: 1 });

    expect(dbMocks.select).toHaveBeenCalledOnce();
    expect(dbMocks.update).toHaveBeenCalledOnce();
    expect(auditMocks.logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "delivery.requeueDeadLetter",
        entityType: "deliveryOutbox",
        entityId: 7,
      }),
    );
  });
});
