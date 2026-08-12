import { TRPCError } from "@trpc/server";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  conversations,
  conversationMessages,
  customers,
  invoiceItems,
  invoices,
  productUnits,
  productVariants,
  products,
  quotationItems,
  quotations,
  waOutbox,
  waTemplates,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { normalizeIraqPhoneE164 } from "../lib/phone";
import {
  generateOfficialDocumentPdf,
  officialDocumentFilename,
  type OfficialDocumentKind,
  type OfficialDocumentPdfData,
} from "./officialDocumentPdf";
import { enqueueAndDispatch, getActiveWaIntegration } from "./whatsapp/outboxService";

export interface OfficialDocumentSnapshot {
  documentId: number;
  kind: OfficialDocumentKind;
  branchId: number;
  ownerId: number | null;
  customerId: number | null;
  customerPhone: string | null;
  customerConsent: "UNKNOWN" | "OPTED_IN" | "OPTED_OUT";
  pdfData: OfficialDocumentPdfData;
}

export interface DocumentAccessScope {
  scopedBranchId: number | null;
  scopedOwnerId: number | null;
}

function notFound(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: "المستند غير موجود أو لا تملك صلاحية الوصول إليه." });
}

export function assertOfficialDocumentAccess(
  document: OfficialDocumentSnapshot,
  scope: DocumentAccessScope,
): void {
  if (scope.scopedBranchId != null && document.branchId !== scope.scopedBranchId) notFound();
  if (
    document.kind === "INVOICE"
    && scope.scopedOwnerId != null
    && document.ownerId !== scope.scopedOwnerId
  ) {
    notFound();
  }
}

export async function loadOfficialDocumentSnapshot(
  kind: OfficialDocumentKind,
  documentId: number,
): Promise<OfficialDocumentSnapshot> {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة." });

  if (kind === "INVOICE") {
    const row = (
      await db
        .select({
          id: invoices.id,
          branchId: invoices.branchId,
          ownerId: invoices.createdBy,
          customerId: invoices.customerId,
          number: invoices.invoiceNumber,
          date: invoices.invoiceDate,
          customerName: customers.name,
          customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
          customerConsent: customers.waConsent,
          subtotal: invoices.subtotal,
          discountAmount: invoices.discountAmount,
          taxAmount: invoices.taxAmount,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          notes: invoices.notes,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customerId, customers.id))
        .where(eq(invoices.id, documentId))
        .limit(1)
    )[0];
    if (!row) notFound();
    const items = await db
      .select({
        productName: products.name,
        variantName: productVariants.variantName,
        unitName: productUnits.unitName,
        quantity: invoiceItems.quantity,
        unitPrice: invoiceItems.unitPrice,
        total: invoiceItems.total,
      })
      .from(invoiceItems)
      .leftJoin(productVariants, eq(invoiceItems.variantId, productVariants.id))
      .leftJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(productUnits, eq(invoiceItems.productUnitId, productUnits.id))
      .where(eq(invoiceItems.invoiceId, documentId));
    return {
      documentId,
      kind,
      branchId: Number(row.branchId),
      ownerId: row.ownerId == null ? null : Number(row.ownerId),
      customerId: row.customerId == null ? null : Number(row.customerId),
      customerPhone: row.customerPhone ?? null,
      customerConsent: row.customerConsent ?? "UNKNOWN",
      pdfData: {
        kind,
        number: row.number,
        date: row.date,
        customerName: row.customerName,
        customerPhone: row.customerPhone,
        subtotal: row.subtotal,
        discountAmount: row.discountAmount,
        taxAmount: row.taxAmount,
        total: row.total,
        paidAmount: row.paidAmount,
        notes: row.notes,
        items: items.map((item) => ({
          productName: item.productName ?? "",
          variantName: item.variantName,
          unitName: item.unitName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          total: item.total,
        })),
      },
    };
  }

  const row = (
    await db
      .select({
        id: quotations.id,
        branchId: quotations.branchId,
        customerId: quotations.customerId,
        number: quotations.quoteNumber,
        date: quotations.quoteDate,
        validUntil: quotations.validUntil,
        customerName: customers.name,
        customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
        customerConsent: customers.waConsent,
        subtotal: quotations.subtotal,
        discountAmount: quotations.discountAmount,
        taxAmount: quotations.taxAmount,
        total: quotations.total,
        notes: quotations.notes,
      })
      .from(quotations)
      .leftJoin(customers, eq(quotations.customerId, customers.id))
      .where(eq(quotations.id, documentId))
      .limit(1)
  )[0];
  if (!row) notFound();
  const items = await db
    .select({
      productName: products.name,
      variantName: productVariants.variantName,
      unitName: productUnits.unitName,
      quantity: quotationItems.quantity,
      unitPrice: quotationItems.unitPrice,
      total: quotationItems.total,
    })
    .from(quotationItems)
    .leftJoin(productVariants, eq(quotationItems.variantId, productVariants.id))
    .leftJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(quotationItems.productUnitId, productUnits.id))
    .where(eq(quotationItems.quotationId, documentId));
  return {
    documentId,
    kind,
    branchId: Number(row.branchId),
    ownerId: null,
    customerId: row.customerId == null ? null : Number(row.customerId),
    customerPhone: row.customerPhone ?? null,
    customerConsent: row.customerConsent ?? "UNKNOWN",
    pdfData: {
      kind,
      number: row.number,
      date: row.date,
      validUntil: row.validUntil,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      subtotal: row.subtotal,
      discountAmount: row.discountAmount,
      taxAmount: row.taxAmount,
      total: row.total,
      notes: row.notes,
      items: items.map((item) => ({
        productName: item.productName ?? "",
        variantName: item.variantName,
        unitName: item.unitName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        total: item.total,
      })),
    },
  };
}

function hasDocumentHeader(components: unknown): boolean {
  return Array.isArray(components)
    && components.some((component) => {
      const value = component as { type?: unknown; format?: unknown };
      return value.type === "HEADER" && value.format === "DOCUMENT";
    });
}

async function findConversation(
  branchId: number,
  customerId: number | null,
  phoneE164: string,
): Promise<{ id: number; lastInboundAt: Date | null } | null> {
  const db = getDb();
  if (!db) return null;
  const handle = phoneE164.replace(/^\+/, "");
  return (
    await db
      .select({ id: conversations.id, lastInboundAt: conversations.lastInboundAt })
      .from(conversations)
      .where(and(
        eq(conversations.branchId, branchId),
        eq(conversations.channel, "WHATSAPP"),
        customerId != null
          ? or(eq(conversations.customerId, customerId), eq(conversations.channelHandle, handle))
          : eq(conversations.channelHandle, handle),
      ))
      .limit(1)
  )[0] ?? null;
}

async function findDocumentTemplate(
  kind: OfficialDocumentKind,
): Promise<{ name: string; language: string; variableCount: number } | null> {
  const db = getDb();
  if (!db) return null;
  const names = kind === "INVOICE"
    ? ["invoice_pdf_ar", "invoice_pdf"]
    : ["quotation_pdf_ar", "quotation_pdf"];
  const rows = await db
    .select({
      name: waTemplates.name,
      language: waTemplates.language,
      variableCount: waTemplates.variableCount,
      componentsJson: waTemplates.componentsJson,
    })
    .from(waTemplates)
    .where(and(
      inArray(waTemplates.name, names),
      eq(waTemplates.templateStatus, "APPROVED"),
    ));
  const row = rows.find((candidate) => hasDocumentHeader(candidate.componentsJson));
  return row
    ? { name: row.name, language: row.language, variableCount: Number(row.variableCount) }
    : null;
}

export interface DeliveryReadiness {
  automaticAvailable: boolean;
  mode: "SESSION" | "TEMPLATE" | "MANUAL";
  phone: string | null;
  filename: string;
  reason: string | null;
  templateName: string | null;
}

export async function getDocumentDeliveryReadiness(
  document: OfficialDocumentSnapshot,
  phoneOverride?: string | null,
): Promise<DeliveryReadiness> {
  const rawPhone = phoneOverride?.trim() || document.customerPhone?.trim() || "";
  const phone = rawPhone ? normalizeIraqPhoneE164(rawPhone) : null;
  const filename = officialDocumentFilename(document.kind, document.pdfData.number);
  if (!phone || !/^\+\d{8,15}$/.test(phone)) {
    return {
      automaticAvailable: false,
      mode: "MANUAL",
      phone,
      filename,
      reason: "رقم واتساب العميل غير موجود أو غير صالح.",
      templateName: null,
    };
  }
  if (document.customerConsent === "OPTED_OUT") {
    return {
      automaticAvailable: false,
      mode: "MANUAL",
      phone,
      filename,
      reason: "العميل مسجّل كرافض لاستلام رسائل واتساب.",
      templateName: null,
    };
  }
  if (!(await getActiveWaIntegration(document.branchId))) {
    return {
      automaticAvailable: false,
      mode: "MANUAL",
      phone,
      filename,
      reason: "تكامل WhatsApp Cloud API غير مفعّل لهذا الفرع.",
      templateName: null,
    };
  }
  const conversation = await findConversation(document.branchId, document.customerId, phone);
  const inFreeWindow = !!conversation?.lastInboundAt
    && Date.now() - conversation.lastInboundAt.getTime() < 24 * 3600 * 1000;
  if (inFreeWindow) {
    return {
      automaticAvailable: true,
      mode: "SESSION",
      phone,
      filename,
      reason: null,
      templateName: null,
    };
  }
  const template = await findDocumentTemplate(document.kind);
  if (template) {
    return {
      automaticAvailable: true,
      mode: "TEMPLATE",
      phone,
      filename,
      reason: null,
      templateName: template.name,
    };
  }
  return {
    automaticAvailable: false,
    mode: "MANUAL",
    phone,
    filename,
    reason: "نافذة المحادثة مغلقة ولا يوجد قالب PDF معتمد من Meta.",
    templateName: null,
  };
}

export async function downloadOfficialDocumentPdf(
  document: OfficialDocumentSnapshot,
): Promise<{ filename: string; bytesBase64: string }> {
  const bytes = await generateOfficialDocumentPdf(document.pdfData);
  return {
    filename: officialDocumentFilename(document.kind, document.pdfData.number),
    bytesBase64: Buffer.from(bytes).toString("base64"),
  };
}

export async function enqueueOfficialDocumentWhatsApp(input: {
  document: OfficialDocumentSnapshot;
  phoneOverride?: string | null;
  caption?: string | null;
  clientRequestId: string;
  createdBy: number;
}): Promise<{ outboxId: number; mode: "SESSION" | "TEMPLATE"; phone: string; filename: string }> {
  const readiness = await getDocumentDeliveryReadiness(input.document, input.phoneOverride);
  if (!readiness.automaticAvailable || readiness.mode === "MANUAL" || !readiness.phone) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: readiness.reason ?? "الإرسال التلقائي غير متاح.",
    });
  }
  const conversation = await findConversation(
    input.document.branchId,
    input.document.customerId,
    readiness.phone,
  );
  const caption = input.caption?.trim()
    || `${input.document.kind === "INVOICE" ? "فاتورة المبيعات" : "عرض السعر"} رقم ${input.document.pdfData.number}`;
  const documentPayload = {
    pdfData: input.document.pdfData,
    filename: readiness.filename,
    caption,
  };

  let templateName: string | null = null;
  let templateLang: string | null = null;
  let bodyParams: string[] = [];
  if (readiness.mode === "TEMPLATE") {
    const template = await findDocumentTemplate(input.document.kind);
    if (!template) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "قالب PDF المعتمد لم يعد متاحاً." });
    }
    templateName = template.name;
    templateLang = template.language;
    const values = [
      input.document.pdfData.customerName || "عميلنا الكريم",
      input.document.pdfData.number,
      moneyForMessage(input.document.pdfData.total),
    ];
    bodyParams = values.slice(0, template.variableCount);
    if (bodyParams.length !== template.variableCount) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "قالب PDF المعتمد يحتوي متغيرات أكثر من المدعوم في المستند.",
      });
    }
  }

  const queued = await enqueueAndDispatch({
    dedupeKey: `DOC_PDF:${input.document.kind}:${input.document.documentId}:${input.clientRequestId}`,
    branchId: input.document.branchId,
    conversationId: conversation?.id ?? null,
    toPhoneE164: readiness.phone,
    kind: readiness.mode === "SESSION" ? "MEDIA" : "TEMPLATE",
    payloadJson: { document: documentPayload, bodyParams },
    templateName,
    templateLang,
    createdBy: input.createdBy,
  });
  return {
    outboxId: queued.id,
    mode: readiness.mode,
    phone: readiness.phone,
    filename: readiness.filename,
  };
}

function moneyForMessage(value: string | number): string {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export async function getDocumentOutboxStatus(
  outboxId: number,
  scopedBranchId: number | null,
): Promise<{ status: string; lastError: string | null; wamid: string | null } | null> {
  const db = getDb();
  if (!db) return null;
  const row = (
    await db
      .select({
        branchId: waOutbox.branchId,
        status: waOutbox.status,
        lastError: waOutbox.lastError,
        wamid: waOutbox.wamid,
      })
      .from(waOutbox)
      .where(eq(waOutbox.id, outboxId))
      .limit(1)
  )[0];
  if (!row || (scopedBranchId != null && Number(row.branchId) !== scopedBranchId)) return null;
  let status: string = row.status;
  if (row.wamid) {
    const message = (
      await db
        .select({ deliveryStatus: conversationMessages.deliveryStatus })
        .from(conversationMessages)
        .where(eq(conversationMessages.externalId, row.wamid))
        .limit(1)
    )[0];
    if (
      message?.deliveryStatus === "DELIVERED"
      || message?.deliveryStatus === "READ"
      || message?.deliveryStatus === "FAILED"
    ) {
      status = message.deliveryStatus;
    }
  }
  return { status, lastError: row.lastError, wamid: row.wamid };
}
