import express from "express";
import fs from "node:fs";
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOverloadGuard } from "../overloadGuard";
import { classifyRequestLane } from "../requestPriority";
import {
  createRuntimeStaticAssets,
  createRuntimeFrontendAssets,
  runtimePublicRoot,
} from "../runtimeStaticAssets";

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

describe("independent storefront static release", () => {
  let fixture: string;
  let server: Server;
  let origin: string;
  let erpRoot: string;
  let storefrontRoot: string;
  beforeAll(async () => {
    fixture = await mkdtemp(
      path.join(os.tmpdir(), "storefront-static-release-"),
    );
    erpRoot = path.join(fixture, ".runtime/web-current/public");
    storefrontRoot = path.join(fixture, ".runtime/storefront-current");
    const roots = [
      erpRoot,
      storefrontRoot,
      path.join(fixture, ".runtime/storefront-releases/previous"),
      path.join(fixture, ".runtime/web-releases/old/previous/public"),
    ];
    for (const [index, root] of Array.from(roots.entries())) {
      await mkdir(path.join(root, "assets"), { recursive: true });
      await writeFile(path.join(root, "index.html"), `shell-${index}`);
      await writeFile(
        path.join(root, "manifest.webmanifest"),
        `manifest-${index}`,
      );
      await writeFile(
        path.join(root, "assets", `entry-hash000${index}.js`),
        `release-${index}`,
      );
    }
    const app = express();
    app.use(createRuntimeStaticAssets(erpRoot, storefrontRoot));
    app.use(createRuntimeFrontendAssets(erpRoot, storefrontRoot));
    app.use((req, res) =>
      res.send(runtimePublicRoot(req, erpRoot, storefrontRoot)),
    );
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    if (
      fixture &&
      path.dirname(path.resolve(fixture)) === path.resolve(os.tmpdir()) &&
      path.basename(fixture).startsWith("storefront-static-release-")
    )
      await rm(fixture, { recursive: true });
  });
  async function get(route: string, host = "alarabiya.online") {
    return await new Promise<{ status: number; body: string; cache?: string }>(
      (resolve, reject) => {
        const outgoing = request(
          origin + route,
          { headers: { host } },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () =>
              resolve({
                status: response.statusCode!,
                body,
                cache: response.headers["cache-control"],
              }),
            );
          },
        );
        outgoing.on("error", reject);
        outgoing.end();
      },
    );
  }
  it("selects the storefront for direct product links and preserves both shared auth entries", async () => {
    expect((await get("/store/product/42")).body).toBe(storefrontRoot);
    expect(
      (await get("/store/product/42", "srv1548487.hstgr.cloud")).body,
    ).toBe(erpRoot);
    for (const route of ["/login", "/account", "/account/password"])
      expect((await get(route)).body).toBe(erpRoot);
    expect((await get("/manifest.webmanifest")).body).toBe("manifest-1");
    expect(
      (await get("/manifest.webmanifest", "srv1548487.hstgr.cloud")).body,
    ).toBe("manifest-0");
  });
  it("serves retained public hashes and legacy ERP hashes after migration, with terminal missing responses", async () => {
    for (let index = 0; index < 4; index++) {
      const result = await get(`/assets/entry-hash000${index}.js`);
      expect(result.status).toBe(200);
      expect(result.body).toBe(`release-${index}`);
      expect(result.cache).toContain("immutable");
    }
    const missing = await get("/assets/entry-missing000.js");
    expect(missing.status).toBe(404);
    expect(missing.cache).toBe("no-store");
    expect(missing.body).not.toContain("shell-");
    expect((await get("/assets/not-a-hash.js")).status).toBe(404);
  });
  it("falls back to the complete ERP shell before the first independent pointer is ready", async () => {
    const filename = path.join(storefrontRoot, "index.html");
    await unlink(filename);
    try {
      expect((await get("/store/product/42")).body).toBe(erpRoot);
    } finally {
      await writeFile(filename, "shell-1");
    }
  });
  it("serves a current hash without enumerating retained releases", async () => {
    const enumeration = vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("Retained releases must not be read for a current asset");
    });
    try {
      const result = await get("/assets/entry-hash0001.js");
      expect(result.status).toBe(200);
      expect(result.body).toBe("release-1");
      expect(enumeration).not.toHaveBeenCalled();
    } finally {
      enumeration.mockRestore();
    }
  });
  it("never serves unpublished assets from a release staging directory", async () => {
    const staging = path.join(
      fixture,
      ".runtime/storefront-releases/.stage-unpublished",
    );
    await mkdir(path.join(staging, "assets"), { recursive: true });
    await writeFile(path.join(staging, "index.html"), "unfinished shell");
    await writeFile(
      path.join(staging, "assets/entry-stage0001.js"),
      "unpublished code",
    );
    const result = await get("/assets/entry-stage0001.js");
    expect(result.status).toBe(404);
    expect(result.cache).toBe("no-store");
    expect(result.body).not.toContain("unpublished code");
  });
  it("serves a retained hash when another release is pruned after enumeration", async () => {
    const releases = path.join(fixture, ".runtime/storefront-releases");
    const retired = path.join(releases, "pruned-during-enumeration");
    await mkdir(retired);
    await writeFile(path.join(retired, "index.html"), "retired shell");
    const readDirectory = fs.readdirSync;
    let removed = false;
    const enumeration = vi
      .spyOn(fs, "readdirSync")
      .mockImplementation((directory, options) => {
        const entries = Reflect.apply(readDirectory, fs, [directory, options]);
        if (String(directory) === releases && !removed) {
          expect(path.dirname(path.resolve(retired))).toBe(
            path.resolve(releases),
          );
          expect(
            path.resolve(retired).startsWith(path.resolve(fixture) + path.sep),
          ).toBe(true);
          removed = true;
          fs.rmSync(retired, { recursive: true });
        }
        return entries;
      });
    try {
      const result = await get("/assets/entry-hash0003.js");
      expect(removed).toBe(true);
      expect(result.status).toBe(200);
      expect(result.body).toBe("release-3");
    } finally {
      enumeration.mockRestore();
    }
  });
  it("skips a release pruned between its completeness and containment checks", async () => {
    const releases = path.join(fixture, ".runtime/storefront-releases");
    const retired = path.join(releases, "pruned-during-validation");
    await mkdir(retired);
    await writeFile(path.join(retired, "index.html"), "retired shell");
    const exists = fs.existsSync;
    let removed = false;
    const validation = vi
      .spyOn(fs, "existsSync")
      .mockImplementation((filename) => {
        const result = exists(filename);
        if (String(filename) === path.join(retired, "index.html") && !removed) {
          expect(path.dirname(path.resolve(retired))).toBe(
            path.resolve(releases),
          );
          expect(
            path.resolve(retired).startsWith(path.resolve(fixture) + path.sep),
          ).toBe(true);
          removed = true;
          fs.rmSync(retired, { recursive: true });
        }
        return result;
      });
    try {
      const result = await get("/assets/entry-hash0003.js");
      expect(removed).toBe(true);
      expect(result.status).toBe(200);
      expect(result.body).toBe("release-3");
    } finally {
      validation.mockRestore();
    }
  });
});
