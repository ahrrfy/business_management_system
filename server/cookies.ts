import type { CookieOptions, Request } from "express";

function isSecureRequest(req: Request): boolean {
  if (req.protocol === "https") return true;
  const forwarded = req.headers["x-forwarded-proto"];
  if (!forwarded) return false;
  const list = Array.isArray(forwarded) ? forwarded : forwarded.split(",");
  return list.some((p) => p.trim().toLowerCase() === "https");
}

/**
 * Session cookie options. Client and API are same-origin (Vite middleware on
 * the Express server), so `sameSite: "lax"` works over plain http on localhost
 * — unlike `none`, which browsers reject without `secure`.
 */
export function getSessionCookieOptions(
  req: Request
): Pick<CookieOptions, "httpOnly" | "path" | "sameSite" | "secure"> {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: isSecureRequest(req),
  };
}
