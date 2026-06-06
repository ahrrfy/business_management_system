import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { parse as parseCookie } from "cookie";
import { eq } from "drizzle-orm";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import { users, type User } from "../../drizzle/schema";
import { getDb } from "../db";

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is required for sessions");
  }
  return new TextEncoder().encode(secret);
}

export type SessionPayload = { uid: number; role: string };

/** Sign a session JWT for a local user. */
export async function signSession(
  uid: number,
  role: string,
  expiresInMs: number = ONE_YEAR_MS
): Promise<string> {
  const expirationSeconds = Math.floor((Date.now() + expiresInMs) / 1000);
  return new SignJWT({ uid, role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(expirationSeconds)
    .sign(getSecret());
}

/** Verify a session JWT. Returns null on any failure (missing/invalid/expired). */
export async function verifySession(
  token: string | undefined | null
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ["HS256"],
    });
    const uid = Number(payload.uid);
    if (!Number.isInteger(uid) || uid <= 0) return null;
    return { uid, role: String(payload.role ?? "user") };
  } catch {
    return null;
  }
}

/** Resolve the authenticated user from the request session cookie, or null. */
export async function getUserFromRequest(req: Request): Promise<User | null> {
  const cookies = parseCookie(req.headers.cookie ?? "");
  const session = await verifySession(cookies[COOKIE_NAME]);
  if (!session) return null;

  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, session.uid))
    .limit(1);

  const user = rows[0];
  if (!user || !user.isActive) return null;
  return user;
}
