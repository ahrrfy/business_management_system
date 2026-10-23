import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { z } from "zod";

// Exercise the installed bundles, including the validator embedded by IMG.LY.
// No image, model download, database, or external service is needed.
const require = createRequire(import.meta.url);
const directory = path.dirname(require.resolve("@imgly/background-removal"));
const pkg = JSON.parse(
  fs.readFileSync(path.join(directory, "../package.json"), "utf8"),
);
const expected = {
  publicPath:
    "https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/",
  debug: false,
  rescale: true,
  device: "cpu",
  proxyToWorker: false,
  fetchArgs: {},
  model: "isnet_fp16",
  output: { format: "image/png", quality: 0.8 },
};
const normalize = (value) => JSON.parse(JSON.stringify(value));
for (const name of ["index.mjs", "index.cjs"]) {
  const source = fs.readFileSync(path.join(directory, name), "utf8");
  assert.match(
    source,
    name.endsWith("mjs") ? /import \{ z \} from "zod"/ : /require\("zod"\)/,
  );
  assert.doesNotMatch(source, /class _ZodArray|zod@3\.|z\.function\(\)\.args/);
  const begin = source.indexOf("var ConfigSchema =");
  const end = source.indexOf("// src/inference.ts", begin);
  assert.ok(begin > 0 && end > begin, "IMG.LY schema must remain inspectable");
  const validate = vm.runInNewContext(
    source.slice(begin, end) + "\nvalidateConfig;",
    {
      z,
      package_default: pkg,
      crossOriginIsolated: true,
      console: { log() {}, debug() {} },
    },
  );
  assert.deepEqual(normalize(validate()), expected);
  assert.deepEqual(normalize(validate({ output: {} })), expected);
  for (const [input, model] of [
    ["small", "isnet_quint8"],
    ["medium", "isnet_fp16"],
    ["large", "isnet"],
    ["isnet_quint8", "isnet_quint8"],
  ])
    assert.equal(validate({ model: input }).model, model);
  const configured = validate({
    publicPath: "/imgly-assets/",
    device: "cpu",
    model: "isnet_quint8",
    proxyToWorker: true,
    output: { format: "image/png" },
  });
  assert.deepEqual(normalize(configured), {
    ...expected,
    publicPath: "/imgly-assets/",
    model: "isnet_quint8",
    proxyToWorker: true,
  });
  assert.equal(
    validate({ publicPath: "/${PACKAGE_NAME}/${PACKAGE_VERSION}/" }).publicPath,
    "/@imgly/background-removal/1.7.0/",
  );
  assert.equal(
    validate({ output: { format: "image/webp", quality: 0.5 } }).output.quality,
    0.5,
  );
  assert.deepEqual(
    normalize(
      validate({ fetchArgs: { headers: { accept: "application/json" } } })
        .fetchArgs,
    ),
    { headers: { accept: "application/json" } },
  );
  for (const bad of [
    { model: "invalid" },
    { device: "invalid" },
    { progress: 1 },
    { output: { format: "invalid" } },
    { debug: "true" },
    { output: { quality: "0.8" } },
  ])
    assert.throws(() => validate(bad));
  const calls = [];
  const config = validate({
    progress: (...args) => {
      calls.push(args);
    },
  });
  config.progress("model", 1, 2);
  assert.deepEqual(calls, [["model", 1, 2]]);
  assert.throws(() => config.progress(1, "bad", 2));
  assert.throws(() =>
    validate({ progress: () => "invalid-return" }).progress("model", 1, 2),
  );
}
let walked = 0;
const item = z.string().superRefine(() => {
  walked++;
});
for (const [schema, input] of [
  [z.array(item).max(2), Array(20000).fill("value")],
  [z.array(item).length(2), Array(20000).fill("value")],
  [
    z.set(item).max(2),
    new Set(Array.from({ length: 20000 }, (_, i) => String(i))),
  ],
  [
    z.map(z.string(), item).max(2),
    new Map(Array.from({ length: 20000 }, (_, i) => [String(i), "value"])),
  ],
]) {
  const result = schema.safeParse(input);
  assert.equal(result.success, false);
  assert.equal(result.error.issues.length, 1);
  assert.equal(
    walked,
    0,
    "Oversized containers must fail before walking elements",
  );
}
assert.equal(
  (await z.array(item).max(2).safeParseAsync(Array(20000).fill("value")))
    .success,
  false,
);
assert.equal(walked, 0);
console.log(
  "Zod security verified: patched ESM/CJS, compatible image configuration/callbacks, bounded collection early rejection.",
);
