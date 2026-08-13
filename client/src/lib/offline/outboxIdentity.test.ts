import { describe, expect, it } from "vitest";
import {
  LEGACY_OUTBOX_REVIEW_MESSAGE,
  outboxIdentityDisposition,
  partitionOutboxByIdentity,
} from "./outboxIdentity";

describe("offline outbox identity isolation", () => {
  it("allows only the employee who captured the cash to auto-replay it", () => {
    expect(outboxIdentityDisposition(11, 11)).toBe("PROCESS");
    expect(outboxIdentityDisposition(11, 22)).toBe("SKIP_OTHER_USER");
  });

  it("fails closed when there is no authenticated employee", () => {
    expect(outboxIdentityDisposition(11, null)).toBe("BLOCK_NO_SESSION");
  });

  it("quarantines legacy rows whose capturing employee is unknown", () => {
    expect(outboxIdentityDisposition(undefined, 22)).toBe("QUARANTINE_LEGACY");
    expect(outboxIdentityDisposition(null, 22)).toBe("QUARANTINE_LEGACY");
    expect(LEGACY_OUTBOX_REVIEW_MESSAGE).toMatch(/مراجعة/);
  });

  it("keeps another employee's earlier row untouched while selecting the current employee's cash", () => {
    const other = { id: "other", capturedByUserId: 11 };
    const legacy = { id: "legacy", capturedByUserId: null };
    const mine = { id: "mine", capturedByUserId: 22 };

    const plan = partitionOutboxByIdentity([other, legacy, mine], 22);

    expect(plan.replayable).toEqual([mine]);
    expect(plan.legacy).toEqual([legacy]);
  });
});
