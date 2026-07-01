// عقد أوامر الشغل (طلب خدمة المطبعة).

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface WorkOrderMaterialInput {
  variantId: number;
  baseQuantity: number;
}

export interface CreateWorkOrderInput {
  branchId: number;
  customerId?: number | null;
  // v3-add-screens(100%): اختياري لطلب خدمة خدمة تخصيص خالصة بلا منتج خام.
  baseVariantId?: number | null;
  title: string;
  customizationText?: string | null;
  quantity?: number; // default 1
  materials?: WorkOrderMaterialInput[]; // additional consumables
  laborCost?: string; // default 0
  salePrice: string;
  dueDate?: string | null; // YYYY-MM-DD
  notes?: string | null;
  // المنفّذ المسؤول عند الإنشاء (يذهب لعمود workOrders.assignedTo؛ null = غير مُسنَد).
  assignedTo?: number | null;
  // v3-add-screens(100%): الحقول الجديدة التي تذهب لأعمدة workOrders الحقيقية.
  receptionChannel?: "WALK_IN" | "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "PHONE" | "OTHER" | null;
  channelHandle?: string | null;
  priority?: "LOW" | "NORMAL" | "URGENT" | null;
  deposit?: string | null;
  paymentMethod?: "CASH" | "CARD" | null;
  paymentReference?: string | null;
  paymentReceiptUrl?: string | null;
  hasDelivery?: boolean | null;
  deliveryAddress?: string | null;
  deliveryCost?: string | null;
  // v3-add-screens(100%): صور نموذج العمل (تذهب لجدول workOrderImages).
  designImages?: Array<{ url: string; caption?: string | null; sortOrder?: number | null }>;
  /** idempotency: نقرة مزدوجة/إعادة شبكة بنفس المفتاح ⇒ طلب خدمة واحد (لا عربون نقدي مزدوج). */
  clientRequestId?: string | null;
}


export type { PaymentMethod };
