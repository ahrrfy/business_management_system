/**
 * kioskRouter — شاشة «قارئ الأسعار» للزبون (الكشك) + إدارة الأجهزة الخارجية.
 *
 * ثلاث طبقات وصول:
 *  ① القراءات (banner/lookup) عبر `kioskReadProcedure`: تقبل مستخدم نظام مسجَّل **أو** كوكي جهاز كشك
 *     **أو** وصولاً عاماً بلا مصادقة (قارئ الأسعار — branchId من المدخل إلزامي).
 *     عند الجهاز: الفرع **مفروض من القاعدة** (resolveKioskDevice) ⇒ يتجاهل أي branchId من العميل (لا IDOR).
 *  ② دخول/خروج الجهاز (deviceLogin/deviceMe/deviceLogout) publicProcedure: الهوية كوكي الجهاز.
 *  ③ إدارة الأجهزة (devices.*) adminProcedure: إنشاء/تدوير/إلغاء/حذف — الرمز الخام يُعرض مرّة واحدة.
 *
 * المخرَج آمن للزبون (kioskService): بلا تكلفة ولا كمية مخزون ولا أسعار جملة/حكومي.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { branches } from "../../drizzle/schema";
import { getDb } from "../db";
import { getSessionCookieOptions } from "../cookies";
import { KIOSK_COOKIE_NAME, KIOSK_TOKEN_TTL_MS, signKioskSession } from "../auth/kioskSession";
import { logAudit } from "../services/auditService";
import { kioskBanner, kioskLookup } from "../services/kioskService";
import {
  createKioskDevice,
  deleteKioskDevice,
  deviceLoginByToken,
  listKioskDevices,
  resolveKioskDevice,
  rotateKioskDevice,
  setKioskDeviceActive,
} from "../services/kioskDeviceService";
import { adminProcedure, middleware, publicProcedure, router } from "../trpc";

/**
 * وسيط القراءة: يُمرّر المستخدم المسجَّل كما هو (deviceBranchId=null ⇒ يُستعمل branchId من المدخل)،
 * أو يحلّ جهاز الكشك من الكوكي فيفرض فرعه، أو يسمح بالوصول العام (بلا مصادقة — قارئ الأسعار)
 * حيث يجب أن يُرسل العميل branchId صراحةً.
 */
const kioskRead = middleware(async ({ ctx, next }) => {
  if (ctx.user) {
    return next({ ctx: { ...ctx, deviceBranchId: null as number | null } });
  }
  const device = await resolveKioskDevice(ctx.req);
  if (device) {
    return next({ ctx: { ...ctx, deviceBranchId: device.branchId as number | null } });
  }
  // وصول عام (قارئ الأسعار بلا دخول) — branchId من المدخل إلزامي
  return next({ ctx: { ...ctx, deviceBranchId: null as number | null } });
});
const kioskReadProcedure = publicProcedure.use(kioskRead);

/** الفرع الفعّال: المفروض من الجهاز (إن وُجد) وإلّا المُرسَل من المستخدم. */
function effectiveBranchId(deviceBranchId: number | null, inputBranchId?: number): number {
  const b = deviceBranchId ?? inputBranchId;
  if (!b || !Number.isInteger(b) || b <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الفرع غير محدّد." });
  }
  return b;
}

const deviceIdInput = z.object({ id: z.number().int().positive() });

export const kioskRouter = router({
  /** قائمة الفروع النشطة (عامة — لقارئ الأسعار بلا دخول). أسماء ومعرّفات فقط. */
  publicBranches: publicProcedure.query(async () => {
    const db = getDb();
    if (!db) return [];
    return db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(eq(branches.isActive, true))
      .orderBy(asc(branches.id));
  }),

  /** منتجات البنر المتوفّرة في الفرع (كامل الكتالوج — بلا سقف). */
  banner: kioskReadProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }))
    .query(({ input, ctx }) => kioskBanner(effectiveBranchId(ctx.deviceBranchId, input.branchId))),

  /** بحث سعر بالباركود (المسح). يعيد null إن لم يُعرَف الباركود. */
  lookup: kioskReadProcedure
    .input(z.object({ branchId: z.number().int().positive().optional(), barcode: z.string().min(1).max(64) }))
    .query(({ input, ctx }) => kioskLookup(input.barcode, effectiveBranchId(ctx.deviceBranchId, input.branchId))),

  // ───────────────────────── مصادقة الجهاز الخارجي ─────────────────────────

  /** دخول الجهاز بالرمز الخام ⇒ كوكي جهاز (KIOSK_COOKIE_NAME). محدود المعدّل في index.ts. */
  deviceLogin: publicProcedure
    .input(z.object({ token: z.string().min(8).max(128) }))
    .mutation(async ({ input, ctx }) => {
      const ip = ctx.req.ip ?? null;
      const r = await deviceLoginByToken(input.token, ip);
      if (!r) {
        await logAudit(ctx, {
          action: "kiosk.deviceLogin.failed",
          entityType: "kioskDevice",
          entityId: null,
          newValue: { prefix: input.token.slice(0, 12) },
        });
        throw new TRPCError({ code: "UNAUTHORIZED", message: "رمز الجهاز غير صحيح أو مُلغى — اطلب من المدير تزويد رمز جديد." });
      }
      const token = await signKioskSession(r.deviceId, r.branchId, r.tokenPrefix);
      ctx.res.cookie(KIOSK_COOKIE_NAME, token, { ...getSessionCookieOptions(ctx.req), maxAge: KIOSK_TOKEN_TTL_MS });
      await logAudit(ctx, {
        action: "kiosk.deviceLogin",
        entityType: "kioskDevice",
        entityId: r.deviceId,
        newValue: { branchId: r.branchId, label: r.label },
      });
      return { ok: true as const, branchId: r.branchId, branchName: r.branchName, label: r.label };
    }),

  /** حالة الجهاز الحالي من الكوكي (لصفحة /kiosk). null = غير مُصرَّح. */
  deviceMe: publicProcedure.query(async ({ ctx }) => {
    const device = await resolveKioskDevice(ctx.req);
    if (!device) return null;
    return {
      deviceId: device.deviceId,
      branchId: device.branchId,
      branchName: device.branchName,
      label: device.label,
    };
  }),

  /** خروج الجهاز: مسح كوكي الجهاز فقط (لا يمسّ كوكي جلسة النظام). */
  deviceLogout: publicProcedure.mutation(async ({ ctx }) => {
    ctx.res.clearCookie(KIOSK_COOKIE_NAME, getSessionCookieOptions(ctx.req));
    return { ok: true } as const;
  }),

  // ───────────────────────── إدارة الأجهزة (مدير) ─────────────────────────

  devices: router({
    /** قائمة الأجهزة (بلا الرمز الخام — يُعرض مرّة واحدة عند الإنشاء/التدوير فقط). */
    list: adminProcedure.query(() => listKioskDevices()),

    /** إنشاء جهاز ⇒ يُعيد الرمز الخام مرّة واحدة (احفظه فوراً؛ لن يظهر ثانيةً). */
    create: adminProcedure
      .input(z.object({ branchId: z.number().int().positive(), label: z.string().trim().min(1).max(120) }))
      .mutation(async ({ input, ctx }) => {
        const r = await createKioskDevice({ branchId: input.branchId, label: input.label, createdBy: ctx.user.id });
        await logAudit(ctx, {
          action: "kiosk.device.create",
          entityType: "kioskDevice",
          entityId: r.id,
          newValue: { branchId: input.branchId, label: input.label, tokenPrefix: r.tokenPrefix },
        });
        return { id: r.id, rawToken: r.rawToken, tokenPrefix: r.tokenPrefix };
      }),

    /** تدوير الرمز ⇒ رمز خام جديد (يُبطل القديم فوراً). */
    rotate: adminProcedure.input(deviceIdInput).mutation(async ({ input, ctx }) => {
      const r = await rotateKioskDevice(input.id);
      await logAudit(ctx, {
        action: "kiosk.device.rotate",
        entityType: "kioskDevice",
        entityId: input.id,
        newValue: { tokenPrefix: r.tokenPrefix },
      });
      return { rawToken: r.rawToken, tokenPrefix: r.tokenPrefix };
    }),

    /** تفعيل/إلغاء الجهاز (الإلغاء يُبطل توكنه فوراً). */
    setActive: adminProcedure
      .input(z.object({ id: z.number().int().positive(), active: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        await setKioskDeviceActive(input.id, input.active);
        await logAudit(ctx, {
          action: input.active ? "kiosk.device.reactivate" : "kiosk.device.revoke",
          entityType: "kioskDevice",
          entityId: input.id,
        });
        return { ok: true as const };
      }),

    /** حذف الجهاز نهائياً. */
    remove: adminProcedure.input(deviceIdInput).mutation(async ({ input, ctx }) => {
      await deleteKioskDevice(input.id);
      await logAudit(ctx, { action: "kiosk.device.delete", entityType: "kioskDevice", entityId: input.id });
      return { ok: true as const };
    }),
  }),
});
