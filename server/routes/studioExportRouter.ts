/**
 * مسار تصدير صور استوديو المنتجات — GET يبثّ ZIP للمدير المصادَق:
 *   GET /api/studio/export.zip?scope=ALL
 *   GET /api/studio/export.zip?scope=CATEGORY&categoryId=5
 *   GET /api/studio/export.zip?scope=PRODUCTS&productIds=1,2,3
 *
 * GET (لا POST) كي يقبله زرُّ التنزيل في المتصفح مباشرةً بلا JavaScript إضافيّ. الأمان
 * كوكي الجلسة نفسها التي تحمي كل مسارات الاستوديو، مع فحصٍ صريحٍ للدور. لا نستعمل tRPC
 * لأنّه لا يبثّ binary — الأرشيف يُبنى قطعةً قطعةً من R2 ويُدفَع مباشرةً.
 *
 * سلسلةُ الحرّاس تُطابق ما تفعله procedures في tRPC:
 *   1. مصادقةُ الجلسة (`getUserFromRequest`).
 *   2. **حلّ الدور الفعّال** (`normalizeOwnerAuthority`/`resolveCustomRole`) —
 *      قبل هذا كان `role` الخام يتجاوز أدواراً مخصّصةً تُلغي الوصول.
 *   3. **إلزامُ 2FA** (`twoFactorEnrollmentRequired`) — مسارُ REST خارج tRPC كان يفلت
 *      من سياسة الإلزام السارية بلا هذا الفحص.
 *   4. دور من مجموعة المدراء + `productStudio: READ` على الأقلّ.
 */
import { Router, type Request, type Response } from "express";
import { TRPCError } from "@trpc/server";
import { createContext } from "../context";
import { hasOperationPolicy, operationDecision, operationRecordScope } from "@shared/operationPermissions";
import { routeOperationAuthority } from "../services/authorization/operationAuthority";
import { canCrossBranches } from "../lib/branchAuthority";
import { hasModuleAccess, type PermissionMap, type RoleKey } from "../../shared/permissions";
import { twoFactorEnrollmentRequired } from "../trpc";
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
    const ctx = await createContext({ req, res }).catch(() => null);
    const user = ctx?.user;
    if (!user) return res.status(401).json({ error: "مصادقةٌ مطلوبة" });

    // إلزامُ 2FA حين تكون السياسة سارية — مسارُ REST كان يفلت منها لأنّه خارج tRPC
    // (الجذر: مراجعة Codex P1 على PR #811). tRPC procedures تفحصه في كل نداء.
    if (twoFactorEnrollmentRequired(user)) {
      return res.status(403).json({ error: "يلزم تفعيل المصادقة الثنائية (2FA) للمتابعة — سياسة إلزامية للمدير/المشرف." });
    }

    // التصدير مسارٌ إداريّ (يكشف كامل الكتالوج) — مقصورٌ على المدير كما قائمة الحملات.
    const isManagerRole = user.role === "admin" || user.role === "manager" || user.isOwner === true;
    const canonical = hasOperationPolicy(user);
    if (canonical ? !operationDecision(user, "productStudio.authorizeExport").allowed : !isManagerRole) {
      return res.status(403).json({ error: "التصدير للمدير فقط" });
    }
    if (!canCrossBranches(user) && user.branchId == null) {
      return res.status(403).json({ error: "يلزم إسناد فرع للحساب قبل تصدير الصور" });
    }
    if (!canonical && !hasModuleAccess(user.role as RoleKey, (user.permissionsOverride ?? null) as PermissionMap | null, "productStudio", "READ")) {
      return res.status(403).json({ error: "لا صلاحيةَ للاستوديو" });
    }

    const parsed = parseScope(req.query);
    if (!parsed.ok) return res.status(400).json({ error: parsed.message });

    // وضعُ الاستعلام المسبق (preflight): يعيد ٢٠٠ فوراً بلا بثِّ أرشيفٍ أو استعلامِ صور
    // — كي يتحقّق الواجهةُ عبر `fetch` من صلاحية الجلسة وسلامة النطاق قبل أن يُطلق تنزيلَ
    // المتصفّح **الأصيل** (`<a href download>` أو `location.assign`) الذي يبثّ الأرشيفَ
    // إلى القرص دون تحميله في ذاكرة JS. بلا هذا كنّا نلفّ الأرشيف كلَّه في Blob (يصل ١٫٨
    // ج.ب لصادرات ٢٠٠٠ صورة) فيتفجّر Safari على iPhone (مراجعة Codex P1). القراءةُ فقط
    // من حرّاس المسار أعلاه — لا تكلفةَ فعليّة (لا استعلامَ صورة، لا نداءَ R2).
    if (req.query.preflight === "1") {
      return res.status(200).json({ ok: true });
    }

    const actor: ProductStudioActor = {
      userId: Number(user.id),
      branchId: user.branchId == null ? null : Number(user.branchId),
      role: user.role,
      isOwner: user.isOwner === true,
      operationAuthority: routeOperationAuthority(user, "productStudio.authorizeExport"),
      scopedOwnerId: canonical && operationRecordScope(user, "productStudio.authorizeExport") === "OWN" ? user.id : null,
    };
    try {
      await streamStudioImageExport(actor, parsed.scope, res);
    } catch (err) {
      logger.error({ err, userId: actor.userId, scope: parsed.scope }, "studio-image-export: route error");
      if (!res.headersSent) res.status(err instanceof TRPCError && err.code === "FORBIDDEN" ? 403 : 500).json({ error: "تعذّر تصدير الصور" });
      else res.destroy(err as Error);
    }
  });

  return r;
}
