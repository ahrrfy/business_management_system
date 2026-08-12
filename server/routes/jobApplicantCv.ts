import { Router, type Request, type Response } from "express";
import { TRPCError } from "@trpc/server";
import { resolvePermissions, type PermissionMap, type RoleKey } from "@shared/permissions";
import { getUserFromRequest } from "../auth/session";
import {
  normalizeOwnerAuthority,
  resolveCustomRole,
  type AuthUser,
} from "../context";
import { logger } from "../logger";
import { companyBranchScope } from "../services/companyBranchScope";
import {
  buildCvDownloadHeaders,
  getJobApplicantCvByKey,
} from "../services/jobApplicantCvService";

/**
 * Binary CV download endpoint. Files are never exposed as static assets or
 * rendered inline: every request revalidates session, HR permission and branch.
 */
export function jobApplicantCvRouter(): Router {
  const router = Router();

  router.get("/:publicKey", async (req: Request, res: Response) => {
    try {
      const rawUser = await getUserFromRequest(req);
      if (!rawUser) return res.status(401).json({ error: "يلزم تسجيل الدخول" });

      const user = rawUser as AuthUser;
      if (user.isOwner) normalizeOwnerAuthority(user);
      else await resolveCustomRole(user);

      const permissions = resolvePermissions(
        user.role as RoleKey,
        (user.permissionsOverride as PermissionMap | null) ?? null,
      );
      if ((permissions.hr ?? "NONE") === "NONE") {
        return res.status(403).json({ error: "لا توجد صلاحية لقراءة ملفات التوظيف" });
      }

      const publicKey = typeof req.params.publicKey === "string" ? req.params.publicKey : "";
      const file = await getJobApplicantCvByKey(publicKey, companyBranchScope(user));
      // Cross-branch and nonexistent keys intentionally share the same response.
      if (!file) return res.status(404).end();

      res.set(buildCvDownloadHeaders(file));
      return res.end(file.bytes);
    } catch (error) {
      if (error instanceof TRPCError && error.code === "FORBIDDEN") {
        return res.status(403).json({ error: "لا توجد صلاحية لقراءة ملفات التوظيف" });
      }
      logger.error({ err: error }, "job-applicant-cv: download failed");
      return res.status(500).end();
    }
  });

  return router;
}
