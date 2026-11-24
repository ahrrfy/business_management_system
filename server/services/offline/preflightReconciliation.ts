import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import { isDupEntry } from "@shared/errorMap.ar";
import { canUseStation, type PermissionMap } from "@shared/permissions";
import { REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";
import {
  idempotencyKeys,
  invoices,
  offlineRecoveryItems,
  shifts,
  users,
} from "../../../drizzle/schema";
import {
  normalizeOwnerAuthority,
  resolveCustomRole,
  type AuthUser,
} from "../../context";
import { canCrossBranches } from "../../lib/branchAuthority";
import { verifyOfflineCaptureProofServer } from "../../lib/offlineCaptureGrant";
import { logger } from "../../logger";
import { assertOperationAuthorized } from "../../operationAuthorization";
import { publishRealtimeEvent } from "../../realtime";
import {
  logAudit,
  logAuditTx,
  type AuditData,
  type AuditMetadata,
} from "../auditService";
import { getInProcessActiveSaleFlight } from "../sale/create";
import { requireDb, withGovernanceTx, withTx } from "../tx";
import { captureRejectedReplay } from "./recovery";
import {
  replayOfflineSale,
  type ReplayOfflineSaleInput,
} from "./replaySale";

export interface OfflineSessionUser {
  id: number;
  role: string;
  branchId?: number | null;
  isOwner?: boolean | null;
}

export interface ReplaySalePayloadBase {
  branchId: number;
  shiftId?: number;
  customerId?: number;
  priceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  lines: ReplayOfflineSaleInput["lines"];
  invoiceDiscount?: string;
  payment: { amount: string; method: "CASH" };
  clientRequestId: string;
  notes?: string;
  cashRoundIQD?: boolean;
  capturedAt: string;
  offlineReceiptNumber: string;
  deviceId?: string;
  capturedByUserId?: number;
  capturedShiftId?: number;
  captureProof?: string;
  keyId?: string;
  grantId?: string;
  grantIssuedAtMs?: number;
  grantExpiresAtMs?: number;
  grantToken?: string;
  salesRepId?: number | null;
  attribution?: {
    repId?: number | null;
    mode?: "DIRECT" | "SPLIT" | "POOL";
  };
}

export function throwNoAssignedBranchError(): never {
  throw new TRPCError({
    code: "FORBIDDEN",
    message: appErrorMessage({
      what: "لا فرع مُسنَد لهذا المستخدم",
      why: "حسابك غير مرتبط بفرع عامل لتنفيذ أو مراجعة العمليات الأوفلاينية",
      doThis: "اطلب من مدير النظام ربط حسابك بفرع من شاشة المستخدمين",
    }),
  });
}

export function throwForeignBranchIdempotencyError(): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "معرّف الطلب مستعمَل لبيع فرع آخر",
      why: "مفتاح idempotency مسجّل على فرع مختلف ولا يجوز كشفه أو استخدامه عبر الفروع",
      doThis: "أنشئ طلب بيع جديد داخل فرعك بمعرّف مستقل",
    }),
  });
}

export function throwSemanticPayloadConflictError(targetLabel: string): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: `تعارض في بصمة حمولة البيع مقابل ${targetLabel}`,
      why: "بصمة الحمولة الدلالية للنية لا تطابق البيانات المسجلة لنفس المعرّف",
      doThis: "راجع بنود السلة والمبلغ الأصلي أو أنشئ عملية جديدة بمعرّف مختلف",
    }),
  });
}

export function replacementClientRequestIdFor(
  originalClientRequestId: string,
): string {
  return `RI-${createHash("sha256").update(originalClientRequestId).digest("hex").slice(0, 32)}`;
}

export function resolveOfflineEffectiveBranchId(
  user: OfflineSessionUser,
  requestedBranchId: number,
): number {
  if (canCrossBranches(user)) return requestedBranchId;
  if (user.branchId == null) {
    throwNoAssignedBranchError();
  }
  return Number(user.branchId);
}

export async function lookupInvoiceNumberById(
  invoiceId: number,
): Promise<string> {
  const db = requireDb();
  const [row] = await db
    .select({ invoiceNumber: invoices.invoiceNumber })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  return row?.invoiceNumber ?? "";
}

export async function verifyAndPrepareReplaySaleService(
  input: ReplaySalePayloadBase,
  user: OfflineSessionUser,
  options?: {
    approvedBy?: number | null;
    quarantineClientRequestId?: string;
  },
) {
  const crossBranch = canCrossBranches(user);
  const effectiveBranchId = resolveOfflineEffectiveBranchId(user, input.branchId);
  const actor = {
    userId: user.id,
    branchId: effectiveBranchId,
    role: user.role,
    isOwner: Boolean(user.isOwner),
  };
  const canApprove =
    Boolean(user.isOwner) || user.role === "admin" || user.role === "manager";
  const approvedBy = options?.approvedBy ?? null;
  const {
    capturedByUserId,
    capturedShiftId,
    captureProof,
    keyId,
    grantId,
    grantIssuedAtMs,
    grantExpiresAtMs,
    grantToken,
    ...replayInput
  } = input;

  const db = requireDb();
  const [existingCommittedInv] = await db
    .select({
      id: invoices.id,
      createdBy: invoices.createdBy,
      branchId: invoices.branchId,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.sourceType, "POS"),
        eq(invoices.sourceId, input.clientRequestId),
      ),
    )
    .limit(1);

  let verifiedQuarantineOwnerId: number = user.id;
  if (capturedByUserId != null) {
    const [maybeUser] = await db
      .select({ id: users.id, branchId: users.branchId })
      .from(users)
      .where(eq(users.id, Number(capturedByUserId)))
      .limit(1);
    if (
      maybeUser &&
      (crossBranch ||
        maybeUser.branchId == null ||
        Number(maybeUser.branchId) === effectiveBranchId)
    ) {
      verifiedQuarantineOwnerId = Number(maybeUser.id);
    }
  }

  const quarantineAndReject = async (
    reasonMsg: string,
    usePreconditionFailed = false,
    quarantineMeta?: Record<string, unknown>,
  ): Promise<never> => {
    const errCode = usePreconditionFailed ? "PRECONDITION_FAILED" : "FORBIDDEN";
    if (!existingCommittedInv) {
      await captureRejectedReplay(
        {
          ...replayInput,
          clientRequestId:
            options?.quarantineClientRequestId ?? replayInput.clientRequestId,
          branchId: effectiveBranchId,
          priceOverrideApproved: false,
          unverifiedOriginalCapturedByUserId: capturedByUserId ?? null,
          submittedByPresenterUserId: user.id,
          ...(usePreconditionFailed && !quarantineMeta
            ? { legacyMissingProof: true }
            : {}),
          ...(quarantineMeta ?? {}),
        },
        errCode,
        reasonMsg,
        verifiedQuarantineOwnerId,
        "RETAIL",
      );
    }
    throw new TRPCError({
      code: errCode,
      message: appErrorMessage({
        what: "تعذّر قبول ترحيل البيع الأوفلايني",
        why: reasonMsg,
        doThis: "راجع طابور الاسترداد الأوفلايني مع مدير الفرع لاستكمال المعالجة",
      }),
    });
  };

  let delegatedSellerUserId: number | null = null;
  if (existingCommittedInv && captureProof == null) {
    if (Number(existingCommittedInv.branchId) !== effectiveBranchId) {
      throwForeignBranchIdempotencyError();
    }
    const committedSellerId = Number(existingCommittedInv.createdBy);
    if (
      capturedByUserId != null &&
      Number(capturedByUserId) !== committedSellerId
    ) {
      await quarantineAndReject(
        "تعارض هوية الملتقط مع الفاتورة الملتزمة مسبقاً على الخادم",
      );
    }
    if (committedSellerId !== Number(user.id)) {
      if (!canApprove && approvedBy == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر مصالحة فاتورة ملتزمة لموظف آخر",
            why: "الموظف الحالي ليس صاحب الفاتورة الأصلي ولا يحمل اعتماد مدير أو أدمن",
            doThis: "أرفق اعتماد المدير أو نفّذ المصالحة بحساب الموظف الأصلي",
          }),
        });
      }
      delegatedSellerUserId = committedSellerId;
    }
  } else {
    if (capturedByUserId == null) {
      await quarantineAndReject(
        "هوية الموظف الملتقط الأصلي مفقودة — عُلّقت العملية للمراجعة الإدارية ولا تُرحَّل تلقائياً",
        true,
      );
    }

    const [capturedUserRow] = await db
      .select()
      .from(users)
      .where(eq(users.id, Number(capturedByUserId)))
      .limit(1);
    if (!capturedUserRow) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تحديد موظف الالتقاط الأصلي",
          why: "معرّف موظف الالتقاط المرسل غير موجود في جدول المستخدمين",
          doThis: "راجع طابور الاسترداد الأوفلايني مع مدير النظام لإسناد العملية يدوياً",
        }),
      });
    }
    if (
      !crossBranch &&
      capturedUserRow.branchId != null &&
      Number(capturedUserRow.branchId) !== effectiveBranchId
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر ترحيل بيع موظف ينتمي لفرع آخر",
          why: "موظف الالتقاط الأصلي مسجّل على فرع مختلف عن فرع العملية",
          doThis: "رحّل العملية من الفرع الصحيح أو عبر حساب أدمن مخوّل بعبور الفروع",
        }),
      });
    }

    if (Number(capturedByUserId) !== Number(user.id)) {
      if (!canApprove && approvedBy == null) {
        await quarantineAndReject(
          "لا يجوز ترحيل بيع التُقط بجلسة موظف آخر دون اعتماد مدير/أدمن",
        );
      }
      delegatedSellerUserId = Number(capturedUserRow.id);
    }

    if (!existingCommittedInv) {
      if (capturedUserRow.isActive === false) {
        await quarantineAndReject(
          "حساب الموظف الملتقط موقوف حالياً — عُلّقت العملية للمراجعة الإدارية",
        );
      }
      const hydratedCapturer = { ...capturedUserRow } as unknown as AuthUser;
      await resolveCustomRole(hydratedCapturer);
      normalizeOwnerAuthority(hydratedCapturer);
      const stationAllowed = canUseStation(
        "RETAIL",
        hydratedCapturer.role,
        hydratedCapturer.permissionsOverride as PermissionMap | null,
      );
      if (!stationAllowed && !hydratedCapturer.isOwner) {
        await quarantineAndReject(
          "صلاحية محطة مبيعات التجزئة مسحوبة من الموظف الملتقط — عُلّقت العملية للمراجعة الإدارية",
        );
      }
      try {
        assertOperationAuthorized(hydratedCapturer, "sales.create");
      } catch {
        await quarantineAndReject(
          "سياسة العمليات تمنع الموظف الملتقط من إنشاء بيع تجزئة — عُلّقت العملية للمراجعة الإدارية",
        );
      }
    }

    const effectiveCapturedShiftId = Number(
      capturedShiftId ?? input.shiftId ?? 0,
    );
    let shiftOpenedAtMs: number | null = null;
    if (!existingCommittedInv) {
      if (
        !effectiveCapturedShiftId ||
        !captureProof ||
        !keyId ||
        !grantId ||
        grantIssuedAtMs == null ||
        grantExpiresAtMs == null ||
        !grantToken
      ) {
        await quarantineAndReject(
          "صف قديم غير مرسل يفتقر إلى ختم ومنحة الالتقاط الموقّعة — حُجر في طابور الاسترداد الإداري دون اختلاق إثبات",
          true,
        );
      }
      const [originShift] = await db
        .select({
          id: shifts.id,
          userId: shifts.userId,
          branchId: shifts.branchId,
          openedAt: shifts.openedAt,
        })
        .from(shifts)
        .where(eq(shifts.id, effectiveCapturedShiftId))
        .limit(1);
      if (
        !originShift ||
        Number(originShift.branchId) !== effectiveBranchId ||
        Number(originShift.userId) !== Number(capturedByUserId)
      ) {
        await quarantineAndReject(
          "عدم تطابق وردية الالتقاط الأصلية مع هوية الموظف الملتقط",
        );
      }
      shiftOpenedAtMs = originShift.openedAt
        ? new Date(originShift.openedAt).getTime()
        : null;
      if (
        Number(capturedByUserId) === Number(user.id) &&
        input.shiftId != null &&
        Number(input.shiftId) !== effectiveCapturedShiftId
      ) {
        await quarantineAndReject(
          "لا يجوز للكاشير تغيير وردية الالتقاط الأصلية لعملية غير مرسلة",
        );
      }
    }

    const verifyRes = verifyOfflineCaptureProofServer(
      captureProof ?? "",
      {
        kind: "SALE",
        keyId: keyId ?? "",
        grantId: grantId ?? "",
        grantIssuedAtMs: Number(grantIssuedAtMs ?? 0),
        grantExpiresAtMs: Number(grantExpiresAtMs ?? 0),
        grantToken: grantToken ?? "",
        clientRequestId: input.clientRequestId,
        offlineReceiptNumber: input.offlineReceiptNumber,
        capturedAt: input.capturedAt,
        branchId: effectiveBranchId,
        capturedShiftId: effectiveCapturedShiftId,
        capturedByUserId: Number(capturedByUserId),
        payload: replayInput,
      },
      { shiftOpenedAtMs },
    );
    if (!verifyRes.ok) {
      if (verifyRes.code === "LATE_ARRIVAL_BEYOND_OFFLINE_GRACE") {
        await quarantineAndReject(verifyRes.message, true, {
          quarantineClassification:
            "LATE_ARRIVAL_BEYOND_GRACE_CRYPTO_VERIFIED",
          cryptoProofVerifiedAtQuarantine: true,
          clientClockUnverifiedByServerWallClock: true,
          grantId: grantId ?? null,
          grantIssuedAtMs: grantIssuedAtMs ?? null,
          grantExpiresAtMs: grantExpiresAtMs ?? null,
        });
      }
      await quarantineAndReject(verifyRes.message);
    }
  }

  return {
    effectiveBranchId,
    actor,
    canApprove,
    approvedBy,
    replayInput,
    verifiedQuarantineOwnerId,
    delegatedSellerUserId,
    priceOverrideApprovedBy: approvedBy ?? (canApprove ? user.id : null),
  };
}

export async function lookupPreflightSaleOutcomeService(
  input: {
    branchId: number;
    clientRequestId: string;
    expectedSemanticSha256?: string;
    mode: "OBSERVE" | "FENCE_IF_UNCOMMITTED";
    kind?: "SALE" | "PRINT_SALE" | "RECEPTION" | "RETURN";
    offlineReceiptNumber?: string;
  },
  user: OfflineSessionUser,
  auditMeta: AuditMetadata,
) {
  const effectiveBranchId = resolveOfflineEffectiveBranchId(user, input.branchId);
  const canAdminReconcile =
    Boolean(user.isOwner) || user.role === "admin" || user.role === "manager";
  const normalizedExpectedHash =
    input.expectedSemanticSha256?.toLowerCase() ?? null;

  const activeFlight = getInProcessActiveSaleFlight(input.clientRequestId);
  if (activeFlight) {
    if (Number(activeFlight.branchId) !== effectiveBranchId) {
      throwForeignBranchIdempotencyError();
    }
    const isFlightOwner = Number(activeFlight.sellerUserId) === Number(user.id);
    if (!isFlightOwner && !canAdminReconcile) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر الاستعلام عن فاتورة قيد التنفيذ لموظف آخر",
          why: "الطلب الجاري يعود لكاشير آخر ولا تملك صلاحية مدير أو أدمن للمصالحة",
          doThis:
            "استدعِ مدير الفرع لمراجعة الفاتورة المعلّقة أو سجّل الدخول بحساب الكاشير الأصلي",
        }),
      });
    }
    if (
      normalizedExpectedHash &&
      activeFlight.semanticSha256.toLowerCase() !== normalizedExpectedHash
    ) {
      throwSemanticPayloadConflictError("الطلب الجاري");
    }
    if (!isFlightOwner && canAdminReconcile) {
      await logAudit(auditMeta, {
        action: "offline.preflight.adminLookup",
        entityType: "invoice",
        entityId: 0,
        branchId: effectiveBranchId,
        newValue: {
          clientRequestId: input.clientRequestId,
          originalSellerId: Number(activeFlight.sellerUserId),
          branchId: effectiveBranchId,
          inFlight: true,
        },
      });
    }
    return { outcome: "UNKNOWN_IN_FLIGHT" as const };
  }

  const isNowaitLockContention = (err: unknown): boolean => {
    const anyErr = err as {
      errno?: number;
      code?: string;
      message?: string;
      cause?: { errno?: number; code?: string; message?: string };
    } | null;
    const errno = anyErr?.errno ?? anyErr?.cause?.errno;
    const code = anyErr?.code ?? anyErr?.cause?.code ?? "";
    const msg = `${anyErr?.message ?? ""} ${anyErr?.cause?.message ?? ""}`;
    return (
      errno === 3572 ||
      errno === 1205 ||
      errno === 1213 ||
      code === "ER_LOCK_NOWAIT" ||
      msg.includes("NOWAIT") ||
      msg.includes("could not be acquired immediately")
    );
  };

  let pendingPostTxAudit: AuditData | null = null;
  try {
    const txOutcome = await withTx(
      async (tx) => {
        const lockQuery =
          input.mode === "FENCE_IF_UNCOMMITTED"
            ? sql`SELECT refId, payloadHash FROM idempotencyKeys WHERE operation = 'sale.create' AND clientRequestId = ${input.clientRequestId} LIMIT 1 FOR UPDATE NOWAIT`
            : sql`SELECT refId, payloadHash FROM idempotencyKeys WHERE operation = 'sale.create' AND clientRequestId = ${input.clientRequestId} LIMIT 1 FOR SHARE NOWAIT`;
        const rawLockRes = await tx.execute(lockQuery);
        const lockRows = (
          Array.isArray(rawLockRes) && Array.isArray(rawLockRes[0])
            ? rawLockRes[0]
            : rawLockRes
        ) as Array<{ refId: number; payloadHash: string | null }>;
        const idempRow = lockRows[0] ?? null;

        const [semHashRow] = await tx
          .select({
            refId: idempotencyKeys.refId,
            payloadHash: idempotencyKeys.payloadHash,
          })
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.operation, "sale.create.semhash"),
              eq(idempotencyKeys.clientRequestId, input.clientRequestId),
            ),
          )
          .limit(1);

        type InvSummary = {
          id: number;
          invoiceNumber: string;
          total: string;
          shiftId: number | null;
          branchId: number;
          createdBy: number | null;
        };
        const rawInvRes = await tx.execute(
          sql`SELECT id, invoiceNumber, total, shiftId, branchId, createdBy FROM invoices WHERE sourceType = 'POS' AND sourceId = ${input.clientRequestId} LIMIT 1 FOR SHARE NOWAIT`,
        );
        const invRows = (
          Array.isArray(rawInvRes) && Array.isArray(rawInvRes[0])
            ? rawInvRes[0]
            : rawInvRes
        ) as InvSummary[];
        let existing: InvSummary | null = invRows[0] ?? null;

        const replacementId = replacementClientRequestIdFor(
          input.clientRequestId,
        );
        let recoveryRow: {
          recoveryStatus: "PENDING" | "POSTED" | "DISCARDED";
          invoiceId: number | null;
          discardReason: string | null;
        } | null = null;
        if (input.mode === "OBSERVE") {
          const [rec] = await tx
            .select({
              branchId: offlineRecoveryItems.branchId,
              channel: offlineRecoveryItems.channel,
              recoveryStatus: offlineRecoveryItems.recoveryStatus,
              invoiceId: offlineRecoveryItems.invoiceId,
              discardReason: offlineRecoveryItems.discardReason,
            })
            .from(offlineRecoveryItems)
            .where(
              inArray(offlineRecoveryItems.clientRequestId, [
                input.clientRequestId,
                replacementId,
              ]),
            )
            .limit(1);
          if (rec) {
            if (Number(rec.branchId) !== effectiveBranchId) {
              throwForeignBranchIdempotencyError();
            }
            recoveryRow = {
              recoveryStatus: rec.recoveryStatus,
              invoiceId: rec.invoiceId != null ? Number(rec.invoiceId) : null,
              discardReason: rec.discardReason ?? null,
            };
          }
          if (
            !existing &&
            rec?.channel === "RETAIL" &&
            recoveryRow?.recoveryStatus === "POSTED" &&
            recoveryRow.invoiceId != null
          ) {
            const [invByRec] = await tx
              .select({
                id: invoices.id,
                invoiceNumber: invoices.invoiceNumber,
                total: invoices.total,
                shiftId: invoices.shiftId,
                branchId: invoices.branchId,
                createdBy: invoices.createdBy,
              })
              .from(invoices)
              .where(eq(invoices.id, recoveryRow.invoiceId))
              .limit(1);
            if (invByRec)
              existing = { ...invByRec, total: String(invByRec.total) };
          }
          if (!existing && input.kind === "RECEPTION") {
            const [recInv] = await tx
              .select({
                id: invoices.id,
                invoiceNumber: invoices.invoiceNumber,
                total: invoices.total,
                shiftId: invoices.shiftId,
                branchId: invoices.branchId,
                createdBy: invoices.createdBy,
              })
              .from(invoices)
              .where(
                and(
                  eq(invoices.sourceType, "POS"),
                  inArray(invoices.sourceId, [
                    `${input.clientRequestId}-sale`,
                    `${input.clientRequestId}-print`,
                  ]),
                ),
              )
              .limit(1);
            if (recInv) existing = { ...recInv, total: String(recInv.total) };
          }
          if (!existing && (input.offlineReceiptNumber || replacementId)) {
            const receiptMatch = await tx
              .select({
                id: invoices.id,
                invoiceNumber: invoices.invoiceNumber,
                total: invoices.total,
                shiftId: invoices.shiftId,
                branchId: invoices.branchId,
                createdBy: invoices.createdBy,
              })
              .from(invoices)
              .where(
                or(
                  and(
                    eq(invoices.sourceType, "POS"),
                    eq(invoices.sourceId, replacementId),
                  ),
                  input.offlineReceiptNumber
                    ? and(
                        eq(invoices.branchId, effectiveBranchId),
                        eq(
                          invoices.offlineReceiptNumber,
                          input.offlineReceiptNumber,
                        ),
                      )
                    : undefined,
                ),
              )
              .limit(1);
            if (receiptMatch[0]) {
              existing = {
                ...receiptMatch[0],
                total: String(receiptMatch[0].total),
              };
            }
          }
          if (!existing && input.kind === "RETURN") {
            const [retKey] = await tx
              .select({ refId: idempotencyKeys.refId })
              .from(idempotencyKeys)
              .where(
                and(
                  eq(idempotencyKeys.operation, "sale.return"),
                  eq(idempotencyKeys.clientRequestId, input.clientRequestId),
                ),
              )
              .limit(1);
            if (retKey && Number(retKey.refId) > 0) {
              const [retInv] = await tx
                .select({
                  id: invoices.id,
                  invoiceNumber: invoices.invoiceNumber,
                  total: invoices.total,
                  shiftId: invoices.shiftId,
                  branchId: invoices.branchId,
                  createdBy: invoices.createdBy,
                })
                .from(invoices)
                .where(eq(invoices.id, Number(retKey.refId)))
                .limit(1);
              if (retInv) existing = { ...retInv, total: String(retInv.total) };
            }
          }
        }

        if (existing) {
          if (Number(existing.branchId) !== effectiveBranchId) {
            throwForeignBranchIdempotencyError();
          }
          const isOriginalSeller = Number(existing.createdBy) === Number(user.id);
          if (!isOriginalSeller && !canAdminReconcile) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: appErrorMessage({
                what: "تعذّر الاستعلام عن فاتورة معلّقة لموظف آخر",
                why: "الفاتورة مسجّلة لكاشير مختلف ولا تملك صلاحية مدير أو أدمن",
                doThis:
                  "اطلب من المدير مصالحة الحالة أو سجّل الدخول بحساب الموظف الأصلي",
              }),
            });
          }
          if (
            normalizedExpectedHash &&
            semHashRow?.payloadHash &&
            semHashRow.payloadHash.toLowerCase() !== normalizedExpectedHash
          ) {
            throwSemanticPayloadConflictError("الفاتورة الملتزمة");
          }
          if (!isOriginalSeller && canAdminReconcile) {
            pendingPostTxAudit = {
              action: "offline.preflight.adminLookup",
              entityType: "invoice",
              entityId: Number(existing.id),
              newValue: {
                clientRequestId: input.clientRequestId,
                originalSellerId: Number(existing.createdBy),
                branchId: effectiveBranchId,
              },
            };
          }
          return {
            outcome: "COMMITTED" as const,
            invoiceId: Number(existing.id),
            invoiceNumber: existing.invoiceNumber,
            total: String(existing.total),
            shiftId: existing.shiftId != null ? Number(existing.shiftId) : null,
            createdBy: Number(existing.createdBy),
            semanticPayloadSha256: semHashRow?.payloadHash ?? null,
            recoveryStatus: recoveryRow?.recoveryStatus ?? null,
            discardReason: recoveryRow?.discardReason ?? null,
          };
        }

        if (idempRow) {
          const refNum = Number(idempRow.refId);
          if (refNum === 0) {
            return { outcome: "UNKNOWN_IN_FLIGHT" as const };
          }
          if (refNum === -1) {
            if (
              normalizedExpectedHash &&
              idempRow.payloadHash &&
              idempRow.payloadHash.toLowerCase() !== normalizedExpectedHash
            ) {
              throwSemanticPayloadConflictError("السجل المسيّج");
            }
            return {
              outcome: "FENCED_NOT_COMMITTED" as const,
              recoveryStatus: recoveryRow?.recoveryStatus ?? null,
              discardReason: recoveryRow?.discardReason ?? null,
            };
          }
        }

        if (input.mode === "OBSERVE") {
          return {
            outcome: "UNKNOWN" as const,
            recoveryStatus: recoveryRow?.recoveryStatus ?? null,
            discardReason: recoveryRow?.discardReason ?? null,
          };
        }

        if (!normalizedExpectedHash) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "بيانات التسييج غير مكتملة",
              why: "يلزم تمرير البصمة الدلالية للنية expectedSemanticSha256 عند طلب التسييج الصريح",
              doThis: "حدّث الواجهة وأعِد طلب التسييج متضمناً بصمة الحمولة",
            }),
          });
        }
        await tx.insert(idempotencyKeys).values([
          {
            operation: "sale.create",
            clientRequestId: input.clientRequestId,
            refId: -1,
            payloadHash: normalizedExpectedHash,
          },
          {
            operation: "sale.create.semhash",
            clientRequestId: input.clientRequestId,
            refId: -1,
            payloadHash: normalizedExpectedHash,
          },
        ]);
        pendingPostTxAudit = {
          action: "offline.preflight.fencedUncommitted",
          entityType: "invoice",
          entityId: 0,
          newValue: {
            clientRequestId: input.clientRequestId,
            branchId: effectiveBranchId,
            expectedSemanticSha256: normalizedExpectedHash,
            fencedByUserId: Number(user.id),
          },
        };
        return { outcome: "FENCED_NOT_COMMITTED" as const };
      },
      { gate: "NONE" },
    );
    if (pendingPostTxAudit) {
      await logAudit(auditMeta, pendingPostTxAudit);
    }
    return txOutcome;
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    if (isNowaitLockContention(err) || isDupEntry(err)) {
      return { outcome: "UNKNOWN_IN_FLIGHT" as const };
    }
    throw err;
  }
}

export async function reissueOutboxSaleService(
  input: ReplaySalePayloadBase & { targetShiftId?: number },
  user: OfflineSessionUser,
  auditMeta: AuditMetadata,
  approvedBy: number | null,
) {
  const { targetShiftId, ...saleReplayRaw } = input;
  const effectiveBranchId = resolveOfflineEffectiveBranchId(user, input.branchId);
  const replacementId = replacementClientRequestIdFor(input.clientRequestId);

  if (approvedBy == null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "يتطلب إعادة ترحيل العملية الأوفلاينية اعتماد مدير",
        why: "إصدار معرّف بديل لطلب مُسيّج خادمياً قرار إداري لمنع الازدواج",
        doThis:
          "أدخل بيانات اعتماد مدير معتمد للفرع أو سجّل الدخول بحساب مدير/أدمن",
      }),
    });
  }

  const db = requireDb();
  const [existingInv] = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      branchId: invoices.branchId,
    })
    .from(invoices)
    .where(
      or(
        and(
          eq(invoices.sourceType, "POS"),
          inArray(invoices.sourceId, [input.clientRequestId, replacementId]),
        ),
        and(
          eq(invoices.branchId, effectiveBranchId),
          eq(invoices.offlineReceiptNumber, input.offlineReceiptNumber),
        ),
      ),
    )
    .limit(1);
  if (existingInv) {
    if (Number(existingInv.branchId) !== effectiveBranchId) {
      throwForeignBranchIdempotencyError();
    }
    return {
      status: "ALREADY_COMMITTED" as const,
      invoiceId: Number(existingInv.id),
      invoiceNumber: existingInv.invoiceNumber,
      message: `الفاتورة ${existingInv.invoiceNumber} مرحَّلة مسبقاً على الخادم`,
    };
  }

  const [existingRec] = await db
    .select({
      id: offlineRecoveryItems.id,
      branchId: offlineRecoveryItems.branchId,
      channel: offlineRecoveryItems.channel,
      recoveryStatus: offlineRecoveryItems.recoveryStatus,
      invoiceId: offlineRecoveryItems.invoiceId,
      discardReason: offlineRecoveryItems.discardReason,
    })
    .from(offlineRecoveryItems)
    .where(
      inArray(offlineRecoveryItems.clientRequestId, [
        input.clientRequestId,
        replacementId,
      ]),
    )
    .limit(1);
  if (existingRec) {
    if (Number(existingRec.branchId) !== effectiveBranchId) {
      throwForeignBranchIdempotencyError();
    }
    if (
      existingRec.channel === "RETAIL" &&
      existingRec.recoveryStatus === "POSTED" &&
      existingRec.invoiceId != null
    ) {
      const [recInv] = await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          branchId: invoices.branchId,
        })
        .from(invoices)
        .where(eq(invoices.id, Number(existingRec.invoiceId)))
        .limit(1);
      if (recInv) {
        if (Number(recInv.branchId) !== effectiveBranchId) {
          throwForeignBranchIdempotencyError();
        }
        return {
          status: "ALREADY_COMMITTED" as const,
          invoiceId: Number(recInv.id),
          invoiceNumber: recInv.invoiceNumber,
          message: `الفاتورة ${recInv.invoiceNumber} مرحَّلة مسبقاً عبر طابور الاسترداد`,
        };
      }
    }
  }
  if (existingRec?.recoveryStatus === "DISCARDED") {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر إعادة ترحيل العملية الأوفلاينية",
        why: `أُهمل هذا الإيصال مسبقاً في سجل الاسترداد (${existingRec.discardReason ?? "قرار إداري"})`,
        doThis: "استخدم خيار «إسقاط وإنهاء» لإغلاق العنصر من الطابور المحلي",
      }),
    });
  }

  const [idempRow] = await db
    .select({ refId: idempotencyKeys.refId })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.operation, "sale.create"),
        eq(idempotencyKeys.clientRequestId, input.clientRequestId),
      ),
    )
    .limit(1);
  if (idempRow && Number(idempRow.refId) === 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "الطلب الأصلي قيد التنفيذ حالياً",
        why: "توجد معاملة مفتوحة على الخادم لنفس معرّف الطلب",
        doThis: "انتظر لحظات ثم افحص الحالة قبل أي إجراء جديد",
      }),
    });
  }
  const replayTargetRequestId =
    idempRow && Number(idempRow.refId) === -1
      ? replacementId
      : input.clientRequestId;

  let prepared: Awaited<ReturnType<typeof verifyAndPrepareReplaySaleService>>;
  try {
    prepared = await verifyAndPrepareReplaySaleService(saleReplayRaw, user, {
      approvedBy,
      quarantineClientRequestId: replayTargetRequestId,
    });
  } catch (prepErr) {
    if (prepErr instanceof TRPCError && prepErr.code === "PRECONDITION_FAILED") {
      const [durableRec] = await db
        .select({
          id: offlineRecoveryItems.id,
          recoveryStatus: offlineRecoveryItems.recoveryStatus,
        })
        .from(offlineRecoveryItems)
        .where(eq(offlineRecoveryItems.clientRequestId, replayTargetRequestId))
        .limit(1);
      if (!durableRec || durableRec.recoveryStatus !== "PENDING") {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: appErrorMessage({
            what: "تعذّر حفظ العملية في طابور الاسترداد الخادمي",
            why: "لم يُثبَّت سجل الاسترداد المعلّق على الخادم فتم الإبقاء على العملية محلياً لضمان عدم ضياع البيع",
            doThis: "أعِد المحاولة بعد التأكد من استقرار الاتصال بالخادم",
          }),
        });
      }
      await logAudit(auditMeta, {
        action: "offline.fencedOutbox.capturedToRecovery",
        entityType: "offlineRecoveryItem",
        entityId: Number(durableRec.id),
        branchId: effectiveBranchId,
        newValue: {
          originalClientRequestId: input.clientRequestId,
          replacementClientRequestId: replayTargetRequestId,
          offlineReceiptNumber: input.offlineReceiptNumber,
          approvedByUserId: approvedBy,
          reason: prepErr.message,
        },
      });
      return {
        status: "CAPTURED_IN_RECOVERY" as const,
        message: prepErr.message,
      };
    }
    throw prepErr;
  }

  const {
    actor,
    replayInput,
    verifiedQuarantineOwnerId,
    delegatedSellerUserId,
  } = prepared;
  const effectiveReplayInput: ReplayOfflineSaleInput = {
    ...replayInput,
    clientRequestId: replayTargetRequestId,
    branchId: effectiveBranchId,
    ...(targetShiftId != null ? { shiftId: targetShiftId } : {}),
    priceOverrideApproved: true,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await replayOfflineSale(
        effectiveReplayInput,
        actor,
        delegatedSellerUserId != null
          ? { attributeToUserId: delegatedSellerUserId }
          : undefined,
      );
      if (!res.idempotentReplay) {
        await logAudit(auditMeta, {
          action: "offline.fencedOutbox.reissue",
          entityType: "invoice",
          entityId: res.invoiceId,
          newValue: {
            originalClientRequestId: input.clientRequestId,
            replacementClientRequestId: replayTargetRequestId,
            offlineReceiptNumber: input.offlineReceiptNumber,
            approvedByUserId: approvedBy,
            capturedAt: input.capturedAt,
            lines: input.lines.length,
          },
        });
        publishRealtimeEvent(
          REALTIME_EVENT_TYPES.BATCH_SALES_SYNCED,
          {
            branchId: effectiveBranchId,
            deviceId: input.deviceId ?? undefined,
            syncedCount: 1,
            totalAmount: input.payment.amount,
            timestamp: Date.now(),
          },
          { branchId: effectiveBranchId },
        );
      }
      return {
        status: "POSTED" as const,
        invoiceId: res.invoiceId,
        invoiceNumber: res.invoiceNumber,
        message: `تم ترحيل العملية بفاتورة ${res.invoiceNumber}`,
      };
    } catch (e: unknown) {
      if (isDupEntry(e) && attempt < 2) continue;
      if (e instanceof TRPCError) {
        if (e.code === "PRECONDITION_FAILED") {
          const captured = await captureRejectedReplay(
            effectiveReplayInput,
            e.code,
            e.message,
            verifiedQuarantineOwnerId,
            "RETAIL",
          );
          const [durableRec] = captured
            ? await db
                .select({
                  id: offlineRecoveryItems.id,
                  recoveryStatus: offlineRecoveryItems.recoveryStatus,
                })
                .from(offlineRecoveryItems)
                .where(
                  eq(
                    offlineRecoveryItems.clientRequestId,
                    replayTargetRequestId,
                  ),
                )
                .limit(1)
            : [];
          if (!captured || !durableRec || durableRec.recoveryStatus !== "PENDING") {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: appErrorMessage({
                what: "تعذّر حفظ العملية في طابور الاسترداد الخادمي",
                why: "لم يُثبَّت سجل الاسترداد المعلّق على الخادم فتم الإبقاء على العملية محلياً لضمان عدم ضياع البيع",
                doThis: "أعِد المحاولة بعد التأكد من استقرار الاتصال بالخادم",
              }),
            });
          }
          await logAudit(auditMeta, {
            action: "offline.fencedOutbox.capturedToRecovery",
            entityType: "offlineRecoveryItem",
            entityId: Number(durableRec.id),
            branchId: effectiveBranchId,
            newValue: {
              originalClientRequestId: input.clientRequestId,
              replacementClientRequestId: replayTargetRequestId,
              offlineReceiptNumber: input.offlineReceiptNumber,
              approvedByUserId: approvedBy,
              reason: e.message,
            },
          });
          return {
            status: "CAPTURED_IN_RECOVERY" as const,
            message: e.message,
          };
        }
        throw e;
      }
      const err = e as {
        message?: string;
        code?: string;
        sqlMessage?: string;
        sql?: string;
      };
      logger.error(
        {
          err: {
            message: err?.message,
            code: err?.code,
            sqlMessage: err?.sqlMessage,
            sql: err?.sql,
          },
          userId: actor.userId,
          branchId: actor.branchId,
          offlineReceiptNumber: input.offlineReceiptNumber,
        },
        "offline.reissueFencedOutboxSale فشل بخطأ غير متوقّع",
      );
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: appErrorMessage({
          what: "تعذّر إعادة ترحيل العملية الأوفلاينية",
          why: "حدث خطأ غير متوقّع أثناء معالجة الطلب على الخادم",
          doThis: "أعِد المحاولة بعد لحظات أو راجع سجل الأخطاء الإداري",
        }),
      });
    }
  }
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذّر توليد رقم فاتورة فريد",
      why: "تكرّر تصادم الترقيم عبر ٣ محاولات متتالية",
      doThis: "أعِد إرسال طلب إعادة الترحيل بعد لحظة",
    }),
  });
}

export async function dismissOutboxItemService(
  input: {
    branchId: number;
    clientRequestId: string;
    kind: "SALE" | "PRINT_SALE" | "RECEPTION" | "RETURN";
    offlineReceiptNumber: string;
    total?: string;
    lastError?: string;
    reason?: string;
  },
  user: OfflineSessionUser,
  auditMeta: AuditMetadata,
  preverifiedApproverId: number | null,
) {
  const effectiveBranchId = resolveOfflineEffectiveBranchId(user, input.branchId);
  const replacementId = replacementClientRequestIdFor(input.clientRequestId);

  return withGovernanceTx(async (tx) => {
    const [exInv] = await tx
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        branchId: invoices.branchId,
      })
      .from(invoices)
      .where(
        or(
          and(
            eq(invoices.sourceType, "POS"),
            inArray(invoices.sourceId, [
              input.clientRequestId,
              replacementId,
              `${input.clientRequestId}-sale`,
              `${input.clientRequestId}-print`,
            ]),
          ),
          and(
            eq(invoices.branchId, effectiveBranchId),
            eq(invoices.offlineReceiptNumber, input.offlineReceiptNumber),
          ),
        ),
      )
      .limit(1);
    if (exInv) {
      if (Number(exInv.branchId) !== effectiveBranchId) {
        throwForeignBranchIdempotencyError();
      }
      return {
        status: "ALREADY_COMMITTED" as const,
        invoiceId: Number(exInv.id),
        invoiceNumber: exInv.invoiceNumber,
        message: `الفاتورة ${exInv.invoiceNumber} مرحَّلة مسبقاً على الخادم`,
      };
    }

    const [rec] = await tx
      .select({
        id: offlineRecoveryItems.id,
        recoveryStatus: offlineRecoveryItems.recoveryStatus,
        invoiceId: offlineRecoveryItems.invoiceId,
        discardReason: offlineRecoveryItems.discardReason,
        branchId: offlineRecoveryItems.branchId,
        channel: offlineRecoveryItems.channel,
      })
      .from(offlineRecoveryItems)
      .where(
        inArray(offlineRecoveryItems.clientRequestId, [
          input.clientRequestId,
          replacementId,
        ]),
      )
      .for("update")
      .limit(1);
    if (rec) {
      if (Number(rec.branchId) !== effectiveBranchId) {
        throwForeignBranchIdempotencyError();
      }
      if (
        rec.channel === "RETAIL" &&
        rec.recoveryStatus === "POSTED" &&
        rec.invoiceId != null
      ) {
        const [recInv] = await tx
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            branchId: invoices.branchId,
          })
          .from(invoices)
          .where(eq(invoices.id, Number(rec.invoiceId)))
          .limit(1);
        if (recInv) {
          if (Number(recInv.branchId) !== effectiveBranchId) {
            throwForeignBranchIdempotencyError();
          }
          return {
            status: "ALREADY_COMMITTED" as const,
            invoiceId: Number(recInv.id),
            invoiceNumber: recInv.invoiceNumber,
            message: `الفاتورة ${recInv.invoiceNumber} مرحَّلة مسبقاً عبر طابور الاسترداد`,
          };
        }
      }
      if (rec.recoveryStatus === "DISCARDED") {
        return {
          status: "SERVER_DISCARDED" as const,
          reason: rec.discardReason ?? "أُهمل العنصر مسبقاً في سجل الاسترداد",
          message:
            "العنصر مُهمل مسبقاً في طابور الاسترداد الخادمي — تم تنظيف الطابور المحلي",
        };
      }
    }

    if (input.kind === "RETURN") {
      const [retKey] = await tx
        .select({ refId: idempotencyKeys.refId })
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.operation, "sale.return"),
            eq(idempotencyKeys.clientRequestId, input.clientRequestId),
          ),
        )
        .limit(1);
      if (retKey && Number(retKey.refId) > 0) {
        return {
          status: "ALREADY_COMMITTED" as const,
          invoiceId: Number(retKey.refId),
          invoiceNumber: "",
          message: "المرتجع مُرحَّل مسبقاً على الخادم",
        };
      }
    }

    const [saleKey] = await tx
      .select({ refId: idempotencyKeys.refId })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.operation, "sale.create"),
          eq(idempotencyKeys.clientRequestId, input.clientRequestId),
        ),
      )
      .for("update")
      .limit(1);
    if (saleKey && Number(saleKey.refId) === 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "الطلب الأصلي قيد التنفيذ حالياً",
          why: "توجد معاملة مفتوحة على الخادم لنفس معرّف الطلب",
          doThis: "انتظر لحظات ثم أعد الفحص قبل إنهاء العنصر",
        }),
      });
    }

    const trimmedReason = (input.reason ?? "").trim();
    if (trimmedReason.length < 5) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "سبب إنهاء وإسقاط العملية من الطابور غير مكتمل",
          why: "يتطلب إسقاط العملية المعلّقة سبباً توثيقياً لا يقل عن ٥ أحرف",
          doThis: "اكتب سبباً واضحاً لإنهاء العملية ثم أعد التأكيد",
        }),
      });
    }
    if (preverifiedApproverId == null) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "يتطلب إسقاط العملية المعلّقة اعتماد مدير",
          why: "إزالة بيع أوفلايني معلّق من الطابور دون ترحيله قرار إداري موثّق",
          doThis:
            "أدخل بيانات اعتماد مدير معتمد أو نفّذ الإجراء من حساب مدير/أدمن",
        }),
      });
    }

    let recoveryEntityId = rec ? Number(rec.id) : 0;
    if (rec && rec.recoveryStatus === "PENDING") {
      await tx
        .update(offlineRecoveryItems)
        .set({
          recoveryStatus: "DISCARDED",
          discardReason: trimmedReason,
          reviewedBy: preverifiedApproverId,
          reviewedAt: new Date(),
        })
        .where(eq(offlineRecoveryItems.id, rec.id));
    } else if (!rec) {
      const channel =
        input.kind === "PRINT_SALE"
          ? "PRINT"
          : input.kind === "RECEPTION"
            ? "RECEPTION"
            : input.kind === "RETURN"
              ? "RETURN"
              : "RETAIL";
      const [inserted] = await tx.insert(offlineRecoveryItems).values({
        branchId: effectiveBranchId,
        deviceId: null,
        clientRequestId: input.clientRequestId,
        offlineReceiptNumber: input.offlineReceiptNumber,
        capturedAt: new Date(),
        payload: JSON.stringify({
          dismissedOutboxItem: true,
          kind: input.kind,
          total: input.total ?? null,
        }),
        rejectCode: "DISMISSED",
        rejectReason: input.lastError ?? trimmedReason,
        submittedByUserId: preverifiedApproverId,
        channel,
        recoveryStatus: "DISCARDED",
        discardReason: trimmedReason,
        reviewedBy: preverifiedApproverId,
        reviewedAt: new Date(),
      });
      recoveryEntityId = Number(
        (inserted as { insertId?: number })?.insertId ?? 0,
      );
    }

    if (input.kind === "SALE" && !saleKey) {
      await tx
        .insert(idempotencyKeys)
        .values({
          operation: "sale.create",
          clientRequestId: input.clientRequestId,
          refId: -1,
          payloadHash: null,
        })
        .onDuplicateKeyUpdate({
          set: { refId: sql`refId` },
        });
    }

    await logAuditTx(tx, auditMeta, {
      action: "offline.outbox.dismissParked",
      entityType: "offlineOutbox",
      entityId: recoveryEntityId,
      newValue: {
        clientRequestId: input.clientRequestId,
        offlineReceiptNumber: input.offlineReceiptNumber,
        kind: input.kind,
        total: input.total ?? null,
        lastError: input.lastError ?? null,
        reason: trimmedReason,
        approvedByUserId: preverifiedApproverId,
        branchId: effectiveBranchId,
      },
    });

    return {
      status: "DISMISSED" as const,
      message: "تم إنهاء وإسقاط العملية من الطابور وتسجيل القرار خادمياً",
    };
  });
}
