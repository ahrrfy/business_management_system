/**
 * مسار تصدير صور استوديو المنتجات — GET يبثّ ZIP للمدير المصادَق:
 *   GET /api/studio/export.zip?scope=ALL
 *   GET /api/studio/export.zip?scope=CATEGORY&categoryId=5
 *   GET /api/studio/export.zip?scope=PRODUCTS&productIds=1,2,3
 *
 * GET (لا POST) كي يقبله زرُّ التنزيل في المتصفح مباشرةً بلا JavaScript إضافيّ. الأمان
 * كوكي الجلسة نفسها التي تحمي كل مسارات الاستوديو، مع فحصٍ صريحٍ للدور. لا نستعمل tRPC
 * لأنّه لا يبثّ binary — الأرشيف يُبنى قطعةً قطعةً من R2 ويُدفَع مباشرةً.
 */
import { Router, type Request, type Response } from "express";
import { getUserFromRequest } from "../auth/session";
import { hasModuleAccess, type PermissionMap } from "../../shared/permissions";
import { logger } from "../logger";
import { streamStudioImageExport, type StudioExportScope } from "../services/productStudioImageExport";
import type { ProductStudioActor } from "../services/productStudioService";

function parseProductIds(raw: unknown): number[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const ids: number[] = [];
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (Number.isSafeInteger(n) && n > 0) ids.push(n);
  }
  return ids;
}

function parseScope(query: Request["query"]): { ok: true; scope: StudioExportScope } | { ok: false; message: string } {
  const raw = String(query.scope ?? "");
  if (raw === "ALL") return { ok: true, scope: { kind: "ALL" } };
  if (raw === "CATEGORY") {
    const categoryId = Number(query.categoryId);
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
      return { ok: false, message: "categoryId مطلوب لنطاق CATEGORY" };
    }
    return { ok: true, scope: { kind: "CATEGORY", categoryId } };
  }
  if (raw === "PRODUCTS") {
    const productIds = parseProductIds(query.productIds);
    if (productIds.length === 0) return { ok: false, message: "productIds (CSV) مطلوبة لنطاق PRODUCTS" };
    if (productIds.length > 500) return { ok: false, message: "أقصى ٥٠٠ منتج لكل نداء" };
    return { ok: true, scope: { kind: "PRODUCTS", productIds } };
  }
  return { ok: false, message: "scope غير معروف — استعمل ALL أو CATEGORY أو PRODUCTS" };
}

export function studioExportRouter(): Router {
  const r = Router({ caseSensitive: true, strict: true });

  r.get("/export.zip", async (req: Request, res: Response) => {
    const user = await getUserFromRequest(req).catch(() => null);
    if (!user) return res.status(401).json({ error: "مصادقةٌ مطلوبة" });
    // التصدير مسارٌ إداريّ (يكشف كامل الكتالوج) — مقصورٌ على المدير كما قائمة الحملات.
    const isManager = user.role === "admin" || user.role === "manager" || user.isOwner === true;
    if (!isManager) return res.status(403).json({ error: "التصدير للمدير فقط" });
    if (!hasModuleAccess(user.role, (user.permissionsOverride ?? null) as PermissionMap | null, "productStudio", "READ")) {
      return res.status(403).json({ error: "لا صلاحيةَ للاستوديو" });
    }

    const parsed = parseScope(req.query);
    if (!parsed.ok) return res.status(400).json({ error: parsed.message });

    const actor: ProductStudioActor = {
      userId: Number(user.id),
      branchId: user.branchId == null ? null : Number(user.branchId),
      role: user.role,
      isOwner: user.isOwner === true,
    };
    try {
      await streamStudioImageExport(actor, parsed.scope, res);
    } catch (err) {
      logger.error({ err, userId: actor.userId, scope: parsed.scope }, "studio-image-export: route error");
      if (!res.headersSent) res.status(500).json({ error: "تعذّر تصدير الصور" });
      else res.destroy(err as Error);
    }
  });

  return r;
}
