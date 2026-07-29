/**
 * CRUD for digitalProviders — admin management of digital card/subscription providers.
 * Each provider maps to exactly one supplier in the system.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import {
  digitalProviders,
  suppliers,
  auditLogs,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { redactAuditValue } from "../auditService";

/* ────────── Enum validation ────────── */
const PROVIDER_TYPES = ["TELECOM", "GLOBAL_CARDS", "EDUCATIONAL", "OTHER"] as const;
const SETTLEMENT_MODES = ["PREPAID", "POSTPAID"] as const;
const RECOGNITION_MODES = ["PRINCIPAL_GROSS"] as const;
const REFERENCE_POLICIES = ["REQUIRED", "OPTIONAL", "NONE"] as const;
const SETTLEMENT_CYCLES = ["DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "ON_DEMAND"] as const;

function assertEnum<T extends string>(val: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(val as T)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${label} غير صالح: ${val}` });
  }
  return val as T;
}

/* ────────── Types ────────── */
export interface CreateProviderInput {
  supplierId: number;
  providerType: string;
  settlementMode: string;
  recognitionMode: string;
  referencePolicy: string;
  settlementCycle: string;
  lowBalanceThreshold?: string | null;
  notes?: string | null;
}

export interface UpdateProviderInput {
  id: number;
  providerType?: string;
  settlementMode?: string;
  recognitionMode?: string;
  referencePolicy?: string;
  settlementCycle?: string;
  lowBalanceThreshold?: string | null;
  isActive?: boolean;
  notes?: string | null;
}

/* ────────── Audit helper (best-effort inside tx) ────────── */
async function auditLog(
  tx: Tx,
  actor: Actor,
  action: string,
  entityId: number,
  details: unknown,
): Promise<void> {
  try {
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId,
      action,
      entityType: "digitalProvider",
      entityId: String(entityId),
      newValue: redactAuditValue(details),
    });
  } catch {
    // best-effort: audit failure must not break the business operation
  }
}

/* ────────── Create ────────── */
export async function createProvider(
  tx: Tx,
  input: CreateProviderInput,
  actor: Actor,
): Promise<{ providerId: number }> {
  // Validate enums
  const providerType = assertEnum(input.providerType, PROVIDER_TYPES, "نوع المزوّد");
  const settlementMode = assertEnum(input.settlementMode, SETTLEMENT_MODES, "نمط التسوية");
  const recognitionMode = assertEnum(input.recognitionMode, RECOGNITION_MODES, "نمط الاعتراف");
  const referencePolicy = assertEnum(input.referencePolicy, REFERENCE_POLICIES, "سياسة المرجع");
  const settlementCycle = assertEnum(input.settlementCycle, SETTLEMENT_CYCLES, "دورية التسوية");

  // lowBalanceThreshold must be >= 0
  const threshold = money(input.lowBalanceThreshold ?? "0");
  if (threshold.lt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "حدّ الرصيد المنخفض يجب أن يكون >= 0" });
  }

  // Verify supplier exists and is active
  const [supplier] = await tx
    .select({ id: suppliers.id, isActive: suppliers.isActive, name: suppliers.name })
    .from(suppliers)
    .where(eq(suppliers.id, input.supplierId))
    .limit(1);
  if (!supplier) {
    throw new TRPCError({ code: "NOT_FOUND", message: "المورّد غير موجود" });
  }
  if (!supplier.isActive) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "المورّد معطَّل — فعّله أولاً" });
  }

  const result = await tx.insert(digitalProviders).values({
    supplierId: input.supplierId,
    providerType,
    settlementMode,
    recognitionMode,
    referencePolicy,
    settlementCycle,
    lowBalanceThreshold: toDbMoney(threshold),
    notes: input.notes?.trim() || null,
    createdBy: actor.userId,
  });
  const providerId = extractInsertId(result);

  await auditLog(tx, actor, "digitalCards.provider.create", providerId, {
    supplierId: input.supplierId,
    providerType,
    settlementMode,
  });

  return { providerId };
}

/* ────────── Update ────────── */
export async function updateProvider(
  tx: Tx,
  input: UpdateProviderInput,
  actor: Actor,
): Promise<void> {
  const [existing] = await tx
    .select()
    .from(digitalProviders)
    .where(eq(digitalProviders.id, input.id))
    .limit(1);
  if (!existing) {
    throw new TRPCError({ code: "NOT_FOUND", message: "المزوّد غير موجود" });
  }

  // Build update set — supplierId is immutable
  const set: Record<string, unknown> = {};
  if (input.providerType !== undefined) {
    set.providerType = assertEnum(input.providerType, PROVIDER_TYPES, "نوع المزوّد");
  }
  if (input.settlementMode !== undefined) {
    set.settlementMode = assertEnum(input.settlementMode, SETTLEMENT_MODES, "نمط التسوية");
  }
  if (input.recognitionMode !== undefined) {
    set.recognitionMode = assertEnum(input.recognitionMode, RECOGNITION_MODES, "نمط الاعتراف");
  }
  if (input.referencePolicy !== undefined) {
    set.referencePolicy = assertEnum(input.referencePolicy, REFERENCE_POLICIES, "سياسة المرجع");
  }
  if (input.settlementCycle !== undefined) {
    set.settlementCycle = assertEnum(input.settlementCycle, SETTLEMENT_CYCLES, "دورية التسوية");
  }
  if (input.lowBalanceThreshold !== undefined) {
    const threshold = money(input.lowBalanceThreshold ?? "0");
    if (threshold.lt(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "حدّ الرصيد المنخفض يجب أن يكون >= 0" });
    }
    set.lowBalanceThreshold = toDbMoney(threshold);
  }
  if (input.isActive !== undefined) {
    set.isActive = input.isActive;
  }
  if (input.notes !== undefined) {
    set.notes = input.notes?.trim() || null;
  }

  if (Object.keys(set).length === 0) return;

  await tx.update(digitalProviders).set(set).where(eq(digitalProviders.id, input.id));

  await auditLog(tx, actor, "digitalCards.provider.update", input.id, {
    changes: set,
  });
}

/* ────────── List ────────── */
export async function listProviders(db: DB) {
  return db
    .select({
      id: digitalProviders.id,
      supplierId: digitalProviders.supplierId,
      supplierName: suppliers.name,
      providerType: digitalProviders.providerType,
      settlementMode: digitalProviders.settlementMode,
      recognitionMode: digitalProviders.recognitionMode,
      referencePolicy: digitalProviders.referencePolicy,
      settlementCycle: digitalProviders.settlementCycle,
      lowBalanceThreshold: digitalProviders.lowBalanceThreshold,
      isActive: digitalProviders.isActive,
      notes: digitalProviders.notes,
      createdAt: digitalProviders.createdAt,
      updatedAt: digitalProviders.updatedAt,
    })
    .from(digitalProviders)
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .orderBy(digitalProviders.id);
}

/* ────────── Get single ────────── */
export async function getProvider(db: DB, id: number) {
  const [row] = await db
    .select({
      id: digitalProviders.id,
      supplierId: digitalProviders.supplierId,
      supplierName: suppliers.name,
      supplierPhone: suppliers.phone,
      providerType: digitalProviders.providerType,
      settlementMode: digitalProviders.settlementMode,
      recognitionMode: digitalProviders.recognitionMode,
      referencePolicy: digitalProviders.referencePolicy,
      settlementCycle: digitalProviders.settlementCycle,
      lowBalanceThreshold: digitalProviders.lowBalanceThreshold,
      isActive: digitalProviders.isActive,
      notes: digitalProviders.notes,
      createdBy: digitalProviders.createdBy,
      createdAt: digitalProviders.createdAt,
      updatedAt: digitalProviders.updatedAt,
    })
    .from(digitalProviders)
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .where(eq(digitalProviders.id, id))
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "المزوّد غير موجود" });
  }
  return row;
}
