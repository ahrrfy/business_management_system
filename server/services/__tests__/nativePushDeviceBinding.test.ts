import { createHash, generateKeyPairSync } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import {
  NATIVE_CLIENT_ID,
  NATIVE_CLIENT_VERSION,
  NATIVE_PROOF_VERSION,
} from "../../auth/deviceProof";
import { assertNativePushDeviceBinding } from "../../routers/nativePushRouter";

function nativeDeviceRequest() {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = publicKey.export({ format: "der", type: "spki" });
  const thumbprint = createHash("sha256").update(der).digest("base64url");
  return {
    thumbprint,
    req: {
      headers: {
        "x-alrueya-client": NATIVE_CLIENT_ID,
        "x-alrueya-client-version": NATIVE_CLIENT_VERSION,
        "x-alrueya-device-proof-version": NATIVE_PROOF_VERSION,
        "x-alrueya-device-key": der.toString("base64url"),
      },
    },
  };
}

describe("native push device/session binding", () => {
  it("matches the Android SHA-256 SPKI contract vector", () => {
    const publicKey =
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEVEO20KsqYittr-8CcyU3nyjf8Ev9Ptt-luhFicMxX8n4i2FJFeymOu2t3Ab9nCAgbSgz2NWDz92ATp0bWpPWoA";
    const thumbprint = "zpFtQhDQqNaoENCcVMAjOuasISgpZOuCpx4EvZvEi4Y";
    const req = {
      headers: {
        "x-alrueya-client": NATIVE_CLIENT_ID,
        "x-alrueya-client-version": NATIVE_CLIENT_VERSION,
        "x-alrueya-device-proof-version": NATIVE_PROOF_VERSION,
        "x-alrueya-device-key": publicKey,
      },
    };
    expect(assertNativePushDeviceBinding(req, thumbprint)).toBe(thumbprint);
  });

  it("accepts the SHA-256 SPKI base64url thumbprint authenticated by device proof", () => {
    const device = nativeDeviceRequest();
    expect(assertNativePushDeviceBinding(device.req, device.thumbprint)).toBe(
      device.thumbprint,
    );
    expect(device.thumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects a different device thumbprint and non-native sessions", () => {
    const device = nativeDeviceRequest();
    const other = nativeDeviceRequest();
    for (const [req, claimed] of [
      [device.req, other.thumbprint],
      [
        {
          headers: {
            "x-alrueya-device-key": device.req.headers["x-alrueya-device-key"],
          },
        },
        device.thumbprint,
      ],
    ] as const) {
      try {
        assertNativePushDeviceBinding(req, claimed);
        throw new Error("expected binding rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(TRPCError);
        expect((error as TRPCError).code).toBe("FORBIDDEN");
      }
    }
  });
});
