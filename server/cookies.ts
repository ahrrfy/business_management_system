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
 * the Express server), so `sameSite: "strict"` works without breaking the app
 * while blocking the cookie on cross-site requests — strong CSRF protection
 * (with `csrfGuard` as a second Origin-check layer). `secure` is derived
 * dynamically from the request protocol (https / x-forwarded-proto behind a proxy).
 */
export function getSessionCookieOptions(
  req: Request
): Pick<CookieOptions, "httpOnly" | "path" | "sameSite" | "secure"> {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: isSecureRequest(req),
  };
}
