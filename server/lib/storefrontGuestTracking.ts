import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

function trackingSecret(): string {
  const secret = process.env.BARCODE_SECRET;
  if (!secret) {
    throw new Error("BARCODE_SECRET غير مُعيَّن لتوقيع تتبّع المتجر");
  }
  return secret;
}

function trackingMac(
  domain: string,
  publicId: string,
  expiresAtSeconds: number,
): string {
  return createHmac("sha256", trackingSecret())
    .update(`${domain}|${publicId}|${expiresAtSeconds}`)
    .digest("base64url");
}

export function buildStorefrontGuestTrackingToken(
  domain: string,
  publicId: string,
  expiresAt: Date,
): string {
  const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1000);
  return `${publicId}.${expiresAtSeconds.toString(36)}.${trackingMac(domain, publicId, expiresAtSeconds)}`;
}

export function hashStorefrontGuestTrackingToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function parseAndVerifyStorefrontGuestTrackingToken(
  domain: string,
  token: string,
): {
  publicId: string;
  tokenHash: string;
  expiresAtSeconds: number;
} | null {
  const normalized = token.trim();
  const [publicId, expiryBase36, receivedMac, extra] = normalized.split(".");
  if (
    extra != null ||
    !/^[a-f0-9]{32}$/.test(publicId ?? "") ||
    !/^[a-z0-9]{1,13}$/.test(expiryBase36 ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(receivedMac ?? "")
  ) {
    return null;
  }
  const expiresAtSeconds = Number.parseInt(expiryBase36, 36);
  if (
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds <= Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  const expected = Buffer.from(
    trackingMac(domain, publicId, expiresAtSeconds),
    "utf8",
  );
  const received = Buffer.from(receivedMac, "utf8");
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    return null;
  }
  return {
    publicId,
    tokenHash: hashStorefrontGuestTrackingToken(normalized),
    expiresAtSeconds,
  };
}
