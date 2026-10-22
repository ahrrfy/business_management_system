import express from "express";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHashedStaticAssets } from "../staticAssets";

describe("hashed static assets contain expected request errors", () => {
  let root: string;
  let server: Server;
  let port: number;
  let escapedErrors = 0;
  let spaRequests = 0;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "erp-asset-miss-"));
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "app-fixture.js"),
      "const ok = 1;",
    );
    await writeFile(path.join(root, "assets", ".private"), "hidden");
    await writeFile(path.join(root, "outside.txt"), "outside");
    const app = express();
    app.use(createHashedStaticAssets(root));
    app.use((_req, res) => {
      spaRequests++;
      res.send("SPA fixture");
    });
    app.use(((err, _req, res, _next) => {
      escapedErrors++;
      res.status(err.status ?? err.statusCode ?? 500).send("global error");
    }) satisfies express.ErrorRequestHandler);
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    server?.closeAllConnections();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (
      path.dirname(root) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith("erp-asset-miss-")
    ) {
      throw new Error("Refusing cleanup outside owned fixture");
    }
    await rm(root, { recursive: true });
  });

  function get(
    url: string,
    method = "GET",
    headers: Record<string, string> = {},
  ) {
    return new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: url, method, headers },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode!, headers: res.headers, body }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("keeps missing hashed files at 404 without SPA or the global error logger", async () => {
    const before = escapedErrors;
    const spaBefore = spaRequests;
    const missing = await get("/assets/app-old.js?version=fixture");
    expect(missing.status).toBe(404);
    expect(missing.headers["cache-control"]).toBe("no-store");
    expect(missing.body).not.toMatch(/SPA|global error|ENOENT|erp-asset-miss/);
    expect(escapedErrors).toBe(before);
    expect(spaRequests).toBe(spaBefore);
    const head = await get("/assets/app-old.js", "HEAD");
    expect(head.status).toBe(404);
    expect(head.body).toBe("");
  });

  it("preserves JavaScript, immutable caching, HEAD, revalidation and ranges", async () => {
    const asset = await get("/assets/app-fixture.js?v=1");
    expect(asset.status).toBe(200);
    expect(asset.body).toBe("const ok = 1;");
    expect(asset.headers["content-type"]).toMatch(/javascript/);
    expect(asset.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    const head = await get("/assets/app-fixture.js", "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe(String(asset.body.length));
    expect(
      (
        await get("/assets/app-fixture.js", "GET", {
          "if-none-match": asset.headers.etag!,
        })
      ).status,
    ).toBe(304);
    const range = await get("/assets/app-fixture.js", "GET", {
      range: "bytes=0-4",
    });
    expect(range.status).toBe(206);
    expect(range.body).toBe("const");
  });

  it("contains invalid paths and methods without exposing files or caching misses", async () => {
    const before = escapedErrors;
    for (const url of [
      "/assets/%zz",
      "/assets/%00.js",
      "/assets/..%2foutside.txt",
      "/assets/.private",
      "/assets/",
      "/assets",
    ]) {
      const result = await get(url);
      expect([400, 403, 404]).toContain(result.status);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.body).not.toMatch(/hidden|outside|SPA|global error/);
    }
    const post = await get("/assets/app-fixture.js", "POST");
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
    expect(escapedErrors).toBe(before);
  });

  it("keeps real filesystem failures visible to the global error handler", async () => {
    const before = escapedErrors;
    const realStat = fs.stat;
    vi.spyOn(fs, "stat").mockImplementation(((filename, ...args) => {
      if (String(filename).endsWith("broken-fixture.js")) {
        const callback = args.at(-1) as (err: NodeJS.ErrnoException) => void;
        queueMicrotask(() =>
          callback(
            Object.assign(new Error("fixture I/O failure"), { code: "EIO" }),
          ),
        );
        return;
      }
      return Reflect.apply(realStat, fs, [filename, ...args]);
    }) as typeof fs.stat);
    expect((await get("/assets/broken-fixture.js")).status).toBe(500);
    expect(escapedErrors).toBe(before + 1);
  });

  it("leaves non-assets to the existing application routes", async () => {
    expect((await get("/catalog")).body).toBe("SPA fixture");
    expect((await get("/assets-other")).body).toBe("SPA fixture");
  });
});
