import { EventEmitter } from "node:events";
import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  verifySession: vi.fn(),
  acquireTenantDb: vi.fn(),
  resolveCompanyById: vi.fn(),
  resolveCompanyByCode: vi.fn(),
}));

vi.mock("../../auth/session", () => ({ verifySession: stubs.verifySession }));
vi.mock("../../db", () => ({
  acquireTenantDb: stubs.acquireTenantDb,
  isMultiTenantModeActive: () => true,
}));
vi.mock("../registry", () => ({
  resolveCompanyById: stubs.resolveCompanyById,
  resolveCompanyByCode: stubs.resolveCompanyByCode,
}));
vi.mock("../../logger", () => ({ logger: { warn: vi.fn() } }));

import { tenancyMiddleware } from "../expressMiddleware";

type RequestStub = EventEmitter & {
  headers: { cookie: string };
  params: Record<string, string>;
  aborted: boolean;
  destroyed: boolean;
};

type ResponseStub = EventEmitter & {
  destroyed: boolean;
  writableEnded: boolean;
  headersSent: boolean;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

function requestStub(): RequestStub {
  return Object.assign(new EventEmitter(), {
    headers: { cookie: "app_session_id=test" },
    params: {},
    aborted: false,
    destroyed: false,
  });
}

function responseStub(): ResponseStub {
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    status: vi.fn(),
    json: vi.fn(),
    send: vi.fn(),
  });
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.verifySession.mockResolvedValue({ companyId: 7 });
  stubs.resolveCompanyById.mockResolvedValue({ id: 7 });
});

describe("tenant middleware lease lifecycle", () => {
  it("releases and stops when the client aborts before a delayed acquisition completes", async () => {
    let resolveLease!: (lease: { db: object; release: () => void }) => void;
    const release = vi.fn();
    stubs.acquireTenantDb.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLease = resolve;
        }),
    );
    const req = requestStub();
    const res = responseStub();
    const next = vi.fn() as NextFunction;

    const handling = tenancyMiddleware()(req as unknown as Request, res as unknown as Response, next);
    await vi.waitFor(() => expect(stubs.acquireTenantDb).toHaveBeenCalledWith(7));
    req.aborted = true;
    req.destroyed = true;
    res.destroyed = true;
    req.emit("aborted");
    res.emit("close");
    resolveLease({ db: {}, release });
    await handling;

    expect(release).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it("holds a normal request lease until finish and releases it exactly once", async () => {
    const release = vi.fn();
    stubs.acquireTenantDb.mockResolvedValueOnce({ db: {}, release });
    const req = requestStub();
    const res = responseStub();
    const next = vi.fn() as NextFunction;

    await tenancyMiddleware()(req as unknown as Request, res as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    res.emit("finish");
    res.emit("close");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns 503 instead of silently degrading a pool-capacity failure to logout", async () => {
    stubs.acquireTenantDb.mockRejectedValueOnce(new Error("Tenant DB pool capacity is busy"));
    const req = requestStub();
    const res = responseStub();
    const next = vi.fn() as NextFunction;

    await tenancyMiddleware()(req as unknown as Request, res as unknown as Response, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: "company database temporarily unavailable" });
    expect(next).not.toHaveBeenCalled();
  });
});
