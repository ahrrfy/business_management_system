import crypto from "node:crypto";

export function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export function verify(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = sign(body, secret);
  if (signature.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}
