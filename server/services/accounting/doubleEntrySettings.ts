import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { doubleEntrySettings } from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import type { Tx } from "../../db";
import { logAuditTx } from "../auditService";
import { canActivate } from "./activationGate";

type AuditContext = Pick<TrpcContext, "user" | "req">;

interface ChangeOptions {
  actorId: number;
  now?: Date;
  auditContext: AuditContext;
}

async function lockedSettings(tx: Tx) {
  let row = (await tx
    .select()
    .from(doubleEntrySettings)
    .where(eq(doubleEntrySettings.id, 1))
    .for("update")
    .limit(1))[0];
  if (!row) {
    await tx.insert(doubleEntrySettings).values({ id: 1, mode: "OFF" });
    row = (await tx
      .select()
      .from(doubleEntrySettings)
      .where(eq(doubleEntrySettings.id, 1))
      .for("update")
      .limit(1))[0];
  }
  return row;
}

/** الانتقال اليدوي الوحيد لبدء الدورة: OFF → SHADOW، مع تدقيق إلزامي داخل المعاملة نفسها. */
export async function startDoubleEntryShadow(tx: Tx, options: ChangeOptions) {
  const current = await lockedSettings(tx);
  if (current.mode !== "OFF") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "يبدأ وضع الظل من OFF فقط." });
  }
  const now = options.now ?? new Date();
  await tx
    .update(doubleEntrySettings)
    .set({ mode: "SHADOW", shadowStartedAt: now, updatedBy: options.actorId })
    .where(eq(doubleEntrySettings.id, 1));
  await logAuditTx(tx, options.auditContext, {
    action: "doubleEntry.shadow.start",
    entityType: "doubleEntrySettings",
    entityId: 1,
    oldValue: { mode: current.mode, shadowStartedAt: current.shadowStartedAt },
    newValue: { mode: "SHADOW", shadowStartedAt: now },
  });
  return { mode: "SHADOW" as const, shadowStartedAt: now.toISOString() };
}

/** SHADOW → ACTIVE فقط، وبعد إعادة فحص البوابة داخل معاملة التغيير نفسها. */
export async function activateDoubleEntry(tx: Tx, options: ChangeOptions) {
  const current = await lockedSettings(tx);
  if (current.mode !== "SHADOW") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن اعتماد ACTIVE قبل وضع الظل." });
  }
  const now = options.now ?? new Date();
  const gate = await canActivate({ tx, now });
  if (!gate.ok) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `بوابة ACTIVE محجوبة: ${gate.blockers.map((item) => item.label).join("، ")}`,
    });
  }
  await tx
    .update(doubleEntrySettings)
    .set({ mode: "ACTIVE", updatedBy: options.actorId })
    .where(eq(doubleEntrySettings.id, 1));
  await logAuditTx(tx, options.auditContext, {
    action: "doubleEntry.activate",
    entityType: "doubleEntrySettings",
    entityId: 1,
    oldValue: { mode: current.mode, shadowStartedAt: current.shadowStartedAt },
    newValue: { mode: "ACTIVE", gate },
  });
  return { mode: "ACTIVE" as const, gate };
}
