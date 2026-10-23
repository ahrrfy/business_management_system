import { eq } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { closeDb, getDb } from "../server/db";
import { repairHistoricalFeeWithholding } from "../server/services/delivery/historicalFeeWithholding";

const targets = [
  {
    consignmentId: 588,
    remittanceId: 68,
    receiptInId: 17107,
    shiftId: 767,
    fee: "2000",
    batchGross: "280000",
    actualBatchNet: "278000",
  },
  {
    consignmentId: 780,
    remittanceId: 83,
    receiptInId: 21836,
    shiftId: 829,
    fee: "5000",
    batchGross: "1001750",
    actualBatchNet: "996750",
  },
  {
    consignmentId: 821,
    remittanceId: 85,
    receiptInId: 22120,
    shiftId: 842,
    fee: "5000",
    batchGross: "405250",
    actualBatchNet: "400250",
  },
];

try {
  const apply = process.argv.includes("--apply");
  if (process.argv.slice(2).some((arg) => arg !== "--apply"))
    throw new Error("Only --apply is supported; default is read-only preview");
  const db = getDb();
  if (!db) throw new Error("Database unavailable");
  const owner = (
    await db
      .select({ id: users.id, role: users.role, branchId: users.branchId })
      .from(users)
      .where(eq(users.id, 1))
      .limit(1)
  )[0];
  if (!owner || owner.role !== "admin")
    throw new Error("Expected verified administrator 1");
  const result = await repairHistoricalFeeWithholding(
    targets,
    {
      userId: Number(owner.id),
      role: "admin",
      branchId: owner.branchId == null ? null : Number(owner.branchId),
    },
    {
      apply,
      evidence:
        "Owner explicitly confirmed actual net remittances 68=278000,83=996750,85=400250 after fees 2000,5000,5000 in Codex chat on 2026-10-23. Correct overstated treasury book cash; preserve closed drawers, approved handovers, customer/COD and original expense.",
    },
  );
  process.stdout.write(JSON.stringify({ apply, result }, null, 2) + "\n");
} finally {
  await closeDb();
}
