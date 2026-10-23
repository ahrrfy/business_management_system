#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { scryptSync, timingSafeEqual } from "node:crypto";

const expected = fs
  .readFileSync(new URL("../.node-version", import.meta.url), "utf8")
  .trim();
assert.equal(
  process.versions.node,
  expected,
  `ERP requires Node.js ${expected}; found ${process.version}`,
);
const sample = Buffer.from("ERP runtime compatibility");
assert.deepEqual(brotliDecompressSync(brotliCompressSync(sample)), sample);
assert.ok(
  timingSafeEqual(
    scryptSync("runtime-probe", "probe-salt", 32),
    scryptSync("runtime-probe", "probe-salt", 32),
  ),
);
console.log(
  `Node.js ${expected}: version, Brotli and authentication crypto verified`,
);
