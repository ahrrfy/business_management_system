/** Read-only catalog verification; never rewrites supplier identities or picks collision owners. */
import "dotenv/config";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import * as schema from "../drizzle/schema";
import { barcodeComparisonKey, barcodeIdentityCandidates, canonicalizeBarcodeInput } from "../shared/barcodeNormalize";
import { resolveBarcodeOwnerResult } from "../server/services/catalog/barcodeAliases";

async function main() {
  const barcode = process.argv[2];
  if (!barcode || !process.env.DATABASE_URL) throw new Error("Provide barcode and DATABASE_URL");
  const connection = await mysql.createConnection(process.env.DATABASE_URL);
  try {
    await connection.query("SET TRANSACTION READ ONLY");
    await connection.beginTransaction();
    const db = drizzle(connection, { schema, mode: "default" });
    const primary = await db.select({ unitId: schema.productUnits.id, barcode: schema.productUnits.barcode, normalized: schema.productUnits.barcodeNormalized }).from(schema.productUnits);
    const aliases = await db.select({ unitId: schema.productUnitBarcodes.productUnitId, barcode: schema.productUnitBarcodes.barcode, normalized: schema.productUnitBarcodes.barcodeNormalized }).from(schema.productUnitBarcodes);
    const identities = new Map<string, Set<number>>();
    let legacyRows = 0;
    let identityKeyMismatches = 0;
    for (const row of [...primary, ...aliases]) {
      if (!row.barcode) continue;
      if (row.normalized !== barcodeComparisonKey(row.barcode)) identityKeyMismatches++;
      if (canonicalizeBarcodeInput(row.barcode) !== row.barcode) legacyRows++;
      for (const candidate of barcodeIdentityCandidates(row.barcode)) {
        const key = barcodeComparisonKey(candidate);
        const owners = identities.get(key) ?? new Set<number>();
        owners.add(row.unitId);
        identities.set(key, owners);
      }
    }
    const conflicts = [...identities].filter(([, owners]) => owners.size > 1);
    const indexPlans = [];
    for (const table of ["productUnits", "productUnitBarcodes"]) {
      const [plan] = await connection.query<mysql.RowDataPacket[]>(
        `EXPLAIN SELECT id FROM ${table} WHERE barcodeNormalized IN (?)`,
        [barcodeIdentityCandidates(barcode).map(barcodeComparisonKey)],
      );
      indexPlans.push({ table, key: plan[0].key, rows: plan[0].rows });
    }
    const timings: number[] = [];
    let resolution: Awaited<ReturnType<typeof resolveBarcodeOwnerResult>> = { status: "NOT_FOUND" };
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      resolution = await resolveBarcodeOwnerResult(db, barcode);
      timings.push(Math.round(performance.now() - start));
    }
    const expectedUnit = process.argv[3] ? Number(process.argv[3]) : null;
    console.log(JSON.stringify({
      mode: "READ_ONLY", barcode, codePoints: [...barcode].map((char) => char.codePointAt(0)),
      catalog: { units: primary.length, aliases: aliases.length, legacyRows, identityKeyMismatches, conflictingIdentities: conflicts.length },
      indexPlans,
      conflicts: conflicts.slice(0, 20).map(([code, owners]) => ({ code, unitIds: [...owners] })),
      resolution: resolution.status === "FOUND" ? { status: resolution.status, unitId: resolution.owner.productUnitId, productId: resolution.owner.productId } : resolution,
      lookupMs: timings,
    }));
    if (identityKeyMismatches || indexPlans.some((plan) => !plan.key)) throw new Error("Barcode identity index verification failed");
    if (resolution.status !== "FOUND" || (expectedUnit != null && resolution.owner.productUnitId !== expectedUnit)) {
      throw new Error("Supplier barcode did not resolve to the expected unique unit");
    }
  } finally {
    await connection.rollback();
    await connection.end();
  }
}

main().catch((error: unknown) => {
  // Avoid logging driver connection options or credentials on operational failures.
  console.error(error instanceof Error ? error.message : "Supplier barcode verification failed");
  process.exitCode = 1;
});
