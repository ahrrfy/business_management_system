import express, { Router, type ErrorRequestHandler } from "express";
import path from "node:path";

/** Expected asset request failures are terminal HTTP responses, not application
 * exceptions. Keep genuine filesystem/server failures on the global error path. */
export function createHashedStaticAssets(publicRoot: string): Router {
  const router = Router();
  router.use(
    "/assets",
    (req, res, next) => {
      if (req.method === "GET" || req.method === "HEAD") return next();
      res.setHeader("Allow", "GET, HEAD");
      res.setHeader("Cache-Control", "no-store");
      res.sendStatus(405);
    },
    express.static(path.join(publicRoot, "assets"), {
      immutable: true,
      maxAge: "1y",
      index: false,
      redirect: false,
      fallthrough: false,
    }),
  );
  const assetError: ErrorRequestHandler = (err, _req, res, next) => {
    const status = err?.status ?? err?.statusCode;
    if (res.headersSent || ![400, 403, 404, 405].includes(status)) {
      next(err);
      return;
    }
    // A missing hash may become available after recovery; never cache its 404
    // with the successful assets' one-year immutable policy.
    res.setHeader("Cache-Control", "no-store");
    res.sendStatus(status);
  };
  router.use("/assets", assetError);
  return router;
}
