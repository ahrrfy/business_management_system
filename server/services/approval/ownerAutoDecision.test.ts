import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "../__tests__/__testUtils__";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  freshness: vi.fn(async () => "PENDING" as const),
  decideDecision: vi.fn(async () => ({ outcome: "EXECUTED" as const })),
}));

vi.mock("../decisions", () => ({
  sourceForKind: () => ({ list: mocks.list, freshness: mocks.freshness }),
  decideDecision: mocks.decideDecision,
}));

import { autoDecideForActiveOwner } from "./ownerAutoDecision";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateTables(["users", "branches"]);
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({
    id: 1,
    openId: "owner-auto",
    name: "المالك",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
    isOwner: true,
    isActive: true,
  });
});

describe("ownerAutoDecision", () => {
  it("يوجه الطلب الجديد بمعرفه مباشرة ولا يعتمد على قائمة صندوق محدودة", async () => {
    await expect(
      autoDecideForActiveOwner(
        { userId: 1, branchId: 1, role: "admin" },
        { kind: "gifts.request.approve", id: 901, expectedVersion: 7 },
      ),
    ).resolves.toBe(true);

    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.decideDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gifts.request.approve",
        id: 901,
        expectedVersion: 7,
        action: "APPROVE",
      }),
      expect.objectContaining({ userId: 1, isOwner: true, crossBranch: true }),
    );
  });
});
