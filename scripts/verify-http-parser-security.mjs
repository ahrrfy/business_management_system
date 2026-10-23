import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { setTimeout } from "node:timers/promises";
import express from "express";

const require = createRequire(import.meta.url);
const parserVersion = createRequire(require.resolve("express"))(
  "body-parser/package.json",
).version;
assert.match(
  parserVersion,
  /^1\.20\.(?:9|[1-9]\d+)$/,
  "Express must resolve a patched body-parser 1.x",
);
const app = express();
app.use(express.json({ limit: "1kb" }));
app.post("/probe", (req, res) => res.json(req.body));
app.get("/alive", (_req, res) => res.json({ ok: true }));
app.use((error, _req, res, _next) =>
  res.status(error.status ?? 400).json({ rejected: true }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const request = (method, path, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.address().port,
        method,
        path,
        headers: body
          ? {
              "content-type": "application/json",
              "content-encoding": "gzip",
              "content-length": body.length,
            }
          : {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (data) => {
          text += data;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(text) }),
        );
      },
    );
    req.setTimeout(3000, () => req.destroy(new Error("Parser probe timeout")));
    req.on("error", reject);
    req.end(body);
  });
try {
  const frame = gzipSync(Buffer.from('{"ok":true}'));
  assert.deepEqual(await request("POST", "/probe", frame), {
    status: 200,
    body: { ok: true },
  });
  for (const trailer of [
    Buffer.from("junk"),
    Buffer.from([0xff]),
    Buffer.from([0x1f, 0x8b, 0, 0]),
  ]) {
    const response = await request(
      "POST",
      "/probe",
      Buffer.concat([frame, trailer]),
    );
    assert.ok([200, 400].includes(response.status));
    await setTimeout(25);
    assert.deepEqual(await request("GET", "/alive"), {
      status: 200,
      body: { ok: true },
    });
  }
  console.log(
    `body-parser ${parserVersion}: compressed JSON and malformed trailing-byte survival verified on an isolated server.`,
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}
