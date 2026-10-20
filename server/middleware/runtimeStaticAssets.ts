import express, { Router, type ErrorRequestHandler } from "express";
import path from "node:path";

/** Local public files do not need the database-backed request lanes. Keep this
 * router ahead of load shedding, behind host/security/rate-limit middleware. */
export function createRuntimeStaticAssets(publicRoot: string): Router {
  const router = Router();
  router.use(
    "/fonts",
    express.static(path.join(publicRoot, "fonts"), {
      index: false,
      redirect: false,
      fallthrough: false,
      dotfiles: "deny",
      // These names are not content-hashed; preserve the existing revalidation policy.
      setHeaders: (res) => {
        res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );
  router.all("/manifest.webmanifest", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      res.sendStatus(405);
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(
      "manifest.webmanifest",
      { root: publicRoot, dotfiles: "deny" },
      (err) => {
        if (err) next(err);
      },
    );
  });
  // A missing/invalid static URL must not fall through to SPA rendering or SQL.
  const staticError: ErrorRequestHandler = (err, _req, res, next) => {
    const status = err?.status ?? err?.statusCode;
    if (!res.headersSent && [400, 403, 404, 405].includes(status)) {
      res.sendStatus(status);
      return;
    }
    next(err);
  };
  router.use(staticError);
  return router;
}
