/**
 * catalogAnomaliesRouter.ts — راوتر لوحة تدقيق شذوذ الكتالوج (L2).
 *
 * ثلاث نقاط:
 *   - `list`         (READ): يُشغّل ست عدسات (L1-L6) على `productVariants`، يُطبِّق استثناءات المستخدم،
 *                    ويعيد الصفوف مصنَّفةً حسب الحدّة.
 *   - `markIntentional` (WRITE, manager): يُعلَّم صفٌّ بأنه «قصديّ» بتبريرٍ إلزاميّ + مدّة اختيارية.
 *   - `markIgnored`     (WRITE, manager): يُعلَّم صفٌّ «تجاهل نهائيّاً» (whitelist دائم بتبرير).
 *   - `clearOverride`   (WRITE, manager): يُلغي استثناءً (يُعيد المتغيّر لمجال الكشف الطبيعيّ).
 *
 * السياسة: كل الكتابات تُسجَّل في `auditLog` (نمط بقيّة المشروع). القراءة مقيّدة بمنح صريح
 * ⇒ الكاشير محجوب حتى لو منح المدير له `products=READ`.
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { catalogAnomaliesReadProcedure, catalogAnomaliesManagerProcedure, router } from "../trpc";
import { detectAll } from "../services/catalogAnomalies/detectors";
import {
  COST_CHANGE_REVERT_WINDOW_DAYS,
  revertCatalogCostChange,
} from "../services/catalogAnomalies/revertCostChange";
import { logAudit } from "../services/auditService";

const codeSchema = z.enum(["L1", "L2", "L3", "L4", "L5", "L6"]);

export const catalogAnomaliesRouter = router({
  /**
   * قائمة الشذوذ الكاملة (L1-L6) — يُطبَّق استثناءات المستخدم لاحقاً (LEFT JOIN مع catalogAnomalyOverrides).
   * `includeOverridden=true` يُعيدها في القائمة (للتاريخ/المراجعة)؛ الافتراضي `false` (الطابور النشط).
   */
  list: catalogAnomaliesReadProcedure
    .input(
      z.object({
        includeOverridden: z.boolean().default(false),
        codes: z.array(codeSchema).optional(),
        severities: z.array(z.enum(["blocker", "warning", "info"])).optional(),
        limitPerLens: z.number().int().positive().max(500).default(200),
        // ترقيم النتيجة النهائية (بعد الفلترة/الاستثناءات) — offset/total تكشف الاقتطاع الصامت
        // بدل جدولٍ يوهم بالاكتمال. limitPerLens يبقى سقف الكشف من DB لكل عدسة (غير هذا).
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().positive().max(500).default(200),
      })
    )
    .query(async ({ input }) => {
      const d = getDb();
      if (!d) return { findings: [], counts: { blocker: 0, warning: 0, info: 0 }, overriddenCount: 0, total: 0, hasMore: false, truncatedLenses: [] as string[] };
      // ١) شغّل الكواشف الست.
      let findings = await detectAll(d, input.limitPerLens);
      // عدسةٌ بلغ عدد نتائجها الخام سقف limitPerLens ⇒ الأرجح أنها اقُتطعت عند مصدر الكشف
      // نفسه (قبل أي فلترة/استثناء) — نُبلغ الواجهة كي تعرض لافتة بدل جدولٍ يوهم بالاكتمال.
      const rawCountByCode = new Map<string, number>();
      for (const f of findings) rawCountByCode.set(f.code, (rawCountByCode.get(f.code) ?? 0) + 1);
      const truncatedLenses = Array.from(rawCountByCode.entries())
        .filter(([, n]) => n >= input.limitPerLens)
        .map(([code]) => code);
      // ٢) فلترة اختيارية بالعدسة/الحدّة.
      if (input.codes && input.codes.length > 0) {
        const codeSet = new Set(input.codes);
        findings = findings.filter((f) => codeSet.has(f.code));
      }
      if (input.severities && input.severities.length > 0) {
        const sevSet = new Set(input.severities);
        findings = findings.filter((f) => sevSet.has(f.severity));
      }
      // ٣) اقرأ استثناءات المستخدم (LEFT JOIN منطقيّ في التطبيق لتفادي N+1).
      const variantIds = findings.map((f) => f.variantId);
      let overrides: Array<{ variantId: number; code: string; kind: string; excludeUntil: Date | string | null }> = [];
      if (variantIds.length > 0) {
        const rows = await d.execute(sql`
          SELECT variantId, code, kind, excludeUntil
          FROM catalogAnomalyOverrides
          WHERE variantId IN (${sql.join(variantIds.map((id) => sql`${id}`), sql`, `)})
            AND (excludeUntil IS NULL OR excludeUntil >= CURDATE())
        `);
        overrides = (rows as unknown as [Array<{ variantId: number; code: string; kind: string; excludeUntil: Date | string | null }>, unknown])[0];
      }
      const overrideMap = new Map<string, { kind: string; excludeUntil: Date | string | null }>();
      for (const o of overrides) {
        overrideMap.set(`${o.variantId}:${o.code}`, { kind: o.kind, excludeUntil: o.excludeUntil });
      }
      // ٤) طبّق الاستثناءات: القصديّ/المتجاهَل يُستبعد من الطابور النشط إن لم يُطلَب.
      let overriddenCount = 0;
      const active = findings.filter((f) => {
        const ov = overrideMap.get(`${f.variantId}:${f.code}`);
        if (!ov) return true;
        overriddenCount++;
        return input.includeOverridden;
      });
      // ٥) الفرز: blocker → warning → info، وضمن كلٍّ بالنسبة تنازلياً.
      const sevOrder: Record<string, number> = { blocker: 0, warning: 1, info: 2 };
      active.sort((a, b) => {
        const so = sevOrder[a.severity] - sevOrder[b.severity];
        if (so !== 0) return so;
        const ar = Number(a.metrics.ratio ?? 0);
        const br = Number(b.metrics.ratio ?? 0);
        return br - ar;
      });
      // ٦) عدّاد الحدّة.
      const counts = { blocker: 0, warning: 0, info: 0 };
      for (const f of active) counts[f.severity]++;
      // ٧) دُلّ على override في كل صف (للعرض في «قصديّ» tab).
      const withOverride = active.map((f) => {
        const ov = overrideMap.get(`${f.variantId}:${f.code}`);
        return { ...f, override: ov ? { kind: ov.kind, excludeUntil: ov.excludeUntil } : null };
      });
      // ٨) ترقيم الصفحة الأخيرة — counts/overriddenCount تبقيان على المجموع الكامل (بطاقات الملخّص).
      const total = withOverride.length;
      const page = withOverride.slice(input.offset, input.offset + input.limit);
      return { findings: page, counts, overriddenCount, total, hasMore: input.offset + page.length < total, truncatedLenses };
    }),

  /** يُعلَّم صفٌّ كـ«قصديّ» (تصفية، عرض ترويجيّ، مذكّرة سنة قديمة، …). */
  markIntentional: catalogAnomaliesManagerProcedure
    .input(
      z.object({
        variantId: z.number().int().positive(),
        code: codeSchema,
        justification: z.string().min(10).max(500),
        excludeUntil: z.string().nullish(), // ISO date "YYYY-MM-DD"
      })
    )
    .mutation(async ({ input, ctx }) => {
      const d = getDb();
      if (!d) return { ok: false };
      const excludeUntil = input.excludeUntil ? new Date(input.excludeUntil) : null;
      // upsert: ON DUPLICATE KEY (variantId, code).
      await d.execute(sql`
        INSERT INTO catalogAnomalyOverrides (variantId, code, kind, justification, excludeUntil, createdBy)
        VALUES (${input.variantId}, ${input.code}, 'INTENTIONAL', ${input.justification}, ${excludeUntil}, ${ctx.user.id})
        ON DUPLICATE KEY UPDATE
          kind = 'INTENTIONAL',
          justification = VALUES(justification),
          excludeUntil = VALUES(excludeUntil),
          createdBy = VALUES(createdBy)
      `);
      await logAudit(ctx, {
        action: "catalogAnomaly.markIntentional",
        entityType: "productVariant",
        entityId: input.variantId,
        newValue: { code: input.code, justification: input.justification, excludeUntil: input.excludeUntil ?? null },
      });
      return { ok: true };
    }),

  /** يُعلَّم صفٌّ «تجاهل نهائيّاً» (whitelist دائم). */
  markIgnored: catalogAnomaliesManagerProcedure
    .input(
      z.object({
        variantId: z.number().int().positive(),
        code: codeSchema,
        justification: z.string().min(10).max(500),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const d = getDb();
      if (!d) return { ok: false };
      await d.execute(sql`
        INSERT INTO catalogAnomalyOverrides (variantId, code, kind, justification, excludeUntil, createdBy)
        VALUES (${input.variantId}, ${input.code}, 'IGNORED', ${input.justification}, NULL, ${ctx.user.id})
        ON DUPLICATE KEY UPDATE
          kind = 'IGNORED',
          justification = VALUES(justification),
          excludeUntil = NULL,
          createdBy = VALUES(createdBy)
      `);
      await logAudit(ctx, {
        action: "catalogAnomaly.markIgnored",
        entityType: "productVariant",
        entityId: input.variantId,
        newValue: { code: input.code, justification: input.justification },
      });
      return { ok: true };
    }),

  /** إلغاء استثناء (يعيد الصفّ للمجال النشط). */
  clearOverride: catalogAnomaliesManagerProcedure
    .input(z.object({ variantId: z.number().int().positive(), code: codeSchema }))
    .mutation(async ({ input, ctx }) => {
      const d = getDb();
      if (!d) return { ok: false };
      await d.execute(sql`
        DELETE FROM catalogAnomalyOverrides WHERE variantId = ${input.variantId} AND code = ${input.code}
      `);
      await logAudit(ctx, {
        action: "catalogAnomaly.clearOverride",
        entityType: "productVariant",
        entityId: input.variantId,
        oldValue: { code: input.code },
      });
      return { ok: true };
    }),

  /**
   * **L3.4:** سجلّ تغيّرات التكلفة/السعر — يقرأ من `priceAnomalyLog` الذي يمتلئ آلياً بـTrigger.
   * فلترة اختيارية: severity ≥ threshold، أيام أخيرة، متغيّر معيّن.
   */
  changeLog: catalogAnomaliesReadProcedure
    .input(
      z.object({
        minSeverity: z.enum(["info", "warning", "blocker", "catastrophic"]).default("warning"),
        days: z.number().int().positive().max(365).default(30),
        variantId: z.number().int().positive().nullish(),
        limit: z.number().int().positive().max(500).default(100),
      })
    )
    .query(async ({ input }) => {
      const d = getDb();
      if (!d) return [];
      // ترتيب الحدّة: catastrophic > blocker > warning > info
      const sevRank: Record<string, number> = { info: 0, warning: 1, blocker: 2, catastrophic: 3 };
      const minRank = sevRank[input.minSeverity];
      const includedSevs: string[] = Object.entries(sevRank).filter(([, r]) => r >= minRank).map(([s]) => s);
      const rows = await d.execute(sql`
        SELECT pal.id, pal.variantId, pal.changeKind, pal.oldValue, pal.newValue, pal.severity,
               pal.reason, pal.actorUserId, u.name AS actorName, pal.reverted, pal.revertedAt, pal.createdAt,
               v.sku, p.name AS productName,
               CASE
                 WHEN pal.changeKind <> 'cost' THEN 0
                 WHEN pal.createdAt < DATE_SUB(NOW(), INTERVAL ${COST_CHANGE_REVERT_WINDOW_DAYS} DAY) THEN 0
                 ELSE 1
               END AS directRevertAllowed,
               CASE
                 WHEN pal.changeKind <> 'cost' THEN 'NON_COST'
                 WHEN pal.createdAt < DATE_SUB(NOW(), INTERVAL ${COST_CHANGE_REVERT_WINDOW_DAYS} DAY) THEN 'EXPIRED'
                 ELSE NULL
               END AS revertBlockReason
        FROM priceAnomalyLog pal
        LEFT JOIN productVariants v ON v.id = pal.variantId
        LEFT JOIN products p ON p.id = v.productId
        LEFT JOIN users u ON u.id = pal.actorUserId
        WHERE pal.severity IN (${sql.join(includedSevs.map((s) => sql`${s}`), sql`, `)})
          AND pal.createdAt >= DATE_SUB(CURDATE(), INTERVAL ${input.days} DAY)
          ${input.variantId ? sql`AND pal.variantId = ${input.variantId}` : sql``}
        ORDER BY pal.createdAt DESC
        LIMIT ${input.limit}
      `);
      return (rows as unknown as [Array<{
        id: number;
        variantId: number;
        changeKind: string;
        oldValue: string;
        newValue: string;
        severity: string;
        reason: string | null;
        actorUserId: number | null;
        actorName: string | null;
        reverted: number;
        revertedAt: Date | string | null;
        createdAt: Date;
        sku: string | null;
        productName: string | null;
        directRevertAllowed: number;
        revertBlockReason: "NON_COST" | "EXPIRED" | "STOCK_ON_HAND" | null;
      }>, unknown])[0];
    }),

  /**
   * **L3.5:** استعادة قيمة سابقة من `priceAnomalyLog` عبر خدمةٍ ذرية تمرّ بحارس حوكمة
   * `costPrice`. صفريّ الرصيد يُستعاد مع تدقيق قبل/بعد؛ وذو المخزون يولّد قيد إعادة تقييم
   * لكل فرع عبر محرك القيود وحارس الفترة، في المعاملة نفسها. الحدود:
   *  - يعمل خلال ٣٠ يوماً من التغيير فقط.
   *  - لا يعمل إن كان الصفّ مُعاداً مسبقاً.
   */
  revertChange: catalogAnomaliesManagerProcedure
    .input(z.object({ logId: z.number().int().positive() }))
    .mutation(({ input, ctx }) =>
      revertCatalogCostChange(input.logId, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId,
        role: ctx.user.role,
        isOwner: ctx.user.isOwner,
        ipAddress:
          (ctx.req?.headers?.["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
          ctx.req?.ip ??
          null,
      }),
    ),
});
