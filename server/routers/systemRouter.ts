// راوتر النظام: معلومات + إدارة النسخ/الاستعادة/التصفير داخل النظام (للمدير فقط).
// العمليات المدمّرة (restore/reset) محصّنة: adminProcedure + إعادة كلمة مرور المدير + رمز تأكيد
// (اسم القاعدة) + نسخة أمان تلقائية (داخل السكربتات) + تدقيق. CSRF مغطّى عبر csrfGuard على /api/trpc.
import { count } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "../trpc";
import type { TrpcContext } from "../context";
import { getDb, isMultiTenantModeActive } from "../db";
import { branches, users, products, customers, invoices } from "../../drizzle/schema";
import { verifyPassword } from "../auth/password";
import { logAudit } from "../services/auditService";
import { getConfiguredTarget, describeTarget } from "../services/printService";
import * as maint from "../services/maintenanceService";
import { getTaxSettings, updateTaxSettings } from "../services/taxSettingsService";

/** يتحقّق من كلمة مرور المدير الحالية (دفاع ضد النقر الخاطئ/جلسة مسروقة). */
function assertPassword(ctx: TrpcContext, password: string) {
  if (!ctx.user || !verifyPassword(password, ctx.user.passwordHash)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "كلمة المرور غير صحيحة." });
  }
}

/** يتحقّق أن رمز التأكيد يطابق اسم القاعدة بالضبط. */
async function assertConfirm(confirm: string) {
  const db = await maint.currentDbName();
  if (!confirm || confirm.trim() !== db) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `رمز التأكيد يجب أن يطابق اسم القاعدة «${db}».` });
  }
}

/**
 * ⛔ يمنع استعادة/تصفير القاعدة كاملةً في وضع تعدّد الشركات — راجع التوثيق المُفصَّل أعلى
 * `runRestore`/`runReset` في maintenanceService.ts لسبب هذا القيد المعماري (لا نقص مؤجَّل).
 * النسخ/القائمة/الحذف/التنزيل تبقى متاحة، مقيَّدة تلقائياً بملفات الشركة الحالية فقط.
 */
function assertSingleTenantOnly(action: string) {
  if (isMultiTenantModeActive()) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        `${action} غير متاح في وضع تعدّد الشركات — عمليات استعادة/تصفير القاعدة كاملةً معطّلة ` +
        "حفاظاً على عزل بيانات الشركات (لا يمكن لأدوات النسخ الحالية ضمان بقاء العملية داخل حدود " +
        "قاعدة شركتك وحدها). النسخ الاحتياطي والتنزيل والحذف لملفاتك تبقى متاحة كما هي. للاستعادة " +
        "الفعلية تواصل مع فريق تشغيل المنصّة.",
    });
  }
}

export const systemRouter = router({
  health: publicProcedure.query(() => ({ ok: true, time: new Date().toISOString() })),

  /** لوحة معلومات النظام (للمدير): القاعدة، الأعداد، النسخ، الطباعة، الجدولة. */
  systemInfo: adminProcedure.query(async () => {
    const db = getDb();
    let counts = { branches: 0, users: 0, products: 0, customers: 0, invoices: 0 };
    if (db) {
      const [b, u, p, c, i] = await Promise.all([
        db.select({ n: count() }).from(branches),
        db.select({ n: count() }).from(users),
        db.select({ n: count() }).from(products),
        db.select({ n: count() }).from(customers),
        db.select({ n: count() }).from(invoices),
      ]);
      counts = { branches: b[0].n, users: u[0].n, products: p[0].n, customers: c[0].n, invoices: i[0].n };
    }
    const target = getConfiguredTarget();
    const [dbName, dbHostVal] = await Promise.all([maint.currentDbName(), maint.currentDbHost()]);
    return {
      db: { name: dbName, host: dbHostVal },
      counts,
      backups: { ...(await maint.backupsStats()), dir: process.env.BACKUP_DIR ?? "backups" },
      printer: { enabled: target != null, description: describeTarget(target) },
      schedule: {
        dailyAt: "02:00",
        offsiteConfigured: !!(process.env.BACKUP_OFFSITE_DIR && process.env.BACKUP_OFFSITE_DIR.trim()),
      },
      confirmToken: dbName,
    };
  }),

  /** قائمة آخر النسخ الاحتياطية المحلّية (للمدير). */
  listBackups: adminProcedure.query(async () => ({
    dir: process.env.BACKUP_DIR ?? "backups",
    backups: (await maint.listBackupFiles()).slice(0, 50),
  })),

  /** نسخة احتياطية الآن (تطابق DATABASE_URL). يعيد الملف المُنشأ. */
  backupNow: adminProcedure.mutation(async ({ ctx }) => {
    const created = await maint.runBackup();
    await logAudit(ctx, { action: "system.backup", entityType: "system", entityId: created?.name ?? null });
    return { ok: true as const, created };
  }),

  /** حذف نسخة احتياطية (للمدير، مسار آمن). */
  deleteBackup: adminProcedure.input(z.object({ name: z.string() })).mutation(async ({ ctx, input }) => {
    const ok = await maint.deleteBackup(input.name);
    if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "النسخة غير موجودة." });
    await logAudit(ctx, { action: "system.backup.delete", entityType: "system", entityId: input.name });
    return { ok: true as const };
  }),

  /** استعادة من نسخة خادم (مدمّر): كلمة مرور + رمز تأكيد + نسخة أمان تلقائية. */
  restoreBackup: adminProcedure
    .input(z.object({ name: z.string(), confirm: z.string(), password: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      assertSingleTenantOnly("استعادة نسخة");
      assertPassword(ctx, input.password);
      await assertConfirm(input.confirm);
      const abs = await maint.resolveBackupFile(input.name);
      if (!abs) throw new TRPCError({ code: "NOT_FOUND", message: "النسخة غير موجودة." });
      await logAudit(ctx, { action: "system.restore.begin", entityType: "system", entityId: input.name });
      await maint.runRestore(abs);
      await logAudit(ctx, { action: "system.restore", entityType: "system", entityId: input.name });
      return { ok: true as const, source: input.name };
    }),

  /** استعادة من ملف مرفوع (مدمّر): كلمة مرور + رمز تأكيد + تحقّق توقيع + حجر مؤقّت + نسخة أمان. */
  restoreUpload: adminProcedure
    .input(z.object({ fileName: z.string(), fileB64: z.string(), confirm: z.string(), password: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      assertSingleTenantOnly("استعادة ملف مرفوع");
      assertPassword(ctx, input.password);
      await assertConfirm(input.confirm);
      const tmp = await maint.quarantineUpload(input.fileB64);
      try {
        await logAudit(ctx, { action: "system.restore.upload.begin", entityType: "system", entityId: input.fileName });
        await maint.runRestore(tmp);
      } finally {
        await maint.cleanupTmp(tmp);
      }
      await logAudit(ctx, { action: "system.restore.upload", entityType: "system", entityId: input.fileName });
      return { ok: true as const, source: input.fileName };
    }),

  /** تصفير «نظام فارغ» (مدمّر جداً): كلمة مرور + رمز تأكيد + نسخة أمان تلقائية. */
  resetSystem: adminProcedure
    .input(z.object({ confirm: z.string(), password: z.string().min(1), seed: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      assertSingleTenantOnly("تصفير النظام");
      assertPassword(ctx, input.password);
      await assertConfirm(input.confirm);
      await logAudit(ctx, { action: "system.reset.begin", entityType: "system", entityId: null });
      await maint.runReset(!!input.seed);
      await logAudit(ctx, { action: "system.reset", entityType: "system", entityId: input.seed ? "seeded" : "empty" });
      return { ok: true as const };
    }),

  /** إعدادات الضريبة الحالية (أيّ مستخدم مُصادَق — تحتاجها شاشات البيع/الشراء الجديدة لتهيئة الافتراضي). */
  getTaxSettings: protectedProcedure.query(() => getTaxSettings()),

  /** تحديث إعدادات الضريبة (للمدير فقط). */
  updateTaxSettings: adminProcedure
    .input(
      z.object({
        enabledByDefault: z.boolean(),
        defaultTaxRatePercent: z.string().min(1),
        taxRegistrationNumber: z.string().trim().max(50).optional().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const before = await getTaxSettings();
      const settings = await updateTaxSettings(input, { userId: ctx.user.id });
      await logAudit(ctx, {
        action: "system.taxSettings.update",
        entityType: "system",
        entityId: null,
        oldValue: before,
        newValue: settings,
      });
      return { ok: true as const, settings };
    }),
});
