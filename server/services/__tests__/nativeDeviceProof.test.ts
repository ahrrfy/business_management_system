import {
  createHash,
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EXPO_SUPERAPP_CLIENT_ID,
  EXPO_SUPERAPP_CLIENT_VERSION,
  NATIVE_CHALLENGE_TTL_MS,
  NativeDeviceProofError,
  buildNativeRegistrationMessage,
  buildNativeRequestMessage,
  createNativeSessionMarker,
  issueNativeDeviceChallenge,
  verifyNativeDeviceRegistration,
  verifyNativeRequestProof,
} from "../../auth/deviceProof";
import { signSession, verifySession } from "../../auth/session";

const originalSecret = process.env.JWT_SECRET;

type DeviceKeys = {
  privateKey: KeyObject;
  publicKeyHeader: string;
  thumbprint: string;
};

function createDeviceKeys(): DeviceKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey,
    publicKeyHeader: der.toString("base64url"),
    thumbprint: createHash("sha256").update(der).digest("base64url"),
  };
}

function signature(privateKey: KeyObject, message: string): string {
  return signMessage(
    "sha256",
    Buffer.from(message, "utf8"),
    privateKey,
  ).toString("base64url");
}

function baseHeaders(
  device: DeviceKeys,
  clientId = "android-native",
): Record<string, string> {
  return {
    "x-alrueya-client": clientId,
    "x-alrueya-client-version":
      clientId === EXPO_SUPERAPP_CLIENT_ID ? EXPO_SUPERAPP_CLIENT_VERSION : "2",
    "x-alrueya-device-proof-version": "1",
    "x-alrueya-device-key": device.publicKeyHeader,
  };
}

function signedRequest(input: {
  device: DeviceKeys;
  sessionToken: string;
  clientId?: "android-native" | typeof EXPO_SUPERAPP_CLIENT_ID;
  method?: string;
  target?: string;
  body?: unknown;
  timestamp: number;
  counter: number;
  nonce?: string;
}) {
  const method = input.method ?? "POST";
  const target = input.target ?? "/api/trpc/superApp.dashboard?batch=1";
  const body = input.body ?? { "0": { json: { scope: "self" } } };
  const bodyText =
    method === "GET" || method === "HEAD" ? "" : JSON.stringify(body);
  const nonce = input.nonce ?? Buffer.alloc(16, 7).toString("base64url");
  const message = buildNativeRequestMessage({
    timestamp: input.timestamp,
    counter: input.counter,
    nonce,
    sessionToken: input.sessionToken,
    method,
    target,
    body: bodyText,
  });
  return {
    method,
    originalUrl: target,
    url: target,
    body,
    headers: {
      ...baseHeaders(input.device, input.clientId),
      "x-alrueya-device-timestamp": String(input.timestamp),
      "x-alrueya-device-counter": String(input.counter),
      "x-alrueya-device-nonce": nonce,
      "x-alrueya-device-signature": signature(input.device.privateKey, message),
    },
  };
}

beforeAll(() => {
  process.env.JWT_SECRET =
    "native-device-proof-test-secret-at-least-thirty-two-bytes";
});

afterAll(() => {
  if (originalSecret == null) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});

describe("native device proof", () => {
  it("registers only the public key that signed the short-lived challenge", async () => {
    const now = Date.now();
    const device = createDeviceKeys();
    const challenge = await issueNativeDeviceChallenge(now);
    const registrationMessage = buildNativeRegistrationMessage(
      challenge.ticket,
      device.thumbprint,
    );
    const registration = await verifyNativeDeviceRegistration(
      {
        headers: {
          ...baseHeaders(device),
          "x-alrueya-device-challenge": challenge.ticket,
          "x-alrueya-device-signature": signature(
            device.privateKey,
            registrationMessage,
          ),
        },
      },
      now,
    );

    expect(registration).toEqual({
      clientId: "android-native",
      keyThumbprint: device.thumbprint,
      sessionMarker: createNativeSessionMarker(0),
    });
  });

  it("admits only the versioned Expo super-app identity under the same device-proof gate", async () => {
    const now = Date.now();
    const device = createDeviceKeys();
    const challenge = await issueNativeDeviceChallenge(now);
    const message = buildNativeRegistrationMessage(
      challenge.ticket,
      device.thumbprint,
    );

    await expect(
      verifyNativeDeviceRegistration(
        {
          headers: {
            ...baseHeaders(device, EXPO_SUPERAPP_CLIENT_ID),
            "x-alrueya-device-challenge": challenge.ticket,
            "x-alrueya-device-signature": signature(device.privateKey, message),
          },
        },
        now,
      ),
    ).resolves.toMatchObject({
      clientId: EXPO_SUPERAPP_CLIENT_ID,
      keyThumbprint: device.thumbprint,
    });

    await expect(
      verifyNativeDeviceRegistration(
        {
          headers: {
            ...baseHeaders(device, EXPO_SUPERAPP_CLIENT_ID),
            "x-alrueya-client-version": "2",
            "x-alrueya-device-challenge": challenge.ticket,
            "x-alrueya-device-signature": signature(device.privateKey, message),
          },
        },
        now,
      ),
    ).rejects.toBeInstanceOf(NativeDeviceProofError);
  });

  it("rejects expired registration challenges", async () => {
    const issuedAt = Date.now();
    const device = createDeviceKeys();
    const challenge = await issueNativeDeviceChallenge(issuedAt);
    const message = buildNativeRegistrationMessage(
      challenge.ticket,
      device.thumbprint,
    );

    await expect(
      verifyNativeDeviceRegistration(
        {
          headers: {
            ...baseHeaders(device),
            "x-alrueya-device-challenge": challenge.ticket,
            "x-alrueya-device-signature": signature(device.privateKey, message),
          },
        },
        issuedAt + NATIVE_CHALLENGE_TTL_MS + 6_000,
      ),
    ).rejects.toBeInstanceOf(NativeDeviceProofError);
  });

  it("rejects registration when a different private key signs the public key", async () => {
    const now = Date.now();
    const claimedDevice = createDeviceKeys();
    const attacker = createDeviceKeys();
    const challenge = await issueNativeDeviceChallenge(now);
    const message = buildNativeRegistrationMessage(
      challenge.ticket,
      claimedDevice.thumbprint,
    );

    await expect(
      verifyNativeDeviceRegistration(
        {
          headers: {
            ...baseHeaders(claimedDevice),
            "x-alrueya-device-challenge": challenge.ticket,
            "x-alrueya-device-signature": signature(
              attacker.privateKey,
              message,
            ),
          },
        },
        now,
      ),
    ).rejects.toBeInstanceOf(NativeDeviceProofError);
  });

  it("accepts one request then rejects replay and session-key mismatch", () => {
    const now = Date.now();
    const device = createDeviceKeys();
    const otherDevice = createDeviceKeys();
    const token = "header.payload.signature";
    const request = signedRequest({
      device,
      sessionToken: token,
      timestamp: now,
      counter: now,
    });

    const accepted = verifyNativeRequestProof({
      req: request,
      sessionToken: token,
      expectedKeyThumbprint: device.thumbprint,
      currentMarker: createNativeSessionMarker(0),
      nowMs: now,
    });
    expect(accepted.nextMarker).toBe(createNativeSessionMarker(now));

    expect(() =>
      verifyNativeRequestProof({
        req: request,
        sessionToken: token,
        expectedKeyThumbprint: device.thumbprint,
        currentMarker: accepted.nextMarker,
        nowMs: now,
      }),
    ).toThrow(NativeDeviceProofError);

    expect(() =>
      verifyNativeRequestProof({
        req: request,
        sessionToken: token,
        expectedKeyThumbprint: otherDevice.thumbprint,
        currentMarker: createNativeSessionMarker(0),
        nowMs: now,
      }),
    ).toThrow(NativeDeviceProofError);
  });

  it("keeps a signed request in the client profile that issued its session", () => {
    const now = Date.now();
    const device = createDeviceKeys();
    const token = "header.payload.signature";
    const expoRequest = signedRequest({
      device,
      sessionToken: token,
      clientId: EXPO_SUPERAPP_CLIENT_ID,
      timestamp: now,
      counter: now,
    });

    expect(
      verifyNativeRequestProof({
        req: expoRequest,
        sessionToken: token,
        expectedKeyThumbprint: device.thumbprint,
        currentMarker: createNativeSessionMarker(
          0,
          EXPO_SUPERAPP_CLIENT_ID,
        ),
        nowMs: now,
      }).nextMarker,
    ).toBe(createNativeSessionMarker(now, EXPO_SUPERAPP_CLIENT_ID));

    expect(() =>
      verifyNativeRequestProof({
        req: {
          ...expoRequest,
          headers: {
            ...expoRequest.headers,
            "x-alrueya-client": "android-native",
            "x-alrueya-client-version": "2",
          },
        },
        sessionToken: token,
        expectedKeyThumbprint: device.thumbprint,
        currentMarker: createNativeSessionMarker(
          0,
          EXPO_SUPERAPP_CLIENT_ID,
        ),
        nowMs: now,
      }),
    ).toThrow(NativeDeviceProofError);
  });

  it("binds the signature to the exact route, body, and session token", () => {
    const now = Date.now();
    const device = createDeviceKeys();
    const token = "header.payload.signature";
    const request = signedRequest({
      device,
      sessionToken: token,
      timestamp: now,
      counter: now,
    });

    for (const altered of [
      { ...request, originalUrl: "/api/trpc/payroll.list?batch=1" },
      { ...request, body: { "0": { json: { scope: "all" } } } },
    ]) {
      expect(() =>
        verifyNativeRequestProof({
          req: altered,
          sessionToken: token,
          expectedKeyThumbprint: device.thumbprint,
          currentMarker: createNativeSessionMarker(0),
          nowMs: now,
        }),
      ).toThrow(NativeDeviceProofError);
    }

    expect(() =>
      verifyNativeRequestProof({
        req: request,
        sessionToken: "stolen.different.cookie",
        expectedKeyThumbprint: device.thumbprint,
        currentMarker: createNativeSessionMarker(0),
        nowMs: now,
      }),
    ).toThrow(NativeDeviceProofError);
  });

  it("requires a fresh proof for logout and rejects replay", () => {
    const now = Date.now();
    const device = createDeviceKeys();
    const token = "header.payload.signature";
    const request = signedRequest({
      device,
      sessionToken: token,
      timestamp: now,
      counter: now,
      target: "/api/trpc/auth.logout?batch=1",
      body: { "0": { json: null } },
    });

    const accepted = verifyNativeRequestProof({
      req: request,
      sessionToken: token,
      expectedKeyThumbprint: device.thumbprint,
      currentMarker: createNativeSessionMarker(0),
      nowMs: now,
    });
    expect(() =>
      verifyNativeRequestProof({
        req: request,
        sessionToken: token,
        expectedKeyThumbprint: device.thumbprint,
        currentMarker: accepted.nextMarker,
        nowMs: now,
      }),
    ).toThrow(NativeDeviceProofError);
  });

  it("keeps browser sessions compatible while native declarations fail closed", async () => {
    const browserRequest = {
      headers: { "user-agent": "Mozilla/5.0 browser-test" },
      socket: { remoteAddress: "127.0.0.1" },
    };
    const browserToken = await signSession(41, 60_000, browserRequest);
    expect(await verifySession(browserToken, browserRequest)).toMatchObject({
      uid: 41,
    });
    expect(
      await verifySession(browserToken, {
        ...browserRequest,
        headers: {
          ...browserRequest.headers,
          "x-alrueya-client": "android-native",
          "x-alrueya-client-version": "2",
          "x-alrueya-device-proof-version": "1",
        },
      }),
    ).toBeNull();

    const device = createDeviceKeys();
    const nativeToken = await signSession(
      42,
      60_000,
      undefined,
      undefined,
      undefined,
      9,
      device.thumbprint,
      EXPO_SUPERAPP_CLIENT_ID,
    );
    expect(await verifySession(nativeToken, browserRequest)).toBeNull();
    expect(
      await verifySession(nativeToken, {
        headers: {
          "x-alrueya-client": EXPO_SUPERAPP_CLIENT_ID,
          "x-alrueya-client-version": EXPO_SUPERAPP_CLIENT_VERSION,
          "x-alrueya-device-proof-version": "1",
        },
        socket: {},
      }),
    ).toMatchObject({ uid: 42, dpc: EXPO_SUPERAPP_CLIENT_ID });
    expect(
      await verifySession(nativeToken, {
        headers: {
          "x-alrueya-client": "android-native",
          "x-alrueya-client-version": "2",
          "x-alrueya-device-proof-version": "1",
        },
        socket: {},
      }),
    ).toBeNull();
  });
});
