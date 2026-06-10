// مسار تنزيل النسخ الاحتياطية إلى جهاز المدير (GET stream). محمي: مدير فقط + مسار آمن داخل backups.
//   GET /api/backups/download?name=<file.sql>
import { Router, type Request, type Response } from "express";
import { createReadStream } from "node:fs";
import path from "node:path";
import { getUserFromRequest } from "./auth/session";
import { resolveBackupFile } from "./services/maintenanceService";
import { logger } from "./logger";

export function backupRouter(): Router {
  const r = Router();

  r.get("/download", async (req: Request, res: Response) => {
    const user = await getUserFromRequest(req).catch(() => null);
    if (!user || user.role !== "admin") {
      return res.status(403).json({ error: "تنزيل النسخ متاح للمدير فقط." });
    }
    const name = String(req.query.name ?? "");
    const abs = await resolveBackupFile(name);
    if (!abs) {
      return res.status(400).json({ error: "اسم نسخة غير صالح أو غير موجود." });
    }
    res.setHeader("Content-Type", "application/sql");
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(name)}"`);
    res.setHeader("Cache-Control", "no-store");
    const stream = createReadStream(abs);
    stream.on("error", (e) => {
      logger.error({ err: e }, "backup download stream failed");
      if (!res.headersSent) res.status(500).json({ error: "تعذّر قراءة النسخة." });
      else res.destroy();
    });
    stream.pipe(res);
  });

  return r;
}
