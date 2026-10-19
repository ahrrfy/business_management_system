import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { buildActualCashWorker, cashRoot } from "../cash/build.mjs";
export const returnsRoot = path.dirname(fileURLToPath(import.meta.url));
export async function buildReturnsWorker(options = {}) {
  const repo = path.resolve(returnsRoot, "../../.."),
    key = (p) => path.join(repo, p).replaceAll("\\", "/").replace(/\.ts$/, "");
  const aliases = {};
  for (const [from, to] of [
    ["cash/actual", "returns/actual"],
    ["cash/identity", "credit/identity"],
    ["credit/actual", "returns/actual"],
    ["credit/schema", "returns/schema"],
    ["credit/http-input", "returns/http-input"],
    ["credit/evidence", "returns/evidence"],
    ["credit/ui", "returns/ui"],
  ]) {
    // The expanded input composes the old schemas without a recursive alias.
    if (from === "credit/http-input")
      aliases[
        key("experiments/d1-continuity/" + from) +
          "|" +
          path.join(returnsRoot, "http-input.ts").replaceAll("\\", "/")
      ] = path.join(repo, "experiments/d1-continuity/credit/http-input.ts");
    aliases[key("experiments/d1-continuity/" + from)] = path.join(
      repo,
      "experiments/d1-continuity/" + to + ".ts",
    );
  }
  aliases[key("server/services/tx")] = path.join(
    repo,
    "experiments/d1-continuity/credit/transaction.ts",
  );
  aliases[
    key("experiments/d1-continuity/cash/schema") +
      "|" +
      path.join(cashRoot, "pages.ts").replaceAll("\\", "/")
  ] = path.join(returnsRoot, "schema.ts");
  const outfile = options.outfile ?? path.join(returnsRoot, "build/worker.mjs"),
    dir = path.dirname(outfile);
  const result = await buildActualCashWorker({
    ...(options.stdin
      ? { stdin: options.stdin, resolveDir: returnsRoot }
      : {
          entry: path.join(
            repo,
            "experiments/d1-continuity/credit/coordinated-worker.ts",
          ),
        }),
    outfile,
    moduleAliases: { ...aliases, ...options.moduleAliases },
    metadata: false,
  });
  for (const name of [
    "server/services/returnService.ts",
    "server/services/reversalEngine.ts",
    "server/services/returns/refundCaps.ts",
  ])
    if (!result.evidence.originalSourceSha256[name])
      throw Error("MISSING_ORIGINAL_RETURN_SOURCE:" + name);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "schema-metadata.mjs");
  await build({
    stdin: {
      contents:
        "export{tables,initializationSql}from'./schema';export{fixtureSql,multiCashierFixtureSql}from'../credit/fixture'",
      resolveDir: options.metadataRoot ?? returnsRoot,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    minifyWhitespace: true,
    legalComments: "none",
    outfile: file,
    logLevel: "silent",
  });
  const meta = await import(pathToFileURL(file).href + "?t=" + Date.now());
  for (const [name, value] of Object.entries({
    "schema.sql": meta.initializationSql,
    "fixture.sql": meta.fixtureSql,
    "multi-cashier.sql": meta.multiCashierFixtureSql,
    "tables.json": JSON.stringify(meta.tables, null, 2),
  }))
    await writeFile(path.join(dir, name), value);
  await writeFile(
    path.join(dir, "journal.sql"),
    (
      await readFile(path.join(cashRoot, "journal-schema.sql"), "utf8")
    ).replaceAll(
      "actual-cash-20261017",
      options.labId ?? "actual-credit-20261018",
    ),
  );
  return result;
}
