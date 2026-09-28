// بنك جهات الاتصال (S3، T3.2) — بطاقة ٣٦٠° لطرف واحد: تجميع قراءة فقط (لا كتابة، لا نسخ بيانات
// مالية) عبر joins/استعلامات محدودة. الحجب حسب الدور (currentBalance/creditLimit) يُطبَّق في
// الراوتر (maskCustomerSensitive/maskSupplierSensitive) — نفس نمط customerRouter.get القائم.
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { contactPersons, conversations, customers, invoices, suppliers } from "../../../drizzle/schema";
import { requireDb } from "../tx";

export interface Contact360Input {
  kind: "customer" | "supplier";
  id: number;
}

/** عزل الفرع لبطاقة ٣٦٠° — نفس شكل ctx المحقون عبر branchScopedProcedure (search.ts/tasks/list.ts
 *  النمط المرجعي). null = عابر للفروع (مدير/أدمن)؛ رقم = يقصر conversations/tasks على ذلك الفرع
 *  (الجدولان الوحيدان اللذان يحملان branchId هنا — العميل/المورّد/الفواتير/أشخاص الاتصال بلا
 *  branchId منطقياً فتبقى عابرة للفروع كما كانت). */
export interface Contact360Ctx {
  scopedBranchId: number | null;
}

async function customer360(id: number, scopedBranchId: number | null) {
  const db = requireDb();
  const customer = (await db.select().from(customers).where(eq(customers.id, id)).limit(1))[0];
  if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });

  const recentInvoices = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      total: invoices.total,
      status: invoices.status,
    })
    .from(invoices)
    .where(eq(invoices.customerId, id))
    .orderBy(desc(invoices.id))
    .limit(5);

  const openTasks: Array<{
    id: number;
    taskNumber: string;
    title: string;
    taskStatus: string;
    priority: string;
    dueAt: Date | null;
  }> = [];

  const convConds = [eq(conversations.customerId, id)];
  if (scopedBranchId != null) convConds.push(eq(conversations.branchId, scopedBranchId));
  const convs = await db
    .select({
      id: conversations.id,
      channel: conversations.channel,
      status: conversations.status,
      lastMessageAt: conversations.lastMessageAt,
      lastMessagePreview: conversations.lastMessagePreview,
      unreadCount: conversations.unreadCount,
    })
    .from(conversations)
    .where(and(...convConds))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(10);

  const persons = await db
    .select()
    .from(contactPersons)
    .where(and(eq(contactPersons.customerId, id), eq(contactPersons.isActive, true)))
    .orderBy(desc(contactPersons.isPrimary), contactPersons.name);

  return {
    kind: "customer" as const,
    customer,
    invoices: recentInvoices,
    openTasks,
    conversations: convs,
    contactPersons: persons,
  };
}

async function supplier360(id: number, scopedBranchId: number | null) {
  const db = requireDb();
  const supplier = (await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1))[0];
  if (!supplier) throw new TRPCError({ code: "NOT_FOUND", message: "المورّد غير موجود" });

  const persons = await db
    .select()
    .from(contactPersons)
    .where(and(eq(contactPersons.supplierId, id), eq(contactPersons.isActive, true)))
    .orderBy(desc(contactPersons.isPrimary), contactPersons.name);

  // ربط اختياري بمحادثات B2B (conversations.supplierId — مركز واتساب الأعمال، 0106).
  const convConds = [eq(conversations.supplierId, id)];
  if (scopedBranchId != null) convConds.push(eq(conversations.branchId, scopedBranchId));
  const convs = await db
    .select({
      id: conversations.id,
      channel: conversations.channel,
      status: conversations.status,
      lastMessageAt: conversations.lastMessageAt,
      lastMessagePreview: conversations.lastMessagePreview,
      unreadCount: conversations.unreadCount,
    })
    .from(conversations)
    .where(and(...convConds))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(10);

  return {
    kind: "supplier" as const,
    supplier,
    contactPersons: persons,
    conversations: convs,
  };
}

export async function contact360(input: Contact360Input, ctx: Contact360Ctx) {
  return input.kind === "customer" ? customer360(input.id, ctx.scopedBranchId) : supplier360(input.id, ctx.scopedBranchId);
}
