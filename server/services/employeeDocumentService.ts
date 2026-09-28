import { and, desc, eq, lte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { employeeDocuments, employees } from "../../drizzle/schema";
import { getDb } from "../db";
import { withTx, type Actor, type MaybeScopedActor } from "./tx";
import { baghdadToday } from "./businessDay";

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not set");
  return db;
}

export type DocumentType =
  | "PASSPORT"
  | "RESIDENCY_VISA"
  | "WORK_PERMIT"
  | "NATIONAL_ID"
  | "HEALTH_CERTIFICATE"
  | "EDUCATION_CERTIFICATE"
  | "CONTRACT_SCAN"
  | "OTHER";

export type DocumentStatus = "ACTIVE" | "EXPIRED" | "EXPIRING_SOON";

export interface AddDocumentInput {
  employeeId: number;
  documentType: DocumentType;
  title: string;
  documentNumber?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  fileUrl?: string | null;
  fileSize?: number | null;
  mimeType?: string | null;
  notes?: string | null;
  alertDaysBefore?: number;
}

export interface UpdateDocumentInput {
  id: number;
  documentType?: DocumentType;
  title?: string;
  documentNumber?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  fileUrl?: string | null;
  fileSize?: number | null;
  mimeType?: string | null;
  notes?: string | null;
  alertDaysBefore?: number;
}

/** احتساب حالة المستند تلقائياً من تاريخ انتهائه وتاريخ اليوم في بغداد. */
export function computeDocumentStatus(
  expiryDate: string | null | undefined,
  alertDaysBefore: number = 30,
  todayStr: string = baghdadToday(),
): DocumentStatus {
  if (!expiryDate) return "ACTIVE";
  if (expiryDate < todayStr) return "EXPIRED";

  const today = new Date(todayStr);
  const exp = new Date(expiryDate);
  const diffDays = Math.ceil((exp.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays <= alertDaysBefore) return "EXPIRING_SOON";
  return "ACTIVE";
}

/** استعلام مستندات موظف محدد. */
export async function listEmployeeDocuments(employeeId: number) {
  const db = requireDb();
  const rows = await db
    .select()
    .from(employeeDocuments)
    .where(eq(employeeDocuments.employeeId, employeeId))
    .orderBy(desc(employeeDocuments.createdAt));

  const today = baghdadToday();
  return rows.map((r) => ({
    ...r,
    calculatedStatus: computeDocumentStatus(r.expiryDate, r.alertDaysBefore, today),
  }));
}

/** استعلام مستند بالمعرّف. */
export async function getDocumentById(id: number) {
  const db = requireDb();
  const [row] = await db
    .select()
    .from(employeeDocuments)
    .where(eq(employeeDocuments.id, id))
    .limit(1);

  if (!row) return null;
  const today = baghdadToday();
  return {
    ...row,
    calculatedStatus: computeDocumentStatus(row.expiryDate, row.alertDaysBefore, today),
  };
}

/** إضافة مستند جديد لموظف. */
export async function addEmployeeDocument(actor: MaybeScopedActor, input: AddDocumentInput) {
  return withTx(async (tx) => {
    const [emp] = await tx
      .select({ id: employees.id, branchId: employees.branchId })
      .from(employees)
      .where(eq(employees.id, input.employeeId))
      .limit(1);

    if (!emp) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر إضافة المستند",
          why: "الموظف المطلوب غير مسجّل في قاعدة البيانات",
          doThis: "تحقّق من معرّف الموظف وأعد المحاولة",
        }),
      });
    }

    const today = baghdadToday();
    const alertDays = input.alertDaysBefore ?? 30;
    const status = computeDocumentStatus(input.expiryDate, alertDays, today);

    const [res] = await tx.insert(employeeDocuments).values({
      employeeId: input.employeeId,
      documentType: input.documentType,
      title: input.title.trim(),
      documentNumber: input.documentNumber?.trim() || null,
      issueDate: input.issueDate || null,
      expiryDate: input.expiryDate || null,
      fileUrl: input.fileUrl || null,
      fileSize: input.fileSize || null,
      mimeType: input.mimeType || null,
      notes: input.notes?.trim() || null,
      status,
      alertDaysBefore: alertDays,
      createdById: actor.userId,
    });

    return { id: res.insertId, status };
  });
}

/** تعديل مستند موظف. */
export async function updateEmployeeDocument(actor: MaybeScopedActor, input: UpdateDocumentInput) {
  return withTx(async (tx) => {
    const [doc] = await tx
      .select()
      .from(employeeDocuments)
      .where(eq(employeeDocuments.id, input.id))
      .limit(1);

    if (!doc) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تعديل المستند",
          why: "المستند المطلوب غير موجود في سجلات الموظف",
          doThis: "تحقّق من رقم المستند وأعد المحاولة من القائمة",
        }),
      });
    }

    const today = baghdadToday();
    const expiry = input.expiryDate !== undefined ? input.expiryDate : doc.expiryDate;
    const alertDays = input.alertDaysBefore !== undefined ? input.alertDaysBefore : doc.alertDaysBefore;
    const status = computeDocumentStatus(expiry, alertDays, today);

    await tx
      .update(employeeDocuments)
      .set({
        ...(input.documentType ? { documentType: input.documentType } : {}),
        ...(input.title ? { title: input.title.trim() } : {}),
        ...(input.documentNumber !== undefined ? { documentNumber: input.documentNumber?.trim() || null } : {}),
        ...(input.issueDate !== undefined ? { issueDate: input.issueDate || null } : {}),
        ...(input.expiryDate !== undefined ? { expiryDate: input.expiryDate || null } : {}),
        ...(input.fileUrl !== undefined ? { fileUrl: input.fileUrl } : {}),
        ...(input.fileSize !== undefined ? { fileSize: input.fileSize } : {}),
        ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
        ...(input.alertDaysBefore !== undefined ? { alertDaysBefore: input.alertDaysBefore } : {}),
        status,
      })
      .where(eq(employeeDocuments.id, input.id));

    return { id: input.id, status };
  });
}

/** حذف مستند. */
export async function deleteEmployeeDocument(actor: MaybeScopedActor, id: number) {
  return withTx(async (tx) => {
    const [doc] = await tx
      .select({ id: employeeDocuments.id })
      .from(employeeDocuments)
      .where(eq(employeeDocuments.id, id))
      .limit(1);

    if (!doc) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر حذف المستند",
          why: "المستند المطلوب غير موجود أو حُذف مسبقاً",
          doThis: "حدّث قائمة المستندات للتحقق من الحالة الحالية",
        }),
      });
    }

    await tx.delete(employeeDocuments).where(eq(employeeDocuments.id, id));
    return { success: true };
  });
}

/** تنبيهات انتهاء المستندات والإقامات خلال فترة محددة (للوحة تحكم HR). */
export async function getExpiringDocumentsAlerts(withinDays: number = 30) {
  const db = requireDb();
  const todayStr = baghdadToday();
  const targetDate = new Date(`${todayStr}T00:00:00Z`);
  targetDate.setUTCDate(targetDate.getUTCDate() + withinDays);
  const targetDateStr = targetDate.toISOString().slice(0, 10);

  const docs = await db
    .select({
      id: employeeDocuments.id,
      employeeId: employeeDocuments.employeeId,
      employeeName: sql<string>`CONCAT(${employees.firstName}, ' ', ${employees.lastName})`,
      documentType: employeeDocuments.documentType,
      title: employeeDocuments.title,
      documentNumber: employeeDocuments.documentNumber,
      expiryDate: employeeDocuments.expiryDate,
      alertDaysBefore: employeeDocuments.alertDaysBefore,
      status: employeeDocuments.status,
    })
    .from(employeeDocuments)
    .innerJoin(employees, eq(employeeDocuments.employeeId, employees.id))
    .where(
      and(
        eq(employees.isActive, true),
        sql`${employeeDocuments.expiryDate} IS NOT NULL`,
        lte(employeeDocuments.expiryDate, targetDateStr),
      ),
    )
    .orderBy(employeeDocuments.expiryDate);

  return docs.map((d) => {
    const isExpired = d.expiryDate! < todayStr;
    const diffDays = Math.ceil(
      (new Date(d.expiryDate!).getTime() - new Date(todayStr).getTime()) / (1000 * 60 * 60 * 24),
    );
    return {
      ...d,
      isExpired,
      daysRemaining: diffDays,
      urgency: isExpired ? "CRITICAL" : diffDays <= 7 ? "HIGH" : diffDays <= 15 ? "MEDIUM" : "LOW",
    };
  });
}
