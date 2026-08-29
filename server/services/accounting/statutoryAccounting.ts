import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import {
  accounts,
  journalLines,
  statutoryAccountingProfiles,
  statutoryAccountMappings,
  statutoryAccounts,
} from "../../../drizzle/schema";
import { getDb, type Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import type { JournalLine } from "./postingEngine";

export type StatutoryAccountType =
  | "ASSET"
  | "LIABILITY"
  | "EQUITY"
  | "REVENUE"
  | "EXPENSE";

export interface ImportedStatutoryAccount {
  code: string;
  name: string;
  type: StatutoryAccountType;
  normalBalance: "DEBIT" | "CREDIT";
  parentCode?: string | null;
  isPosting?: boolean;
  sortOrder?: number;
  notes?: string | null;
}

export interface MappingInput {
  internalAccountId: number;
  statutoryAccountId: number;
  rationale?: string | null;
}

type DbExecutor = NonNullable<ReturnType<typeof getDb>> | Tx;

function requireDb(): NonNullable<ReturnType<typeof getDb>> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL غير مضبوط");
  return db;
}

function cleanRequired(value: string, label: string, max: number): string {
  const cleaned = value.trim();
  if (!cleaned) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${label} مطلوب.` });
  }
  if (cleaned.length > max) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} يتجاوز ${max} محرفاً.`,
    });
  }
  return cleaned;
}

async function lockedDraft(tx: Tx, profileId: number) {
  const row = (
    await tx
      .select()
      .from(statutoryAccountingProfiles)
      .where(eq(statutoryAccountingProfiles.id, profileId))
      .for("update")
      .limit(1)
  )[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "إصدار الدليل غير موجود." });
  }
  if (row.status !== "DRAFT") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "الإصدار المعتمد أو المتقاعد غير قابل للتعديل؛ أنشئ إصداراً جديداً.",
    });
  }
  return row;
}

export async function createStatutoryProfile(
  tx: Tx,
  input: {
    profileKey: string;
    version: number;
    name: string;
    authorityReference: string;
    effectiveFrom: string;
  },
  actorId: number,
) {
  const profileKey = cleanRequired(input.profileKey, "مفتاح الدليل", 64).toUpperCase();
  const name = cleanRequired(input.name, "اسم الدليل", 160);
  const authorityReference = cleanRequired(
    input.authorityReference,
    "مرجع الجهة/التعليمات",
    255,
  );
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "رقم الإصدار يجب أن يكون موجباً." });
  }
  const duplicate = (
    await tx
      .select({ id: statutoryAccountingProfiles.id })
      .from(statutoryAccountingProfiles)
      .where(
        and(
          eq(statutoryAccountingProfiles.profileKey, profileKey),
          eq(statutoryAccountingProfiles.version, input.version),
        ),
      )
      .limit(1)
  )[0];
  if (duplicate) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "يوجد إصدار بنفس المفتاح والرقم.",
    });
  }
  const result = await tx.insert(statutoryAccountingProfiles).values({
    profileKey,
    version: input.version,
    name,
    authorityReference,
    effectiveFrom: input.effectiveFrom,
    status: "DRAFT",
    createdBy: actorId,
  });
  return { id: extractInsertId(result) };
}

function validateImportedAccounts(rows: readonly ImportedStatutoryAccount[]) {
  if (rows.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يمكن اعتماد دليل نظامي بلا حسابات.",
    });
  }
  const byCode = new Map<string, ImportedStatutoryAccount>();
  for (const raw of rows) {
    const code = cleanRequired(raw.code, "رمز الحساب", 30);
    cleanRequired(raw.name, `اسم الحساب ${code}`, 160);
    if (byCode.has(code)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `رمز مكرر: ${code}.` });
    }
    byCode.set(code, raw);
  }
  for (const [code, row] of Array.from(byCode.entries())) {
    const parentCode = row.parentCode?.trim();
    if (!parentCode) continue;
    if (parentCode === code || !byCode.has(parentCode)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الحساب ${code} يشير إلى أب غير صالح (${parentCode}).`,
      });
    }
    if (byCode.get(parentCode)?.type !== row.type) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `نوع الحساب ${code} لا يطابق نوع أبيه ${parentCode}.`,
      });
    }
    const visited = new Set([code]);
    let cursor: ImportedStatutoryAccount | undefined = row;
    while (cursor?.parentCode) {
      const next = cursor.parentCode.trim();
      if (visited.has(next)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `دورة أبوّة مكتشفة عند الحساب ${code}.`,
        });
      }
      visited.add(next);
      cursor = byCode.get(next);
    }
  }
}

/** استيراد ذري كامل: يفشل كله إذا كان رمز/أب/نوع واحد غير صالح. */
export async function replaceStatutoryAccounts(
  tx: Tx,
  profileId: number,
  rows: readonly ImportedStatutoryAccount[],
) {
  await lockedDraft(tx, profileId);
  validateImportedAccounts(rows);

  await tx
    .delete(statutoryAccountMappings)
    .where(eq(statutoryAccountMappings.profileId, profileId));
  await tx
    .update(statutoryAccounts)
    .set({ parentId: null })
    .where(eq(statutoryAccounts.profileId, profileId));
  await tx
    .delete(statutoryAccounts)
    .where(eq(statutoryAccounts.profileId, profileId));

  const ids = new Map<string, number>();
  for (const [index, row] of Array.from(rows.entries())) {
    const code = row.code.trim();
    const result = await tx.insert(statutoryAccounts).values({
      profileId,
      code,
      name: row.name.trim(),
      type: row.type,
      normalBalance: row.normalBalance,
      parentId: null,
      isPosting: row.isPosting ?? true,
      sortOrder: row.sortOrder ?? index,
      notes: row.notes?.trim() || null,
    });
    ids.set(code, extractInsertId(result));
  }
  for (const row of rows) {
    const parentCode = row.parentCode?.trim();
    if (!parentCode) continue;
    await tx
      .update(statutoryAccounts)
      .set({ parentId: ids.get(parentCode)! })
      .where(eq(statutoryAccounts.id, ids.get(row.code.trim())!));
  }
  return { imported: rows.length };
}

/** يستبدل خريطة الإصدار كاملةً كي لا يبقى ربط قديم مختفياً بعد الاستيراد. */
export async function replaceStatutoryMappings(
  tx: Tx,
  profileId: number,
  mappings: readonly MappingInput[],
  actorId: number,
) {
  await lockedDraft(tx, profileId);
  const uniqueInternal = new Set(mappings.map((item) => item.internalAccountId));
  if (uniqueInternal.size !== mappings.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تكرر حساب تشغيلي في الخريطة." });
  }

  const internalIds = Array.from(uniqueInternal);
  const statutoryIds = Array.from(
    new Set(mappings.map((item) => item.statutoryAccountId)),
  );
  const internalRows = internalIds.length
    ? await tx.select().from(accounts).where(inArray(accounts.id, internalIds))
    : [];
  const statutoryRows = statutoryIds.length
    ? await tx
        .select()
        .from(statutoryAccounts)
        .where(inArray(statutoryAccounts.id, statutoryIds))
    : [];
  const internalById = new Map(internalRows.map((row) => [Number(row.id), row]));
  const statutoryById = new Map(statutoryRows.map((row) => [Number(row.id), row]));
  for (const item of mappings) {
    const internal = internalById.get(item.internalAccountId);
    const statutory = statutoryById.get(item.statutoryAccountId);
    if (!internal || !internal.isActive || !internal.systemRole) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الحساب التشغيلي ${item.internalAccountId} غير صالح للترحيل.`,
      });
    }
    if (!statutory || Number(statutory.profileId) !== profileId || !statutory.isPosting) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الحساب النظامي ${item.statutoryAccountId} لا ينتمي للإصدار أو ليس حساب ترحيل.`,
      });
    }
    if (internal.type !== statutory.type) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `لا يمكن ربط ${internal.code} (${internal.type}) بـ${statutory.code} (${statutory.type}).`,
      });
    }
  }

  await tx
    .delete(statutoryAccountMappings)
    .where(eq(statutoryAccountMappings.profileId, profileId));
  if (mappings.length) {
    await tx.insert(statutoryAccountMappings).values(
      mappings.map((item) => ({
        profileId,
        internalAccountId: item.internalAccountId,
        statutoryAccountId: item.statutoryAccountId,
        rationale: item.rationale?.trim() || null,
        createdBy: actorId,
      })),
    );
  }
  return { mapped: mappings.length };
}

async function profileReadiness(executor: DbExecutor, profileId: number) {
  const profile = (
    await executor
      .select()
      .from(statutoryAccountingProfiles)
      .where(eq(statutoryAccountingProfiles.id, profileId))
      .limit(1)
  )[0];
  if (!profile) return null;
  const rows = await executor
    .select({
      internalAccountId: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      role: accounts.systemRole,
      statutoryAccountId: statutoryAccountMappings.statutoryAccountId,
      statutoryCode: statutoryAccounts.code,
      statutoryName: statutoryAccounts.name,
    })
    .from(accounts)
    .leftJoin(
      statutoryAccountMappings,
      and(
        eq(statutoryAccountMappings.profileId, profileId),
        eq(statutoryAccountMappings.internalAccountId, accounts.id),
      ),
    )
    .leftJoin(
      statutoryAccounts,
      eq(statutoryAccounts.id, statutoryAccountMappings.statutoryAccountId),
    )
    .where(and(eq(accounts.isActive, true), isNotNull(accounts.systemRole)))
    .orderBy(asc(accounts.sortOrder));
  const unresolvedJournalRoles = await executor
    .selectDistinct({ role: journalLines.role })
    .from(journalLines)
    .leftJoin(accounts, eq(accounts.systemRole, journalLines.role))
    .leftJoin(
      statutoryAccountMappings,
      and(
        eq(statutoryAccountMappings.profileId, profileId),
        eq(statutoryAccountMappings.internalAccountId, accounts.id),
      ),
    )
    .where(isNull(statutoryAccountMappings.id));
  const unmapped = rows.filter((row) => row.statutoryAccountId == null);
  return {
    profile,
    totalInternalAccounts: rows.length,
    mappedAccounts: rows.length - unmapped.length,
    unmappedAccounts: unmapped.map((row) => ({
      id: Number(row.internalAccountId),
      code: row.code,
      name: row.name,
      type: row.type,
      role: row.role!,
    })),
    unresolvedJournalRoles: unresolvedJournalRoles.map((row) => row.role),
    mappings: rows.map((row) => ({
      internalAccountId: Number(row.internalAccountId),
      internalCode: row.code,
      internalName: row.name,
      internalType: row.type,
      role: row.role!,
      statutoryAccountId:
        row.statutoryAccountId == null ? null : Number(row.statutoryAccountId),
      statutoryCode: row.statutoryCode ?? null,
      statutoryName: row.statutoryName ?? null,
    })),
  };
}

async function approvedMappingRows(executor: DbExecutor, profileId: number) {
  return executor
    .select({
      internalAccountId: accounts.id,
      internalCode: accounts.code,
      role: accounts.systemRole,
      statutoryAccountId: statutoryAccounts.id,
      statutoryCode: statutoryAccounts.code,
      statutoryName: statutoryAccounts.name,
    })
    .from(statutoryAccountMappings)
    .innerJoin(accounts, eq(accounts.id, statutoryAccountMappings.internalAccountId))
    .innerJoin(
      statutoryAccounts,
      eq(statutoryAccounts.id, statutoryAccountMappings.statutoryAccountId),
    )
    .where(eq(statutoryAccountMappings.profileId, profileId))
    .orderBy(asc(accounts.code));
}

async function statutoryAccountSnapshotRows(executor: DbExecutor, profileId: number) {
  return executor
    .select({
      id: statutoryAccounts.id,
      code: statutoryAccounts.code,
      name: statutoryAccounts.name,
      type: statutoryAccounts.type,
      normalBalance: statutoryAccounts.normalBalance,
      parentId: statutoryAccounts.parentId,
      isPosting: statutoryAccounts.isPosting,
      sortOrder: statutoryAccounts.sortOrder,
    })
    .from(statutoryAccounts)
    .where(eq(statutoryAccounts.profileId, profileId))
    .orderBy(asc(statutoryAccounts.code));
}

async function contentSnapshot(executor: DbExecutor, profileId: number) {
  const accountSnapshotRows = await statutoryAccountSnapshotRows(executor, profileId);
  const accountRows = accountSnapshotRows.map(
    ({ code, name, type, normalBalance, parentId, isPosting, sortOrder }) => ({
      code,
      name,
      type,
      normalBalance,
      parentId,
      isPosting,
      sortOrder,
    }),
  );
  const rawMappingRows = await approvedMappingRows(executor, profileId);
  const mappingRows = rawMappingRows.map(
    ({ internalCode, role, statutoryCode }) => ({
      internalCode,
      role,
      statutoryCode,
    }),
  );
  return {
    accountSnapshotRows,
    rawMappingRows,
    hash: createHash("sha256")
      .update(JSON.stringify({ accounts: accountRows, mappings: mappingRows }))
      .digest("hex"),
  };
}

async function contentHash(executor: DbExecutor, profileId: number) {
  return (await contentSnapshot(executor, profileId)).hash;
}

/**
 * يعيد بيانات الإصدارات المعتمدة من نفس لقطة قاعدة البيانات بعد التحقق من أن
 * الدليل والخريطة الحيّين ما زالا يطابقان البصمة المثبّتة وقت الاعتماد.
 */
export async function getVerifiedStatutoryProfileDetails(
  executor: DbExecutor,
  profileIds: number[],
) {
  const details = [];
  for (const profileId of Array.from(new Set(profileIds))) {
    const readiness = await profileReadiness(executor, profileId);
    if (
      !readiness ||
      readiness.profile.status === "DRAFT" ||
      !readiness.profile.contentHash
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `الإصدار النظامي ${profileId} غير معتمد ولا يمكن تضمينه في حزمة التدقيق.`,
      });
    }
    const snapshot = await contentSnapshot(executor, profileId);
    if (snapshot.hash !== readiness.profile.contentHash) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `تغيّر محتوى الإصدار النظامي ${readiness.profile.version} بعد اعتماده؛ أنشئ إصداراً جديداً وأعد المصادقة قبل التصدير.`,
      });
    }
    const codeById = new Map(
      snapshot.accountSnapshotRows.map((row) => [Number(row.id), row.code]),
    );
    const approvedAccounts = snapshot.accountSnapshotRows.map((row) => ({
      statutoryAccountId: Number(row.id),
      code: row.code,
      name: row.name,
      type: row.type,
      normalBalance: row.normalBalance,
      parentId: row.parentId == null ? null : Number(row.parentId),
      parentCode:
        row.parentId == null ? null : (codeById.get(Number(row.parentId)) ?? null),
      isPosting: row.isPosting,
      sortOrder: row.sortOrder,
    }));
    const approvedMappings = snapshot.rawMappingRows.map(
      (row) => ({
        ...row,
        internalAccountId: Number(row.internalAccountId),
        statutoryAccountId: Number(row.statutoryAccountId),
      }),
    );
    details.push({ ...readiness, approvedAccounts, approvedMappings });
  }
  return details;
}

export async function approveStatutoryProfile(
  tx: Tx,
  input: {
    profileId: number;
    accountantName: string;
    approvalReference: string;
  },
  actorId: number,
) {
  await lockedDraft(tx, input.profileId);
  const readiness = await profileReadiness(tx, input.profileId);
  if (!readiness) throw new TRPCError({ code: "NOT_FOUND" });
  if (
    readiness.totalInternalAccounts === 0 ||
    readiness.unmappedAccounts.length > 0 ||
    readiness.unresolvedJournalRoles.length > 0
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `لا اعتماد قبل اكتمال الخريطة: ${readiness.unmappedAccounts.length} حساب و${readiness.unresolvedJournalRoles.length} دور يومية بلا ربط.`,
    });
  }
  const accountantName = cleanRequired(input.accountantName, "اسم مراقب الحسابات", 150);
  const approvalReference = cleanRequired(
    input.approvalReference,
    "مرجع المصادقة",
    255,
  );
  const hash = await contentHash(tx, input.profileId);
  const now = new Date();

  await tx
    .update(statutoryAccountingProfiles)
    .set({ status: "RETIRED", activeGuard: null })
    .where(eq(statutoryAccountingProfiles.status, "ACTIVE"));
  await tx
    .update(statutoryAccountingProfiles)
    .set({
      status: "ACTIVE",
      activeGuard: "ACTIVE",
      contentHash: hash,
      accountantName,
      approvalReference,
      approvedBy: actorId,
      approvedAt: now,
    })
    .where(eq(statutoryAccountingProfiles.id, input.profileId));

  // تثبيت تصنيف القيود السابقة غير المصنّفة مرة واحدة؛ قيود إصدار سابق تبقى على إصداره.
  await tx.execute(sql`
    UPDATE journalLines jl
    INNER JOIN accounts a ON a.systemRole = jl.role AND a.isActive = 1
    INNER JOIN statutoryAccountMappings sam
      ON sam.profileId = ${input.profileId} AND sam.internalAccountId = a.id
    SET jl.accountId = a.id,
        jl.statutoryProfileId = ${input.profileId},
        jl.statutoryAccountId = sam.statutoryAccountId
    WHERE jl.statutoryProfileId IS NULL
  `);
  return { id: input.profileId, contentHash: hash, approvedAt: now.toISOString() };
}

export async function listStatutoryProfiles() {
  const db = requireDb();
  const rows = await db
    .select()
    .from(statutoryAccountingProfiles)
    .orderBy(
      asc(statutoryAccountingProfiles.profileKey),
      asc(statutoryAccountingProfiles.version),
    );
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

export async function getStatutoryProfileDetail(profileId: number) {
  const db = requireDb();
  const readiness = await profileReadiness(db, profileId);
  if (!readiness) return null;
  const statRows = await db
    .select()
    .from(statutoryAccounts)
    .where(eq(statutoryAccounts.profileId, profileId))
    .orderBy(asc(statutoryAccounts.sortOrder), asc(statutoryAccounts.code));
  return {
    profile: { ...readiness.profile, id: Number(readiness.profile.id) },
    accounts: statRows.map((row) => ({
      ...row,
      id: Number(row.id),
      profileId: Number(row.profileId),
      parentId: row.parentId == null ? null : Number(row.parentId),
    })),
    totalInternalAccounts: readiness.totalInternalAccounts,
    mappedAccounts: readiness.mappedAccounts,
    unmappedAccounts: readiness.unmappedAccounts,
    unresolvedJournalRoles: readiness.unresolvedJournalRoles,
    mappings: readiness.mappings,
  };
}

export async function getStatutoryActivationReadiness(executor?: DbExecutor) {
  const db = executor ?? requireDb();
  const active = (
    await db
      .select()
      .from(statutoryAccountingProfiles)
      .where(eq(statutoryAccountingProfiles.status, "ACTIVE"))
      .limit(1)
  )[0];
  if (!active) {
    return {
      ok: false,
      activeProfile: null,
      totalInternalAccounts: 0,
      mappedAccounts: 0,
      unmappedAccounts: [],
      unresolvedJournalRoles: [],
      reason: "لا يوجد إصدار نظامي معتمد من مراقب الحسابات.",
      summary: "غير معتمد",
      detail:
        "أنشئ إصداراً نظامياً، استورد حساباته، اربط جميع الحسابات التشغيلية، ثم سجّل مصادقة مراقب الحسابات.",
    };
  }
  const readiness = await profileReadiness(db, Number(active.id));
  const ok = Boolean(
    readiness &&
      readiness.totalInternalAccounts > 0 &&
      readiness.unmappedAccounts.length === 0 &&
      readiness.unresolvedJournalRoles.length === 0 &&
      active.contentHash &&
      active.accountantName &&
      active.approvalReference,
  );
  return {
    ok,
    activeProfile: {
      id: Number(active.id),
      profileKey: active.profileKey,
      version: active.version,
      name: active.name,
      effectiveFrom: active.effectiveFrom,
      contentHash: active.contentHash,
      accountantName: active.accountantName,
      approvalReference: active.approvalReference,
      approvedAt: active.approvedAt,
    },
    totalInternalAccounts: readiness?.totalInternalAccounts ?? 0,
    mappedAccounts: readiness?.mappedAccounts ?? 0,
    unmappedAccounts: readiness?.unmappedAccounts ?? [],
    unresolvedJournalRoles: readiness?.unresolvedJournalRoles ?? [],
    reason: ok ? null : "الإصدار النظامي المعتمد غير مكتمل التغطية.",
    summary: ok
      ? `${readiness!.mappedAccounts}/${readiness!.totalInternalAccounts} حساب`
      : `${readiness?.unmappedAccounts.length ?? 0} حساب و${readiness?.unresolvedJournalRoles.length ?? 0} دور بلا ربط`,
    detail: ok
      ? "الإصدار النظامي مصادق وتغطي خريطته جميع الحسابات التشغيلية وأدوار اليومية."
      : "أكمل ربط الحسابات التشغيلية وأدوار القيود داخل إصدار نظامي جديد ثم اعتمده.",
  };
}

export interface JournalLineSnapshot extends JournalLine {
  accountId: number | null;
  statutoryProfileId: number | null;
  statutoryAccountId: number | null;
}

/** يحسم الحسابين مرةً واحدة داخل معاملة الترحيل ويحظر أي فجوة بعد اعتماد دليل نظامي. */
export async function snapshotJournalLines(
  tx: Tx,
  lines: readonly JournalLine[],
): Promise<JournalLineSnapshot[]> {
  const roles = Array.from(new Set(lines.map((line) => line.role)));
  const internalRows = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.isActive, true), inArray(accounts.systemRole, roles)));
  const internalByRole = new Map(
    internalRows
      .filter((row) => row.systemRole)
      .map((row) => [row.systemRole!, row]),
  );
  const active = (
    await tx
      .select({ id: statutoryAccountingProfiles.id })
      .from(statutoryAccountingProfiles)
      .where(eq(statutoryAccountingProfiles.status, "ACTIVE"))
      .for("share")
      .limit(1)
  )[0];
  const missingInternal = roles.filter((role) => !internalByRole.has(role));
  if (active && missingInternal.length) {
    throw new Error(`أدوار بلا حساب تشغيلي فعّال: ${missingInternal.join("، ")}.`);
  }
  const mappingByInternalId = new Map<number, number>();
  if (active) {
    const mappingRows = await tx
      .select({
        internalAccountId: statutoryAccountMappings.internalAccountId,
        statutoryAccountId: statutoryAccountMappings.statutoryAccountId,
      })
      .from(statutoryAccountMappings)
      .where(
        and(
          eq(statutoryAccountMappings.profileId, active.id),
          inArray(
            statutoryAccountMappings.internalAccountId,
            internalRows.map((row) => Number(row.id)),
          ),
        ),
      );
    for (const row of mappingRows) {
      mappingByInternalId.set(
        Number(row.internalAccountId),
        Number(row.statutoryAccountId),
      );
    }
    const missingMappings = internalRows.filter(
      (row) => !mappingByInternalId.has(Number(row.id)),
    );
    if (missingMappings.length) {
      throw new Error(
        `الدليل النظامي المعتمد يفتقد: ${missingMappings.map((row) => row.code).join("، ")}.`,
      );
    }
  }
  return lines.map((line) => {
    const internal = internalByRole.get(line.role);
    return {
      ...line,
      accountId: internal ? Number(internal.id) : null,
      statutoryProfileId: active ? Number(active.id) : null,
      statutoryAccountId: active
        ? mappingByInternalId.get(Number(internal!.id))!
        : null,
    };
  });
}
