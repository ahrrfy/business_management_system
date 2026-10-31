import type { Request, RequestHandler } from "express";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "../../shared/errors";
import { webRuntimeRole } from "../lib/clusterRole";
import { isPublicStorefrontRequest } from "./publicStorefrontHost";
import { ResourceAdmissionError } from "../lib/resourceAdmission";
import { sendResourceError, withPublicHttpBoundaryWork } from "./storefrontAdmission";

export function isPublicWorkProcedure(path: string): boolean {
  return (
    path.startsWith("storefront.") ||
    path.startsWith("recruitment.") ||
    path === "kiosk.publicBranches"
  );
}

/** Authentication is supplied by the existing session verifier, never a request header. */
export function assertRuntimeProcedure(
  path: string,
  authenticatedStaff: boolean,
): void {
  if (
    webRuntimeRole() === "admin" &&
    isPublicWorkProcedure(path) &&
    !authenticatedStaff
  )
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: appErrorMessage({
        what: "يلزم تسجيل الدخول",
        why: "هذه واجهة الموظفين",
        doThis: "سجّل الدخول أو افتح موقع المتجر العام",
      }),
    });
}

export function isPublicHttpWork(req: Request): boolean {
  // Express defaults are case-insensitive and permit a trailing slash. Classify
  // a copy only: tenant slugs, IDs and handler paths must retain their case.
  const path = req.originalUrl.split("?", 1)[0].toLowerCase();
  return (
    path.startsWith("/api/img/") ||
    path === "/store" ||
    path.startsWith("/store/") ||
    path.startsWith("/s/w/") ||
    path.startsWith("/feeds/") ||
    path.startsWith("/api/feeds/") ||
    /^\/sitemap(?:[./-]|$)/i.test(path) ||
    (path === "/" && isPublicStorefrontRequest(req))
  );
}

/** Mount after tenancy and public admission, before the public HTTP handler. */
export function createAdminPublicHttpBoundary(
  verifyStaff: (req: Request) => Promise<boolean> = async (req) => {
    const { getSessionContext } = await import("../auth/session");
    return (await getSessionContext(req)).user != null;
  },
): RequestHandler {
  return (req, res, next) => {
    if (webRuntimeRole() !== "admin" || !isPublicHttpWork(req)) return next();
    void withPublicHttpBoundaryWork(req, res, () => verifyStaff(req)).then((authenticated) => {
      if (req.aborted || res.destroyed || res.writableEnded) return;
      if (authenticated) next();
      else res.status(404).end();
    }, (error) => {
      if (error instanceof ResourceAdmissionError) sendResourceError(req, res, error);
      else next(error);
    });
  };
}
