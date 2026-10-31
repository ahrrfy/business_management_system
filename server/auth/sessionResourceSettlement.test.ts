import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { COOKIE_NAME } from "../../shared/const";
import { users } from "../../drizzle/schema";
import { getDb } from "../db";
import { getSessionContext, signSession } from "./session";

vi.mock("../db", () => ({ getDb: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("actual session SQL settlement", () => {
  it.each([true, false])(
    "drains a held SQL sibling before propagating a failed %s users query",
    async (failUser) => {
      vi.stubEnv("JWT_SECRET", "synthetic-session-resource-settlement-only");
      const request = { headers: { "user-agent": "resource-test" } } as Request;
      const token = await signSession(
        1,
        60000,
        request,
        undefined,
        undefined,
        1,
      );
      request.headers.cookie = `${COOKIE_NAME}=${token}`;
      let release!: (rows: never[]) => void;
      const held = new Promise<never[]>((resolve) => {
        release = resolve;
      });
      const failure = new Error("synthetic SQL failure");
      const started: unknown[] = [];
      vi.mocked(getDb).mockReturnValue({
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              limit: () => {
                return {
                  then: (
                    resolve: (rows: never[]) => unknown,
                    reject: (error: unknown) => unknown,
                  ) => {
                    started.push(table);
                    return (
                      (table === users) === failUser
                        ? Promise.reject(failure)
                        : held
                    ).then(resolve, reject);
                  },
                };
              },
            }),
          }),
        }),
      } as unknown as NonNullable<ReturnType<typeof getDb>>);
      let settled = false;
      const outcome = getSessionContext(request).then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      for (let n = 0; n < 30 && started.length !== 2; n++)
        await new Promise((r) => setTimeout(r, 1));
      expect(started).toHaveLength(2);
      await new Promise((r) => setTimeout(r, 5));
      const settledBeforeSibling = settled;
      release([]);
      expect(await outcome).toBe(failure);
      expect(settledBeforeSibling).toBe(false);
      expect(started).toHaveLength(2); // Drizzle thenables must not execute twice while draining.
    },
  );
});
