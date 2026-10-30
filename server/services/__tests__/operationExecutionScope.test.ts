import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withGovernanceTx, withTx } from "../tx";
import { withOperationAuthority } from "../authorization/operationExecutionScope";

const db = () => getDb()!;
const policy = (allowed: boolean) => ({ version: 1 as const, grants: {
  "operation.purchases.decideControl": allowed,
  "operation.decisions.decide": true,
} });
const authority = (userId: number) => ({
  actor: { userId, role: "manager", branchId: 1 },
  path: "purchases.decideControl", legacyAllowed: () => true,
});
beforeEach(async () => {
  await db().insert(s.branches).values({ id: 1, name: "Scope test", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "scope-denied", role: "manager", branchId: 1, operationPolicy: policy(false), loginMethod: "local" },
    { id: 2, openId: "scope-allowed", role: "manager", branchId: 1, operationPolicy: policy(true), loginMethod: "local" },
  ]);
});
describe("authorization follows the real domain transaction", () => {
  it("denied underlying operation never reaches the domain writer", async () => {
    let entered = false;
    await expect(withOperationAuthority(authority(1), () => withTx(async tx => {
      entered = true;
      await tx.insert(s.auditLogs).values({ action: "test.domain.write", entityType: "TEST_SCOPE", userId: 1 });
    }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(entered).toBe(false);
    expect(await db().select().from(s.auditLogs)).toHaveLength(0);
  });
  it("revocation after dispatch but before its domain transaction is enforced", async () => {
    await expect(withOperationAuthority(authority(2), async () => {
      await db().update(s.users).set({ operationPolicy: policy(false) }).where(eq(s.users.id, 2));
      return withTx(async () => "must not execute");
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("nested generic permission cannot replace a denied parent operation", async () => {
    await expect(withOperationAuthority(authority(1), () => withOperationAuthority({
      ...authority(1), path: "decisions.decide",
    }, () => withTx(async () => "must not execute")))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("a canonical grant still preserves a fixed source invariant", async () => {
    await expect(withOperationAuthority({ ...authority(2), assertCurrent: () => {
      throw new TRPCError({ code: "FORBIDDEN", message: "Reserved source" });
    } }, () => withTx(async () => "must not execute"))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("governance acquires its own exclusive gate without an outer writer transaction", async () => {
    await expect(withOperationAuthority(authority(2), () => withGovernanceTx(async () => "guarded"))).resolves.toBe("guarded");
  }, 5000);
  it("parallel requests do not inherit each other's authorization context", async () => {
    const results = await Promise.allSettled([
      withOperationAuthority(authority(1), () => withTx(async () => "denied")),
      withOperationAuthority(authority(2), () => withTx(async () => "allowed")),
    ]);
    expect(results[0].status).toBe("rejected");
    expect(results[1]).toEqual({ status: "fulfilled", value: "allowed" });
  });
  it("dispatch scope does not leak into a later unrelated transaction", async () => {
    await withOperationAuthority(authority(1), async () => undefined);
    await expect(withTx(async () => "ordinary transaction")).resolves.toBe("ordinary transaction");
  });
});
