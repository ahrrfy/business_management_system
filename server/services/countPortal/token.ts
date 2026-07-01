// توكن بوابة العدّ (jose HS256) — إصدار وتحقّق كوكي count_token.
import { SignJWT, jwtVerify } from "jose";

/** اسم كوكي بوابة العدّ — منفصل عن كوكي جلسة النظام كي لا يتداخلا. */
export const COUNT_COOKIE_NAME = "count_token";

/** صلاحية توكن البوابة: 12 ساعة — تكفي يوم جرد كاملاً ولا تبقى مفتوحة للأبد. */
export const COUNT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is required for count portal tokens");
  }
  return new TextEncoder().encode(secret);
}

/** حمولة توكن البوابة: k="stk" تمييزاً عن أي JWT آخر بنفس السرّ + جلسة وتكليف محدّدان. */
export type CountTokenPayload = { sid: number; aid: number };

/** يُصدر توكن بوابة عدّ لتكليف محدّد في جلسة محدّدة (صلاحية 12 ساعة). */
export async function signCountToken(sessionId: number, assignmentId: number): Promise<string> {
  const expirationSeconds = Math.floor((Date.now() + COUNT_TOKEN_TTL_MS) / 1000);
  return new SignJWT({ k: "stk", sid: sessionId, aid: assignmentId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(expirationSeconds)
    .sign(getSecret());
}

/** يتحقّق من توكن البوابة. null عند أي فشل (مفقود/تالف/منتهٍ/ليس توكن جرد). */
export async function verifyCountToken(
  token: string | undefined | null
): Promise<CountTokenPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    // k="stk" يمنع قبول توكن جلسة النظام (أو أي JWT آخر بنفس السرّ) في البوابة.
    if (payload.k !== "stk") return null;
    const sid = Number(payload.sid);
    const aid = Number(payload.aid);
    if (!Number.isInteger(sid) || sid <= 0) return null;
    if (!Number.isInteger(aid) || aid <= 0) return null;
    return { sid, aid };
  } catch {
    return null;
  }
}
