import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { doubleEntrySettings, journalEntries } from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb, type DB, type Tx } from "../../db";
import { logAuditTx } from "../auditService";
import { canActivate } from "./activationGate";
import {
  writeShadowOpeningJournal,
  writeShadowOpeningMemo,
} from "./journalStore";
import { previewShadowOpening } from "./shadowOpening";
import type { ShadowOpeningAllocation } from "./shadowOpening";
import { POSTING_POLICY_HASH } from "./postingEngine";
import { lockFinancialPostingGate } from "../reports/monthCloseGate";

type AuditContext = Pick<TrpcContext, "user" | "req">;

interface ChangeOptions {
  actorId: number;
  now?: Date;
  auditContext: AuditContext;
}

interface PrepareShadowOptions {
  actorId: number;
  now?: Date;
  db?: DB;
  allocations?: ShadowOpeningAllocation[];
}

interface StartShadowOptions extends ChangeOptions {
  preparationToken: string;
  expectedOpeningHash: string;
  allocations: ShadowOpeningAllocation[];
}

interface StopOptions extends ChangeOptions {
  reason: string;
}

interface ApprovePolicyOptions extends ChangeOptions {
  reference: string;
  accountantName: string;
}

interface ClearPolicyApprovalOptions extends ChangeOptions {
  reason: string;
}

const OPENING_PREPARATION_TTL_MS = 15 * 60 * 1000;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[a-f0-9]{64}$/;

interface OpeningPreparationPayload {
  version: 1;
  actorId: number;
  cycleId: string;
  asOf: string;
  openingHash: string;
  allocations: ShadowOpeningAllocation[];
  expiresAt: number;
}

function preparationSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET مطلوب لتوقيع معاينة الافتتاح.");
  }
  return secret;
}

function signOpeningPreparation(payload: OpeningPreparationPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", preparationSecret())
    .update(`double-entry-opening:${encoded}`, "utf8")
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyOpeningPreparation(
  token: string,
  actorId: number,
  now: Date,
): OpeningPreparationPayload {
  try {
    const [encoded, signature, trailing] = token.split(".");
    if (!encoded || !signature || trailing !== undefined)
      throw new Error("format");
    const supplied = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", preparationSecret())
      .update(`double-entry-opening:${encoded}`, "utf8")
      .digest();
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new Error("signature");
    }
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as OpeningPreparationPayload;
    if (
      payload.version !== 1 ||
      payload.actorId !== actorId ||
      !UUID_V4.test(payload.cycleId) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(payload.asOf) ||
      !SHA256_HEX.test(payload.openingHash) ||
      !Array.isArray(payload.allocations) ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.expiresAt < now.getTime()
    ) {
      throw new Error("payload");
    }
    return payload;
  } catch {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "انتهت أو تلفت معاينة الافتتاح؛ أعد إعداد المعاينة قبل البدء.",
    });
  }
}

async function lockedSettings(tx: Tx) {
  // Mode transitions use the same company gate and lock order as postEntry.
  // This prevents a settings -> close-gate inversion against financial writers.
  await lockFinancialPostingGate(tx);
  let row = (
    await tx
      .select()
      .from(doubleEntrySettings)
      .where(eq(doubleEntrySettings.id, 1))
      .for("update")
      .limit(1)
  )[0];
  if (!row) {
    await tx
      .insert(doubleEntrySettings)
      .values({ id: 1, mode: "OFF" })
      .onDuplicateKeyUpdate({ set: { id: 1 } });
    row = (
      await tx
        .select()
        .from(doubleEntrySettings)
        .where(eq(doubleEntrySettings.id, 1))
        .for("update")
        .limit(1)
    )[0];
  }
  return row;
}

/** يولّد دورة مقترحة موقعة ويعرض لقطة القطع بلا أي كتابة أو تغييرٍ للوضع. */
export async function prepareDoubleEntryShadowOpening(
  options: PrepareShadowOptions,
) {
  const db = options.db ?? getDb();
  if (!db) throw new Error("DATABASE_URL not set");
  const now = options.now ?? new Date();
  const current = (
    await db
      .select({ mode: doubleEntrySettings.mode })
      .from(doubleEntrySettings)
      .where(eq(doubleEntrySettings.id, 1))
      .limit(1)
  )[0];
  if (current && current.mode !== "OFF") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "تُعد لقطة افتتاح دورة جديدة من وضع OFF فقط.",
    });
  }
  const cycleId = randomUUID();
  const preview = await previewShadowOpening({
    cycleId,
    allocations: options.allocations ?? [],
    db,
  });
  const expiresAt = now.getTime() + OPENING_PREPARATION_TTL_MS;
  return {
    preview,
    preparationToken: signOpeningPreparation({
      version: 1,
      actorId: options.actorId,
      cycleId,
      asOf: preview.asOf,
      openingHash: preview.openingHash,
      allocations: preview.manualAllocations,
      expiresAt,
    }),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/** OFF → SHADOW بعد إعادة بناء اللقطة الموقعة ومطابقتها، وكل ذلك داخل المعاملة نفسها. */
export async function startDoubleEntryShadow(
  tx: Tx,
  options: StartShadowOptions,
) {
  const current = await lockedSettings(tx);
  if (current.mode !== "OFF") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "يبدأ وضع الظل من OFF فقط.",
    });
  }
  const now = options.now ?? new Date();
  const prepared = verifyOpeningPreparation(
    options.preparationToken,
    options.actorId,
    now,
  );
  const expectedOpeningHash = options.expectedOpeningHash.trim();
  if (
    !SHA256_HEX.test(expectedOpeningHash) ||
    expectedOpeningHash !== prepared.openingHash
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "بصمة الافتتاح المؤكدة لا تطابق المعاينة الموقعة.",
    });
  }
  const collision = (
    await tx
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.cycleId, prepared.cycleId))
      .limit(1)
  )[0];
  if (collision) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "معرّف دورة المعاينة مستخدم؛ أعد إعداد معاينة جديدة.",
    });
  }
  const preview = await previewShadowOpening({
    cycleId: prepared.cycleId,
    asOf: prepared.asOf,
    allocations: options.allocations,
    db: tx,
  });
  const allocationsMatch =
    JSON.stringify(preview.manualAllocations) ===
    JSON.stringify(prepared.allocations);
  if (
    !preview.canApprove ||
    preview.openingHash !== expectedOpeningHash ||
    !allocationsMatch ||
    preview.journalGroups.length === 0
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        preview.openingHash !== expectedOpeningHash
          ? "تغيرت الأرصدة منذ المعاينة؛ راجع لقطة جديدة ثم أكدها."
          : !allocationsMatch
            ? "تخصيص الرصيد الافتتاحي لا يطابق المعاينة الموقعة."
            : `لقطة الافتتاح محجوبة: ${preview.blockers.map((item) => item.message).join("، ") || "لا توجد مجموعة افتتاح صالحة"}`,
    });
  }
  const zeroOpening = preview.lines.length === 0;
  const zeroCertificateIsValid =
    zeroOpening &&
    preview.journalGroups.length === 1 &&
    preview.journalGroups[0].branchId === null &&
    preview.journalGroups[0].lines.length === 0 &&
    preview.journalGroups[0].debit === "0.00" &&
    preview.journalGroups[0].credit === "0.00" &&
    preview.totals.debit === "0.00" &&
    preview.totals.credit === "0.00" &&
    preview.totals.isBalanced;
  if (
    (zeroOpening && !zeroCertificateIsValid) ||
    (!zeroOpening &&
      preview.journalGroups.some((group) => group.lines.length === 0))
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "بنية مجموعات لقطة الافتتاح غير صالحة للكتابة.",
    });
  }
  const entryDate = new Date(`${preview.asOf}T00:00:00.000Z`);
  for (const group of preview.journalGroups) {
    if (zeroOpening) {
      await writeShadowOpeningMemo(tx, {
        cycleId: prepared.cycleId,
        sourceKey: group.sourceKey,
        entryDate,
        branchId: group.branchId,
      });
    } else {
      await writeShadowOpeningJournal(tx, {
        cycleId: prepared.cycleId,
        sourceKey: group.sourceKey,
        entryDate,
        branchId: group.branchId,
        lines: group.lines,
      });
    }
  }
  await tx
    .update(doubleEntrySettings)
    .set({
      mode: "SHADOW",
      shadowStartedAt: now,
      shadowCycleId: prepared.cycleId,
      shadowOpeningHash: preview.openingHash,
      // المصادقة البشرية مرتبطة بسياسات/بصمة الدورة التي راجعتها؛ لا تُورَّث إلى دورة جديدة.
      policyApprovalReference: null,
      policyApprovalPolicyHash: null,
      policyApprovalCycleId: null,
      policyApprovalOpeningHash: null,
      policyAccountantName: null,
      policyApprovedAt: null,
      policyApprovedBy: null,
      updatedBy: options.actorId,
    })
    .where(eq(doubleEntrySettings.id, 1));
  await logAuditTx(tx, options.auditContext, {
    action: "doubleEntry.shadow.start",
    entityType: "doubleEntrySettings",
    entityId: 1,
    oldValue: { mode: current.mode, shadowStartedAt: current.shadowStartedAt },
    newValue: {
      mode: "SHADOW",
      shadowStartedAt: now,
      cycleId: prepared.cycleId,
      openingAsOf: preview.asOf,
      openingHash: preview.openingHash,
      openingEntries: preview.journalGroups.length,
      openingLines: preview.lines.length,
      openingDebit: preview.totals.debit,
      openingCredit: preview.totals.credit,
      openingAllocations: preview.manualAllocations,
      previousPolicyApprovalCleared: Boolean(
        current.policyApprovalReference || current.policyApprovedAt,
      ),
    },
  });
  return {
    mode: "SHADOW" as const,
    shadowStartedAt: now.toISOString(),
    cycleId: prepared.cycleId,
    openingHash: preview.openingHash,
    openingAsOf: preview.asOf,
  };
}

/** SHADOW → ACTIVE فقط، وبعد إعادة فحص البوابة داخل معاملة التغيير نفسها. */
export async function activateDoubleEntry(tx: Tx, options: ChangeOptions) {
  const current = await lockedSettings(tx);
  if (current.mode !== "SHADOW") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "لا يمكن اعتماد ACTIVE قبل وضع الظل.",
    });
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

/**
 * إيقافٌ تشغيليّ مدقَّق من SHADOW أو ACTIVE إلى OFF.
 * لا تُحذف اليوميات التاريخية؛ إيقاف الكتابة الجديدة لا يغيّر حقيقةً محاسبيةً سبق تسجيلها.
 */
export async function stopDoubleEntry(tx: Tx, options: StopOptions) {
  const current = await lockedSettings(tx);
  if (current.mode === "OFF") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "الدفتر المزدوج متوقف بالفعل.",
    });
  }

  const reason = options.reason.trim();
  if (reason.length < 10) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب إيقاف الدفتر المزدوج يجب ألا يقل عن 10 أحرف.",
    });
  }
  if (reason.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب الإيقاف يجب ألا يتجاوز 500 محرف.",
    });
  }

  await tx
    .update(doubleEntrySettings)
    .set({
      mode: "OFF",
      shadowStartedAt: null,
      shadowCycleId: null,
      shadowOpeningHash: null,
      policyApprovalReference: null,
      policyApprovalPolicyHash: null,
      policyApprovalCycleId: null,
      policyApprovalOpeningHash: null,
      policyAccountantName: null,
      policyApprovedAt: null,
      policyApprovedBy: null,
      updatedBy: options.actorId,
    })
    .where(eq(doubleEntrySettings.id, 1));
  await logAuditTx(tx, options.auditContext, {
    action: "doubleEntry.stop",
    entityType: "doubleEntrySettings",
    entityId: 1,
    oldValue: {
      mode: current.mode,
      shadowStartedAt: current.shadowStartedAt,
      cycleId: current.shadowCycleId,
      openingHash: current.shadowOpeningHash,
    },
    newValue: {
      mode: "OFF",
      shadowStartedAt: null,
      cycleId: null,
      openingHash: null,
      reason,
    },
  });
  return { mode: "OFF" as const };
}

/** يسجل مرجع المصادقة البشرية؛ لا يدّعي اعتماداً معيارياً أو حكومياً. */
export async function approveDoubleEntryPolicy(
  tx: Tx,
  options: ApprovePolicyOptions,
) {
  const current = await lockedSettings(tx);
  if (
    current.mode !== "SHADOW" ||
    !current.shadowCycleId ||
    !current.shadowOpeningHash
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "تُسجّل مصادقة السياسة داخل دورة SHADOW ذات لقطة افتتاح مثبتة فقط.",
    });
  }
  const reference = options.reference.trim();
  const accountantName = options.accountantName.trim();
  if (reference.length < 10 || reference.length > 255) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مرجع المصادقة يجب أن يكون بين 10 و255 محرفاً.",
    });
  }
  if (accountantName.length < 3 || accountantName.length > 150) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "اسم المحاسب يجب أن يكون بين 3 و150 محرفاً.",
    });
  }
  const now = options.now ?? new Date();
  await tx
    .update(doubleEntrySettings)
    .set({
      policyApprovalReference: reference,
      policyApprovalPolicyHash: POSTING_POLICY_HASH,
      policyApprovalCycleId: current.shadowCycleId,
      policyApprovalOpeningHash: current.shadowOpeningHash,
      policyAccountantName: accountantName,
      policyApprovedAt: now,
      policyApprovedBy: options.actorId,
      updatedBy: options.actorId,
    })
    .where(eq(doubleEntrySettings.id, 1));
  await logAuditTx(tx, options.auditContext, {
    action: "doubleEntry.policy.approve",
    entityType: "doubleEntrySettings",
    entityId: 1,
    oldValue: {
      reference: current.policyApprovalReference,
      accountantName: current.policyAccountantName,
      approvedAt: current.policyApprovedAt,
      approvedBy: current.policyApprovedBy,
    },
    newValue: {
      reference,
      accountantName,
      approvedAt: now,
      approvedBy: options.actorId,
      cycleId: current.shadowCycleId,
      openingHash: current.shadowOpeningHash,
      policyHash: POSTING_POLICY_HASH,
    },
  });
  return {
    reference,
    accountantName,
    approvedAt: now.toISOString(),
    approvedBy: options.actorId,
    cycleId: current.shadowCycleId,
    openingHash: current.shadowOpeningHash,
    policyHash: POSTING_POLICY_HASH,
  };
}

export async function clearDoubleEntryPolicyApproval(
  tx: Tx,
  options: ClearPolicyApprovalOptions,
) {
  const current = await lockedSettings(tx);
  if (current.mode === "ACTIVE") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "أوقف ACTIVE أولاً قبل مسح مصادقة السياسة.",
    });
  }
  const reason = options.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب مسح المصادقة يجب أن يكون بين 10 و500 محرف.",
    });
  }
  await tx
    .update(doubleEntrySettings)
    .set({
      policyApprovalReference: null,
      policyApprovalPolicyHash: null,
      policyApprovalCycleId: null,
      policyApprovalOpeningHash: null,
      policyAccountantName: null,
      policyApprovedAt: null,
      policyApprovedBy: null,
      updatedBy: options.actorId,
    })
    .where(eq(doubleEntrySettings.id, 1));
  await logAuditTx(tx, options.auditContext, {
    action: "doubleEntry.policy.clear",
    entityType: "doubleEntrySettings",
    entityId: 1,
    oldValue: {
      reference: current.policyApprovalReference,
      accountantName: current.policyAccountantName,
      approvedAt: current.policyApprovedAt,
      approvedBy: current.policyApprovedBy,
    },
    newValue: { cleared: true, reason },
  });
  return { cleared: true as const };
}
