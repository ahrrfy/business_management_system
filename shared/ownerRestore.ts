import { z } from "zod";

export const OWNER_RESTORE_STATUS_PATH = "/api/backups/owner-restore/status";
export const ownerRestoreName = z.string().max(180).regex(/^[A-Za-z0-9_.$-]+\.sql$/).refine(name => !name.includes(".."));
export const ownerRestoreTicket = z.string().regex(/^[a-f0-9]{64}$/);
export const ownerRestoreTargetSchema = z.object({
  host: z.enum(["127.0.0.1", "[::1]", "localhost"]),
  port: z.number().int().min(1).max(65535),
  database: z.string().regex(/^[A-Za-z0-9_]+$/),
  user: z.string().regex(/^[A-Za-z0-9_]+$/),
});
export const ownerRestoreRequest = z.object({
  name: ownerRestoreName,
  actorId: z.number().int().positive(),
  target: ownerRestoreTargetSchema,
  source: z.object({ size: z.number().int().positive(), sha256: ownerRestoreTicket }),
});
export const ownerRestoreStatus = z.object({
  id: z.string().uuid(),
  name: ownerRestoreName,
  phase: z.enum(["PREPARING", "MAINTENANCE", "BACKING_UP", "RESTORING", "ROLLING_BACK",
    "RESTORED", "ROLLED_BACK", "FAILED", "RECOVERY_REQUIRED"]),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  safetyArchive: z.string().max(185).nullable(),
  error: z.string().regex(/^[A-Z0-9_]{3,64}$/).nullable(),
});
export const ownerRestoreStart = z.object({ ticket: ownerRestoreTicket, status: ownerRestoreStatus });
export type OwnerRestoreStatus = z.infer<typeof ownerRestoreStatus>;

export function ownerRestoreConfirmation(name: string) {
  return `استعادة ${name}.gpg`;
}
