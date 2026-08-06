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
  /** ش٤ (§٧.٢) — جزء `deposit` الذي سبق قبضُه (عرابين مسوّدة عبر orderPayments): له إيصاله
   *  وقيده منذ القبض، فلا يُنشأ له إيصالٌ ثانٍ هنا (I5) — الإيصال للجزء الجديد N = deposit − هذا. */
  depositPreCollected?: string | null;
  paymentMethod?: "CASH" | "CARD" | "TRANSFER" | "WALLET" | "TELECOM" | null;
  paymentReference?: string | null;
  paymentReceiptUrl?: string | null;
  hasDelivery?: boolean | null;
  deliveryAddress?: string | null;
  deliveryCost?: string | null;
  // اِستقبال (تكامل التوصيل، ٤/٨): هاتف مستلم التوصيل — مصدر حقيقة قابل للاستعلام.
  deliveryPhone?: string | null;
  /** ٥/٨ — مَن يقبض أجرة التوصيل: COURIER (افتراضي) | COUNTER | SHOP. الأجرة **ليست** جزءاً
   *  من salePrice في أيّ حالة — تمريرٌ لا إيراد (قرار المالك). */
  deliveryFeeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
  /** ٥/٨ — زبون عابر بلا سجلّ عميل: اسمٌ/هاتفٌ مرجعيّان للطلب (لا يُنشئان عميلاً ولا ذمّة). */
  contactName?: string | null;
  contactPhone?: string | null;
  // v3-add-screens(100%): صور نموذج العمل (تذهب لجدول workOrderImages).
  designImages?: Array<{ url: string; caption?: string | null; sortOrder?: number | null }>;
  /** idempotency: نقرة مزدوجة/إعادة شبكة بنفس المفتاح ⇒ طلب خدمة واحد (لا عربون نقدي مزدوج). */
  clientRequestId?: string | null;
  /** ش٠ (٥/٨، V4): وردية مُتحقَّقٌ منها من مسار الاستقبال (checkoutReception يقفلها FOR UPDATE
   *  ويثبت أنها OPEN + RECEPTION + لنفس الفرع). تمريرها يضمن «سلّة واحدة ⇒ درج واحد»: كل نقد
   *  السلة (بيع + عرابين + أجرة أمانة) يهبط على درج القابض نفسه، فيُحاسَب الموظّف على ما استلمه
   *  هو فقط. غيابها (الإنشاء المفرد workOrders.create) يُبقي الحلّ الذاتي openShiftIdTx. */
  shiftId?: number | null;
}


export type { PaymentMethod };
