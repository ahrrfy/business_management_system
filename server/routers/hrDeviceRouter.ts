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
import { eq } from "drizzle-orm";
import { employees } from "../../drizzle/schema";
import { requireDb } from "../services/tx";
import { isDupEntry, toArabicMessage } from "@shared/errorMap.ar";
import { isExactHostNetwork, resolveBridgeSecurityConfig } from "../services/hrDevices/bridgeSecurity";
import {
  adoptDeviceOrigin,
  getOriginAttempt,
  listPendingOriginAttempts,
  resolveOriginAttempt,
} from "../services/hrDevices/originTrust";

const hrRead = protectedProcedure.use(requireModule("hr", "READ"));
const hrWrite = protectedProcedure.use(requireModule("hr", "FULL"));
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");

/**
 * سريان الربط: التاريخ الصريح إن أُعطي، وإلا تاريخ مباشرة الموظف.
 * الحدّ الافتراضيّ هو الحارس الفعليّ — الجهاز يحمل عشرات آلاف السجلات التاريخية، وربطٌ
 * بلا حدٍّ ينسب حضور من حمل الرقم قبله. غياب تاريخ المباشرة ⇒ null (بلا حدّ) والواجهة تُنبّه.
 */
async function resolveEffectiveFrom(employeeId: number, explicit?: string | null): Promise<string | null> {
  if (explicit) return explicit;
  const db = requireDb();
  const [e] = await db
    .select({ hireDate: employees.hireDate })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);
  if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
  return e.hireDate ?? null;
}

const deviceInput = z.object({
  name: z.string().trim().min(1, "اسم الجهاز مطلوب"),
  model: z.string().trim().optional(),
  location: z.string().trim().optional(),
  branchId: z.number().int().positive().nullish(),
  deviceCode: z.string().trim().optional(),
  ip: z
    .string()
    .trim()
    .max(80)
    .refine((value) => isExactHostNetwork(value), "أدخل عنوان IP واحداً صالحاً للجهاز")
    .optional(),
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

  /**
   * فلترا موظف/مدى تاريخ فوق `hrDeviceService.listPunches` — الخدمة (خارج ملكية هذه الشريحة)
   * تدعم deviceId/unmatchedOnly بترقيمٍ حقيقيّ على مستوى SQL فقط؛ الموظف والتاريخ يُطبَّقان هنا
   * بمسحٍ تراكميّ فوق صفحات الخدمة (٢٠٠ الحدّ الأقصى لكل نداء) حتى تُشبَع نافذة (offset,limit)
   * المطلوبة أو يُبلَغ صمّام أمان (٤٠٠٠ سجلّ) — الطابور مرتّبٌ الأحدث أولاً فالمسح يبدأ من هناك.
   */
  punchesList: hrRead
    .input(
      z.object({
        deviceId: z.number().int().positive().optional(),
        unmatchedOnly: z.boolean().optional(),
        employeeId: z.number().int().positive().optional(),
        dateFrom: dateStr.optional(),
        dateTo: dateStr.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      })
    )
    .query(async ({ input }) => {
      const limit = input.limit ?? 25;
      const targetOffset = input.offset ?? 0;
      if (input.employeeId == null && !input.dateFrom && !input.dateTo) {
        return svc.listPunches({ deviceId: input.deviceId, unmatchedOnly: input.unmatchedOnly, limit, offset: targetOffset });
      }

      const SCAN_PAGE = 200;
      const SCAN_CAP = 4000;
      type PunchRow = Awaited<ReturnType<typeof svc.listPunches>>["rows"][number];
      const matched: PunchRow[] = [];
      let scanOffset = 0;
      let serviceHasMore = true;
      while (matched.length < targetOffset + limit + 1 && serviceHasMore && scanOffset < SCAN_CAP) {
        const page = await svc.listPunches({ deviceId: input.deviceId, unmatchedOnly: input.unmatchedOnly, limit: SCAN_PAGE, offset: scanOffset });
        for (const r of page.rows) {
          if (input.employeeId != null && r.employeeId !== input.employeeId) continue;
          const day = r.punchAt ? new Date(r.punchAt as unknown as string).toISOString().slice(0, 10) : null;
          if (input.dateFrom && (!day || day < input.dateFrom)) continue;
          if (input.dateTo && (!day || day > input.dateTo)) continue;
          matched.push(r);
        }
        scanOffset += page.rows.length;
        serviceHasMore = page.hasMore;
      }
      return {
        rows: matched.slice(targetOffset, targetOffset + limit),
        hasMore: matched.length > targetOffset + limit || serviceHasMore,
      };
    }),

  deviceUsers: hrRead
    .input(z.object({ deviceId: z.number().int().positive() }))
    .query(({ input }) => svc.listDeviceUsers(input.deviceId)),

  /**
   * ربط مستخدم جهاز بموظف — يلحق الربط بالبصمات الخام السابقة ويطويها فوراً.
   * `effectiveFrom` يحدّ الإلحاق الرجعيّ (لا تُنسَب بصمةٌ أقدم منه). غيابه ⇒ يُشتقّ من تاريخ
   * مباشرة الموظف: أرقام الأجهزة تُعاد استعمالها، وسحب تاريخ الجهاز بلا حدٍّ كان ينسب
   * حضور موظفٍ سابق حمل الرقم نفسه للموظف الحالي فيدخل احتساب راتبه.
   */
  mapUser: hrWrite
    .input(
      z.object({
        deviceId: z.number().int().positive(),
        enrollId: z.number().int().min(0),
        employeeId: z.number().int().positive().nullable(),
        effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح").nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const from = input.employeeId == null ? null : await resolveEffectiveFrom(input.employeeId, input.effectiveFrom);
      let backfilled: number;
      try {
        backfilled = await mapDeviceUserToEmployee(input.deviceId, input.enrollId, input.employeeId, from);
      } catch (err) {
        if (isDupEntry(err)) throw new TRPCError({ code: "CONFLICT", message: toArabicMessage({ cause: err }), cause: err });
        throw err;
      }
      if (input.employeeId != null) foldSoon();
      await logAudit(ctx, {
        action: "hrDevice.mapUser",
        entityType: "hrDeviceUser",
        entityId: input.enrollId,
        newValue: { deviceId: input.deviceId, employeeId: input.employeeId, effectiveFrom: from, backfilled },
      });
      return { backfilled, effectiveFrom: from };
    }),

  /** ربوط جهاز الحضور لموظف واحد — تُعرَض في بطاقة الموظف (الربط يُدار من حيث يُوظَّف). */
  employeeLinks: hrRead
    .input(z.object({ employeeId: z.number().int().positive() }))
    .query(({ input }) => svc.listEmployeeDeviceLinks(input.employeeId)),

  /** أرقام الجهاز غير المربوطة — قائمة الاختيار في حوار الربط ببطاقة الموظف. */
  unlinkedDeviceUsers: hrRead
    .input(z.object({ deviceId: z.number().int().positive() }))
    .query(({ input }) => svc.listUnlinkedDeviceUsers(input.deviceId)),

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

  /** حذف صفّ جهازٍ وهميّ (سُجّل تلقائياً من فحص اتصال) — غير معتمَد وبلا بصمات وبلا مستخدمين. */
  deleteDevice: hrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await svc.deleteDevice(input.id);
      await logAudit(ctx, {
        action: "hrDevice.delete",
        entityType: "hrFingerprintDevice",
        entityId: input.id,
        oldValue: { name: res.name, serialNumber: res.serialNumber },
      });
      return res;
    }),

  /* ── مصادر الاتصال («العنوان يُتعلَّم لا يُكتَب») ─────────────────────────────
   * مزوّد الإنترنت يغيّر عنوان المتجر العامّ دورياً فتصدّ بوّابةُ الهويّة الجهازَ. الاعتماد
   * تلقائيّ متى عزّزته جلسةُ موظّفٍ مُصادَقة (originTrust)؛ وهذه الإجراءات هي المسار
   * الاحتياطيّ المرئيّ حين تغيب القرينة — بدل SSH وتعديلٍ يدويّ على الإنتاج. */

  /** محاولات الاتصال المعلّقة من عناوين غير موثوقة — للعرض في شاشة الأجهزة. */
  pendingOrigins: hrRead.query(() => listPendingOriginAttempts(20)),

  /** اعتماد عنوانٍ جديد لجهاز بنقرة (مدير) — يسري فوراً بلا إعادة تشغيل الجسر. */
  trustOrigin: hrWrite
    .input(
      z.object({
        id: z.number().int().positive(),
        /** إلزاميّ للمصدر المحجوب عند البوّابة الأولى (بلا رقم تسلسليّ) — يختاره المدير. */
        deviceId: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const attempt = await getOriginAttempt(input.id);
      if (!attempt) throw new TRPCError({ code: "NOT_FOUND", message: "المحاولة غير موجودة" });
      if (attempt.resolvedAt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "المحاولة محسومة مسبقاً" });
      }
      const deviceId = attempt.deviceId ?? input.deviceId ?? null;
      if (deviceId == null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "اختر الجهاز الذي يخصّه هذا العنوان قبل الاعتماد.",
        });
      }
      const device = await svc.getDevice(deviceId);
      if (!device) throw new TRPCError({ code: "NOT_FOUND", message: "الجهاز غير موجود" });
      if (!device.enabled) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "اعتمد الجهاز أولاً من قائمة الأجهزة." });
      }
      // ربطٌ صريح في .env يتجاهل عمود `ip` تماماً ⇒ كتابته هنا وعدٌ كاذب: الشاشة تقول
      // «سيتصل» والجهاز يبقى مرفوضاً. نرفض برسالةٍ تدلّ على مكان الإصلاح الحقيقيّ.
      const serial = device.serialNumber?.trim();
      if (serial && resolveBridgeSecurityConfig().deviceIdentityBindings[serial]) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "هذا الجهاز مربوطٌ صراحةً في إعدادات الخادم (HR_DEVICE_IDENTITY_BINDINGS) — عدّل الربط هناك؛ تعديل العنوان هنا لن يُغيّر شيئاً.",
        });
      }
      try {
        await adoptDeviceOrigin({
          deviceId,
          serialNumber: serial || attempt.serialNumber,
          ip: attempt.ip,
          resolution: "MANUAL",
          resolvedBy: Number(ctx.user.id),
        });
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        if (raw.startsWith("HR_ORIGIN_ADOPT_CONFLICT:")) {
          throw new TRPCError({ code: "BAD_REQUEST", message: raw.split(":").slice(1).join(":") });
        }
        throw e;
      }
      // المصدر المحجوب سُجّل برقمٍ تسلسليّ فارغ؛ حسمُه يحتاج مفتاحه هو لا سريال الجهاز.
      await resolveOriginAttempt({
        serialNumber: attempt.serialNumber,
        ip: attempt.ip,
        resolution: "MANUAL",
        resolvedBy: Number(ctx.user.id),
      });
      await logAudit(ctx, {
        action: "hrDevice.trustOrigin",
        entityType: "hrFingerprintDevice",
        entityId: deviceId,
        newValue: { ip: attempt.ip, serialNumber: serial ?? null, attempts: attempt.attemptCount },
      });
      return { ok: true as const, ip: attempt.ip };
    }),

  /** صرف محاولة (ليست جهازنا) — تختفي من الطابور ولا تُمنح أيّ ثقة. */
  dismissOrigin: hrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const attempt = await getOriginAttempt(input.id);
      if (!attempt) throw new TRPCError({ code: "NOT_FOUND", message: "المحاولة غير موجودة" });
      await resolveOriginAttempt({
        serialNumber: attempt.serialNumber,
        ip: attempt.ip,
        resolution: "DISMISSED",
        resolvedBy: Number(ctx.user.id),
      });
      await logAudit(ctx, {
        action: "hrDevice.dismissOrigin",
        entityType: "hrFingerprintDevice",
        entityId: attempt.deviceId ?? 0,
        oldValue: { ip: attempt.ip, serialNumber: attempt.serialNumber },
      });
      return { ok: true as const };
    }),

  /** تشغيل الطيّ يدوياً (زر «معالجة الآن» — مفيد بعد ربط دفعة مستخدمين). */
  processFolds: hrWrite.mutation(async ({ ctx }) => {
    const res = await processPendingFolds();
    await logAudit(ctx, { action: "hrDevice.processFolds", entityType: "hrFingerprintDevice", entityId: 0, newValue: res });
    return res;
  }),
});
