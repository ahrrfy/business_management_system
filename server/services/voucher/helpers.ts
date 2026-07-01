// أدوات داخلية: البصمة التدقيقية، ترقيم السند (Race-safe عبر GET_LOCK)، حلّ الدور،
// فرض ملكية الفرع، والتحقّق من فئة السند — لا تُصدَّر من نقطة الدخول العامة.
import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { desc, eq, like, sql } from "drizzle-orm";
import { receipts, voucherCategories } from "../../../drizzle/schema";
import { toDateStr } from "../money";
import { resolveActorRoleTx } from "../shiftService";
import { type Actor, withTx } from "../tx";
import type { PartyType, PaymentMethod } from "./types";

/** يَحسب SHA-256 لخَتم السند ⇒ سَلامة سجل تَدقيقي ضدّ التَلاعب بـDB. */
function computeSignature(parts: {
  id: number;
  amount: string;
  partyType: PartyType;
  partyId: number | null;
  paymentMethod: PaymentMethod;
  voucherDate: string;
  voucherNumber: string;
  createdBy: number;
  approvedBy: number | null;
  branchId: number;
}): string {
  const canonical = [
    parts.id,
    parts.amount,
    parts.partyType,
    parts.partyId ?? "",
    parts.paymentMethod,
    parts.voucherDate,
    parts.voucherNumber,
    parts.createdBy,
    parts.approvedBy ?? "",
    parts.branchId,
  ].join("|");
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/** يولّد رقم سند تسلسلي يومي للفرع: RV-1-20260609-00001 أو PV-1-20260609-00001
 *
 * Race protection عبر GET_LOCK المربوط بالاتصال: SELECT...FOR UPDATE بنطاق LIKE
 * لا يَقفل صفوفاً غير موجودة في InnoDB ⇒ معاملتان متزامنتان قد تَقرآن نفس MAX
 * وتُولّدان نفس seq. القفل بنطاق (voucher:type:branchId:ymd) يَمنع التضارب على
 * مستوى الفرع/النوع/اليوم. الفهرس الفريد على voucherNumber يبقى الحارس الأخير
 * (راوتر يُعيد المحاولة على ER_DUP_ENTRY).
 */
async function nextVoucherNumber(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  voucherType: "RECEIPT" | "PAYMENT",
  branchId: number,
): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `${voucherType === "RECEIPT" ? "RV" : "PV"}-${branchId}-${ymd}-`;
  const lockName = `voucher:${voucherType}:${branchId}:${ymd}`;
  const lockRes: any = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`);
  const lockedRow = Array.isArray(lockRes) ? lockRes[0]?.[0] : lockRes?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) {
    throw new Error(`voucher numbering lock timeout for ${lockName}`);
  }
  try {
    const rows = await tx
      .select({ n: receipts.voucherNumber })
      .from(receipts)
      .where(like(receipts.voucherNumber, `${prefix}%`))
      .orderBy(desc(receipts.id))
      .for("update")
      .limit(1);
    const last = rows[0]?.n;
    const seq = last ? parseInt(String(last).slice(prefix.length), 10) + 1 : 1;
    return prefix + String(seq).padStart(5, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

/** يحلّ دور الفاعل: من actor.role إن مرّره الموجّه، وإلا يقرأه من قاعدة البيانات (مرّة واحدة).
 *  يَستعمل resolveActorRoleTx المُشترك في shiftService (نُقِل ليُستعمَل أيضاً في expenseService/saleService). */
async function resolveActorRole(tx: Parameters<Parameters<typeof withTx>[0]>[0], actor: Actor): Promise<string> {
  if (actor.role) return actor.role;
  return resolveActorRoleTx(tx, actor.userId);
}

/** يفرض ملكية الفرع للفاعل لعمليات التغيير الحرجة: admin يمرّ، وغيره يجب أن يطابق فرع الكيان.
 *  يسدّ نمطاً جذرياً ٢: managerProcedure معاملة سابقاً كأنها عبر-فرعية، فمدير فرعٍ يعكس سند فرعٍ آخر. */
async function assertBranchOwnership(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  actor: Actor,
  targetBranchId: number | null,
  entityLabel: string,
): Promise<void> {
  const role = await resolveActorRole(tx, actor);
  if (role === "admin") return;
  if (targetBranchId == null) return; // كيان بلا فرع مُسنَد ⇒ لا يُمكن فرض الانتماء
  if (Number(actor.branchId) !== Number(targetBranchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `لا تستطيع تعديل ${entityLabel} لفرع آخر`,
    });
  }
}

/** يَتحقّق من فئة السند: موجودة + نشطة + اتجاهها يَسمح بنوع السند. */
async function validateCategory(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  categoryId: number,
  direction: "IN" | "OUT",
): Promise<void> {
  const c = (await tx.select().from(voucherCategories).where(eq(voucherCategories.id, categoryId)).limit(1))[0];
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "فئة السند غير موجودة" });
  if (!c.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: `فئة «${c.name}» مُعطَّلة` });
  if (c.direction !== "BOTH" && c.direction !== direction) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `فئة «${c.name}» مخصّصة لسندات ${c.direction === "IN" ? "القبض" : "الصرف"} فقط`,
    });
  }
}


export { computeSignature, nextVoucherNumber, resolveActorRole, assertBranchOwnership, validateCategory };
