import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../../db";

const stubs = vi.hoisted(() => ({ tenantDb: null as unknown as DB }));

vi.mock("../../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db")>();
  return {
    ...actual,
    acquireTenantDb: vi.fn(async () => ({ db: stubs.tenantDb, release: () => undefined })),
  };
});

vi.mock("../../tenancy/registry", () => ({
  resolveCompanyByCode: vi.fn(async (code: string) =>
    code === "alpha" ? { id: 101, code } : code === "beta" ? { id: 202, code } : null),
}));

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { imageRouter } from "../../imageRoute";
import { __resetImageStoreForTest, contentHash, getImageStore, objectKeyFor, shortHash } from "../../lib/imageStore";
import { truncateTables } from "./__testUtils__";

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]);
let storeDir = "";

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use("/api/img", imageRouter());
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

beforeEach(async () => {
  delete process.env.CONTROL_DATABASE_URL;
  await truncateTables(["productImages", "products"]);
  const base = getDb();
  if (!base) throw new Error("test database unavailable");
  stubs.tenantDb = base;
  storeDir = await mkdtemp(path.join(tmpdir(), "erp-product-tenant-image-"));
  process.env.IMAGE_STORE_DRIVER = "fs";
  process.env.IMAGE_STORE_DIR = storeDir;
  process.env.CONTROL_DATABASE_URL = "mysql://control.invalid/test";
  __resetImageStoreForTest();
});

afterEach(async () => {
  delete process.env.CONTROL_DATABASE_URL;
  delete process.env.IMAGE_STORE_DRIVER;
  delete process.env.IMAGE_STORE_DIR;
  __resetImageStoreForTest();
  if (storeDir) await rm(storeDir, { recursive: true, force: true });
});

describe("anonymous product image tenant route", () => {
  it("resolves the company from the public URL and cannot cross its object namespace", async () => {
    await stubs.tenantDb.insert(s.products).values([
      { id: 901, name: "Alpha product", isActive: true, isService: false, showInStore: true },
      { id: 902, name: "Beta product", isActive: true, isService: false, showInStore: true },
    ]);
    const hash = contentHash(JPEG_BYTES);
    const alphaKey = objectKeyFor(hash, "image/jpeg", "company-101/studio/candidate");
    const betaKey = objectKeyFor(hash, "image/jpeg", "company-202/studio/candidate");
    await getImageStore().put(alphaKey, JPEG_BYTES, "image/jpeg");
    await getImageStore().put(betaKey, JPEG_BYTES, "image/jpeg");
    await stubs.tenantDb.insert(s.productImages).values([
      { id: 901, productId: 901, url: "stored-object", objectKey: alphaKey, contentHash: hash, mime: "image/jpeg", bytes: JPEG_BYTES.length, reviewStatus: "APPROVED" },
      { id: 902, productId: 902, url: "stored-object", objectKey: betaKey, contentHash: hash, mime: "image/jpeg", bytes: JPEG_BYTES.length, reviewStatus: "APPROVED" },
    ]);

    await withServer(async (base) => {
      const version = shortHash(hash);
      expect((await fetch(`${base}/api/img/company/alpha/product/901?v=${version}`)).status).toBe(200);
      expect((await fetch(`${base}/api/img/company/alpha/product/902?v=${version}`)).status).toBe(404);
      expect((await fetch(`${base}/api/img/company/beta/product/902?v=${version}`)).status).toBe(200);
      expect((await fetch(`${base}/api/img/company/beta/product/901?v=${version}`)).status).toBe(404);
      expect((await fetch(`${base}/api/img/company/unknown/product/901?v=${version}`)).status).toBe(404);
      expect((await fetch(`${base}/api/img/product/901?v=${version}`)).status).toBe(404);
    });
  });
});
