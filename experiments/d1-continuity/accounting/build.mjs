import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReturnsWorker } from "../returns/build.mjs";
export const accountingRoot = path.dirname(fileURLToPath(import.meta.url));
export async function buildAccountingWorker(options = {}) {
  const repo = path.resolve(accountingRoot, "../../..");
  const key = (p) =>
    path.join(repo, p).replaceAll("\\", "/").replace(/\.ts$/, "");
  const aliases = {};
  for (const from of ["cash/actual", "credit/actual"])
    aliases[key("experiments/d1-continuity/" + from)] = path.join(
      accountingRoot,
      options.candidate ? "candidate.ts" : "actual.ts",
    );
  for (const from of ["cash/identity", "credit/identity"])
    aliases[key("experiments/d1-continuity/" + from)] = path.join(
      accountingRoot,
      "identity.ts",
    );
  aliases[key("experiments/d1-continuity/credit/schema")] = path.join(
    accountingRoot,
    "schema.ts",
  );
  aliases[
    key("experiments/d1-continuity/cash/schema") +
      "|" +
      path
        .join(repo, "experiments/d1-continuity/cash/pages.ts")
        .replaceAll("\\", "/")
  ] = path.join(accountingRoot, "schema.ts");
  return buildReturnsWorker({
    ...options,
    moduleAliases: aliases,
    metadataRoot: accountingRoot,
    labId: "actual-accounting-q1-native",
    outfile: options.outfile ?? path.join(accountingRoot, "build/worker.mjs"),
  });
}
