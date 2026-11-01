import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { createResourceAdmission } from "../../lib/resourceAdmission";
import {
  createStorefrontAdmission,
  publicBatchCost,
} from "../storefrontAdmission";
import { router, storefrontPublicWriteProcedure } from "../../trpc";
import {
  submitPublicStorefrontReview,
  submitStorefrontProductReview,
} from "../../services/storefrontProductReviewService";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../../db", () => ({ getDb: mocks.getDb }));
vi.mock("../../realtime", () => ({ publishRealtimeEvent: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let n = 0; n < 100 && !check(); n++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(check()).toBe(true);
}

// Use the actual common tRPC root, audit INSERT, review services and notification
// transactions. Only SQL and realtime delivery are synthetic; no provider runs.
const reviewRouter = router({
  storefront: router({
    submitProductReview: storefrontPublicWriteProcedure.mutation(() =>
      submitStorefrontProductReview({
        customerId: 1,
        productId: 1,
        rating: 5,
        comment: "Useful synthetic review",
      }),
    ),
    submitPublicProductReview: storefrontPublicWriteProcedure.mutation(() =>
      submitPublicStorefrontReview({
        productId: 1,
        rating: 5,
        reviewerName: "Synthetic visitor",
        comment: "Useful synthetic review",
      }),
    ),
  }),
});

beforeEach(() => vi.clearAllMocks());

describe("review notification / common audit resource overlap", () => {
  it.each([
    ["submitProductReview", "audit-first"],
    ["submitPublicProductReview", "audit-first"],
    ["submitProductReview", "notifications-first"],
    ["submitPublicProductReview", "notifications-first"],
  ] as const)(
    "%s covers all pending SQL through %s settlement",
    async (procedure, settlement) => {
      const recipients = deferred(),
        audit = deferred();
      const workers = [deferred(), deferred()];
      const pendingSql = new Set<string>();
      const notificationUsers: number[] = [];
      let peakSql = 0;
      let auditAction = "";
      let transactions = 0;
      const holdSql = async (name: string, work: Promise<void>) => {
        pendingSql.add(name);
        peakSql = Math.max(peakSql, pendingSql.size);
        try {
          await work;
        } finally {
          pendingSql.delete(name);
        }
      };
      const database = {
        select: () => ({
          from: (table: unknown) => {
            const rows = async () => {
              if (table === s.users) {
                await recipients.promise;
                return [{ id: 11 }, { id: 12 }];
              }
              if (table === s.products || table === s.onlineOrders)
                return [{ id: 1 }];
              // Disable delivery in the synthetic preference row after the real
              // notification INSERT; keep the transaction and worker code real.
              if (table === s.appNotificationPreferences)
                return [{ approvals: false }];
              throw new Error("Unexpected SELECT in review fixture");
            };
            const query = {
              where: () => query,
              innerJoin: () => query,
              leftJoin: () => query,
              orderBy: () => query,
              limit: rows,
              then: (
                done: (value: unknown) => unknown,
                failed: (error: unknown) => unknown,
              ) => rows().then(done, failed),
            };
            return query;
          },
        }),
        insert: (table: unknown) => ({
          values: async (value: { userId?: number; action?: string }) => {
            if (table === s.storefrontProductReviews) return [{ insertId: 41 }];
            if (table === s.auditLogs) {
              auditAction = value.action!;
              await holdSql("audit", audit.promise);
              return [];
            }
            if (table === s.appNotifications) {
              const index = notificationUsers.length;
              notificationUsers.push(value.userId!);
              await holdSql(
                `notification:${value.userId}`,
                workers[index].promise,
              );
              return [];
            }
            throw new Error("Unexpected INSERT in review fixture");
          },
        }),
        transaction: async (work: (tx: unknown) => Promise<void>) => {
          transactions++;
          await work(database);
        },
      };
      mocks.getDb.mockReturnValue(database);
      const gate = createResourceAdmission({
        mode: "enforce",
        maxActiveCost: 8,
        publicMaxActiveCost: 6,
        readMaxActiveCost: 6,
        orderMaxActiveCost: 2,
        maxQueued: 1,
        maxQueuedCost: 6,
        queueTimeoutMs: 50,
      });
      const path = `storefront.${procedure}`;
      const req = Object.assign(new EventEmitter(), {
        path: `/${path}`,
        baseUrl: "/api/trpc",
        headers: {},
        ip: "127.0.0.1",
      }) as Request;
      const res = Object.assign(new EventEmitter(), {
        setHeader: vi.fn(),
      }) as unknown as Response;
      await new Promise<void>((resolve) =>
        createStorefrontAdmission(gate)(req, res, () => resolve()),
      );
      const reserved = gate.snapshot().activeCost;
      const caller = reviewRouter.createCaller({
        req,
        res,
        user: null,
        sessionId: null,
      } as never);
      let responseSettled = false;
      const response = caller.storefront[procedure]().then((result) => {
        responseSettled = true;
        res.emit("finish");
        return result;
      });
      try {
        await until(() => pendingSql.has("audit"));
        expect(responseSettled).toBe(false);
        recipients.resolve();
        await until(() => pendingSql.size === 3);
        expect(transactions).toBe(2);
        expect(notificationUsers).toEqual([11, 12]);
        expect(auditAction).toBe(`rpc.${path}`);
        expect(publicBatchCost([path])).toEqual({
          lane: "public-read",
          cost: reserved,
        });
        expect(gate.snapshot().activeCost).toBe(reserved);

        if (settlement === "audit-first") {
          audit.resolve();
          expect(await response).toEqual({ ok: true, status: "PENDING" });
          expect(gate.snapshot().activeCost).toBe(reserved);
          workers[0].resolve();
          await until(() => pendingSql.size === 1);
          expect(gate.snapshot().activeCost).toBe(reserved);
          workers[1].resolve();
        } else {
          workers.forEach((worker) => worker.resolve());
          await until(() => pendingSql.size === 1);
          expect(responseSettled).toBe(false);
          expect(gate.snapshot().activeCost).toBe(reserved);
          audit.resolve();
          expect(await response).toEqual({ ok: true, status: "PENDING" });
        }
        await until(() => gate.snapshot().activeCost === 0);
        expect(pendingSql.size).toBe(0);
        // Compare against actual concurrent SQL, not just a literal weight.
        expect(peakSql).toBe(3);
        expect(reserved).toBeGreaterThanOrEqual(peakSql);
      } finally {
        recipients.resolve();
        audit.resolve();
        workers.forEach((worker) => worker.resolve());
        await response;
        await until(() => gate.snapshot().activeCost === 0);
      }
    },
  );
});
