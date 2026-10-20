/**
 * Owner-authorized supplier settlement repair. Defaults to read-only inspection.
 * --inspect [--supplier-id N] [--branch-id N] [--out NEW_JSON_PATH]
 * --adopt --input PREVIEW_JSON --actor-id N --branch-id N
 * --record-attested --input OWNER_ATTESTATION_JSON --actor-id N --branch-id N
 * Adoption links already-posted money; attestation records explicitly confirmed
 * missing payments today through the native engine, preserving actual dates as evidence.
 */
import "dotenv/config";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "../drizzle/schema";
import { closeDb, getDb } from "../server/db";
import {
  recordAttestedSupplierSettlement,
  type AttestedSupplierSettlementInput,
} from "../server/services/purchase/attestedSupplierSettlement";
import {
  adoptHistoricalSupplierSettlement,
  previewHistoricalSupplierSettlements,
} from "../server/services/purchase/historicalSupplierSettlement";
import type { Actor } from "../server/services/tx";

const args = process.argv.slice(2);
function value(flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const result = args[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`Missing ${flag}`);
  return result;
}
function integer(flag: string, required = false): number | undefined {
  const raw = value(flag);
  if (raw == null && !required) return undefined;
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error(`Invalid ${flag}`);
  return number;
}
function readInput(): unknown {
  const inputPath = value("--input");
  if (!inputPath) throw new Error("--input is required for a repair");
  return JSON.parse(fs.readFileSync(inputPath, "utf8").replace(/^\uFEFF/, ""));
}
async function owner(): Promise<Actor> {
  const id = integer("--actor-id", true)!;
  const [row] = await getDb()!
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!row?.isActive || !row.isOwner)
    throw new Error("An active database owner is required");
  const branchId = row.branchId ?? integer("--branch-id", true)!;
  return { userId: row.id, branchId, role: row.role, isOwner: true };
}
function emit(result: unknown): void {
  const text = JSON.stringify(result, null, 2);
  const outputPath = value("--out");
  if (outputPath) fs.writeFileSync(outputPath, `${text}\n`, { flag: "wx" });
  else console.log(text);
}
try {
  if (!getDb()) throw new Error("DATABASE_URL is required");
  const modes = ["--inspect", "--adopt", "--record-attested"].filter((flag) =>
    args.includes(flag),
  );
  if (modes.length > 1) throw new Error("Select exactly one repair mode");
  if (modes[0] === "--adopt") {
    const input = z
      .object({
        version: z.literal(1),
        episodes: z
          .array(
            z.object({
              episodeId: z.string().min(1).max(120),
              evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
            }),
          )
          .max(200),
      })
      .passthrough()
      .parse(readInput());
    const actor = await owner();
    const results = [];
    for (const episode of input.episodes)
      results.push(await adoptHistoricalSupplierSettlement(episode, actor));
    emit({ mode: "ADOPT_EXISTING_PAYMENT_EVIDENCE", results });
  } else if (modes[0] === "--record-attested") {
    const input = readInput() as AttestedSupplierSettlementInput;
    emit({
      mode: "RECORD_OWNER_ATTESTED_MISSING_PAYMENT_CORRECTION",
      result: await recordAttestedSupplierSettlement(input, await owner()),
    });
  } else {
    emit(
      await previewHistoricalSupplierSettlements({
        supplierId: integer("--supplier-id"),
        branchId: integer("--branch-id"),
      }),
    );
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Supplier settlement repair failed",
  );
  process.exitCode = 1;
} finally {
  await closeDb();
}
