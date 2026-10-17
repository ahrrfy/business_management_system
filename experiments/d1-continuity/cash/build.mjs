import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export const cashRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(cashRoot, "../../..");
export async function buildActualCashWorker(options = {}) {
  const outfile = options.outfile ?? path.join(cashRoot, "build/worker.mjs");
  const substitutions = {
    "server/db": "db-shim.ts",
    "server/logger": "logger",
    "server/services/whatsapp": "whatsapp",
    "server/realtime/index": "realtime",
    "server/realtime": "realtime",
  };
  const result = await build({
    absWorkingDir: root,
    ...(options.stdin
      ? {
          stdin: {
            contents: options.stdin,
            resolveDir: cashRoot,
            sourcefile: "cash-entry.ts",
            loader: "ts",
          },
        }
      : { entryPoints: [options.entry ?? path.join(cashRoot, "worker.ts")] }),
    outfile,
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "import", "default"],
    external: ["node:*", "./sql-wasm.wasm"],
    minifyWhitespace: true,
    legalComments: "none",
    metafile: true,
    logLevel: "silent",
    plugins: [
      {
        name: "cash-port-boundaries",
        setup(b) {
          b.onLoad({ filter: /sql-wasm\.js$/ }, async (args) => {
            const original = await readFile(args.path, "utf8");
            if (
              !original.includes('ba="undefined"!=typeof WorkerGlobalScope') ||
              !original.includes('ca="object"==typeof process')
            )
              throw Error("Pinned sql.js environment shape changed");
            return {
              loader: "js",
              contents: original
                .replace('ba="undefined"!=typeof WorkerGlobalScope', "ba=false")
                .replace(/ca="object"==typeof process[^;]+/, "ca=false"),
            };
          });
          b.onResolve({ filter: /.*/ }, (args) =>
            builtinModules.includes(args.path)
              ? { path: "node:" + args.path, external: true }
              : null,
          );
          b.onResolve({ filter: /^\./ }, (args) => {
            const target = path
              .resolve(args.resolveDir, args.path)
              .replace(/\.ts$/, "")
              .replaceAll("\\", "/");
            for (const [source, shim] of Object.entries(substitutions)) {
              if (target === path.join(root, source).replaceAll("\\", "/"))
                return shim.endsWith(".ts")
                  ? { path: path.join(cashRoot, shim) }
                  : { path: shim, namespace: "cash-boundary" };
            }
            if (
              target.startsWith(root.replaceAll("\\", "/")) &&
              existsSync(target + ".ts")
            )
              return { path: target + ".ts", sideEffects: false };
          });
          b.onLoad({ filter: /.*/, namespace: "cash-boundary" }, (args) => ({
            loader: "js",
            contents:
              args.path === "logger"
                ? "export const logger={warn(){},info(){},error(){},debug(){}};"
                : args.path === "whatsapp"
                  ? 'export function flowNotify(){throw new Error("Unsupported notification transport")}'
                  : 'export function publishRealtimeEvent(){throw new Error("No publication before durable cash outbox delivery")}',
          }));
        },
      },
    ],
  });
  const inputs = Object.entries(
    Object.values(result.metafile.outputs)[0].inputs,
  )
    .filter(([, v]) => v.bytesInOutput > 0)
    .map(([s]) => s.replaceAll("\\", "/"));
  const forbidden = inputs.filter((s) =>
    /node_modules\/mysql2\/|server\/db\.ts$|\/lab\/commands\.mjs$|node_modules\/(?:express|firebase-admin|openai)\//.test(
      s,
    ),
  );
  if (forbidden.length) throw Error("Forbidden source: " + forbidden.join(","));
  for (const required of [
    "server/services/posExternalPayment.ts",
    "server/services/sale/create.ts",
    "server/services/inventoryService.ts",
    "server/services/ledgerService.ts",
    "server/services/numbering.ts",
    "server/services/idempotency.ts",
    "server/services/reports/monthCloseGate.ts",
  ])
    if (!inputs.includes(required))
      throw Error("Missing actual source " + required);
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      inputs
        .filter((s) => /^(server|shared|drizzle)\//.test(s))
        .map(async (s) => [
          s,
          createHash("sha256")
            .update(await readFile(path.join(root, s)))
            .digest("hex"),
        ]),
    ),
  );
  const evidence = {
    originalSourceSha256: sourceHashes,
    substitutions,
    forbiddenDependencies: forbidden,
    sqlJs: {
      version: "1.13.0",
      wasmSha256: createHash("sha256")
        .update(
          await readFile(
            path.join(cashRoot, "node_modules/sql.js/dist/sql-wasm.wasm"),
          ),
        )
        .digest("hex"),
      adaptation:
        "Disable Node/browser location probing; instantiate imported compiled WASM only; no runtime UDF registration",
    },
    metafile: result.metafile,
  };
  if (options.write !== false) {
    await mkdir(path.dirname(outfile), { recursive: true });
    await writeFile(outfile, result.outputFiles[0].contents);
    await copyFile(
      path.join(cashRoot, "node_modules/sql.js/dist/sql-wasm.wasm"),
      path.join(path.dirname(outfile), "sql-wasm.wasm"),
    );
    await writeFile(
      path.join(path.dirname(outfile), "source-evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
  }
  if (options.write !== false) {
    const metadataPath = path.join(
      path.dirname(outfile),
      "schema-metadata.mjs",
    );
    await build({
      absWorkingDir: root,
      stdin: {
        contents:
          "export {initializationSql,tables} from './schema'; export {fixtureSql} from './fixture';",
        resolveDir: cashRoot,
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: metadataPath,
      minifyWhitespace: true,
      legalComments: "none",
      logLevel: "silent",
    });
    const metadata = await import(
      pathToFileURL(metadataPath).href + "?v=" + Date.now()
    );
    await writeFile(
      path.join(path.dirname(outfile), "schema.sql"),
      metadata.initializationSql,
    );
    await writeFile(
      path.join(path.dirname(outfile), "fixture.sql"),
      metadata.fixtureSql,
    );
    await writeFile(
      path.join(path.dirname(outfile), "tables.json"),
      JSON.stringify(metadata.tables, null, 2),
    );
  }
  return { ...result, evidence };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await buildActualCashWorker();
