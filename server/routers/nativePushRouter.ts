import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  isCurrentNativeClient,
  verifiedNativeKeyThumbprint,
} from "../auth/deviceProof";
import { logAudit } from "../services/auditService";
import {
  countActiveNativePushDevices,
  isNativePushConfigured,
  NATIVE_PUSH_ENVIRONMENTS,
  NativePushConfigurationError,
  NativePushConflictError,
  NativePushValidationError,
  registerNativePushDevice,
  revokeNativePushDevice,
} from "../services/nativePushService";
import { router, selfServiceProcedure } from "../trpc";

const installationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/);
const deviceThumbprintSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * Bind push registration/revocation to the same P-256 key already authenticated by the native
 * session proof. A browser session cannot opt into this merely by adding a public-key header:
 * declaring the current native client makes the authenticated self-service boundary require a
 * proof-bound `dpk` cookie. Every operation remains owned by `ctx.user`; callers cannot select a
 * different user or employee.
 */
export function assertNativePushDeviceBinding(
  req: { headers?: Record<string, unknown> },
  claimedThumbprint: string,
): string {
  let verified: string | null = null;
  try {
    if (isCurrentNativeClient(req)) verified = verifiedNativeKeyThumbprint(req);
  } catch {
    verified = null;
  }
  if (!verified || verified !== claimedThumbprint) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "هوية جهاز الإشعارات لا تطابق الجلسة.",
    });
  }
  return verified;
}

function rethrowNativePushError(error: unknown): never {
  if (error instanceof NativePushValidationError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  if (error instanceof NativePushConflictError) {
    throw new TRPCError({ code: "CONFLICT", message: error.message });
  }
  if (error instanceof NativePushConfigurationError) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: error.message,
    });
  }
  throw error;
}

/** Native Android push registration. Ownership is always taken from the authenticated ERP user. */
export const nativePushRouter = router({
  status: selfServiceProcedure.query(async ({ ctx }) => ({
    configured: isNativePushConfigured(),
    activeCount: await countActiveNativePushDevices(ctx.user.id),
  })),

  register: selfServiceProcedure
    .input(
      z
        .object({
          installationId: installationIdSchema,
          devicePublicKeyHash: deviceThumbprintSchema,
          environment: z.enum(NATIVE_PUSH_ENVIRONMENTS),
          appVersion: z.string().trim().min(1).max(64),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const devicePublicKeyHash = assertNativePushDeviceBinding(
          ctx.req as { headers?: Record<string, unknown> },
          input.devicePublicKeyHash,
        );
        const result = await registerNativePushDevice({
          userId: ctx.user.id,
          ...input,
          devicePublicKeyHash,
        });
        await logAudit(ctx, {
          action: "nativePush.registered",
          entityType: "nativePushDevice",
          entityId: result.id,
          newValue: {
            installationIdHash: result.installationIdHash,
            devicePublicKeyHash,
            environment: input.environment,
            appVersion: input.appVersion,
          },
        });
        return { id: result.id, registered: true as const };
      } catch (error) {
        rethrowNativePushError(error);
      }
    }),

  revokeDevice: selfServiceProcedure
    .input(z.object({ devicePublicKeyHash: deviceThumbprintSchema }).strict())
    .mutation(async ({ input, ctx }) => {
      try {
        const deviceHash = assertNativePushDeviceBinding(
          ctx.req as { headers?: Record<string, unknown> },
          input.devicePublicKeyHash,
        );
        await revokeNativePushDevice(ctx.user.id, deviceHash);
        await logAudit(ctx, {
          action: "nativePush.device_revoked",
          entityType: "nativePushDevice",
          entityId: deviceHash,
        });
        return { revoked: true as const };
      } catch (error) {
        rethrowNativePushError(error);
      }
    }),
});
