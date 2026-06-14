/* ============================================================================
 * موجّه tRPC لأجهزة البصمة + الهجرة — وحدة الموارد البشرية (server/routers/hrDeviceRouter.ts)
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (requireModule). كل كتابة تُدقَّق (logAudit).
 * يُركَّب تحت namespace: trpc.hrDevices (يُسجّله قائد التكامل).
 * ========================================================================== */
import { z } from "zod";
import { logAudit } from "../services/auditService";
import * as svc from "../services/hrDeviceService";
import { protectedProcedure, requireModule, router } from "../trpc";

const hrRead = protectedProcedure.use(requireModule("hr", "READ"));
const hrWrite = protectedProcedure.use(requireModule("hr", "FULL"));

const deviceInput = z.object({
  name: z.string().trim().min(1, "اسم الجهاز مطلوب"),
  model: z.string().trim().optional(),
  location: z.string().trim().optional(),
  branchId: z.number().int().positive().nullish(),
  deviceCode: z.string().trim().optional(),
  ip: z.string().trim().optional(),
  port: z.number().int().min(0).max(65535).nullish(),
  serverHost: z.string().trim().optional(),
  serverPort: z.number().int().min(0).max(65535).nullish(),
  status: z.enum(["online", "offline"]).optional(),
  usersCount: z.number().int().min(0).nullish(),
  recordsCount: z.number().int().min(0).nullish(),
  firmware: z.string().trim().optional(),
});

export const hrDeviceRouter = router({
  list: hrRead.query(() => svc.listDevices()),

  get: hrRead.input(z.object({ id: z.number().int().positive() })).query(({ input }) => svc.getDevice(input.id)),

  migrationStatus: hrRead.query(() => svc.migrationStatus()),

  create: hrWrite.input(deviceInput).mutation(async ({ input, ctx }) => {
    const d = await svc.createDevice(input as svc.DeviceInput);
    await logAudit(ctx, { action: "hrDevice.create", entityType: "hrFingerprintDevice", entityId: d?.id, newValue: { name: d?.name, location: input.location ?? null } });
    return d;
  }),

  update: hrWrite
    .input(deviceInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const { id, ...rest } = input;
      const d = await svc.updateDevice(id, rest as svc.DeviceInput);
      await logAudit(ctx, { action: "hrDevice.update", entityType: "hrFingerprintDevice", entityId: id, newValue: { name: d?.name } });
      return d;
    }),

  migrate: hrWrite.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const d = await svc.migrateDevice(input.id);
    await logAudit(ctx, { action: "hrDevice.migrate", entityType: "hrFingerprintDevice", entityId: input.id, newValue: { migrated: true, serverHost: d?.serverHost } });
    return d;
  }),
});
