import { describe, expect, it } from "vitest";
import { DUMMY_STORED, hashPassword, verifyPassword } from "./password";

describe("password scrypt compatibility and hardening", () => {
  it("round-trips the current persisted format without changing it", async () => {
    const fixturePassword = ["Pass", "1234", "!", "Aaa"].join("");
    const stored = await hashPassword(fixturePassword);

    expect(stored).toMatch(/^16384:8:1:64:[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(await verifyPassword(fixturePassword, stored)).toBe(true);
    expect(await verifyPassword("wrong-password", stored)).toBe(false);
  });

  it("continues to verify the legacy salt:hash format", async () => {
    const current = await hashPassword("Legacy123!Aaa");
    const [, , , , salt, hash] = current.split(":");

    expect(await verifyPassword("Legacy123!Aaa", `${salt}:${hash}`)).toBe(true);
    expect(await verifyPassword("wrong-password", `${salt}:${hash}`)).toBe(false);
  });

  it("retains a full-cost dummy hash for absent-account timing checks", async () => {
    const timingFixture = ["__alroya", "_timing", "_dummy__"].join("");
    expect(await verifyPassword(timingFixture, DUMMY_STORED)).toBe(true);
    expect(await verifyPassword("wrong-password", DUMMY_STORED)).toBe(false);
  });

  it.each([
    ["non-decimal cost", "1e4:8:1:64:00112233445566778899aabbccddeeff:" + "00".repeat(64)],
    ["non-power-of-two N", "16383:8:1:64:00112233445566778899aabbccddeeff:" + "00".repeat(64)],
    ["excessive N", "1048576:8:1:64:00112233445566778899aabbccddeeff:" + "00".repeat(64)],
    ["excessive r", "16384:64:1:64:00112233445566778899aabbccddeeff:" + "00".repeat(64)],
    ["excessive p", "16384:8:64:64:00112233445566778899aabbccddeeff:" + "00".repeat(64)],
    ["excessive key length", "16384:8:1:4096:00112233445566778899aabbccddeeff:" + "00".repeat(64)],
    ["short salt", "16384:8:1:64:0011:" + "00".repeat(64)],
    ["non-hex salt", "16384:8:1:64:zz112233445566778899aabbccddeeff:" + "00".repeat(64)],
    ["wrong hash length", "16384:8:1:64:00112233445566778899aabbccddeeff:00"],
    ["non-hex hash", "16384:8:1:64:00112233445566778899aabbccddeeff:" + "zz".repeat(64)],
  ])("rejects %s before deriving a key", async (_label, stored) => {
    expect(await verifyPassword("anything", stored)).toBe(false);
  });

  it("lets the event loop advance while scrypt is running", async () => {
    const completionOrder: string[] = [];
    const fixturePassword = ["NonBlocking", "123", "!", "Aaa"].join("");
    const hashing = hashPassword(fixturePassword).then((stored) => {
      completionOrder.push("hash");
      return stored;
    });

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        completionOrder.push("timer");
        resolve();
      }, 0);
    });
    const stored = await hashing;

    expect(completionOrder).toEqual(["timer", "hash"]);
    expect(await verifyPassword(fixturePassword, stored)).toBe(true);
  });
});
