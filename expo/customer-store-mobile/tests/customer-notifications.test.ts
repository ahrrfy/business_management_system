import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("customer notification identity binding", () => {
  it("يرسل جلسة العميل مع تسجيل الجهاز ويعيد ربط الرمز بعد تحقق الهاتف", () => {
    const notifications = readFileSync(resolve(process.cwd(), "lib/customer-notifications.ts"), "utf8");
    const verifyPhone = readFileSync(resolve(process.cwd(), "app/verify-phone.tsx"), "utf8");
    const checkout = readFileSync(resolve(process.cwd(), "app/checkout.tsx"), "utf8");

    expect(notifications).toContain("loadVerifiedCustomerSession");
    expect(notifications).toContain("customerSessionToken:");
    expect(notifications).toContain("syncCustomerPushIdentity");
    expect(notifications).toContain("importance: Notifications.AndroidImportance.HIGH");
    expect(verifyPhone).toContain("syncCustomerPushIdentity(session.token)");
    expect(checkout).toContain("enableTransactionalPush(customerSessionToken ?? undefined)");
  });
});
