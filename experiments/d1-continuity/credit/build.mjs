import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { buildActualCashWorker, cashRoot } from "../cash/build.mjs";
export const creditRoot = path.dirname(fileURLToPath(import.meta.url));
export async function buildCreditWorker(options = {}) {
  const repo = path.resolve(creditRoot, "../../.."),
    key = (p) => path.join(repo, p).replaceAll("\\", "/").replace(/\.ts$/, ""),
    aliases = {
      [key("experiments/d1-continuity/cash/actual.ts")]: path.join(
        creditRoot,
        "actual.ts",
      ),
      [key("experiments/d1-continuity/cash/identity.ts")]: path.join(
        creditRoot,
        "identity.ts",
      ),
      [key("server/services/tx.ts")]: path.join(creditRoot, "transaction.ts"),
      [key("experiments/d1-continuity/cash/schema.ts") +
      "|" +
      path.join(cashRoot, "pages.ts").replaceAll("\\", "/")]: path.join(
        creditRoot,
        "schema.ts",
      ),
    };
  const outfile = options.outfile ?? path.join(creditRoot, "build/worker.mjs");
  const result = await buildActualCashWorker({
    ...(options.stdin
      ? { stdin: options.stdin, resolveDir: creditRoot }
      : {
          entry:
            options.entry ?? path.join(creditRoot, "coordinated-worker.ts"),
        }),
    outfile,
    moduleAliases: aliases,
    metadata: false,
  });
  for (const required of [
    "server/services/sale/payment.ts",
    "server/lib/credit.ts",
    "server/services/contractPriceService.ts",
    "server/services/reconciliation/autoSettlementService.ts",
  ])
    if (!result.evidence.originalSourceSha256[required])
      throw Error("Missing original credit source " + required);
  const dir = path.dirname(outfile);
  await mkdir(dir, { recursive: true });
  const metaFile = path.join(dir, "schema-metadata.mjs");
  await build({
    stdin: {
      contents:
        "export{initializationSql,tables}from'./schema';export{fixtureSql,multiCashierFixtureSql}from'./fixture';",
      resolveDir: creditRoot,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: metaFile,
    minifyWhitespace: true,
    legalComments: "none",
    logLevel: "silent",
  });
  const meta = await import(pathToFileURL(metaFile).href + "?v=" + Date.now());
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
    ).replaceAll("actual-cash-20261017", "actual-credit-20261018"),
  );
  return result;
}
