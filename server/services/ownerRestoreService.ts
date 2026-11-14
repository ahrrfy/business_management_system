import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { request } from "node:http";
import type { RequestHandler } from "express";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "../../shared/errors";
import { isMultiTenantModeActive } from "../db";
import { resolveRecordedArchive } from "../lib/backupEvidence";
import { hasOwnerRestoreFence, ownerRestorePaths, ownerRestoreTarget } from "../lib/ownerRestoreFiles";
import { ownerRestoreStart, ownerRestoreStatus, ownerRestoreTicket } from "../../shared/ownerRestore";
import { backupsDir } from "./maintenanceService";

const maintenanceMessage = "النظام في وضع الصيانة أثناء الاستعادة.";

function productionConfiguration() {
  if (process.env.NODE_ENV !== "production" || isMultiTenantModeActive()) return null;
  const paths = ownerRestorePaths();
  const target = ownerRestoreTarget(process.env.DATABASE_URL);
  return paths && target && target.user !== "root" ? { paths, target } : null;
}

function controller(socketPath: string, endpoint: string, payload?: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = payload && JSON.stringify(payload);
    const req = request({
      socketPath, path: endpoint, method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
    }, response => {
      response.setEncoding("utf8");
      let text = "";
      response.on("data", chunk => {
        text += chunk;
        if (text.length > 8192) req.destroy(new Error("RESTORE_RESPONSE_TOO_LARGE"));
      });
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error("RESTORE_CONTROLLER_REFUSED"));
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.setTimeout(body ? 5000 : 1000, () => req.destroy(new Error("RESTORE_CONTROLLER_TIMEOUT")));
    req.end(body);
  });
}

export async function ownerProductionRestoreAvailable() {
  const config = productionConfiguration();
  if (!config || hasOwnerRestoreFence(config.paths.fence)) return false;
  const ready = await controller(config.paths.socket, "/ready").catch(() => null);
  return !!ready && typeof ready === "object" && "ready" in ready && ready.ready === true;
}

export async function startOwnerProductionRestore(name: string, actorId: number) {
  const config = productionConfiguration();
  if (!config) throw new TRPCError({
    code: "FORBIDDEN",
    message: appErrorMessage({
      what: "تعذّر بدء الاستعادة المشفّرة",
      why: "هذه البيئة لا توفر متحكّم استعادة مهيّأ لهذه القاعدة.",
      doThis: "اطلب من مسؤول النظام مراجعة إعدادات خدمة الاستعادة.",
    }),
  });
  const archive = await resolveRecordedArchive(backupsDir(), process.env.BACKUP_OFFSITE_DIR?.trim(), `${name}.gpg`);
  if (!archive) throw new TRPCError({
    code: "NOT_FOUND",
    message: appErrorMessage({
      what: "النسخة المشفّرة المحددة غير متاحة",
      why: "تعذّر العثور على الأرشيف أو بيان التحقق الخاص به.",
      doThis: "حدّث سجلّ النسخ واختر نسخة تحمل حالة التشفير الموثّق.",
    }),
  });
  try {
    return ownerRestoreStart.parse(await controller(config.paths.socket, "/start", {
      name, actorId, target: config.target, source: { size: archive.manifest.size, sha256: archive.manifest.sha256 },
    }));
  } catch {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر تأكيد بدء الاستعادة",
        why: "متحكّم الاستعادة غير متاح أو مشغول بعملية أخرى.",
        doThis: "راجع حالة الصيانة في شاشة النسخ قبل إرسال طلب جديد.",
      }),
    });
  }
}

export function ownerRestoreMaintenanceBoundary(): RequestHandler {
  const paths = ownerRestorePaths();
  return (req, res, next) => {
    if (!paths || !hasOwnerRestoreFence(paths.fence)) return next();
    if (!req.path.startsWith("/api/") && req.path !== "/api" && req.path !== "/healthz" &&
        ["GET", "HEAD"].includes(req.method)) return next();
    res.setHeader("Retry-After", "3");
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ message: maintenanceMessage });
  };
}

export const readOwnerRestoreStatus: RequestHandler = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const paths = ownerRestorePaths();
  const ticket = ownerRestoreTicket.safeParse(req.get("Authorization")?.match(/^Bearer (.+)$/)?.[1]);
  if (paths && ticket.success) {
    try {
      const stat = await lstat(paths.state);
      if (stat.isFile() && stat.size <= 8192) {
        const state = JSON.parse(await readFile(paths.state, "utf8"));
        const digest = ownerRestoreTicket.safeParse(state.ticketDigest);
        const status = ownerRestoreStatus.safeParse(state.status);
        if (digest.success && status.success && timingSafeEqual(Buffer.from(digest.data, "hex"),
          createHash("sha256").update(ticket.data).digest())) {
          res.json(status.data);
          return;
        }
      }
    } catch { /* A missing or unreadable receipt grants no access. */ }
  }
  res.status(404).end();
};
