import { afterEach, describe, expect, it } from "vitest";
import type { DB } from "../../../db";
import { runWithCompany } from "../../../tenancy/context";
import { imageStoreTenantPrefix, studioObjectPrefix } from "../tenantNamespace";

const originalControlUrl = process.env.CONTROL_DATABASE_URL;

afterEach(() => {
  if (originalControlUrl === undefined) delete process.env.CONTROL_DATABASE_URL;
  else process.env.CONTROL_DATABASE_URL = originalControlUrl;
});

describe("image store tenant namespace", () => {
  it("uses distinct stable prefixes for two companies", () => {
    const fakeDb = {} as DB;
    const first = runWithCompany(101, fakeDb, () => studioObjectPrefix("candidate"));
    const second = runWithCompany(202, fakeDb, () => studioObjectPrefix("candidate"));
    expect(first).toBe("company-101/studio/candidate");
    expect(second).toBe("company-202/studio/candidate");
    expect(first).not.toBe(second);
  });

  it("fails closed without company context in multi-tenant mode", () => {
    process.env.CONTROL_DATABASE_URL = "mysql://control.invalid/test";
    expect(() => imageStoreTenantPrefix()).toThrow(/company context is required/);
  });
});
