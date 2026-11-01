import express, {
  Router,
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
} from "express";
import fs from "node:fs";
import { isPublicStorefrontHost } from "./publicStorefrontHost";
import path from "node:path";

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Local public files do not need the database-backed request lanes. Keep this
 * router ahead of load shedding, behind host/security/rate-limit middleware. */
export function runtimePublicRoot(
  req: Pick<Request, "get" | "path">,
  erpRoot: string,
  storefrontRoot = process.env.STOREFRONT_STATIC_ROOT,
): string {
  const shared = /^\/(?:login|account)(?:\/|$)/.test(req.path);
  return storefrontRoot &&
    isPublicStorefrontHost(req.get("host")) &&
    !shared &&
    fs.existsSync(path.join(storefrontRoot, "index.html"))
    ? storefrontRoot
    : erpRoot;
}

/** Only complete known release roots are candidates; paths from the URL never choose a directory. */
export function retainedRuntimeAssetRoots(
  erpRoot: string,
  storefrontRoot = process.env.STOREFRONT_STATIC_ROOT,
): string[] {
  if (!storefrontRoot) return [erpRoot];
  const runtimeRoot = path.dirname(path.resolve(storefrontRoot));
  const recent = (directory: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingPath(error)) return [];
      throw error;
    }
    return entries
      .filter(
        (entry) =>
          !entry.name.startsWith(".") &&
          entry.isDirectory() &&
          !entry.isSymbolicLink(),
      )
      .flatMap((entry) => {
        const root = path.join(directory, entry.name);
        try {
          const stat = fs.lstatSync(root);
          return stat.isDirectory() ? [{ root, mtimeMs: stat.mtimeMs }] : [];
        } catch (error) {
          if (isMissingPath(error)) return [];
          throw error;
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 3)
      .map((entry) => entry.root);
  };
  const candidates = [
    storefrontRoot,
    erpRoot,
    ...recent(path.join(runtimeRoot, "storefront-releases")),
    ...recent(path.join(runtimeRoot, "web-releases")).flatMap((directory) => [
      path.join(directory, "candidate/public"),
      path.join(directory, "previous/public"),
    ]),
    path.resolve(runtimeRoot, "../dist/public"),
  ];
  return Array.from(new Set(candidates)).filter((directory) => {
    try {
      if (!fs.existsSync(path.join(directory, "index.html"))) return false;
      if (
        [
          storefrontRoot,
          erpRoot,
          path.resolve(runtimeRoot, "../dist/public"),
        ].includes(directory)
      )
        return true;
      const relative = path.relative(
        fs.realpathSync(runtimeRoot),
        fs.realpathSync(directory),
      );
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    } catch (error) {
      if (isMissingPath(error)) return false;
      throw error;
    }
  });
}

/** Missing hashes are terminal, including during first migration from the unified frontend. */
export function createRuntimeFrontendAssets(
  erpRoot: string,
  storefrontRoot = process.env.STOREFRONT_STATIC_ROOT,
): RequestHandler {
  return (req, res, next) => {
    if (!/^\/assets(?:\/|$)/.test(req.path)) return next();
    if (!["GET", "HEAD"].includes(req.method)) {
      res.setHeader("Allow", "GET, HEAD");
      res.sendStatus(405);
      return;
    }
    if (
      !/^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/.test(
        req.path,
      )
    ) {
      res.setHeader("Cache-Control", "no-store");
      res.sendStatus(404);
      return;
    }
    const selected = runtimePublicRoot(req, erpRoot, storefrontRoot);
    const roots = [selected];
    let retainedLoaded = false;
    let index = 0;
    const serve = (error?: unknown): void => {
      if (error) {
        next(error);
        return;
      }
      if (index >= roots.length && !retainedLoaded) {
        retainedLoaded = true;
        try {
          roots.push(
            ...retainedRuntimeAssetRoots(erpRoot, storefrontRoot).filter(
              (root) => root !== selected,
            ),
          );
        } catch (enumerationError) {
          next(enumerationError);
          return;
        }
      }
      const root = roots[index++];
      if (!root) {
        res.setHeader("Cache-Control", "no-store");
        res.sendStatus(404);
        return;
      }
      const requestedFile = path.join(root, req.path.slice(1));
      try {
        const relative = path.relative(
          fs.realpathSync(root),
          fs.realpathSync(requestedFile),
        );
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          serve();
          return;
        }
      } catch {
        serve();
        return;
      }
      express.static(root, {
        index: false,
        redirect: false,
        fallthrough: true,
        immutable: true,
        maxAge: "1y",
        dotfiles: "deny",
      })(req, res, serve);
    };
    serve();
  };
}

export function createRuntimeStaticAssets(
  publicRoot: string,
  storefrontRoot = process.env.STOREFRONT_STATIC_ROOT,
): Router {
  const router = Router();
  router.use("/fonts", (req, res, next) =>
    express.static(
      path.join(runtimePublicRoot(req, publicRoot, storefrontRoot), "fonts"),
      {
        index: false,
        redirect: false,
        fallthrough: false,
        dotfiles: "deny",
        // These names are not content-hashed; preserve the existing revalidation policy.
        setHeaders: (res) => {
          res.setHeader("Cache-Control", "no-cache");
        },
      },
    )(req, res, next),
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
      {
        root: runtimePublicRoot(req, publicRoot, storefrontRoot),
        dotfiles: "deny",
      },
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
