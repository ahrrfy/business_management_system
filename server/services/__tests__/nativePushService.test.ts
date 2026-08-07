import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetNativePushCachesForTests,
  hashFcmInstallationId,
  NativePushConfigurationError,
  NativePushValidationError,
  normalizeNativePushPayload,
  readFcmCredentials,
  sendFcmDataMessage,
  validateDevicePublicKeyHash,
  validateFcmInstallationId,
  validateNativeDestination,
} from "../nativePushService";

const savedCredentials = process.env.FCM_SERVICE_ACCOUNT_JSON;
const savedProjectId = process.env.FCM_PROJECT_ID;

describe("native push security contract", () => {
  beforeEach(() => {
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
    delete process.env.FCM_PROJECT_ID;
    __resetNativePushCachesForTests();
  });

  afterEach(() => {
    if (savedCredentials === undefined)
      delete process.env.FCM_SERVICE_ACCOUNT_JSON;
    else process.env.FCM_SERVICE_ACCOUNT_JSON = savedCredentials;
    if (savedProjectId === undefined) delete process.env.FCM_PROJECT_ID;
    else process.env.FCM_PROJECT_ID = savedProjectId;
    __resetNativePushCachesForTests();
  });

  it("validates Firebase Installation IDs and persists only a deterministic hash for lookup", () => {
    const installationId = "cYx_AbCdEf1234567890-_";
    expect(validateFcmInstallationId(installationId)).toBe(installationId);
    expect(hashFcmInstallationId(installationId)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashFcmInstallationId(installationId)).not.toContain(installationId);
    expect(() => validateFcmInstallationId("short id with spaces")).toThrow(
      NativePushValidationError,
    );
    expect(() => validateFcmInstallationId("x".repeat(129))).toThrow(
      NativePushValidationError,
    );
    const deviceThumbprint = Buffer.alloc(32, 0).toString("base64url");
    expect(validateDevicePublicKeyHash(deviceThumbprint)).toBe(
      deviceThumbprint,
    );
    expect(
      validateDevicePublicKeyHash(deviceThumbprint.toLowerCase()),
    ).not.toBe(deviceThumbprint);
    expect(() => validateDevicePublicKeyHash("a".repeat(64))).toThrow(
      NativePushValidationError,
    );
  });

  it("accepts typed native destinations and rejects web, intent and ambiguous URLs", () => {
    expect(validateNativeDestination("alrueya://app/home")).toBe(
      "alrueya://app/home",
    );
    expect(
      validateNativeDestination("alrueya://app/module/tasks/view/task_42"),
    ).toBe("alrueya://app/module/tasks/view/task_42");
    for (const unsafe of [
      "https://example.com/payroll",
      "http://127.0.0.1/admin",
      "intent://app/#Intent;scheme=alrueya;end",
      "alrueya://evil/home",
      "alrueya://app/home?redirect=https://evil.example",
      "alrueya://app/module/tasks/view",
      "alrueya://app/module/tasks/browse/task_42",
    ]) {
      expect(() => validateNativeDestination(unsafe), unsafe).toThrow(
        NativePushValidationError,
      );
    }
  });

  it("redacts sensitive text before it reaches FCM", () => {
    const payload = normalizeNativePushPayload({
      notificationId: "salary_2026_08",
      kind: "PAYROLL_READY",
      title: "راتب شهر آب",
      body: "تم إيداع مبلغ الراتب",
      destination: "alrueya://app/module/hr/view/payroll_8",
      urgency: "information",
      sensitive: true,
    });
    expect(payload.title).toBe("تحديث آمن");
    expect(payload.body).toBe("افتح سوبر العربية لعرض التفاصيل.");
    expect(JSON.stringify(payload)).not.toContain("راتب شهر آب");
    expect(JSON.stringify(payload)).not.toContain("تم إيداع مبلغ الراتب");
  });

  it("fails closed when FCM credentials are absent or mismatched", () => {
    expect(() => readFcmCredentials()).toThrow(NativePushConfigurationError);
    process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: "alrueya-prod",
      client_email: "push@alrueya-prod.iam.gserviceaccount.com",
      private_key:
        "-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----\n",
    });
    process.env.FCM_PROJECT_ID = "different-project";
    expect(() => readFcmCredentials()).toThrow(/لا يطابق/);
  });

  it("sends data-only payloads through FCM HTTP v1 without remote URL navigation", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: "alrueya-prod",
      client_email: "push@alrueya-prod.iam.gserviceaccount.com",
      private_key: privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
    });
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        if (String(input).includes("oauth2.googleapis.com")) {
          return new Response(
            JSON.stringify({
              access_token: "access-token-abcdefghijklmnopqrstuvwxyz",
              expires_in: 3600,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({ name: "projects/alrueya-prod/messages/123" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    ) as unknown as typeof fetch;
    const payload = normalizeNativePushPayload({
      notificationId: "approval_42",
      kind: "APPROVAL_REQUIRED",
      title: "موافقة جديدة",
      body: "يوجد طلب بانتظار الإجراء",
      destination: "alrueya://app/approvals",
      urgency: "action",
      sensitive: false,
    });

    const result = await sendFcmDataMessage(
      "cYx_AbCdEf1234567890-_",
      payload,
      fetchMock,
    );

    expect(result.status).toBe("SENT");
    expect(calls).toHaveLength(2);
    const request = JSON.parse(String(calls[1].init?.body)) as {
      message: Record<string, unknown>;
    };
    expect(request.message).toHaveProperty(
      "data.destination",
      "alrueya://app/approvals",
    );
    expect(request.message).not.toHaveProperty("notification");
    expect(request.message).toHaveProperty("fid", "cYx_AbCdEf1234567890-_");
    expect(request.message).not.toHaveProperty("token");
    expect(String(calls[1].init?.body)).not.toContain("https://");
  });
});
