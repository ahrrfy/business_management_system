import { describe, expect, it } from "vitest";
import { assertSeedPolicy } from "./seedPolicy";

describe("seed policy", () => {
  it("يرفض بذرة العينة من دون تأكيد صريح", () => {
    expect(() => assertSeedPolicy({ SEED_MODE: "sample", ADMIN_PASSWORD: "StrongPass123" })).toThrow(
      "CONFIRM_SAMPLE_DATA_SEED"
    );
  });

  it("يرفض كلمات المرور المنشورة حتى مع التأكيد", () => {
    expect(() =>
      assertSeedPolicy({
        SEED_MODE: "sample",
        CONFIRM_SAMPLE_DATA_SEED: "1",
        ADMIN_PASSWORD: "Admin@12345",
      })
    ).toThrow("صريحة وقوية");
  });

  it("يسمح بعينة مؤكدة وكلمة قوية", () => {
    expect(
      assertSeedPolicy({
        SEED_MODE: "sample",
        CONFIRM_SAMPLE_DATA_SEED: "1",
        ADMIN_PASSWORD: "StrongPass123",
      })
    ).toEqual({ isProd: false, password: "StrongPass123" });
  });

  it("يسمح ببذرة الإنتاج من دون علم العينة لكنه يفرض كلمة قوية", () => {
    expect(assertSeedPolicy({ SEED_MODE: "prod", ADMIN_PASSWORD: "StrongPass123" })).toEqual({
      isProd: true,
      password: "StrongPass123",
    });
    expect(() => assertSeedPolicy({ SEED_MODE: "prod", ADMIN_PASSWORD: "CHANGE_ME_STRONG_PASSWORD" })).toThrow(
      "الإنتاج"
    );
  });
});
