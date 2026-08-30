// مسار تنزيل النسخ الاحتياطية إلى جهاز المدير (GET stream). محمي: مدير فقط + مسار آمن داخل backups.
//   GET /api/backups/download?name=<file.sql>
import { Router, type Request, type Response } from "express";
import { createReadStream } from "node:fs";
import path from "node:path";
import { getSessionContext, getUserFromRequest } from "./auth/session";
import {
  acquireRestoreLock,
  cleanupTmp,
  consumeRestoreUploadTicket,
  currentDbName,
  quarantineUploadStream,
  resolveBackupFile,
  RestoreUploadValidationError,
  runRestore,
  verifyRestoreUploadTicket,
} from "./services/maintenanceService";
import { logAudit } from "./services/auditService";
import { logger } from "./logger";

export function backupRouter(): Router {
  // يجب أن يطابق canonical Nginx location حرفياً؛ Router الافتراضي غير حساس للحالة
  // فيجعل RESTORE-UPLOAD يتجاوز حد restore ثم يصل هنا.
  const r = Router({ caseSensitive: true, strict: true });

  r.get("/download", async (req: Request, res: Response) => {
    const user = await getUserFromRequest(req).catch(() => null);
    if (!user || (user.role !== "admin" && !user.isOwner)) {
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

  r.post("/restore-upload", async (req: Request, res: Response) => {
    // التحقّق يحدث قبل تركيب أي body parser/مستهلك للدفق. الطلب المجهول يُرفض فوراً
    // ولا يستطيع إجبار Node على تجميع ملف الاستعادة في الذاكرة أو على القرص.
    const session = await getSessionContext(req).catch(() => ({ user: null, sessionId: null }));
    if (!session.user || (session.user.role !== "admin" && !session.user.isOwner)) {
      return res.status(403).json({ error: "استعادة النسخ متاحة للمدير فقط." });
    }

    const rawAuthorization = req.get("authorization") ?? "";
    const token = rawAuthorization.startsWith("Bearer ") ? rawAuthorization.slice(7).trim() : "";
    const ticket = token ? await verifyRestoreUploadTicket(token) : null;
    const currentName = ticket ? await currentDbName() : "";
    if (
      !ticket ||
      session.sessionId == null ||
      ticket.userId !== session.user.id ||
      ticket.sessionId !== session.sessionId ||
      ticket.dbName !== currentName
    ) {
      return res.status(401).json({ error: "تصريح رفع الاستعادة غير صالح أو منتهي." });
    }
    if (req.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/sql") {
      return res.status(415).json({ error: "نوع الملف غير صالح؛ المطلوب application/sql." });
    }
    const contentLength = Number(req.get("content-length"));
    if (!Number.isSafeInteger(contentLength) || contentLength !== ticket.fileSize) {
      return res.status(400).json({ error: "حجم الملف لا يطابق تصريح الرفع." });
    }
    if (!ticket.ticketId || !(await consumeRestoreUploadTicket(ticket.ticketId))) {
      return res.status(409).json({ error: "استُخدم تصريح الرفع مسبقاً؛ أعد التأكيد للمحاولة من جديد." });
    }

    let releaseLock: (() => Promise<void>) | null = null;
    let tmp: string | null = null;
    try {
      releaseLock = await acquireRestoreLock();
      tmp = await quarantineUploadStream(req, ticket.fileSize);
      await logAudit(
        { user: session.user, req },
        { action: "system.restore.upload.begin", entityType: "system", entityId: ticket.fileName },
      );
      await runRestore(tmp);
      await logAudit(
        { user: session.user, req },
        { action: "system.restore.upload", entityType: "system", entityId: ticket.fileName },
      );
      res.setHeader("Cache-Control", "no-store");
      return res.json({ ok: true, source: ticket.fileName });
    } catch (error) {
      await logAudit(
        { user: session.user, req },
        {
          action: "system.restore.upload",
          entityType: "system",
          entityId: ticket.fileName,
          outcome: "FAILURE",
        },
      );
      if (error instanceof RestoreUploadValidationError) {
        return res.status(error.status).json({ error: error.message });
      }
      logger.error({ err: error, userId: session.user.id }, "restore upload failed");
      return res.status(500).json({ error: "فشلت الاستعادة من الملف." });
    } finally {
      if (tmp) await cleanupTmp(tmp);
      if (releaseLock) await releaseLock();
    }
  });

  return r;
}
