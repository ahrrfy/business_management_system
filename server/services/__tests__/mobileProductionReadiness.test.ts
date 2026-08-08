import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertMobileProductionReadiness,
  checkMobileProductionReadiness,
} from "../mobileProductionReadiness";

function validEnvironment(): NodeJS.ProcessEnv {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    NODE_ENV: "production",
    SUPER_APP_NATIVE_REQUIRED: "1",
    INTEGRATIONS_ENCRYPTION_KEY: "1".repeat(64),
    TWO_FACTOR_ENFORCEMENT: "on",
    NATIVE_PUSH_ENVIRONMENT: "prod",
    HR_DEVICE_BRIDGE: "1",
    FCM_PROJECT_ID: "alrueya-prod",
    FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: "alrueya-prod",
      client_email: "push@alrueya-prod.iam.gserviceaccount.com",
      private_key: privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
    }),
  };
}

describe("mobile production startup gate", () => {
  it("is inactive outside explicitly required production", () => {
    expect(checkMobileProductionReadiness({ NODE_ENV: "test" })).toEqual({
      required: false,
      ready: true,
      issues: [],
    });
  });

  it("accepts a complete FCM, 2FA and physical-device configuration", () => {
    const env = validEnvironment();
    expect(checkMobileProductionReadiness(env)).toEqual({
      required: true,
      ready: true,
      issues: [],
    });
    expect(() => assertMobileProductionReadiness(env)).not.toThrow();
  });

  it("fails closed with stable codes and never includes secret values", () => {
    const env = validEnvironment();
    env.FCM_SERVICE_ACCOUNT_JSON = "{}";
    env.INTEGRATIONS_ENCRYPTION_KEY = "short-secret";
    env.TWO_FACTOR_ENFORCEMENT = "off";
    env.NATIVE_PUSH_ENVIRONMENT = "dev";
    delete env.HR_DEVICE_BRIDGE;

    const result = checkMobileProductionReadiness(env);
    expect(result.ready).toBe(false);
    expect(result.issues).toEqual([
      "FCM_CONFIGURATION_INVALID",
      "TWO_FACTOR_ENCRYPTION_KEY_INVALID",
      "TWO_FACTOR_ENFORCEMENT_DISABLED",
      "NATIVE_PUSH_ENVIRONMENT_INVALID",
      "ATTENDANCE_DEVICE_BRIDGE_DISABLED",
    ]);
    expect(() => assertMobileProductionReadiness(env)).toThrow(
      "MOBILE_PRODUCTION_NOT_READY:FCM_CONFIGURATION_INVALID",
    );
    expect(JSON.stringify(result)).not.toContain("short-secret");
  });
});
