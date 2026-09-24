/**
 * Forensic Remediation Script for Stale Funded Drafts (D10 Radar Anomaly)
 *
 * Targets:
 * 1. Draft 53 (DRF-1-20260909-00002):
 *    - Held deposit 25,000 IQD (TRANSFER Ref 4695, Receipt 9358)
 *    - Duplicate of Work Order 282 (delivered, Invoice 8024 paid 45,000 IQD under same Ref 4695)
 *    - Action: Refund deposit 25,000 IQD (paymentId: 63) + Cancel draft 53
 *
 * 2. Draft 28 (DRF-1-20260819-00001):
 *    - Held deposit 50,000 IQD (TRANSFER Ref 7717, Receipt 3936)
 *    - Customer Hadeel Miqdad (#157) later paid 24,000 IQD CASH on delivery for WO 364 (Invoice 11203)
 *    - Action: Refund deposit 50,000 IQD (paymentId: 22) + Cancel draft 28
 *
 * Usage:
 *   pnpm tsx scripts/remediate_stale_funded_drafts.ts --inspect
 *   pnpm tsx scripts/remediate_stale_funded_drafts.ts --apply-draft-53
 *   pnpm tsx scripts/remediate_stale_funded_drafts.ts --apply-draft-28
 *   pnpm tsx scripts/remediate_stale_funded_drafts.ts --apply-all
 */

import "dotenv/config";
import { getDb } from "../server/db";
import { eq, sql } from "drizzle-orm";
import { receptionDrafts, orderPayments, receipts } from "../drizzle/schema";
import { refundDeposit } from "../server/services/reception/deposits";
import { cancelDraft } from "../server/services/reception/draft";

async function inspect(db: NonNullable<ReturnType<typeof getDb>>) {
  console.log("\n========================================================");
  console.log("--- FORENSIC INSPECTION: STALE FUNDED DRAFTS (D10) ---");
  console.log("========================================================\n");

  const [d10Rows] = await db.execute(sql`
    SELECT x.draftId, x.draftNumber, x.userId, u.name AS userName,
      CAST(x.heldNet AS CHAR) AS heldNet, x.ageHours
    FROM (
      SELECT d.id AS draftId, d.draftNumber AS draftNumber, d.createdBy AS userId,
        (SELECT COALESCE(SUM(op.amount), 0) FROM orderPayments op
          WHERE op.draftId = d.id AND op.orderPayKind = 'COLLECTION'
            AND op.orderPayStatus IN ('HELD','REFUNDED'))
        - (SELECT COALESCE(SUM(op.amount), 0) FROM orderPayments op
          WHERE op.draftId = d.id AND op.orderPayKind = 'REFUND') AS heldNet,
        TIMESTAMPDIFF(HOUR, d.createdAt, NOW()) AS ageHours
      FROM receptionDrafts d
      WHERE d.draftStatus = 'OPEN' AND d.moneyLocked = 1
        AND d.createdAt < DATE_SUB(NOW(), INTERVAL 24 HOUR)
    ) x
    LEFT JOIN users u ON u.id = x.userId
    WHERE x.heldNet > 0
    ORDER BY x.ageHours DESC;
  `);

  console.log("Active D10 Radar Anomalies:", JSON.stringify(d10Rows, null, 2));

  for (const draftId of [28, 53]) {
    const draft = (
      await db.select().from(receptionDrafts).where(eq(receptionDrafts.id, draftId))
    )[0];
    const payments = await db
      .select()
      .from(orderPayments)
      .where(eq(orderPayments.draftId, draftId));

    console.log(`\n--- Draft ID ${draftId} Summary ---`);
    console.log("Draft Header:", draft ? {
      id: draft.id,
      draftNumber: draft.draftNumber,
      status: draft.status,
      moneyLocked: draft.moneyLocked,
      version: draft.version,
      total: draft.total,
      contactName: draft.contactName,
      contactPhone: draft.contactPhone,
      createdAt: draft.createdAt,
    } : "NOT FOUND");
    console.log("Payments:", payments.map((p) => ({
      id: p.id,
      kind: p.kind,
      amount: p.amount,
      method: p.method,
      status: p.status,
      receiptId: p.receiptId,
      parentPaymentId: p.parentPaymentId,
      createdAt: p.createdAt,
    })));
  }
}

async function remediateDraft53() {
  console.log("\n>>> Executing Atomic Remediation for Draft 53 (DRF-1-20260909-00002)...");
  const adminActor = { userId: 1, branchId: 1, role: "admin" as const };

  const db = getDb();
  if (!db) throw new Error("DB unavailable");

  const draft = (
    await db.select().from(receptionDrafts).where(eq(receptionDrafts.id, 53))
  )[0];
  if (!draft) throw new Error("Draft 53 not found");

  if (draft.status !== "OPEN") {
    console.log(`Draft 53 status is already ${draft.status}. Skipping.`);
    return;
  }

  // 1. Refund the 25,000 IQD held deposit (paymentId: 63)
  console.log("1. Calling refundDeposit for paymentId 63 (25,000 IQD)...");
  const refundResult = await refundDeposit(
    {
      paymentId: 63,
      amount: "25000.00",
      reason: "إلغاء قيد عربون مكرر لتحويل #4695 (طُبق بالكامل على أمر شغل #282 وفاتورة #8024)",
      clientRequestId: `remediate-drf53-ref-${Date.now()}`,
    },
    adminActor,
    { authorizedByManager: true },
  );
  console.log("Refund Result:", refundResult);

  // Re-read draft for updated version
  const freshDraft = (
    await db.select().from(receptionDrafts).where(eq(receptionDrafts.id, 53))
  )[0]!;

  // 2. Cancel Draft 53
  console.log(`2. Calling cancelDraft for draftId 53 (version: ${freshDraft.version})...`);
  const cancelResult = await cancelDraft(
    {
      draftId: 53,
      version: freshDraft.version,
      reason: "مسودة مكررة تم تنفيذها ومحاسبتها عبر أمر الشغل #282 وفاتورة #8024",
    },
    adminActor,
  );
  console.log("Cancel Result:", cancelResult);
  console.log(">>> Draft 53 Remediation Complete! ✅");
}

async function remediateDraft28() {
  console.log("\n>>> Executing Atomic Remediation for Draft 28 (DRF-1-20260819-00001)...");
  const adminActor = { userId: 1, branchId: 1, role: "admin" as const };

  const db = getDb();
  if (!db) throw new Error("DB unavailable");

  const draft = (
    await db.select().from(receptionDrafts).where(eq(receptionDrafts.id, 28))
  )[0];
  if (!draft) throw new Error("Draft 28 not found");

  if (draft.status !== "OPEN") {
    console.log(`Draft 28 status is already ${draft.status}. Skipping.`);
    return;
  }

  // 1. Refund the 50,000 IQD held deposit (paymentId: 22)
  console.log("1. Calling refundDeposit for paymentId 22 (50,000 IQD)...");
  const refundResult = await refundDeposit(
    {
      paymentId: 22,
      amount: "50000.00",
      reason: "استرداد عربون تحويل معلق لمسوّدة ملغاة (العميلة سددت نقداً لطلب مستقل #5272)",
      clientRequestId: `remediate-drf28-ref-${Date.now()}`,
    },
    adminActor,
    { authorizedByManager: true },
  );
  console.log("Refund Result:", refundResult);

  // Re-read draft for updated version
  const freshDraft = (
    await db.select().from(receptionDrafts).where(eq(receptionDrafts.id, 28))
  )[0]!;

  // 2. Cancel Draft 28
  console.log(`2. Calling cancelDraft for draftId 28 (version: ${freshDraft.version})...`);
  const cancelResult = await cancelDraft(
    {
      draftId: 28,
      version: freshDraft.version,
      reason: "إلغاء مسودة معلقة بعد استرداد العربون - استبدلت بطلب خدمة #5272 المسدد نقداً",
    },
    adminActor,
  );
  console.log("Cancel Result:", cancelResult);
  console.log(">>> Draft 28 Remediation Complete! ✅");
}

async function main() {
  const db = getDb();
  if (!db) {
    throw new Error("Could not initialize database connection.");
  }

  const args = process.argv.slice(2);
  const doInspect = args.includes("--inspect") || args.length === 0;
  const do53 = args.includes("--apply-draft-53") || args.includes("--apply-all");
  const do28 = args.includes("--apply-draft-28") || args.includes("--apply-all");

  if (doInspect && !do53 && !do28) {
    await inspect(db);
    console.log("\nTo apply remediation, run with:");
    console.log("  pnpm tsx scripts/remediate_stale_funded_drafts.ts --apply-draft-53");
    console.log("  pnpm tsx scripts/remediate_stale_funded_drafts.ts --apply-draft-28");
    console.log("  pnpm tsx scripts/remediate_stale_funded_drafts.ts --apply-all");
    process.exit(0);
  }

  if (do53) {
    await remediateDraft53();
  }

  if (do28) {
    await remediateDraft28();
  }

  console.log("\nPost-remediation inspection:");
  await inspect(db);
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL Remediation Error:", err);
  process.exit(1);
});
