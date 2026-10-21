/** Owner maintenance: preview by default; --apply requires the exact preview hash. */
import "dotenv/config";
import fs from "node:fs";
import { closeDb } from "../server/db.ts";
import {
  previewCustomerReceiptHistory,
  adoptCustomerReceiptHistory,
} from "../server/services/customerReceiptHistory.ts";
const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`Missing ${flag}`);
  return v;
};
const integer = (flag) => {
  const n = Number(value(flag));
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid ${flag}`);
  return n;
};
try {
  const inputPath = value("--input");
  if (!inputPath) throw new Error("--input FILE or --input - is required");
  const input = JSON.parse(
    fs
      .readFileSync(inputPath === "-" ? 0 : inputPath, "utf8")
      .replace(/^\uFEFF/, ""),
  );
  const result = args.includes("--apply")
    ? await adoptCustomerReceiptHistory(
        {
          ...input,
          batchKey: value("--batch-key"),
          evidenceHash: value("--evidence-hash"),
        },
        { userId: integer("--actor-id"), branchId: integer("--branch-id") },
      )
    : await previewCustomerReceiptHistory(input);
  const output = JSON.stringify(result, null, 2) + "\n";
  const out = value("--out");
  if (out) fs.writeFileSync(out, output, { flag: "wx" });
  else console.log(output);
} catch (e) {
  console.error(
    e instanceof Error ? e.message : "Historical receipt repair failed",
  );
  process.exitCode = 1;
} finally {
  await closeDb();
}
