/**
 * CRUD for digitalWallets — admin management of prepaid wallets per provider x branch.
 * Deposit/withdrawal operations are in S9 (not here).
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import {
  digitalProviders,
  digitalWallets,
  branches,
  suppliers,
  auditLogs,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import type { Actor } from "../tx";
import { redactAuditValue } from "../auditService";

/* ────────── Types ────────── */
export interface CreateWalletInput {
  providerId: number;
  branchId: number;
  code: string;
  name: string;
  currency?: string;
}

export interface UpdateWalletInput {
  id: number;
  name?: string;
  isActive?: boolean;
}

export interface WalletFilters {
  providerId?: number;
  branchId?: number;
  isActive?: boolean;
}

/* ────────── Audit helper ────────── */
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
      entityType: "digitalWallet",
      entityId: String(entityId),
      newValue: redactAuditValue(details),
    });
  } catch {
    // best-effort
  }
}

/* ────────── Create ────────── */
export async function createWallet(
  tx: Tx,
  input: CreateWalletInput,
  actor: Actor,
): Promise<{ walletId: number }> {
  const code = input.code?.trim();
  const name = input.name?.trim();
  if (!code) throw new TRPCError({ code: "BAD_REQUEST", message: "رمز المحفظة مطلوب" });
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المحفظة مطلوب" });

  // Verify provider exists & is active
  const [provider] = await tx
    .select({
      id: digitalProviders.id,
      isActive: digitalProviders.isActive,
      settlementMode: digitalProviders.settlementMode,
    })
    .from(digitalProviders)
    .where(eq(digitalProviders.id, input.providerId))
    .limit(1);
  if (!provider) {
    throw new TRPCError({ code: "NOT_FOUND", message: "المزوّد غير موجود" });
  }
  if (!provider.isActive) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "المزوّد معطَّل" });
  }
  // Wallets only for prepaid providers
  if (provider.settlementMode !== "PREPAID") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "المحافظ متاحة فقط لمزوّدي الدفع المسبق (PREPAID)",
    });
  }

  // Verify branch exists
  const [branch] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.id, input.branchId))
    .limit(1);
  if (!branch) {
    throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });
  }

  // Unique constraint (providerId, branchId, code) enforced by DB,
  // but give a friendly error:
  const [dup] = await tx
    .select({ id: digitalWallets.id })
    .from(digitalWallets)
    .where(
      and(
        eq(digitalWallets.providerId, input.providerId),
        eq(digitalWallets.branchId, input.branchId),
        eq(digitalWallets.code, code),
      ),
    )
    .limit(1);
  if (dup) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "يوجد محفظة بنفس الرمز لهذا المزوّد والفرع",
    });
  }

  const result = await tx.insert(digitalWallets).values({
    providerId: input.providerId,
    branchId: input.branchId,
    code,
    name,
    currency: "IQD",
    currentBalance: "0",
    reservedBalance: "0",
    isActive: true,
  });
  const walletId = extractInsertId(result);

  await auditLog(tx, actor, "digitalCards.wallet.create", walletId, {
    providerId: input.providerId,
    branchId: input.branchId,
    code,
    name,
  });

  return { walletId };
}

/* ────────── Update ────────── */
export async function updateWallet(
  tx: Tx,
  input: UpdateWalletInput,
  actor: Actor,
): Promise<void> {
  const [existing] = await tx
    .select({ id: digitalWallets.id })
    .from(digitalWallets)
    .where(eq(digitalWallets.id, input.id))
    .limit(1);
  if (!existing) {
    throw new TRPCError({ code: "NOT_FOUND", message: "المحفظة غير موجودة" });
  }

  // Cannot change providerId, branchId, code after creation
  const set: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name?.trim();
    if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المحفظة مطلوب" });
    set.name = name;
  }
  if (input.isActive !== undefined) {
    set.isActive = input.isActive;
  }

  if (Object.keys(set).length === 0) return;

  await tx.update(digitalWallets).set(set).where(eq(digitalWallets.id, input.id));

  await auditLog(tx, actor, "digitalCards.wallet.update", input.id, {
    changes: set,
  });
}

/* ────────── List ────────── */
export async function listWallets(db: DB, filters?: WalletFilters) {
  const conds = [];
  if (filters?.providerId != null) {
    conds.push(eq(digitalWallets.providerId, filters.providerId));
  }
  if (filters?.branchId != null) {
    conds.push(eq(digitalWallets.branchId, filters.branchId));
  }
  if (filters?.isActive != null) {
    conds.push(eq(digitalWallets.isActive, filters.isActive));
  }

  return db
    .select({
      id: digitalWallets.id,
      providerId: digitalWallets.providerId,
      providerType: digitalProviders.providerType,
      providerName: suppliers.name,
      branchId: digitalWallets.branchId,
      branchName: branches.name,
      code: digitalWallets.code,
      name: digitalWallets.name,
      currency: digitalWallets.currency,
      currentBalance: digitalWallets.currentBalance,
      reservedBalance: digitalWallets.reservedBalance,
      isActive: digitalWallets.isActive,
      createdAt: digitalWallets.createdAt,
      updatedAt: digitalWallets.updatedAt,
    })
    .from(digitalWallets)
    .innerJoin(digitalProviders, eq(digitalWallets.providerId, digitalProviders.id))
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .innerJoin(branches, eq(digitalWallets.branchId, branches.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(digitalWallets.id);
}

/* ────────── Get single ────────── */
export async function getWallet(db: DB, id: number) {
  const [row] = await db
    .select({
      id: digitalWallets.id,
      providerId: digitalWallets.providerId,
      providerType: digitalProviders.providerType,
      supplierName: suppliers.name,
      branchId: digitalWallets.branchId,
      branchName: branches.name,
      code: digitalWallets.code,
      name: digitalWallets.name,
      currency: digitalWallets.currency,
      currentBalance: digitalWallets.currentBalance,
      reservedBalance: digitalWallets.reservedBalance,
      isActive: digitalWallets.isActive,
      createdAt: digitalWallets.createdAt,
      updatedAt: digitalWallets.updatedAt,
    })
    .from(digitalWallets)
    .innerJoin(digitalProviders, eq(digitalWallets.providerId, digitalProviders.id))
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .innerJoin(branches, eq(digitalWallets.branchId, branches.id))
    .where(eq(digitalWallets.id, id))
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "المحفظة غير موجودة" });
  }
  return row;
}
