/* ============================================================================
 * موجّه tRPC لأجهزة البصمة + الهجرة — وحدة الموارد البشرية (server/routers/hrDeviceRouter.ts)
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (requireModule). كل كتابة تُدقَّق (logAudit).
 * يُركَّب تحت namespace: trpc.hrDevices (يُسجّله قائد التكامل).
 * ========================================================================== */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { logAudit } from "../services/auditService";
import * as svc from "../services/hrDeviceService";
import {
  DEVICE_COMMANDS,
  PROTOCOL_COMMANDS,
  enqueueCommand,
  foldSoon,
  mapDeviceUserToEmployee,
  processPendingFolds,
} from "../services/hrDevices";
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
  serialNumber: z.string().trim().max(64).optional(),
  protocol: z.enum(["AIFACE_WS", "ZKTECO_PUSH"]).optional(),
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

  /* —— المزامنة الحقيقية (0089) —— */

  bridgeStatus: hrRead.query(() => svc.bridgeStatus()),

  punchesList: hrRead
    .input(
      z.object({
        deviceId: z.number().int().positive().optional(),
        unmatchedOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      })
    )
    .query(({ input }) => svc.listPunches(input)),

  deviceUsers: hrRead
    .input(z.object({ deviceId: z.number().int().positive() }))
    .query(({ input }) => svc.listDeviceUsers(input.deviceId)),

  /** ربط مستخدم جهاز بموظف — يلحق الربط بالبصمات الخام السابقة ويطويها فوراً. */
  mapUser: hrWrite
    .input(
      z.object({
        deviceId: z.number().int().positive(),
        enrollId: z.number().int().min(0),
        employeeId: z.number().int().positive().nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const backfilled = await mapDeviceUserToEmployee(input.deviceId, input.enrollId, input.employeeId);
      if (input.employeeId != null) foldSoon();
      await logAudit(ctx, {
        action: "hrDevice.mapUser",
        entityType: "hrDeviceUser",
        entityId: input.enrollId,
        newValue: { deviceId: input.deviceId, employeeId: input.employeeId, backfilled },
      });
      return { backfilled };
    }),

  /** إرسال أمر للجهاز (قائمة بيضاء لكل بروتوكول) — يُدفع فوراً إن كان متصلاً وإلا عند نبضته. */
  enqueueCommand: hrWrite
    .input(
      z.object({
        deviceId: z.number().int().positive(),
        cmd: z.enum(DEVICE_COMMANDS),
        payload: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const device = await svc.getDevice(input.deviceId);
      if (!device) throw new TRPCError({ code: "NOT_FOUND", message: "الجهاز غير موجود" });
      const allowed = PROTOCOL_COMMANDS[device.protocol] ?? [];
      if (!allowed.includes(input.cmd)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `الأمر ${input.cmd} غير مدعوم لبروتوكول ${device.protocol} حالياً`,
        });
      }
      const commandId = await enqueueCommand(input.deviceId, input.cmd, input.payload ?? null, ctx.user.id);
      await logAudit(ctx, {
        action: "hrDevice.command",
        entityType: "hrFingerprintDevice",
        entityId: input.deviceId,
        newValue: { cmd: input.cmd, commandId },
      });
      return { commandId };
    }),

  commandsList: hrRead
    .input(z.object({ deviceId: z.number().int().positive(), limit: z.number().int().min(1).max(100).optional() }))
    .query(({ input }) => svc.listCommands(input.deviceId, input.limit ?? 30)),

  /** اعتماد جهاز سجّل نفسه تلقائياً (بوابة القبول — لا بصمات تُقبل قبله). */
  approveDevice: hrWrite
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().trim().max(200).optional(),
        branchId: z.number().int().positive().nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const d = await svc.approveDevice(input.id, { name: input.name, branchId: input.branchId ?? null });
      await logAudit(ctx, {
        action: "hrDevice.approve",
        entityType: "hrFingerprintDevice",
        entityId: input.id,
        newValue: { enabled: true, name: d?.name },
      });
      return d;
    }),

  /** تشغيل الطيّ يدوياً (زر «معالجة الآن» — مفيد بعد ربط دفعة مستخدمين). */
  processFolds: hrWrite.mutation(async ({ ctx }) => {
    const res = await processPendingFolds();
    await logAudit(ctx, { action: "hrDevice.processFolds", entityType: "hrFingerprintDevice", entityId: 0, newValue: res });
    return res;
  }),
});
