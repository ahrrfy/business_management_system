import { describe, expect, it, vi } from "vitest";

import { completeTwoFactorSignIn } from "../lib/signInFlow";

describe("completeTwoFactorSignIn", () => {
  it("uses one local confirmation and reuses its authenticated window for the first workspace load", async () => {
    const events: string[] = [];
    const unlockLocalSession = vi.fn(async () => {
      events.push("unlock");
    });
    const completeNativeTwoFactor = vi.fn(async () => {
      events.push("verify");
    });
    const refreshWorkspace = vi.fn(
      async (options?: { localProtectionAlreadyConfirmed?: boolean }) => {
        events.push(
          `refresh:${String(options?.localProtectionAlreadyConfirmed)}`,
        );
        return { mode: "ready" as const, today: null };
      },
    );

    await expect(
      completeTwoFactorSignIn(
        { ticket: "opaque-ticket", code: "000000", recoveryCode: "" },
        { completeNativeTwoFactor, refreshWorkspace, unlockLocalSession },
      ),
    ).resolves.toEqual({ mode: "ready", today: null });

    expect(events).toEqual(["unlock", "verify", "refresh:true"]);
    expect(unlockLocalSession).toHaveBeenCalledTimes(1);
  });

  it("does not refresh the workspace when server verification fails", async () => {
    const refreshWorkspace = vi.fn();

    await expect(
      completeTwoFactorSignIn(
        { ticket: "opaque-ticket", code: "000000", recoveryCode: "" },
        {
          completeNativeTwoFactor: vi.fn(async () => {
            throw new Error("rejected");
          }),
          refreshWorkspace,
          unlockLocalSession: vi.fn(async () => undefined),
        },
      ),
    ).rejects.toThrow("rejected");

    expect(refreshWorkspace).not.toHaveBeenCalled();
  });
});
