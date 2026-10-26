import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_DELETION_DISCLOSURE,
  ACCOUNT_DELETION_RETENTION_DAYS,
  confirmAndDeleteStorefrontAccountStep,
  extractIraqiPhoneLocalInput,
  isFirebaseNativeUnavailableError,
  isMobilePhoneOtpAvailable,
  sendAccountDeletionOtpStep,
} from "@/lib/account-deletion";

const mobileRoot = resolve(__dirname, "..");

describe("Mobile in-app OTP account deletion (app/(tabs)/account.tsx & lib/account-deletion.ts)", () => {
  it("discloses immediate anonymization, session revocation, 365-day accounting retention, and active order/balance preconditions", () => {
    expect(ACCOUNT_DELETION_RETENTION_DAYS).toBe(365);
    expect(ACCOUNT_DELETION_DISCLOSURE.summary).toContain("365");
    expect(ACCOUNT_DELETION_DISCLOSURE.summary).toContain("إخفاء");
    expect(ACCOUNT_DELETION_DISCLOSURE.summary).toContain("الجلسات");
    expect(ACCOUNT_DELETION_DISCLOSURE.preconditions).toContain("طلبات نشطة");
    expect(ACCOUNT_DELETION_DISCLOSURE.preconditions).toContain("أرصدة");

    const accountSrc = readFileSync(resolve(mobileRoot, "app/(tabs)/account.tsx"), "utf8");
    expect(accountSrc).not.toContain("void deleteMyStorefrontAccount;");
    expect(accountSrc).toContain("sendAccountDeletionOtpStep");
    expect(accountSrc).toContain("confirmAndDeleteStorefrontAccountStep");
    expect(accountSrc).toContain('openLegalPage("deleteAccount")');
  });

  it("sends SMS OTP to verified session phone (or typed phone), confirms 6-digit code, calls deleteMyStorefrontAccount, and clears local session", async () => {
    expect(extractIraqiPhoneLocalInput("+9647701234567")).toBe("7701234567");
    expect(extractIraqiPhoneLocalInput("07801112233")).toBe("7801112233");

    const sendOtp = vi.fn(async (phone: string) => `+964${phone.replace(/^\+?964|^0/, "")}`);
    const confirmOtp = vi.fn(async (_code: string) => ({
      firebaseIdToken: "fb-id-token-" + "x".repeat(120),
      phone: "+9647701234567",
    }));
    const deleteAccount = vi.fn(async () => ({
      ok: true as const,
      deletedAt: "2026-10-26T07:55:00.000Z",
    }));
    const clearSession = vi.fn(async () => undefined);

    const otpStep = await sendAccountDeletionOtpStep("+9647701234567", {
      platformOs: "android",
      sendOtp,
    });
    expect(sendOtp).toHaveBeenCalledWith("+9647701234567");
    expect(otpStep).toEqual({
      nextStep: "CODE",
      normalizedPhone: "+9647701234567",
    });

    const deletionResult = await confirmAndDeleteStorefrontAccountStep(" 654321 ", {
      confirmOtp,
      deleteAccount,
      clearSession,
    });

    expect(confirmOtp).toHaveBeenCalledWith("654321");
    expect(deleteAccount).toHaveBeenCalledWith({
      firebaseIdToken: "fb-id-token-" + "x".repeat(120),
    });
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(deletionResult).toEqual({
      ok: true,
      deletedAt: "2026-10-26T07:55:00.000Z",
    });
  });

  it("rejects empty phone or malformed OTP codes before network calls and preserves session when backend rejects active order / unsettled balance", async () => {
    const sendOtp = vi.fn();
    await expect(
      sendAccountDeletionOtpStep("   ", {
        platformOs: "android",
        sendOtp,
      }),
    ).rejects.toThrow(/رقم الهاتف/);
    expect(sendOtp).not.toHaveBeenCalled();

    const confirmOtp = vi.fn(async () => ({
      firebaseIdToken: "fb-token-live",
      phone: "+9647701234567",
    }));
    const deleteAccount = vi.fn(async () => {
      throw new Error("يتعذّر حذف الحساب لوجود طلب نشط قيد التنفيذ");
    });
    const clearSession = vi.fn(async () => undefined);

    await expect(
      confirmAndDeleteStorefrontAccountStep("12ab", {
        confirmOtp,
        deleteAccount,
        clearSession,
      }),
    ).rejects.toThrow(/6 أرقام/);
    expect(confirmOtp).not.toHaveBeenCalled();

    await expect(
      confirmAndDeleteStorefrontAccountStep("123456", {
        confirmOtp,
        deleteAccount,
        clearSession,
      }),
    ).rejects.toThrow(/طلب نشط/);
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("falls back cleanly to web /legal/delete-account when Firebase Phone Auth native module is unavailable (web or Expo Go)", async () => {
    expect(isMobilePhoneOtpAvailable("android")).toBe(true);
    expect(isMobilePhoneOtpAvailable("ios")).toBe(true);
    expect(isMobilePhoneOtpAvailable("web")).toBe(false);

    const webStep = await sendAccountDeletionOtpStep("07701234567", {
      platformOs: "web",
      sendOtp: vi.fn(),
    });
    expect(webStep.nextStep).toBe("WEB_FALLBACK");

    const expoGoError = new Error(
      "هذه النسخة لا تحتوي مكتبة Firebase الأصلية. ثبّت أحدث بناء للتطبيق، لا Expo Go، ثم حاول مرة واحدة.",
    );
    expect(isFirebaseNativeUnavailableError(expoGoError)).toBe(true);

    const expoGoStep = await sendAccountDeletionOtpStep("07701234567", {
      platformOs: "android",
      sendOtp: vi.fn(async () => {
        throw expoGoError;
      }),
    });
    expect(expoGoStep.nextStep).toBe("WEB_FALLBACK");
  });
});
