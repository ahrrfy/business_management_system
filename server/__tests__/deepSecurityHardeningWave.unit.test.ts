import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import {
  assertSafeAttachmentUrl,
  isSafeAttachmentUrl,
  sanitizeAttachmentHref,
} from "@shared/attachmentUrl";
import type { RealtimeEvent } from "@shared/realtimeEvents";
import { validateUserForSession } from "../auth/session";
import {
  destroyTxUnderlyingConnection,
  normalizeMysqlLockName,
  withTxNamedLock,
} from "../lib/mysqlNamedLock";
import { SseManager } from "../realtime/sseManager";
import { channelWebhooksRouter } from "../routes/channelWebhooks";
import { rateForDayDetailed } from "../services/attendanceService";
import { scopeHistoricalValuation } from "../services/inventory/valuationSnapshot";
import { protectedProcedure, router } from "../trpc";

describe("shared/attachmentUrl — attachment XSS & scheme hardening (SEC-13)", () => {
  it("rejects dangerous schemes, traversal, and control characters", () => {
    const unsafeInputs = [
      "javascript:alert(document.cookie)",
      "  JaVaScRiPt:alert(1)  ",
      "vbscript:msgbox(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+",
      "http://insecure.example.com/voucher.pdf",
      "/api/files/../../etc/passwd",
      "/uploads/../secret.txt",
      "https://cdn.alarabiya.online/file\u0000.pdf",
    ];

    for (const bad of unsafeInputs) {
      expect(sanitizeAttachmentHref(bad)).toBeNull();
      expect(isSafeAttachmentUrl(bad)).toBe(false);
      expect(() => assertSafeAttachmentUrl(bad, "المرفق")).toThrow();
    }
  });

  it("accepts https URLs, safe internal paths, and raster base64 data URLs", () => {
    const safeInputs = [
      "https://cdn.alarabiya.online/vouchers/2026/rec-10.pdf",
      "/api/img/4421",
      "/uploads/vouchers/scan_01.webp",
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      "data:image/webp;base64,UklGRh4AAABXRUJQ",
    ];

    for (const good of safeInputs) {
      expect(sanitizeAttachmentHref(good)).not.toBeNull();
      expect(isSafeAttachmentUrl(good)).toBe(true);
      expect(() => assertSafeAttachmentUrl(good, "المرفق")).not.toThrow();
    }

    expect(sanitizeAttachmentHref(null)).toBeNull();
    expect(sanitizeAttachmentHref("   ")).toBeNull();
    expect(isSafeAttachmentUrl(null)).toBe(true);
    expect(() => assertSafeAttachmentUrl("")).not.toThrow();
  });
});

describe("server/routes/channelWebhooks — malformed body & challenge hardening (SEC-01)", () => {
  it("returns 400 text/plain instead of crashing when POST body is missing or not a Buffer", async () => {
    const app = express();
    app.use((req, _res, next) => {
      if (req.headers["x-preparsed-json"] === "1") {
        (req as unknown as { body: unknown }).body = { unexpected: "object" };
      }
      next();
    });
    app.use("/webhooks", channelWebhooksRouter());

    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      const { port } = server.address() as AddressInfo;
      for (const endpoint of ["whatsapp", "instagram", "store"]) {
        const resPlain = await fetch(`http://127.0.0.1:${port}/webhooks/${endpoint}`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "not-raw-json-buffer",
        });
        expect(resPlain.status).toBe(400);
        expect(resPlain.headers.get("content-type") ?? "").toContain("text/plain");

        const resPreparsed = await fetch(`http://127.0.0.1:${port}/webhooks/${endpoint}`, {
          method: "POST",
          headers: { "x-preparsed-json": "1" },
        });
        expect(resPreparsed.status).toBe(400);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("server/auth/session & server/trpc — temporary password expiry & change gate (SEC-11)", () => {
  it("rejects sessions whose temporary password has expired while mustChangePassword is true", () => {
    const now = Date.now();
    expect(
      validateUserForSession(
        {
          isActive: true,
          status: "ACTIVE",
          mustChangePassword: true,
          tempPasswordExpiresAt: new Date(now - 5_000),
        },
        null,
        now,
      ),
    ).toBe(false);

    expect(
      validateUserForSession(
        {
          isActive: true,
          status: "ACTIVE",
          mustChangePassword: true,
          tempPasswordExpiresAt: new Date(now + 60_000),
        },
        null,
        now,
      ),
    ).toBe(true);

    expect(
      validateUserForSession(
        {
          isActive: true,
          status: "ACTIVE",
          mustChangePassword: false,
          tempPasswordExpiresAt: new Date(now - 5_000),
        },
        null,
        now,
      ),
    ).toBe(true);
  });

  it("blocks non-exempt protected procedures when mustChangePassword=true while allowing auth.me and auth.changePassword", async () => {
    const prevEnforcement = process.env.TWO_FACTOR_ENFORCEMENT;
    process.env.TWO_FACTOR_ENFORCEMENT = "off";
    try {
      const testRouter = router({
        auth: router({
          me: protectedProcedure.query(() => "ok-me"),
          changePassword: protectedProcedure.query(() => "ok-change"),
        }),
        sales: router({
          list: protectedProcedure.query(() => "should-not-run"),
        }),
      });

      const caller = testRouter.createCaller({
        req: { headers: {}, ip: "127.0.0.1" } as never,
        res: {} as never,
        sessionId: 1,
        nativeClientId: null,
        user: {
          id: 42,
          openId: "local:test",
          name: "Test Cashier",
          username: "cashier42",
          email: null,
          phone: null,
          passwordHash: "x",
          loginMethod: "local",
          role: "cashier",
          customRoleId: null,
          roleLockedByInactiveCustomRole: false,
          branchId: 1,
          isOwner: false,
          isActive: true,
          status: "ACTIVE",
          mustChangePassword: true,
          tempPasswordExpiresAt: new Date(Date.now() + 3_600_000),
          accessExpiresAt: null,
          sessionsValidFrom: new Date(0),
          tokenVersion: 1,
          totpSecretEncrypted: null,
          totpEnabledAt: null,
          totpRecoveryCodesJson: null,
          permissionsOverride: null,
          operationalCaps: null,
          operationPolicy: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastSignedIn: new Date(),
        } as never,
      });

      await expect(caller.auth.me()).resolves.toBe("ok-me");
      await expect(caller.auth.changePassword()).resolves.toBe("ok-change");
      await expect(caller.sales.list()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    } finally {
      if (prevEnforcement === undefined) delete process.env.TWO_FACTOR_ENFORCEMENT;
      else process.env.TWO_FACTOR_ENFORCEMENT = prevEnforcement;
    }
  });
});

describe("server/realtime/sseManager — fail-closed branch/user scoping & eviction (SEC-12)", () => {
  function mockReqRes() {
    const req = new EventEmitter();
    const writes: string[] = [];
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false,
      destroyed: false,
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      end: function () {
        this.writableEnded = true;
      },
    });
    return { req: req as never, res: res as never, writes };
  }

  it("denies branch-scoped events to non-cross-branch clients with null scopedBranchId and enforces userIds + evictUser", () => {
    const mgr = new SseManager();
    const cNullBranch = mockReqRes();
    const cBranch2 = mockReqRes();
    const cOwner = mockReqRes();

    mgr.registerClient({
      id: "c-null",
      userId: 10,
      role: "cashier",
      scopedBranchId: null,
      canCrossBranches: false,
      req: cNullBranch.req,
      res: cNullBranch.res,
    });
    mgr.registerClient({
      id: "c-b2",
      userId: 20,
      role: "manager",
      scopedBranchId: 2,
      canCrossBranches: false,
      req: cBranch2.req,
      res: cBranch2.res,
    });
    mgr.registerClient({
      id: "c-owner",
      userId: 30,
      role: "manager",
      scopedBranchId: null,
      canCrossBranches: true,
      req: cOwner.req,
      res: cOwner.res,
    });

    const branchEvent: RealtimeEvent = {
      id: "evt-1",
      type: "PENDING_APPROVAL_CREATED",
      timestamp: Date.now(),
      payload: { requestId: 99 },
      scope: { branchId: 2, userIds: [10, 20, 30] },
    };

    const delivered = mgr.broadcast(branchEvent);
    expect(delivered).toBe(2);
    expect(cNullBranch.writes).toHaveLength(0);
    expect(cBranch2.writes).toHaveLength(1);
    expect(cOwner.writes).toHaveLength(1);

    const targetedEvent: RealtimeEvent = {
      id: "evt-2",
      type: "APPROVAL_RESOLVED",
      timestamp: Date.now(),
      payload: { requestId: 99 },
      scope: { userIds: [20] },
    };
    expect(mgr.broadcast(targetedEvent)).toBe(1);
    expect(cBranch2.writes).toHaveLength(2);
    expect(cOwner.writes).toHaveLength(1);

    expect(mgr.evictUser(20)).toBe(1);
    expect(mgr.activeCount).toBe(2);
    mgr.evictUser(10);
    mgr.evictUser(30);
    expect(mgr.activeCount).toBe(0);
  });
});

describe("Wave 4 — MySQL named lock safety & Decimal precision invariants", () => {
  it("normalizes overlong lock keys to <= 64 ASCII chars and destroys poisoned connections on RELEASE_LOCK failure", async () => {
    expect(normalizeMysqlLockName("online-customer:upsert")).toBe("online-customer:upsert");
    const overlong = normalizeMysqlLockName(`online-customer:${"9".repeat(90)}`);
    expect(overlong.length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(overlong, "utf8")).toBeLessThanOrEqual(64);

    const destroySpy = vi.fn();
    const fakeTx = {
      session: { client: { destroy: destroySpy } },
      execute: vi
        .fn()
        .mockResolvedValueOnce([[{ locked: 1 }]])
        .mockResolvedValueOnce([[{ released: 0 }]]),
    };

    await expect(
      withTxNamedLock(
        fakeTx as never,
        "online-customer:upsert",
        5,
        () => {
          throw new Error("busy");
        },
        async () => "ok",
      ),
    ).rejects.toThrow(/Failed to release MySQL named lock/);

    expect(destroyTxUnderlyingConnection(fakeTx)).toBe(true);
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it("preserves exact Decimal precision in valuation scoping and attendance rate derivation", () => {
    const scoped = scopeHistoricalValuation(
      {
        source: "LIVE",
        cutoffDate: "2026-11-27",
        totalValue: "999999999999.99",
        stockValue: "999999999999.99",
        inTransitValue: "0.00",
        branches: [
          { branchId: 1, value: "0.10", inTransitValue: "0.20" },
          { branchId: 2, value: "50.00", inTransitValue: "10.00" },
        ],
      },
      1,
    );
    expect(scoped.stockValue).toBe("0.10");
    expect(scoped.inTransitValue).toBe("0.20");
    expect(scoped.totalValue).toBe("0.30");

    const rateInfo = rateForDayDetailed(
      { payType: "monthly", salary: "600000" },
      "2026-11-15",
    );
    expect(rateInfo.basis).toBe("fallbackSchedule");
    expect(rateInfo.rate).toBeGreaterThan(0);
  });
});
