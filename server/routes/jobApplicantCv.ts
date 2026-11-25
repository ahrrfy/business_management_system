import { Router, type Request, type Response } from "express";
import { TRPCError } from "@trpc/server";
import { resolvePermissions, type PermissionMap, type RoleKey } from "@shared/permissions";
import { authenticateExpressRequest } from "../auth/expressAuth";
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
      const auth = await authenticateExpressRequest(req);
      if (!auth.ok) {
        return res.status(auth.status).json({ error: auth.error });
      }
      const user = auth.user;

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
