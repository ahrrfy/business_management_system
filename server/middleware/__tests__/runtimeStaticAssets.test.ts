import express from "express";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOverloadGuard } from "../overloadGuard";
import { classifyRequestLane } from "../requestPriority";
import { createRuntimeStaticAssets } from "../runtimeStaticAssets";

describe("runtime static assets before load shedding", () => {
  let fixture: string;
  let server: Server;
  let port: number;
  let lagMs = 418;
  const font = Buffer.from("wOF2-test-font");
  const manifest = '{"name":"ERP fixture"}';

  beforeAll(async () => {
    fixture = await mkdtemp(path.join(os.tmpdir(), "erp-static-overload-"));
    const publicRoot = path.join(fixture, "public");
    await mkdir(path.join(publicRoot, "fonts"), { recursive: true });
    await writeFile(
      path.join(publicRoot, "fonts", "cairo-latin-500-normal.woff2"),
      font,
    );
    await writeFile(path.join(publicRoot, "fonts", ".secret"), "hidden");
    await writeFile(path.join(publicRoot, "manifest.webmanifest"), manifest);
    await writeFile(path.join(publicRoot, "private.txt"), "outside-fonts");
    const app = express();
    app.use(createRuntimeStaticAssets(publicRoot));
    app.use(
      createOverloadGuard({
        lagMs: () => lagMs,
        maxLagMs: 500,
        thresholdFor: (req) =>
          ({ critical: 2500, storefront: 300, normal: 500 })[
            classifyRequestLane(req.path, req.hostname)
          ],
        onShed: (_req, res) => {
          res.status(503).send("shed");
        },
      }),
    );
    // Existing late static serving reproduces the deployed order behind the guard.
    app.use(express.static(publicRoot));
    app.all("/api/trpc/sales.create", (_req, res) => {
      res.send("cashier");
    });
    app.use((_req, res) => {
      res.send("SPA fallback");
    });
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
    if (fixture) {
      const resolved = path.resolve(fixture);
      if (
        path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
        !path.basename(resolved).startsWith("erp-static-overload-")
      ) {
        throw new Error("Refusing cleanup outside owned fixture");
      }
      await rm(resolved, { recursive: true });
    }
  });

  function get(url: string, method = "GET") {
    return new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      body: Buffer;
    }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: url,
          method,
          headers: { host: "alarabiya.online" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("serves the observed font at the incident's 418ms storefront lag", async () => {
    lagMs = 418;
    const result = await get("/fonts/cairo-latin-500-normal.woff2?v=test");
    expect(result.status).toBe(200);
    expect(result.body).toEqual(font);
    expect(result.headers["content-type"]).toMatch(/font\/woff2/);
    expect(result.headers["cache-control"]).toBe("no-cache");
  });

  it("serves HEAD without bytes even above the critical threshold", async () => {
    lagMs = 5000;
    const result = await get("/fonts/cairo-latin-500-normal.woff2", "HEAD");
    expect(result.status).toBe(200);
    expect(result.body.length).toBe(0);
    expect(result.headers["content-length"]).toBe(String(font.length));
  });

  it("serves the exact manifest without changing its revalidation policy", async () => {
    lagMs = 5000;
    const result = await get("/manifest.webmanifest");
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe(manifest);
    expect(result.headers["content-type"]).toMatch(/manifest\+json/);
    expect(result.headers["cache-control"]).toBe("no-cache");
    const head = await get("/manifest.webmanifest", "HEAD");
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
  });

  it("ends a missing manifest locally without invoking the SPA fallback", async () => {
    const filename = path.join(fixture, "public", "manifest.webmanifest");
    await unlink(filename);
    try {
      const result = await get("/manifest.webmanifest");
      expect(result.status).toBe(404);
      expect(result.body.toString()).not.toMatch(/SPA fallback|shed/);
    } finally {
      await writeFile(filename, manifest);
    }
  });

  it("ends missing font, directory, and dotfile requests locally", async () => {
    lagMs = 5000;
    for (const url of [
      "/fonts/missing.woff2",
      "/fonts",
      "/fonts/",
      "/fonts/.secret",
    ]) {
      const result = await get(url);
      expect([403, 404]).toContain(result.status);
      expect(result.body.toString()).not.toMatch(/SPA fallback|shed|hidden/);
    }
  });

  it("rejects traversal outside fonts and handles malformed encoding locally", async () => {
    lagMs = 5000;
    for (const url of [
      "/fonts/..%2fprivate.txt",
      "/fonts/%2e%2e/private.txt",
      "/fonts/%00.woff2",
      "/fonts/%zz",
    ]) {
      const result = await get(url);
      expect([400, 403, 404]).toContain(result.status);
      expect(result.body.toString()).not.toMatch(
        /outside-fonts|SPA fallback|shed/,
      );
    }
  });

  it("rejects writes to both local static surfaces", async () => {
    lagMs = 5000;
    for (const url of [
      "/fonts/cairo-latin-500-normal.woff2",
      "/manifest.webmanifest",
    ]) {
      const result = await get(url, "POST");
      expect(result.status).toBe(405);
      expect(result.headers.allow).toBe("GET, HEAD");
    }
  });

  it("keeps dynamic images, unknown manifest children, and cashier thresholds protected", async () => {
    lagMs = 418;
    expect((await get("/api/img/product/1885")).status).toBe(503);
    expect((await get("/manifest.webmanifest/extra")).status).toBe(503);
    expect((await get("/api/trpc/sales.create", "POST")).status).toBe(200);
    lagMs = 2501;
    expect((await get("/api/trpc/sales.create", "POST")).status).toBe(503);
  });

  it("registers the production static router before the real lag monitor and guard", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../../index.ts"),
      "utf8",
    );
    const mount = source.search(/app\.use\(\s*createRuntimeStaticAssets\(/);
    expect(mount).toBeGreaterThan(0);
    expect(mount).toBeLessThan(
      source.indexOf("const lagMonitor = startLagMonitor()"),
    );
    expect(source.slice(mount - 90, mount)).toContain(
      'process.env.NODE_ENV !== "development"',
    );
  });
});
