/**
 * shared/atomicPermissions.ts — شجرة الصلاحيات الذرية الشاملة ومصفوفة الحوكمة التشغيلية.
 *
 * كتالوج مفاتيح الصلاحيات الذرية بصيغة Domain.Resource.Action يغطي كافة قطاعات وأدوار
 * شركة الرؤية العربية (الكاشير، الاستقبال، المطبعة والورش، المستودعات، المشتريات،
 * الخزينة والمالية، المبيعات الميدانية، التوصيل، الموارد البشرية، الإدارة والتدقيق).
 *
 * يتضمن:
 *  ١) تعريفات المجالات والموارد والأفعال الذرية (10 قطاعات، 100+ مفتاح ذري).
 *  ٢) مخططات وأنواع Zod (AtomicPermissionKey, AtomicPermissionsMap, OperationalCaps, SensitiveDataMasking).
 *  ٣) القوالب الافتراضية لكافة الأدوار الـ11 الأساسية + أدوار الكاشير الـ3 للأقسام.
 *  ٤) محرك الحل والاشتقاق الهرمي (Resolution Engine) للسقوف والصلاحيات والبيانات الحساسة.
 *  ٥) مساعدات التوافق الرجعي التام 100% مع الوحدات الـ29 القديمة (FULL / READ / NONE).
 */

import { z } from "zod";
import { ALL_PERMISSION_MODULE_KEYS } from "./permissions";
import { normalizeSearchText } from "./searchNormalize";
import {
  ENTERPRISE_ATOMIC_DEFINITIONS,
  ENTERPRISE_RESOURCE_METADATA,
} from "./atomicPermissionExtensions";

// ============================================================================
// ١. تعريفات القطاعات التشغيلية (Domains) والأفعال المعيارية (Standard Actions)
// ============================================================================

export type DomainKey =
  | "pos"
  | "reception"
  | "workshop"
  | "inventory"
  | "purchasing"
  | "treasury"
  | "fieldsales"
  | "delivery"
  | "hr"
  | "governance";

export const ALL_DOMAINS: DomainKey[] = [
  "pos",
  "reception",
  "workshop",
  "inventory",
  "purchasing",
  "treasury",
  "fieldsales",
  "delivery",
  "hr",
  "governance",
];

export interface DomainMetadata {
  key: DomainKey;
  label: string;
  labelAr?: string;
  description: string;
  descriptionAr?: string;
  iconName: string;
  order: number;
}

export const DOMAIN_METADATA: Record<DomainKey, DomainMetadata> = {
  pos: {
    key: "pos",
    label: "الكاشير ونقاط البيع",
    labelAr: "الكاشير ونقاط البيع",
    description: "إدارة ورديات الصندوق، فواتير المبيعات الفورية، المرتجعات، والبطاقات الرقمية",
    descriptionAr: "إدارة ورديات الصندوق، فواتير المبيعات الفورية، المرتجعات، والبطاقات الرقمية",
    iconName: "Store",
    order: 1,
  },
  reception: {
    key: "reception",
    label: "الاستقبال وأوامر الشغل",
    labelAr: "الاستقبال وأوامر الشغل",
    description: "استقبال طلبات العملاء، فتح أوامر الشغل الفنية، العربون، واعتماد البروفات",
    descriptionAr: "استقبال طلبات العملاء، فتح أوامر الشغل الفنية، العربون، واعتماد البروفات",
    iconName: "ClipboardList",
    order: 2,
  },
  workshop: {
    key: "workshop",
    label: "المطبعة والورش الفنية",
    labelAr: "المطبعة والورش الفنية",
    description: "أوامر التشغيل والماكينات، استهلاك المواد الخام، إثبات الهالك، وإعادة الطباعة",
    descriptionAr: "أوامر التشغيل والماكينات، استهلاك المواد الخام، إثبات الهالك، وإعادة الطباعة",
    iconName: "Wrench",
    order: 3,
  },
  inventory: {
    key: "inventory",
    label: "المستودعات والمخازن",
    labelAr: "المستودعات والمخازن",
    description: "أرصدة الأصناف، المناقلات بين الفروع، الجرد الدوري والمفاجئ، وتسوية الفروقات",
    descriptionAr: "أرصدة الأصناف، المناقلات بين الفروع، الجرد الدوري والمفاجئ، وتسوية الفروقات",
    iconName: "Boxes",
    order: 4,
  },
  purchasing: {
    key: "purchasing",
    label: "المشتريات والموردين",
    labelAr: "المشتريات والموردين",
    description: "سجلات الموردين، أوامر الشراء، أذونات الاستلام المخزني، والمطابقة الثلاثية",
    descriptionAr: "سجلات الموردين، أوامر الشراء، أذونات الاستلام المخزني، والمطابقة الثلاثية",
    iconName: "ShoppingCart",
    order: 5,
  },
  treasury: {
    key: "treasury",
    label: "الخزينة والمالية",
    labelAr: "الخزينة والمالية",
    description: "حركة الخزائن والصناديق، سندات القبض والصرف، المصروفات، والتحويلات النقدية",
    descriptionAr: "حركة الخزائن والصناديق، سندات القبض والصرف، المصروفات، والتحويلات النقدية",
    iconName: "Landmark",
    order: 6,
  },
  fieldsales: {
    key: "fieldsales",
    label: "المبيعات الميدانية",
    labelAr: "المبيعات الميدانية",
    description: "زيارات المناديب، عروض الأسعار التفاوضية، طلبيات الجملة، والعملاء التجاريين",
    descriptionAr: "زيارات المناديب، عروض الأسعار التفاوضية، طلبيات الجملة، والعملاء التجاريين",
    iconName: "Briefcase",
    order: 7,
  },
  delivery: {
    key: "delivery",
    label: "التوصيل واللوجستيات",
    labelAr: "التوصيل واللوجستيات",
    description: "توزيع الشحنات على المناديب، إثبات التسليم، تحصيل مبالغ COD، وتسوية العجز",
    descriptionAr: "توزيع الشحنات على المناديب، إثبات التسليم، تحصيل مبالغ COD، وتسوية العجز",
    iconName: "Truck",
    order: 8,
  },
  hr: {
    key: "hr",
    label: "الموارد البشرية والرواتب",
    labelAr: "الموارد البشرية والرواتب",
    description: "بيانات الموظفين، الحضور والانصراف، مسير الرواتب، الإجازات، وعمولات المبيعات",
    descriptionAr: "بيانات الموظفين، الحضور والانصراف، مسير الرواتب، الإجازات، وعمولات المبيعات",
    iconName: "Users",
    order: 9,
  },
  governance: {
    key: "governance",
    label: "الإدارة والرقابة والحوكمة",
    labelAr: "الإدارة والرقابة والحوكمة",
    description: "سجلات التدقيق الأمني، إدارة المستخدمين والأدوار، تجاوز السقوف، وإعدادات النظام",
    descriptionAr: "سجلات التدقيق الأمني، إدارة المستخدمين والأدوار، تجاوز السقوف، وإعدادات النظام",
    iconName: "ShieldCheck",
    order: 10,
  },
};

/**
 * الأفعال المعيارية الثمانية المشتركة (Standard Actions).
 */
export type StandardActionType =
  | "view"
  | "create"
  | "edit"
  | "cancel"
  | "print"
  | "reprint"
  | "export"
  | "approve";

export interface StandardActionMeta {
  key: StandardActionType;
  action: StandardActionType;
  label: string;
  labelAr: string;
  iconName: string;
}

export const STANDARD_ACTIONS: StandardActionMeta[] = [
  { key: "view", action: "view", label: "عرض", labelAr: "عرض", iconName: "Eye" },
  { key: "create", action: "create", label: "إضافة", labelAr: "إضافة", iconName: "PlusCircle" },
  { key: "edit", action: "edit", label: "تعديل", labelAr: "تعديل", iconName: "Edit3" },
  { key: "cancel", action: "cancel", label: "إلغاء / عكس", labelAr: "إلغاء / عكس", iconName: "Ban" },
  { key: "print", action: "print", label: "طباعة", labelAr: "طباعة", iconName: "Printer" },
  { key: "reprint", action: "reprint", label: "إعادة طباعة", labelAr: "إعادة طباعة", iconName: "RotateCcw" },
  { key: "export", action: "export", label: "تصدير", labelAr: "تصدير", iconName: "Download" },
  { key: "approve", action: "approve", label: "اعتماد", labelAr: "اعتماد", iconName: "CheckCircle2" },
];

export type PermissionSensitivity = "normal" | "medium" | "high" | "critical";

// ============================================================================
// ٢. تعريفات المفاتيح الذرية (Atomic Permission Definitions)
// ============================================================================

export type AtomicPermissionKey = string;

export interface AtomicPermissionDefinition {
  key: AtomicPermissionKey;
  domain: DomainKey;
  resource: string;
  action: string;
  standardAction?: StandardActionType;
  label: string;
  labelAr: string;
  description: string;
  descriptionAr: string;
  sensitivity: PermissionSensitivity;
  legacyModule: string;
  sodGroup?: string;
  isSpecialOperation?: boolean;
}

const BASE_ATOMIC_PERMISSION_DEFINITIONS: AtomicPermissionDefinition[] = [
  // --------------------------------------------------------------------------
  // 1. pos (الكاشير ونقاط البيع)
  // --------------------------------------------------------------------------
  {
    key: "pos.shift.open",
    domain: "pos",
    resource: "shift",
    action: "open",
    standardAction: "create",
    label: "فتح وردية صندوق جديدة",
    labelAr: "فتح وردية صندوق جديدة",
    description: "بدء وردية كاشير وإثبات الرصيد الافتتاحي في درج النقد",
    descriptionAr: "بدء وردية كاشير وإثبات الرصيد الافتتاحي في درج النقد",
    sensitivity: "normal",
    legacyModule: "pos",
  },
  {
    key: "pos.shift.close",
    domain: "pos",
    resource: "shift",
    action: "close",
    standardAction: "edit",
    label: "إغلاق الوردية وإجراء الجرد النقدي",
    labelAr: "إغلاق الوردية وإجراء الجرد النقدي",
    description: "إنهاء الوردية وجرد النقدية وإصدار تقرير Z",
    descriptionAr: "إنهاء الوردية وجرد النقدية وإصدار تقرير Z",
    sensitivity: "normal",
    legacyModule: "pos",
  },
  {
    key: "pos.invoice.create",
    domain: "pos",
    resource: "invoice",
    action: "create",
    standardAction: "create",
    label: "إصدار فاتورة بيع نقدية جديدة",
    labelAr: "إصدار فاتورة بيع نقدية جديدة",
    description: "إنشاء فاتورة بيع فورية في نقطة البيع وتسجيل المدفوعات",
    descriptionAr: "إنشاء فاتورة بيع فورية في نقطة البيع وتسجيل المدفوعات",
    sensitivity: "normal",
    legacyModule: "sales",
  },
  {
    key: "pos.invoice.view",
    domain: "pos",
    resource: "invoice",
    action: "view",
    standardAction: "view",
    label: "استعراض فواتير نقطة البيع",
    labelAr: "استعراض فواتير نقطة البيع",
    description: "عرض سجل وتفاصيل فواتير البيع المصدرة في الوردية أو الفرع",
    descriptionAr: "عرض سجل وتفاصيل فواتير البيع المصدرة في الوردية أو الفرع",
    sensitivity: "normal",
    legacyModule: "sales",
  },
  {
    key: "pos.invoice.reprint",
    domain: "pos",
    resource: "invoice",
    action: "reprint",
    standardAction: "reprint",
    label: "إعادة طباعة إيصال بيع سابق",
    labelAr: "إعادة طباعة إيصال بيع سابق",
    description: "طباعة نسخة إضافية من إيصال الفاتورة للعميل",
    descriptionAr: "طباعة نسخة إضافية من إيصال الفاتورة للعميل",
    sensitivity: "normal",
    legacyModule: "sales",
  },
  {
    key: "pos.invoice.print",
    domain: "pos",
    resource: "invoice",
    action: "print",
    standardAction: "print",
    label: "طباعة إيصال البيع الفوري",
    labelAr: "طباعة إيصال البيع الفوري",
    description: "طباعة إيصال الفاتورة فور إصدارها على الطابعة الحرارية",
    descriptionAr: "طباعة إيصال الفاتورة فور إصدارها على الطابعة الحرارية",
    sensitivity: "normal",
    legacyModule: "sales",
  },
  {
    key: "pos.invoice.export",
    domain: "pos",
    resource: "invoice",
    action: "export",
    standardAction: "export",
    label: "تصدير فواتير نقطة البيع",
    labelAr: "تصدير فواتير نقطة البيع",
    description: "تصدير بيانات فواتير البيع إلى ملفات خارجية",
    descriptionAr: "تصدير بيانات فواتير البيع إلى ملفات خارجية",
    sensitivity: "medium",
    legacyModule: "sales",
  },
  {
    key: "pos.invoice.void",
    domain: "pos",
    resource: "invoice",
    action: "void",
    standardAction: "cancel",
    label: "إلغاء أو شطب فاتورة بيع",
    labelAr: "إلغاء أو شطب فاتورة بيع",
    description: "إلغاء فاتورة مبيعات صادرة وعكس أثرها المالي والمخزني بالكامل",
    descriptionAr: "إلغاء فاتورة مبيعات صادرة وعكس أثرها المالي والمخزني بالكامل",
    sensitivity: "critical",
    legacyModule: "sales",
  },
  {
    key: "pos.return.create",
    domain: "pos",
    resource: "return",
    action: "create",
    standardAction: "create",
    label: "إصدار مرتجع مبيعات فوري",
    labelAr: "إصدار مرتجع مبيعات فوري",
    description: "استلام بضاعة مرتجعة من العميل ورد قيمتها النقدية ضمن السقف المسموح",
    descriptionAr: "استلام بضاعة مرتجعة من العميل ورد قيمتها النقدية ضمن السقف المسموح",
    sensitivity: "medium",
    legacyModule: "sales",
  },
  {
    key: "pos.discount.apply",
    domain: "pos",
    resource: "discount",
    action: "apply",
    standardAction: "edit",
    label: "تطبيق خصم يدوي على الفاتورة",
    labelAr: "تطبيق خصم يدوي على الفاتورة",
    description: "منح خصم تجاري على مستوى البند أو الفاتورة ضمن السقف الرقمي المحدد",
    descriptionAr: "منح خصم تجاري على مستوى البند أو الفاتورة ضمن السقف الرقمي المحدد",
    sensitivity: "medium",
    legacyModule: "sales",
  },
  {
    key: "pos.price.override",
    domain: "pos",
    resource: "price",
    action: "override",
    standardAction: "edit",
    label: "تعديل سعر بيع الصنف يدوياً",
    labelAr: "تعديل سعر بيع الصنف يدوياً",
    description: "تجاوز السعر النظامي المحدد للصنف في نقطة البيع",
    descriptionAr: "تجاوز السعر النظامي المحدد للصنف في نقطة البيع",
    sensitivity: "critical",
    legacyModule: "sales",
  },
  {
    key: "pos.drawer.open",
    domain: "pos",
    resource: "drawer",
    action: "open",
    standardAction: "approve",
    label: "فتح درج النقد يدوياً بدون عملية بيع",
    labelAr: "فتح درج النقد يدوياً بدون عملية بيع",
    description: "فتح صندوق النقدية لأسباب رقابية أو تنظيمية بدون ربطه بفاتورة بيع",
    descriptionAr: "فتح صندوق النقدية لأسباب رقابية أو تنظيمية بدون ربطه بفاتورة بيع",
    sensitivity: "high",
    legacyModule: "treasury",
  },
  {
    key: "pos.digital_card.sell",
    domain: "pos",
    resource: "digital_card",
    action: "sell",
    standardAction: "create",
    label: "بيع البطاقات الرقمية والاشتراكات",
    labelAr: "بيع البطاقات الرقمية والاشتراكات",
    description: "إصدار وتفعيل أكواد الاشتراكات والبطاقات الرقمية للعملاء",
    descriptionAr: "إصدار وتفعيل أكواد الاشتراكات والبطاقات الرقمية للعملاء",
    sensitivity: "normal",
    legacyModule: "digital_cards",
  },

  // --------------------------------------------------------------------------
  // 2. reception (الاستقبال وخدمة العملاء وأوامر الشغل)
  // --------------------------------------------------------------------------
  {
    key: "reception.order.create",
    domain: "reception",
    resource: "order",
    action: "create",
    standardAction: "create",
    label: "تسجيل وتثبيت أمر شغل وطلب طباعة",
    labelAr: "تسجيل وتثبيت أمر شغل وطلب طباعة",
    description: "فتح تذكرة طلب جديدة لأعمال المطبعة والنسخ والتصميم",
    descriptionAr: "فتح تذكرة طلب جديدة لأعمال المطبعة والنسخ والتصميم",
    sensitivity: "normal",
    legacyModule: "workorders",
  },
  {
    key: "reception.order.view",
    domain: "reception",
    resource: "order",
    action: "view",
    standardAction: "view",
    label: "استعراض أوامر الشغل ومتابعة مراحلها",
    labelAr: "استعراض أوامر الشغل ومتابعة مراحلها",
    description: "متابعة مسار أوامر الشغل وحالاتها ومواعيد تسليمها",
    descriptionAr: "متابعة مسار أوامر الشغل وحالاتها ومواعيد تسليمها",
    sensitivity: "normal",
    legacyModule: "workorders",
  },
  {
    key: "reception.order.update",
    domain: "reception",
    resource: "order",
    action: "update",
    standardAction: "edit",
    label: "تعديل مواصفات وتفاصيل أمر الشغل",
    labelAr: "تعديل مواصفات وتفاصيل أمر الشغل",
    description: "تعديل القياسات، الكميات، أو المواد المطلوبة لأمر الشغل قبل التشغيل",
    descriptionAr: "تعديل القياسات، الكميات، أو المواد المطلوبة لأمر الشغل قبل التشغيل",
    sensitivity: "normal",
    legacyModule: "workorders",
  },
  {
    key: "reception.order.cancel",
    domain: "reception",
    resource: "order",
    action: "cancel",
    standardAction: "cancel",
    label: "إلغاء أمر شغل قيد التنفيذ",
    labelAr: "إلغاء أمر شغل قيد التنفيذ",
    description: "إلغاء طلب الشغل وتسوية العرابين أو المواد المستهلكة",
    descriptionAr: "إلغاء طلب الشغل وتسوية العرابين أو المواد المستهلكة",
    sensitivity: "high",
    legacyModule: "workorders",
  },
  {
    key: "reception.order.deliver",
    domain: "reception",
    resource: "order",
    action: "deliver",
    standardAction: "approve",
    label: "تسليم المنتج المطبوع للعميل وإقفال الطلب",
    labelAr: "تسليم المنتج المطبوع للعميل وإقفال الطلب",
    description: "تسليم البضاعة الجاهزة للعميل وتحصيل المتبقي وإقفال أمر الشغل",
    descriptionAr: "تسليم البضاعة الجاهزة للعميل وتحصيل المتبقي وإقفال أمر الشغل",
    sensitivity: "normal",
    legacyModule: "workorders",
  },
  {
    key: "reception.order.print",
    domain: "reception",
    resource: "order",
    action: "print",
    standardAction: "print",
    label: "طباعة كارت وتذكرة أمر الشغل",
    labelAr: "طباعة كارت وتذكرة أمر الشغل",
    description: "طباعة بطاقة متابعة أمر الشغل لفرق المطبعة والاستقبال",
    descriptionAr: "طباعة بطاقة متابعة أمر الشغل لفرق المطبعة والاستقبال",
    sensitivity: "normal",
    legacyModule: "workorders",
  },
  {
    key: "reception.deposit.collect",
    domain: "reception",
    resource: "deposit",
    action: "collect",
    standardAction: "create",
    label: "استلام وقبض عربون دفعة أولى",
    labelAr: "استلام وقبض عربون دفعة أولى",
    description: "تحصيل عربون مالي لأمر الشغل وإثباته كأمانة أو دفعة في الصندوق",
    descriptionAr: "تحصيل عربون مالي لأمر الشغل وإثباته كأمانة أو دفعة في الصندوق",
    sensitivity: "normal",
    legacyModule: "treasury",
  },
  {
    key: "reception.proof.send",
    domain: "reception",
    resource: "proof",
    action: "send",
    standardAction: "create",
    label: "إرسال بروفة التصميم للعميل للموافقة",
    labelAr: "إرسال بروفة التصميم للعميل للموافقة",
    description: "رفع وإرسال عينة التصميم للعميل للاعتماد قبل المباشرة بالطباعة",
    descriptionAr: "رفع وإرسال عينة التصميم للعميل للاعتماد قبل المباشرة بالطباعة",
    sensitivity: "normal",
    legacyModule: "workorders",
  },
  {
    key: "reception.proof.approve",
    domain: "reception",
    resource: "proof",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد موافقة العميل على بروفة التصميم",
    labelAr: "اعتماد موافقة العميل على بروفة التصميم",
    description: "إثبات موافقة العميل الصريحة على نموذج الطباعة النهائي",
    descriptionAr: "إثبات موافقة العميل الصريحة على نموذج الطباعة النهائي",
    sensitivity: "normal",
    legacyModule: "workorders",
  },
  {
    key: "reception.quote.create",
    domain: "reception",
    resource: "quote",
    action: "create",
    standardAction: "create",
    label: "إصدار عرض سعر أولي لخدمات الطباعة",
    labelAr: "إصدار عرض سعر أولي لخدمات الطباعة",
    description: "توليد عرض أسعار تفصيلي للعميل مع احتساب المواد والتشغيل",
    descriptionAr: "توليد عرض أسعار تفصيلي للعميل مع احتساب المواد والتشغيل",
    sensitivity: "normal",
    legacyModule: "crm",
  },
  {
    key: "reception.customer.create",
    domain: "reception",
    resource: "customer",
    action: "create",
    standardAction: "create",
    label: "فتح سجل عميل جديد من شباك الاستقبال",
    labelAr: "فتح سجل عميل جديد من شباك الاستقبال",
    description: "تسجيل بيانات عميل جديد في دليل العملاء الموحد",
    descriptionAr: "تسجيل بيانات عميل جديد في دليل العملاء الموحد",
    sensitivity: "normal",
    legacyModule: "crm",
  },

  // --------------------------------------------------------------------------
  // 3. workshop (المطبعة والورش والتصنيع الفني)
  // --------------------------------------------------------------------------
  {
    key: "workshop.job.view",
    domain: "workshop",
    resource: "job",
    action: "view",
    standardAction: "view",
    label: "استعراض قائمة أوامر الطباعة والتشغيل الفني",
    labelAr: "استعراض قائمة أوامر الطباعة والتشغيل الفني",
    description: "عرض جدول الأعمال المحولة لخطوط الإنتاج والماكينات",
    descriptionAr: "عرض جدول الأعمال المحولة لخطوط الإنتاج والماكينات",
    sensitivity: "normal",
    legacyModule: "workorders",
  },
  {
    key: "workshop.job.start",
    domain: "workshop",
    resource: "job",
    action: "start",
    standardAction: "edit",
    label: "بدء تشغيل ماكينة الطباعة أو التجليد",
    labelAr: "بدء تشغيل ماكينة الطباعة أو التجليد",
    description: "تحويل أمر الشغل لحالة قيد التنفيذ على خط الإنتاج المحدد",
    descriptionAr: "تحويل أمر الشغل لحالة قيد التنفيذ على خط الإنتاج المحدد",
    sensitivity: "normal",
    legacyModule: "workorders",
  },
  {
    key: "workshop.job.complete",
    domain: "workshop",
    resource: "job",
    action: "complete",
    standardAction: "approve",
    label: "إنهاء مرحلة فنية (طباعة/سلوفان/قص/تجليد)",
    labelAr: "إنهاء مرحلة فنية (طباعة/سلوفان/قص/تجليد)",
    description: "توثيق إنجاز مرحلة تصنيع وتحويل القطعة للمرحلة التالية أو للاستقبال",
    descriptionAr: "توثيق إنجاز مرحلة تصنيع وتحويل القطعة للمرحلة التالية أو للاستقبال",
    sensitivity: "normal",
    legacyModule: "workorders",
  },
  {
    key: "workshop.material.consume",
    domain: "workshop",
    resource: "material",
    action: "consume",
    standardAction: "create",
    label: "إثبات استهلاك الورق والأحبار والمواد الخام",
    labelAr: "إثبات استهلاك الورق والأحبار والمواد الخام",
    description: "صرف المواد الخام المستهلكة فعلياً من رصيد ورشة العمل",
    descriptionAr: "صرف المواد الخام المستهلكة فعلياً من رصيد ورشة العمل",
    sensitivity: "normal",
    legacyModule: "inventory",
  },
  {
    key: "workshop.waste.record",
    domain: "workshop",
    resource: "waste",
    action: "record",
    standardAction: "create",
    label: "إثبات الهالك والتالف الفني أثناء التشغيل",
    labelAr: "إثبات الهالك والتالف الفني أثناء التشغيل",
    description: "توثيق كميات التالف من الورق أو المواد بسبب أعطال أو تجارب ضبط",
    descriptionAr: "توثيق كميات التالف من الورق أو المواد بسبب أعطال أو تجارب ضبط",
    sensitivity: "medium",
    legacyModule: "inventory",
  },
  {
    key: "workshop.rework.request",
    domain: "workshop",
    resource: "rework",
    action: "request",
    standardAction: "create",
    label: "طلب إعادة طباعة أو تشغيل ناتج عن خطأ فني",
    labelAr: "طلب إعادة طباعة أو تشغيل ناتج عن خطأ فني",
    description: "رفع طلب إعادة تنفيذ أمر شغل تالف مع بيان السبب ومسؤولية التكلفة",
    descriptionAr: "رفع طلب إعادة تنفيذ أمر شغل تالف مع بيان السبب ومسؤولية التكلفة",
    sensitivity: "medium",
    legacyModule: "workorders",
    sodGroup: "rework",
  },
  {
    key: "workshop.rework.approve",
    domain: "workshop",
    resource: "rework",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد إعادة الطباعة وتحميل التكلفة",
    labelAr: "اعتماد إعادة الطباعة وتحميل التكلفة",
    description: "الموافقة على أمر إعادة التشغيل وصرف المواد البديلة وتحديد المسؤولية",
    descriptionAr: "الموافقة على أمر إعادة التشغيل وصرف المواد البديلة وتحديد المسؤولية",
    sensitivity: "high",
    legacyModule: "workorders",
    sodGroup: "rework",
  },
  {
    key: "workshop.queue.reorder",
    domain: "workshop",
    resource: "queue",
    action: "reorder",
    standardAction: "edit",
    label: "إعادة ترتيب أولوية طابور أوامر الطباعة",
    labelAr: "إعادة ترتيب أولوية طابور أوامر الطباعة",
    description: "تقديم أو تأخير مواعيد تشغيل أوامر الطباعة على الماكينات",
    descriptionAr: "تقديم أو تأخير مواعيد تشغيل أوامر الطباعة على الماكينات",
    sensitivity: "medium",
    legacyModule: "workorders",
  },

  // --------------------------------------------------------------------------
  // 4. inventory (المستودعات والمخازن والأرصدة والجرد)
  // --------------------------------------------------------------------------
  {
    key: "inventory.balance.view",
    domain: "inventory",
    resource: "balance",
    action: "view",
    standardAction: "view",
    label: "استعلام أرصدة المخزون المتاحة في الفروع",
    labelAr: "استعلام أرصدة المخزون المتاحة في الفروع",
    description: "عرض الكميات المتوفرة والمحجوزة للأصناف في مستودعات الشركة",
    descriptionAr: "عرض الكميات المتوفرة والمحجوزة للأصناف في مستودعات الشركة",
    sensitivity: "normal",
    legacyModule: "inventory",
  },
  {
    key: "inventory.balance.export",
    domain: "inventory",
    resource: "balance",
    action: "export",
    standardAction: "export",
    label: "تصدير كشف أرصدة المخزون",
    labelAr: "تصدير كشف أرصدة المخزون",
    description: "تصدير كشف كامل بأرصدة المخزون إلى ملفات Excel أو CSV",
    descriptionAr: "تصدير كشف كامل بأرصدة المخزون إلى ملفات Excel أو CSV",
    sensitivity: "medium",
    legacyModule: "inventory",
  },
  {
    key: "inventory.item.view",
    domain: "inventory",
    resource: "item",
    action: "view",
    standardAction: "view",
    label: "استعراض بطاقة الصنف والمواصفات الفنية",
    labelAr: "استعراض بطاقة الصنف والمواصفات الفنية",
    description: "معاينة تفاصيل المنتج، الوحدات، الباركودات، والمواصفات بدون التكلفة",
    descriptionAr: "معاينة تفاصيل المنتج، الوحدات، الباركودات، والمواصفات بدون التكلفة",
    sensitivity: "normal",
    legacyModule: "products",
  },
  {
    key: "inventory.transfer.create",
    domain: "inventory",
    resource: "transfer",
    action: "create",
    standardAction: "create",
    label: "إنشاء طلب مناقلة بضاعة بين المستودعات",
    labelAr: "إنشاء طلب مناقلة بضاعة بين المستودعات",
    description: "طلب تحويل كميات محددة من مستودع إلى مستودع أو فرع آخر",
    descriptionAr: "طلب تحويل كميات محددة من مستودع إلى مستودع أو فرع آخر",
    sensitivity: "normal",
    legacyModule: "inventory",
  },
  {
    key: "inventory.transfer.dispatch",
    domain: "inventory",
    resource: "transfer",
    action: "dispatch",
    standardAction: "edit",
    label: "شحن وإرسال البضاعة المنقولة",
    labelAr: "شحن وإرسال البضاعة المنقولة",
    description: "إخراج البضاعة من المخزن المصدر وتثبيت وضعها كبضاعة قيد النقل",
    descriptionAr: "إخراج البضاعة من المخزن المصدر وتثبيت وضعها كبضاعة قيد النقل",
    sensitivity: "normal",
    legacyModule: "inventory",
  },
  {
    key: "inventory.transfer.receive",
    domain: "inventory",
    resource: "transfer",
    action: "receive",
    standardAction: "approve",
    label: "فحص وتأكيد استلام المناقلة في المخزن الوارد",
    labelAr: "فحص وتأكيد استلام المناقلة في المخزن الوارد",
    description: "مطابقة الكميات الواردة وإدخالها في رصيد المستودع المستلم",
    descriptionAr: "مطابقة الكميات الواردة وإدخالها في رصيد المستودع المستلم",
    sensitivity: "normal",
    legacyModule: "inventory",
  },
  {
    key: "inventory.stocktake.create",
    domain: "inventory",
    resource: "stocktake",
    action: "create",
    standardAction: "create",
    label: "إنشاء جلسة جرد دوري أو مفاجئ للمخزن",
    labelAr: "إنشاء جلسة جرد دوري أو مفاجئ للمخزن",
    description: "بدء جلسة جرد مخزني وتجميد أو حصر الأصناف الخاضعة للجرد",
    descriptionAr: "بدء جلسة جرد مخزني وتجميد أو حصر الأصناف الخاضعة للجرد",
    sensitivity: "normal",
    legacyModule: "inventory",
    sodGroup: "stocktake",
  },
  {
    key: "inventory.stocktake.record",
    domain: "inventory",
    resource: "stocktake",
    action: "record",
    standardAction: "edit",
    label: "مسح وإدخال الكميات المجرودة فعلياً",
    labelAr: "مسح وإدخال الكميات المجرودة فعلياً",
    description: "إدخال قراءات الباركود والأعداد الفعلية على أرض الواقع",
    descriptionAr: "إدخال قراءات الباركود والأعداد الفعلية على أرض الواقع",
    sensitivity: "normal",
    legacyModule: "inventory",
  },
  {
    key: "inventory.stocktake.approve",
    domain: "inventory",
    resource: "stocktake",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد نتائج ومحاضر الجرد النهائي",
    labelAr: "اعتماد نتائج ومحاضر الجرد النهائي",
    description: "الموافقة الرسمية على نتائج الجرد وحصر الفروقات الإجمالية",
    descriptionAr: "الموافقة الرسمية على نتائج الجرد وحصر الفروقات الإجمالية",
    sensitivity: "critical",
    legacyModule: "inventory",
    sodGroup: "stocktake",
  },
  {
    key: "inventory.adjustment.request",
    domain: "inventory",
    resource: "adjustment",
    action: "request",
    standardAction: "create",
    label: "طلب تسوية فروقات المخزون (عجز/زيادة)",
    labelAr: "طلب تسوية فروقات المخزون (عجز/زيادة)",
    description: "تقديم مذكرة تسوية لتعديل رصيد صنف بناءً على فحص أو جرد (Maker)",
    descriptionAr: "تقديم مذكرة تسوية لتعديل رصيد صنف بناءً على فحص أو جرد (Maker)",
    sensitivity: "medium",
    legacyModule: "inventory",
    sodGroup: "adjustment",
  },
  {
    key: "inventory.adjustment.approve",
    domain: "inventory",
    resource: "adjustment",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد تسوية الفروقات المخزنية وترحيلها",
    labelAr: "اعتماد تسوية الفروقات المخزنية وترحيلها",
    description: "المصادقة الإدارية وترحيل قيود الفروقات المخزنية إلى النظام (Checker)",
    descriptionAr: "المصادقة الإدارية وترحيل قيود الفروقات المخزنية إلى النظام (Checker)",
    sensitivity: "critical",
    legacyModule: "inventory",
    sodGroup: "adjustment",
  },
  {
    key: "inventory.scrap.write_off",
    domain: "inventory",
    resource: "scrap",
    action: "write_off",
    standardAction: "cancel",
    label: "إتلاف وشطب بضاعة راكدة أو تالفة",
    labelAr: "إتلاف وشطب بضاعة راكدة أو تالفة",
    description: "إخراج بضاعة تالفة نهائياً من العهدة وتحميل قيمتها لحساب التلف",
    descriptionAr: "إخراج بضاعة تالفة نهائياً من العهدة وتحميل قيمتها لحساب التلف",
    sensitivity: "critical",
    legacyModule: "inventory",
  },
  {
    key: "inventory.barcode.print",
    domain: "inventory",
    resource: "barcode",
    action: "print",
    standardAction: "print",
    label: "طباعة وتوليد باركودات الأصناف والرفوف",
    labelAr: "طباعة وتوليد باركودات الأصناف والرفوف",
    description: "طباعة ملصقات الباركود والأسعار ولواصق الرفوف على الطابعات المخصصة",
    descriptionAr: "طباعة ملصقات الباركود والأسعار ولواصق الرفوف على الطابعات المخصصة",
    sensitivity: "normal",
    legacyModule: "inventory",
  },

  // --------------------------------------------------------------------------
  // 5. purchasing (المشتريات والموردين والمطابقة الثلاثية)
  // --------------------------------------------------------------------------
  {
    key: "purchasing.supplier.view",
    domain: "purchasing",
    resource: "supplier",
    action: "view",
    standardAction: "view",
    label: "استعراض قائمة الموردين وسجلاتهم",
    labelAr: "استعراض قائمة الموردين وسجلاتهم",
    description: "معاينة ملفات الموردين والأرصدة القائمة وعناوينهم",
    descriptionAr: "معاينة ملفات الموردين والأرصدة القائمة وعناوينهم",
    sensitivity: "normal",
    legacyModule: "suppliers",
  },
  {
    key: "purchasing.supplier.create",
    domain: "purchasing",
    resource: "supplier",
    action: "create",
    standardAction: "create",
    label: "إضافة مورد جديد للنظام",
    labelAr: "إضافة مورد جديد للنظام",
    description: "فتح حساب مورد جديد وتسجيل بياناته التجارية وشروط الدفع",
    descriptionAr: "فتح حساب مورد جديد وتسجيل بياناته التجارية وشروط الدفع",
    sensitivity: "normal",
    legacyModule: "suppliers",
  },
  {
    key: "purchasing.supplier.update",
    domain: "purchasing",
    resource: "supplier",
    action: "update",
    standardAction: "edit",
    label: "تعديل بيانات مورد قائم",
    labelAr: "تعديل بيانات مورد قائم",
    description: "تحديث معلومات الاتصال، الحسابات المصرفية، أو شروط التعامل",
    descriptionAr: "تحديث معلومات الاتصال، الحسابات المصرفية، أو شروط التعامل",
    sensitivity: "medium",
    legacyModule: "suppliers",
  },
  {
    key: "purchasing.po.create",
    domain: "purchasing",
    resource: "po",
    action: "create",
    standardAction: "create",
    label: "إنشاء مسودة أمر شراء جديد",
    labelAr: "إنشاء مسودة أمر شراء جديد",
    description: "إعداد مسودة طلب شراء بضاعة أو مواد خام من مورد محدد",
    descriptionAr: "إعداد مسودة طلب شراء بضاعة أو مواد خام من مورد محدد",
    sensitivity: "normal",
    legacyModule: "purchases",
  },
  {
    key: "purchasing.po.confirm",
    domain: "purchasing",
    resource: "po",
    action: "confirm",
    standardAction: "approve",
    label: "اعتماد وإرسال أمر الشراء للمورد",
    labelAr: "اعتماد وإرسال أمر الشراء للمورد",
    description: "الموافقة الرسمية على أمر الشراء وتثبيته كالتزام تعاقدي مع المورد",
    descriptionAr: "الموافقة الرسمية على أمر الشراء وتثبيته كالتزام تعاقدي مع المورد",
    sensitivity: "medium",
    legacyModule: "purchases",
  },
  {
    key: "purchasing.po.print",
    domain: "purchasing",
    resource: "po",
    action: "print",
    standardAction: "print",
    label: "طباعة أمر الشراء الرسمي",
    labelAr: "طباعة أمر الشراء الرسمي",
    description: "طباعة نسخة أمر الشراء المعتمد لإرسالها للمورد",
    descriptionAr: "طباعة نسخة أمر الشراء المعتمد لإرسالها للمورد",
    sensitivity: "normal",
    legacyModule: "purchases",
  },
  {
    key: "purchasing.po.cancel",
    domain: "purchasing",
    resource: "po",
    action: "cancel",
    standardAction: "cancel",
    label: "إلغاء أمر شراء قائم",
    labelAr: "إلغاء أمر شراء قائم",
    description: "إلغاء أمر شراء قبل وصول البضاعة أو قبل تنفيذ الشحنة",
    descriptionAr: "إلغاء أمر شراء قبل وصول البضاعة أو قبل تنفيذ الشحنة",
    sensitivity: "medium",
    legacyModule: "purchases",
  },
  {
    key: "purchasing.grn.receive",
    domain: "purchasing",
    resource: "grn",
    action: "receive",
    standardAction: "create",
    label: "إثبات استلام الشحنة وإصدار إذن الاستلام",
    labelAr: "إثبات استلام الشحنة وإصدار إذن الاستلام",
    description: "توثيق وصول بضاعة الشراء للمخزن وإصدار مذكرة استلام بضاعة (GRN)",
    descriptionAr: "توثيق وصول بضاعة الشراء للمخزن وإصدار مذكرة استلام بضاعة (GRN)",
    sensitivity: "normal",
    legacyModule: "purchases",
  },
  {
    key: "purchasing.invoice.match",
    domain: "purchasing",
    resource: "invoice",
    action: "match",
    standardAction: "edit",
    label: "مطابقة فاتورة المورد مع إذن الاستلام والأمر",
    labelAr: "مطابقة فاتورة المورد مع إذن الاستلام والأمر",
    description: "إجراء المطابقة الثلاثية وإثبات فاتورة الشراء في ذمة المورد",
    descriptionAr: "إجراء المطابقة الثلاثية وإثبات فاتورة الشراء في ذمة المورد",
    sensitivity: "medium",
    legacyModule: "purchases",
  },
  {
    key: "purchasing.return.create",
    domain: "purchasing",
    resource: "return",
    action: "create",
    standardAction: "create",
    label: "إنشاء مرتجع بضاعة لمورد خارجي",
    labelAr: "إنشاء مرتجع بضاعة لمورد خارجي",
    description: "إرجاع بضاعة معيبة أو فائضة للمورد وإنشاء إشعار خصم على حسابه",
    descriptionAr: "إرجاع بضاعة معيبة أو فائضة للمورد وإنشاء إشعار خصم على حسابه",
    sensitivity: "medium",
    legacyModule: "purchases",
  },
  {
    key: "purchasing.payment.request",
    domain: "purchasing",
    resource: "payment",
    action: "request",
    standardAction: "create",
    label: "تقديم طلب سداد مستحقات مورد (Maker)",
    labelAr: "تقديم طلب سداد مستحقات مورد (Maker)",
    description: "طلب صرف دفعة مالية للمورد بناءً على فواتير مستحقة الدفع",
    descriptionAr: "طلب صرف دفعة مالية للمورد بناءً على فواتير مستحقة الدفع",
    sensitivity: "normal",
    legacyModule: "purchases",
    sodGroup: "purchasing_payment",
  },
  {
    key: "purchasing.payment.approve",
    domain: "purchasing",
    resource: "payment",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد صرف مستحقات المورد (Checker)",
    labelAr: "اعتماد صرف مستحقات المورد (Checker)",
    description: "المصادقة النهائية على سداد دفعة المورد وإحالتها للخزينة",
    descriptionAr: "المصادقة النهائية على سداد دفعة المورد وإحالتها للخزينة",
    sensitivity: "high",
    legacyModule: "treasury",
    sodGroup: "purchasing_payment",
  },

  // --------------------------------------------------------------------------
  // 6. treasury (الخزينة والمالية والسندات والمصروفات)
  // --------------------------------------------------------------------------
  {
    key: "treasury.cashbox.view",
    domain: "treasury",
    resource: "cashbox",
    action: "view",
    standardAction: "view",
    label: "استعراض أرصدة الخزائن والصناديق النقدية",
    labelAr: "استعراض أرصدة الخزائن والصناديق النقدية",
    description: "الاطلاع على النقد الفعلي المتوفر في الصناديق الرئيسية وحسابات البنوك",
    descriptionAr: "الاطلاع على النقد الفعلي المتوفر في الصناديق الرئيسية وحسابات البنوك",
    sensitivity: "normal",
    legacyModule: "treasury",
  },
  {
    key: "treasury.voucher_in.create",
    domain: "treasury",
    resource: "voucher_in",
    action: "create",
    standardAction: "create",
    label: "إصدار سند قبض نقدي أو تحويل بنكي",
    labelAr: "إصدار سند قبض نقدي أو تحويل بنكي",
    description: "استلام دفعة من عميل أو إيراد متنوع وإيداعها في الصندوق",
    descriptionAr: "استلام دفعة من عميل أو إيراد متنوع وإيداعها في الصندوق",
    sensitivity: "normal",
    legacyModule: "treasury",
  },
  {
    key: "treasury.voucher_in.cancel",
    domain: "treasury",
    resource: "voucher_in",
    action: "cancel",
    standardAction: "cancel",
    label: "إلغاء سند قبض معتمد",
    labelAr: "إلغاء سند قبض معتمد",
    description: "إلغاء سند قبض صادر وعكس أثره على رصيد الصندوق وكشف حساب العميل",
    descriptionAr: "إلغاء سند قبض صادر وعكس أثره على رصيد الصندوق وكشف حساب العميل",
    sensitivity: "high",
    legacyModule: "treasury",
  },
  {
    key: "treasury.voucher_out.create",
    domain: "treasury",
    resource: "voucher_out",
    action: "create",
    standardAction: "create",
    label: "إنشاء سند صرف نقدي أو بنكي (Maker)",
    labelAr: "إنشاء سند صرف نقدي أو بنكي (Maker)",
    description: "إعداد سند دفع نقدية أو شيك لمورد أو جهة خارجية ضمن السقف المسموح",
    descriptionAr: "إعداد سند دفع نقدية أو شيك لمورد أو جهة خارجية ضمن السقف المسموح",
    sensitivity: "medium",
    legacyModule: "treasury",
    sodGroup: "voucher",
  },
  {
    key: "treasury.voucher_out.approve",
    domain: "treasury",
    resource: "voucher_out",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد سند الصرف وإطلاق النقدية (Checker)",
    labelAr: "اعتماد سند الصرف وإطلاق النقدية (Checker)",
    description: "المصادقة الإدارية على صرف السند وخروج النقدية من الخزينة",
    descriptionAr: "المصادقة الإدارية على صرف السند وخروج النقدية من الخزينة",
    sensitivity: "high",
    legacyModule: "treasury",
    sodGroup: "voucher",
  },
  {
    key: "treasury.voucher.print",
    domain: "treasury",
    resource: "voucher",
    action: "print",
    standardAction: "print",
    label: "طباعة سند القبض أو الصرف",
    labelAr: "طباعة سند القبض أو الصرف",
    description: "طباعة إيصال السند الرسمي للأطراف المستلمة أو المسلمة",
    descriptionAr: "طباعة إيصال السند الرسمي للأطراف المستلمة أو المسلمة",
    sensitivity: "normal",
    legacyModule: "treasury",
  },
  {
    key: "treasury.expense.create",
    domain: "treasury",
    resource: "expense",
    action: "create",
    standardAction: "create",
    label: "تسجيل مصروف تشغيلي يومي",
    labelAr: "تسجيل مصروف تشغيلي يومي",
    description: "إثبات بند نثريات أو وقود أو صيانة طارئة ضمن سقف المصاريف",
    descriptionAr: "إثبات بند نثريات أو وقود أو صيانة طارئة ضمن سقف المصاريف",
    sensitivity: "normal",
    legacyModule: "expenses",
    sodGroup: "expenses",
  },
  {
    key: "treasury.expense.approve",
    domain: "treasury",
    resource: "expense",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد المصروف اليومي",
    labelAr: "اعتماد المصروف اليومي",
    description: "الموافقة المحاسبية على صحة وتبرير المصروف التشغيلي وترحيله",
    descriptionAr: "الموافقة المحاسبية على صحة وتبرير المصروف التشغيلي وترحيله",
    sensitivity: "medium",
    legacyModule: "expenses",
    sodGroup: "expenses",
  },
  {
    key: "treasury.transfer.execute",
    domain: "treasury",
    resource: "transfer",
    action: "execute",
    standardAction: "approve",
    label: "تحويل نقد بين الخزائن والحسابات المصرفية",
    labelAr: "تحويل نقد بين الخزائن والحسابات المصرفية",
    description: "نقل سيولة نقدية بين الصناديق الفرعية أو الإيداع في الحسابات البنكية",
    descriptionAr: "نقل سيولة نقدية بين الصناديق الفرعية أو الإيداع في الحسابات البنكية",
    sensitivity: "high",
    legacyModule: "treasury",
  },
  {
    key: "treasury.shift.reconcile",
    domain: "treasury",
    resource: "shift",
    action: "reconcile",
    standardAction: "approve",
    label: "توريد نقدية ورديات الكاشير للخزينة الرئيسية",
    labelAr: "توريد نقدية ورديات الكاشير للخزينة الرئيسية",
    description: "استلام وتدقيق حصيلة ورديات الكاشير وإيداعها في القاصة المركزية",
    descriptionAr: "استلام وتدقيق حصيلة ورديات الكاشير وإيداعها في القاصة المركزية",
    sensitivity: "normal",
    legacyModule: "treasury",
  },
  {
    key: "treasury.period.lock",
    domain: "treasury",
    resource: "period",
    action: "lock",
    standardAction: "approve",
    label: "إقفال الشهر المالي أو السنة المحاسبية",
    labelAr: "إقفال الشهر المالي أو السنة المحاسبية",
    description: "إغلاق الفترة المحاسبية ومنع أي تعديل أو إضافة على القيود السابقة",
    descriptionAr: "إغلاق الفترة المحاسبية ومنع أي تعديل أو إضافة على القيود السابقة",
    sensitivity: "critical",
    legacyModule: "treasury",
  },
  {
    key: "treasury.period.unlock",
    domain: "treasury",
    resource: "period",
    action: "unlock",
    standardAction: "approve",
    label: "إعادة فتح فترة محاسبية مقفلة",
    labelAr: "إعادة فتح فترة محاسبية مقفلة",
    description: "إلغاء قفل الفترة المحاسبية للقيام بتسويات استثنائية (صلاحية سيادية)",
    descriptionAr: "إلغاء قفل الفترة المحاسبية للقيام بتسويات استثنائية (صلاحية سيادية)",
    sensitivity: "critical",
    legacyModule: "treasury",
  },

  // --------------------------------------------------------------------------
  // 7. fieldsales (المبيعات الميدانية والشركات والتعاقدات)
  // --------------------------------------------------------------------------
  {
    key: "fieldsales.visit.record",
    domain: "fieldsales",
    resource: "visit",
    action: "record",
    standardAction: "create",
    label: "توثيق زيارة عميل ميداني والموقع الجغرافي",
    labelAr: "توثيق زيارة عميل ميداني والموقع الجغرافي",
    description: "تسجيل تقرير الزيارة الميدانية مع الإحداثيات وملاحظات العميل",
    descriptionAr: "تسجيل تقرير الزيارة الميدانية مع الإحداثيات وملاحظات العميل",
    sensitivity: "normal",
    legacyModule: "crm",
  },
  {
    key: "fieldsales.quote.create",
    domain: "fieldsales",
    resource: "quote",
    action: "create",
    standardAction: "create",
    label: "إنشاء عرض سعر مخصص لعميل تجاري أو شركة",
    labelAr: "إنشاء عرض سعر مخصص لعميل تجاري أو شركة",
    description: "إعداد عرض أسعار تفاوضي لصفقة تجارية أو مناقصة",
    descriptionAr: "إعداد عرض أسعار تفاوضي لصفقة تجارية أو مناقصة",
    sensitivity: "normal",
    legacyModule: "sales",
  },
  {
    key: "fieldsales.quote.discount",
    domain: "fieldsales",
    resource: "quote",
    action: "discount",
    standardAction: "edit",
    label: "تطبيق خصم تفاوضي لعميل ميداني",
    labelAr: "تطبيق خصم تفاوضي لعميل ميداني",
    description: "منح نسبة خصم تجارية ضمن السقف المتاح لمندوب المبيعات",
    descriptionAr: "منح نسبة خصم تجارية ضمن السقف المتاح لمندوب المبيعات",
    sensitivity: "medium",
    legacyModule: "sales",
  },
  {
    key: "fieldsales.order.submit",
    domain: "fieldsales",
    resource: "order",
    action: "submit",
    standardAction: "create",
    label: "تثبيت طلبية مبيعات خارجية للمستودع",
    labelAr: "تثبيت طلبية مبيعات خارجية للمستودع",
    description: "إرسال طلبية مؤكدة من الميدان لتجهيزها وشحنها من المستودع",
    descriptionAr: "إرسال طلبية مؤكدة من الميدان لتجهيزها وشحنها من المستودع",
    sensitivity: "normal",
    legacyModule: "sales",
  },
  {
    key: "fieldsales.customer.create",
    domain: "fieldsales",
    resource: "customer",
    action: "create",
    standardAction: "create",
    label: "تسجيل عميل تجاري جديد في الميدان",
    labelAr: "تسجيل عميل تجاري جديد في الميدان",
    description: "فتح سجل لشركة أو مكتبة جديدة مع تحديد الموقع والسجل التجاري",
    descriptionAr: "فتح سجل لشركة أو مكتبة جديدة مع تحديد الموقع والسجل التجاري",
    sensitivity: "normal",
    legacyModule: "crm",
  },
  {
    key: "fieldsales.statement.view",
    domain: "fieldsales",
    resource: "statement",
    action: "view",
    standardAction: "view",
    label: "استعراض كشف حساب ورصيد العميل الميداني",
    labelAr: "استعراض كشف حساب ورصيد العميل الميداني",
    description: "الاطلاع على الذمم والديون السابقة وفواتير العميل قبل البيع الآجل",
    descriptionAr: "الاطلاع على الذمم والديون السابقة وفواتير العميل قبل البيع الآجل",
    sensitivity: "normal",
    legacyModule: "collections",
  },
  {
    key: "fieldsales.price_tier.view",
    domain: "fieldsales",
    resource: "price_tier",
    action: "view",
    standardAction: "view",
    label: "استعراض فئات أسعار الجملة والشركات",
    labelAr: "استعراض فئات أسعار الجملة والشركات",
    description: "معاينة لوائح أسعار الجملة، التوزيع، والجهات الحكومية",
    descriptionAr: "معاينة لوائح أسعار الجملة، التوزيع، والجهات الحكومية",
    sensitivity: "normal",
    legacyModule: "products",
  },

  // --------------------------------------------------------------------------
  // 8. delivery (اللوجستيات والتوصيل وتحصيل الـCOD)
  // --------------------------------------------------------------------------
  {
    key: "delivery.dispatch.create",
    domain: "delivery",
    resource: "dispatch",
    action: "create",
    standardAction: "create",
    label: "ترحيل وتوزيع الطرود على المناديب",
    labelAr: "ترحيل وتوزيع الطرود على المناديب",
    description: "إسناد الشحنات والطرود لمناديب التوصيل حسب المناطق وخطوط السير",
    descriptionAr: "إسناد الشحنات والطرود لمناديب التوصيل حسب المناطق وخطوط السير",
    sensitivity: "normal",
    legacyModule: "courier",
  },
  {
    key: "delivery.parcel.view",
    domain: "delivery",
    resource: "parcel",
    action: "view",
    standardAction: "view",
    label: "متابعة شحنات وطرود التوصيل الحالية",
    labelAr: "متابعة شحنات وطرود التوصيل الحالية",
    description: "متابعة مسار الطرود، حالة التوصيل، وتحديثات المستلمين",
    descriptionAr: "متابعة مسار الطرود، حالة التوصيل، وتحديثات المستلمين",
    sensitivity: "normal",
    legacyModule: "courier",
  },
  {
    key: "delivery.proof.confirm",
    domain: "delivery",
    resource: "proof",
    action: "confirm",
    standardAction: "approve",
    label: "تسجيل نجاح تسليم الطلب للعميل",
    labelAr: "تسجيل نجاح تسليم الطلب للعميل",
    description: "توثيق استلام العميل للطلب وإثبات توقيعه أو رمز التسليم",
    descriptionAr: "توثيق استلام العميل للطلب وإثبات توقيعه أو رمز التسليم",
    sensitivity: "normal",
    legacyModule: "courier",
  },
  {
    key: "delivery.proof.partial",
    domain: "delivery",
    resource: "proof",
    action: "partial",
    standardAction: "edit",
    label: "تسجيل تسليم جزئي وإعادة بنود مرتجعة",
    labelAr: "تسجيل تسليم جزئي وإعادة بنود مرتجعة",
    description: "تسليم جزء من الطلبية وإرجاع البنود المتبقية لمخزن الإرجاع",
    descriptionAr: "تسليم جزء من الطلبية وإرجاع البنود المتبقية لمخزن الإرجاع",
    sensitivity: "medium",
    legacyModule: "courier",
  },
  {
    key: "delivery.failure.record",
    domain: "delivery",
    resource: "failure",
    action: "record",
    standardAction: "cancel",
    label: "توثيق تعذر التسليم وسبب الإرجاع",
    labelAr: "توثيق تعذر التسليم وسبب الإرجاع",
    description: "إثبات عدم التمكن من التسليم (رفض العميل، عنوان خاطئ، إغلاق)",
    descriptionAr: "إثبات عدم التمكن من التسليم (رفض العميل، عنوان خاطئ، إغلاق)",
    sensitivity: "normal",
    legacyModule: "courier",
  },
  {
    key: "delivery.cod.settle",
    domain: "delivery",
    resource: "cod",
    action: "settle",
    standardAction: "approve",
    label: "استلام وتوريد مبالغ الـCOD من المندوب",
    labelAr: "استلام وتوريد مبالغ الـCOD من المندوب",
    description: "استلام مبالغ الدفع عند الاستلام من المندوب وإيداعها في الصندوق",
    descriptionAr: "استلام مبالغ الدفع عند الاستلام من المندوب وإيداعها في الصندوق",
    sensitivity: "normal",
    legacyModule: "treasury",
  },
  {
    key: "delivery.shortfall.assign",
    domain: "delivery",
    resource: "shortfall",
    action: "assign",
    standardAction: "create",
    label: "تقييد عجز التحصيل كذمة على المندوب",
    labelAr: "تقييد عجز التحصيل كذمة على المندوب",
    description: "إثبات نقص التحصيل أو فقدان البضاعة كذمة مالية مستحقة على المندوب",
    descriptionAr: "إثبات نقص التحصيل أو فقدان البضاعة كذمة مالية مستحقة على المندوب",
    sensitivity: "medium",
    legacyModule: "collections",
  },
  {
    key: "delivery.shortfall.write_off",
    domain: "delivery",
    resource: "shortfall",
    action: "write_off",
    standardAction: "cancel",
    label: "شطب أو إعفاء عجز مالي لمندوب",
    labelAr: "شطب أو إعفاء عجز مالي لمندوب",
    description: "إسقاط الذمة المالية أو العجز الناتج عن قوة قاهرة بموافقة الإدارة",
    descriptionAr: "إسقاط الذمة المالية أو العجز الناتج عن قوة قاهرة بموافقة الإدارة",
    sensitivity: "critical",
    legacyModule: "treasury",
  },

  // --------------------------------------------------------------------------
  // 9. hr (الموارد البشرية والرواتب والدوام والعمولات)
  // --------------------------------------------------------------------------
  {
    key: "hr.employee.view",
    domain: "hr",
    resource: "employee",
    action: "view",
    standardAction: "view",
    label: "استعراض قائمة الموظفين والملفات الشخصية",
    labelAr: "استعراض قائمة الموظفين والملفات الشخصية",
    description: "الاطلاع على الهيكل الوظيفي، بيانات الاتصال، وسجلات العمل",
    descriptionAr: "الاطلاع على الهيكل الوظيفي، بيانات الاتصال، وسجلات العمل",
    sensitivity: "normal",
    legacyModule: "hr",
  },
  {
    key: "hr.employee.manage",
    domain: "hr",
    resource: "employee",
    action: "manage",
    standardAction: "edit",
    label: "إضافة وتعديل بيانات الموظفين والعقود",
    labelAr: "إضافة وتعديل بيانات الموظفين والعقود",
    description: "تعديل العقود، الرواتب الأساسية، البدلات، والمسميات الوظيفية",
    descriptionAr: "تعديل العقود، الرواتب الأساسية، البدلات، والمسميات الوظيفية",
    sensitivity: "medium",
    legacyModule: "hr",
  },
  {
    key: "hr.attendance.record",
    domain: "hr",
    resource: "attendance",
    action: "record",
    standardAction: "create",
    label: "تسجيل الحضور والانصراف والبصمات",
    labelAr: "تسجيل الحضور والانصراف والبصمات",
    description: "تسجيل أوقات الحضور اليومي والانصراف اليدوي أو الآلي",
    descriptionAr: "تسجيل أوقات الحضور اليومي والانصراف اليدوي أو الآلي",
    sensitivity: "normal",
    legacyModule: "hr",
  },
  {
    key: "hr.attendance.adjust",
    domain: "hr",
    resource: "attendance",
    action: "adjust",
    standardAction: "edit",
    label: "تعديل ساعات الدوام وتبرير التأخير والغياب",
    labelAr: "تعديل ساعات الدوام وتبرير التأخير والغياب",
    description: "تصحيح سجلات الحضور وإضافة أذونات المغادرة أو العمل الإضافي",
    descriptionAr: "تصحيح سجلات الحضور وإضافة أذونات المغادرة أو العمل الإضافي",
    sensitivity: "medium",
    legacyModule: "hr",
  },
  {
    key: "hr.leave.approve",
    domain: "hr",
    resource: "leave",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد الإجازات والمغادرات الإدارية",
    labelAr: "اعتماد الإجازات والمغادرات الإدارية",
    description: "الموافقة الرسمية على طلبات الإجازات السنوية والمرضية والاضطرارية",
    descriptionAr: "الموافقة الرسمية على طلبات الإجازات السنوية والمرضية والاضطرارية",
    sensitivity: "normal",
    legacyModule: "hr",
  },
  {
    key: "hr.payroll.compute",
    domain: "hr",
    resource: "payroll",
    action: "compute",
    standardAction: "create",
    label: "احتساب مسير الرواتب والاستحقاقات والخصميات",
    labelAr: "احتساب مسير الرواتب والاستحقاقات والخصميات",
    description: "توليد مسير الرواتب الشهري واحتساب ساعات الدوام والخصومات (Maker)",
    descriptionAr: "توليد مسير الرواتب الشهري واحتساب ساعات الدوام والخصومات (Maker)",
    sensitivity: "medium",
    legacyModule: "hr",
    sodGroup: "payroll",
  },
  {
    key: "hr.payroll.approve",
    domain: "hr",
    resource: "payroll",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد مسير الرواتب الشهري النهائي",
    labelAr: "اعتماد مسير الرواتب الشهري النهائي",
    description: "المصادقة الإدارية العليا على جدول الرواتب وصافي المستحقات (Checker)",
    descriptionAr: "المصادقة الإدارية العليا على جدول الرواتب وصافي المستحقات (Checker)",
    sensitivity: "high",
    legacyModule: "hr",
    sodGroup: "payroll",
  },
  {
    key: "hr.payroll.disburse",
    domain: "hr",
    resource: "payroll",
    action: "disburse",
    standardAction: "approve",
    label: "صرف الرواتب وتوليد قيودها المحاسبية",
    labelAr: "صرف الرواتب وتوليد قيودها المحاسبية",
    description: "تحويل الرواتب لحسابات الموظفين وإطلاق قيود الصرف المحاسبية",
    descriptionAr: "تحويل الرواتب لحسابات الموظفين وإطلاق قيود الصرف المحاسبية",
    sensitivity: "critical",
    legacyModule: "treasury",
  },
  {
    key: "hr.commission.compute",
    domain: "hr",
    resource: "commission",
    action: "compute",
    standardAction: "create",
    label: "احتساب عمولات البائعين والمناديب",
    labelAr: "احتساب عمولات البائعين والمناديب",
    description: "حساب العمولات والمكافآت الشهرية بناءً على الأهداف المحققة (Maker)",
    descriptionAr: "حساب العمولات والمكافآت الشهرية بناءً على الأهداف المحققة (Maker)",
    sensitivity: "normal",
    legacyModule: "commissions",
    sodGroup: "commissions",
  },
  {
    key: "hr.commission.approve",
    domain: "hr",
    resource: "commission",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد صرف عمولات المبيعات",
    labelAr: "اعتماد صرف عمولات المبيعات",
    description: "المصادقة على صرف العمولات وإضافتها لمسير الرواتب (Checker)",
    descriptionAr: "المصادقة على صرف العمولات وإضافتها لمسير الرواتب (Checker)",
    sensitivity: "high",
    legacyModule: "commissions",
    sodGroup: "commissions",
  },

  // --------------------------------------------------------------------------
  // 10. governance (الإدارة العامة والتدقيق الأمني والسياسات الحاكمة)
  // --------------------------------------------------------------------------
  {
    key: "governance.audit.view",
    domain: "governance",
    resource: "audit",
    action: "view",
    standardAction: "view",
    label: "استعراض سجل الرقابة والتدقيق الأمني الشامل",
    labelAr: "استعراض سجل الرقابة والتدقيق الأمني الشامل",
    description: "الاطلاع على سجل الأحداث وحركات النظام وتتبع الفاعلين بالتاريخ والساعة",
    descriptionAr: "الاطلاع على سجل الأحداث وحركات النظام وتتبع الفاعلين بالتاريخ والساعة",
    sensitivity: "normal",
    legacyModule: "settings",
  },
  {
    key: "governance.audit.export",
    domain: "governance",
    resource: "audit",
    action: "export",
    standardAction: "export",
    label: "تصدير سجلات التدقيق والعمليات",
    labelAr: "تصدير سجلات التدقيق والعمليات",
    description: "استخراج ملفات سجل التدقيق للجهات الرقابية والمراجعين الخارجيين",
    descriptionAr: "استخراج ملفات سجل التدقيق للجهات الرقابية والمراجعين الخارجيين",
    sensitivity: "critical",
    legacyModule: "settings",
  },
  {
    key: "governance.user.manage",
    domain: "governance",
    resource: "user",
    action: "manage",
    standardAction: "edit",
    label: "إدارة الحسابات (إضافة، تعديل، تجميد)",
    labelAr: "إدارة الحسابات (إضافة، تعديل، تجميد)",
    description: "إنشاء مستخدمين جدد، تغيير حالتهم، وربطهم بالفروع والأدوار",
    descriptionAr: "إنشاء مستخدمين جدد، تغيير حالتهم، وربطهم بالفروع والأدوار",
    sensitivity: "high",
    legacyModule: "users",
  },
  {
    key: "governance.user.reset_security",
    domain: "governance",
    resource: "user",
    action: "reset_security",
    standardAction: "edit",
    label: "تصفير كلمات المرور أو إلغاء 2FA",
    labelAr: "تصفير كلمات المرور أو إلغاء 2FA",
    description: "إعادة ضبط بيانات الدخول وتصفير مفاتيح المصادقة الثنائية للمستخدمين",
    descriptionAr: "إعادة ضبط بيانات الدخول وتصفير مفاتيح المصادقة الثنائية للمستخدمين",
    sensitivity: "high",
    legacyModule: "users",
  },
  {
    key: "governance.role.manage",
    domain: "governance",
    resource: "role",
    action: "manage",
    standardAction: "edit",
    label: "ضبط وتعديل الأدوار ومصفوفة الصلاحيات",
    labelAr: "ضبط وتعديل الأدوار ومصفوفة الصلاحيات",
    description: "تعديل قوالب الأدوار المخصصة وشجرة الصلاحيات والسقوف التشغيلية",
    descriptionAr: "تعديل قوالب الأدوار المخصصة وشجرة الصلاحيات والسقوف التشغيلية",
    sensitivity: "critical",
    legacyModule: "users",
  },
  {
    key: "governance.branch.manage",
    domain: "governance",
    resource: "branch",
    action: "manage",
    standardAction: "edit",
    label: "إدارة الفروع وتراخيصها وإعداداتها",
    labelAr: "إدارة الفروع وتراخيصها وإعداداتها",
    description: "تهيئة فروع الشركة، بياناتها القانونية، وإعدادات الربط الشبكي",
    descriptionAr: "إدارة فروع الشركة، بياناتها القانونية، وإعدادات الربط الشبكي",
    sensitivity: "high",
    legacyModule: "settings",
  },
  {
    key: "governance.settings.manage",
    domain: "governance",
    resource: "settings",
    action: "manage",
    standardAction: "edit",
    label: "تعديل إعدادات النظام الحاكمة وسياساته",
    labelAr: "تعديل إعدادات النظام الحاكمة وسياساته",
    description: "التحكم في سياسات النظام، أسعار الصرف، خوادم الطباعة، والتكاملات",
    descriptionAr: "التحكم في سياسات النظام، أسعار الصرف، خوادم الطباعة، والتكاملات",
    sensitivity: "critical",
    legacyModule: "settings",
  },
  {
    key: "governance.executive.view_kpi",
    domain: "governance",
    resource: "executive",
    action: "view_kpi",
    standardAction: "view",
    label: "لوحة القيادة والمؤشرات التنفيذية العليا",
    labelAr: "لوحة القيادة والمؤشرات التنفيذية العليا",
    description: "عرض مؤشرات الأداء الإجمالية، المبيعات الكلية، ونسب النمو",
    descriptionAr: "عرض مؤشرات الأداء الإجمالية، المبيعات الكلية، ونسب النمو",
    sensitivity: "normal",
    legacyModule: "reports",
  },
  {
    key: "governance.cost_margin.view",
    domain: "governance",
    resource: "cost_margin",
    action: "view",
    standardAction: "view",
    label: "رؤية التكاليف الحقيقية وهامش الربح الصافي",
    labelAr: "رؤية التكاليف الحقيقية وهامش الربح الصافي",
    description: "كشف تكاليف الشراء وهامش الربح في الفواتير والتقارير والمنتجات",
    descriptionAr: "كشف تكاليف الشراء وهامش الربح في الفواتير والتقارير والمنتجات",
    sensitivity: "high",
    legacyModule: "reports",
  },
  {
    key: "governance.limit.override",
    domain: "governance",
    resource: "limit",
    action: "override",
    standardAction: "approve",
    label: "تجاوز السقوف التشغيلية للحسابات (Break-glass)",
    labelAr: "تجاوز السقوف التشغيلية للحسابات (Break-glass)",
    description: "إجازة العمليات الاستثنائية التي تتجاوز السقوف الرقمية المحددة",
    descriptionAr: "إجازة العمليات الاستثنائية التي تتجاوز السقوف الرقمية المحددة",
    sensitivity: "critical",
    legacyModule: "settings",
  },
  // --- Additional Enterprise Definitions ---
  {
    key: "pos.shift.view",
    domain: "pos",
    resource: "shift",
    action: "view",
    standardAction: "view",
    label: "استعراض سجل الورديات السابقة",
    labelAr: "استعراض سجل الورديات السابقة",
    description: "عرض تفاصيل وأرصدة ومبيعات الورديات السابقة في الفرع",
    descriptionAr: "عرض تفاصيل وأرصدة ومبيعات الورديات السابقة في الفرع",
    sensitivity: "normal",
    legacyModule: "pos",
      },
  {
    key: "pos.shift.print",
    domain: "pos",
    resource: "shift",
    action: "print",
    standardAction: "print",
    label: "طباعة تقرير الوردية وجرد النقدية Z-Report",
    labelAr: "طباعة تقرير الوردية وجرد النقدية Z-Report",
    description: "طباعة ملخص مبيعات الوردية والتصفيات النقدية والشبكة",
    descriptionAr: "طباعة ملخص مبيعات الوردية والتصفيات النقدية والشبكة",
    sensitivity: "normal",
    legacyModule: "pos",
      },
  {
    key: "pos.shift.variance_approve",
    domain: "pos",
    resource: "shift",
    action: "variance_approve",
    standardAction: "approve",
    label: "اعتماد فروقات العجز والزيادة النقدية بالوردية",
    labelAr: "اعتماد فروقات العجز والزيادة النقدية بالوردية",
    description: "الموافقة الإدارية على فروقات الصندوق وترحيلها محاسبياً",
    descriptionAr: "الموافقة الإدارية على فروقات الصندوق وترحيلها محاسبياً",
    sensitivity: "high",
    legacyModule: "pos",
    isSpecialOperation: true,
  },
  {
    key: "pos.invoice.edit",
    domain: "pos",
    resource: "invoice",
    action: "edit",
    standardAction: "edit",
    label: "تعديل بنود الفاتورة المفتوحة قبل الدفع",
    labelAr: "تعديل بنود الفاتورة المفتوحة قبل الدفع",
    description: "إضافة أو حذف كميات وتعديل بنود السلة في الفاتورة الجارية",
    descriptionAr: "إضافة أو حذف كميات وتعديل بنود السلة في الفاتورة الجارية",
    sensitivity: "normal",
    legacyModule: "sales",
      },
  {
    key: "pos.invoice.approve",
    domain: "pos",
    resource: "invoice",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد الفواتير الاستثنائية والآجلة",
    labelAr: "اعتماد الفواتير الاستثنائية والآجلة",
    description: "اعتماد الفواتير التي تتطلب موافقة مشرف المبيعات أو البيع الآجل",
    descriptionAr: "اعتماد الفواتير التي تتطلب موافقة مشرف المبيعات أو البيع الآجل",
    sensitivity: "high",
    legacyModule: "sales",
    isSpecialOperation: true,
  },
  {
    key: "pos.return.view",
    domain: "pos",
    resource: "return",
    action: "view",
    standardAction: "view",
    label: "استعراض سجل المرتجعات",
    labelAr: "استعراض سجل المرتجعات",
    description: "عرض وتتبع طلبات وفواتير مرتجع المبيعات في نقطة البيع",
    descriptionAr: "عرض وتتبع طلبات وفواتير مرتجع المبيعات في نقطة البيع",
    sensitivity: "normal",
    legacyModule: "sales",
      },
  {
    key: "pos.return.no_invoice",
    domain: "pos",
    resource: "return",
    action: "no_invoice",
    standardAction: "create",
    label: "إصدار مرتجع بدون أصل فاتورة",
    labelAr: "إصدار مرتجع بدون أصل فاتورة",
    description: "استرجاع بضاعة نقدية من العميل دون تقديم رقم الفاتورة الأصلية",
    descriptionAr: "استرجاع بضاعة نقدية من العميل دون تقديم رقم الفاتورة الأصلية",
    sensitivity: "high",
    legacyModule: "sales",
    isSpecialOperation: true,
  },
  {
    key: "pos.return.exchange",
    domain: "pos",
    resource: "return",
    action: "exchange",
    standardAction: "edit",
    label: "إجراء استبدال أصناف المبيعات",
    labelAr: "إجراء استبدال أصناف المبيعات",
    description: "استبدال صنف بآخر مع احتساب ودفع أو رد فرق السعر مباشرة",
    descriptionAr: "استبدال صنف بآخر مع احتساب ودفع أو رد فرق السعر مباشرة",
    sensitivity: "medium",
    legacyModule: "sales",
      },
  {
    key: "pos.return.approve",
    domain: "pos",
    resource: "return",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد استرجاع المبالغ فوق السقف المسموح",
    labelAr: "اعتماد استرجاع المبالغ فوق السقف المسموح",
    description: "الموافقة على صرف مبالغ المرتجعات الكبيرة التي تتجاوز سقف الكاشير",
    descriptionAr: "الموافقة على صرف مبالغ المرتجعات الكبيرة التي تتجاوز سقف الكاشير",
    sensitivity: "high",
    legacyModule: "sales",
    isSpecialOperation: true,
  },
  {
    key: "pos.return.cancel",
    domain: "pos",
    resource: "return",
    action: "cancel",
    standardAction: "cancel",
    label: "إلغاء طلب المرتجع واستعادة الفاتورة",
    labelAr: "إلغاء طلب المرتجع واستعادة الفاتورة",
    description: "إلغاء إجراء الإرجاع وعكس القيود المخزنية والمالية المترتبة",
    descriptionAr: "إلغاء إجراء الإرجاع وعكس القيود المخزنية والمالية المترتبة",
    sensitivity: "high",
    legacyModule: "sales",
      },
  {
    key: "pos.discount.override",
    domain: "pos",
    resource: "discount",
    action: "override",
    standardAction: "approve",
    label: "تجاوز السقف الأقصى لخصم نقطة البيع",
    labelAr: "تجاوز السقف الأقصى لخصم نقطة البيع",
    description: "منح خصم تجاري أعلى من النسبة أو المبلغ المصرح به للكاشير",
    descriptionAr: "منح خصم تجاري أعلى من النسبة أو المبلغ المصرح به للكاشير",
    sensitivity: "critical",
    legacyModule: "sales",
    isSpecialOperation: true,
  },
  {
    key: "pos.digital_card.view",
    domain: "pos",
    resource: "digital_card",
    action: "view",
    standardAction: "view",
    label: "استعراض أرصدة وبطاقات الخدمات الرقمية",
    labelAr: "استعراض أرصدة وبطاقات الخدمات الرقمية",
    description: "عرض المخزون الرقمي لبطاقات الإنترنت والشحن والألعاب",
    descriptionAr: "عرض المخزون الرقمي لبطاقات الإنترنت والشحن والألعاب",
    sensitivity: "normal",
    legacyModule: "digital_cards",
      },
  {
    key: "pos.digital_card.print",
    domain: "pos",
    resource: "digital_card",
    action: "print",
    standardAction: "print",
    label: "طباعة كود وبيانات البطاقة الرقمية للعميل",
    labelAr: "طباعة كود وبيانات البطاقة الرقمية للعميل",
    description: "إصدار وطباعة إيصال يحتوي الرقم السري وكود التعبئة للبطاقة",
    descriptionAr: "إصدار وطباعة إيصال يحتوي الرقم السري وكود التعبئة للبطاقة",
    sensitivity: "medium",
    legacyModule: "digital_cards",
      },
  {
    key: "pos.operations.hold",
    domain: "pos",
    resource: "operations",
    action: "hold",
    standardAction: "edit",
    label: "تعليق واسترجاع الفواتير المفتوحة",
    labelAr: "تعليق واسترجاع الفواتير المفتوحة",
    description: "حفظ سلة عميل مؤقتاً لخدمة عميل آخر ثم استرجاعها لاحقاً",
    descriptionAr: "حفظ سلة عميل مؤقتاً لخدمة عميل آخر ثم استرجاعها لاحقاً",
    sensitivity: "normal",
    legacyModule: "sales",
      },
  {
    key: "pos.operations.split",
    domain: "pos",
    resource: "operations",
    action: "split",
    standardAction: "edit",
    label: "تقسيم الفاتورة وتعدد طرق الدفع",
    labelAr: "تقسيم الفاتورة وتعدد طرق الدفع",
    description: "تجزئة حساب الفاتورة بين نقد وشبكة أو بين عدة أطراف",
    descriptionAr: "تجزئة حساب الفاتورة بين نقد وشبكة أو بين عدة أطراف",
    sensitivity: "normal",
    legacyModule: "sales",
      },
  {
    key: "pos.operations.credit",
    domain: "pos",
    resource: "operations",
    action: "credit",
    standardAction: "create",
    label: "البيع الآجل على الحساب من نقطة البيع",
    labelAr: "البيع الآجل على الحساب من نقطة البيع",
    description: "ترحيل قيمة الفاتورة على حساب عميل آجل مسجل بالنظام",
    descriptionAr: "ترحيل قيمة الفاتورة على حساب عميل آجل مسجل بالنظام",
    sensitivity: "high",
    legacyModule: "sales",
    isSpecialOperation: true,
  },
  {
    key: "reception.deposit.refund",
    domain: "reception",
    resource: "deposit",
    action: "refund",
    standardAction: "cancel",
    label: "استرداد أو إلغاء العربون المقدم",
    labelAr: "استرداد أو إلغاء العربون المقدم",
    description: "إلغاء سند قبض العربون ورد المبلغ للعميل عند إلغاء الطلب",
    descriptionAr: "إلغاء سند قبض العربون ورد المبلغ للعميل عند إلغاء الطلب",
    sensitivity: "high",
    legacyModule: "workorders",
    isSpecialOperation: true,
  },
  {
    key: "reception.proof.view",
    domain: "reception",
    resource: "proof",
    action: "view",
    standardAction: "view",
    label: "استعراض بروفات وتصاميم أمر الشغل",
    labelAr: "استعراض بروفات وتصاميم أمر الشغل",
    description: "معاينة الملفات الفنية ونماذج التصميم المرفوعة لأمر الشغل",
    descriptionAr: "معاينة الملفات الفنية ونماذج التصميم المرفوعة لأمر الشغل",
    sensitivity: "normal",
    legacyModule: "workorders",
      },
  {
    key: "reception.quote.view",
    domain: "reception",
    resource: "quote",
    action: "view",
    standardAction: "view",
    label: "استعراض عروض أسعار الاستقبال",
    labelAr: "استعراض عروض أسعار الاستقبال",
    description: "عرض قائمة عروض الأسعار الصادرة من قسم الاستقبال",
    descriptionAr: "عرض قائمة عروض الأسعار الصادرة من قسم الاستقبال",
    sensitivity: "normal",
    legacyModule: "workorders",
      },
  {
    key: "reception.quote.print",
    domain: "reception",
    resource: "quote",
    action: "print",
    standardAction: "print",
    label: "طباعة وتصدير عرض سعر الاستقبال",
    labelAr: "طباعة وتصدير عرض سعر الاستقبال",
    description: "طباعة نسخة ورقية رسمية لعرض السعر لتسليمها للعميل",
    descriptionAr: "طباعة نسخة ورقية رسمية لعرض السعر لتسليمها للعميل",
    sensitivity: "normal",
    legacyModule: "workorders",
      },
  {
    key: "reception.customer.view",
    domain: "reception",
    resource: "customer",
    action: "view",
    standardAction: "view",
    label: "استعراض بيانات عملاء الاستقبال",
    labelAr: "استعراض بيانات عملاء الاستقبال",
    description: "البحث في سجل العملاء والتواصل معهم بخصوص طلباتهم",
    descriptionAr: "البحث في سجل العملاء والتواصل معهم بخصوص طلباتهم",
    sensitivity: "normal",
    legacyModule: "crm",
      },
  {
    key: "reception.customer.edit",
    domain: "reception",
    resource: "customer",
    action: "edit",
    standardAction: "edit",
    label: "تعديل بيانات عميل الاستقبال",
    labelAr: "تعديل بيانات عميل الاستقبال",
    description: "تحديث أرقام هواتف وعناوين عملاء قسم الاستقبال",
    descriptionAr: "تحديث أرقام هواتف وعناوين عملاء قسم الاستقبال",
    sensitivity: "normal",
    legacyModule: "crm",
      },
  {
    key: "workshop.job.create",
    domain: "workshop",
    resource: "job",
    action: "create",
    standardAction: "create",
    label: "إنشاء بطاقة تشغيل صناعية جديدة",
    labelAr: "إنشاء بطاقة تشغيل صناعية جديدة",
    description: "فتح أمر تشغيل إنتاجي مستقل لخطوط الطباعة والتشطيب",
    descriptionAr: "فتح أمر تشغيل إنتاجي مستقل لخطوط الطباعة والتشطيب",
    sensitivity: "normal",
    legacyModule: "workorders",
      },
  {
    key: "workshop.job.dispatch",
    domain: "workshop",
    resource: "job",
    action: "dispatch",
    standardAction: "edit",
    label: "تعيين أمر التشغيل لماكينة أو فني محدد",
    labelAr: "تعيين أمر التشغيل لماكينة أو فني محدد",
    description: "إسناد مهام الطباعة والقص والتجليد للماكينات المتاحة",
    descriptionAr: "إسناد مهام الطباعة والقص والتجليد للماكينات المتاحة",
    sensitivity: "normal",
    legacyModule: "workorders",
    isSpecialOperation: true,
  },
  {
    key: "workshop.job.cancel",
    domain: "workshop",
    resource: "job",
    action: "cancel",
    standardAction: "cancel",
    label: "إلغاء أمر التشغيل في الورشة",
    labelAr: "إلغاء أمر التشغيل في الورشة",
    description: "إيقاف تنفيذ بطاقة التشغيل وعكس المواد المصروفة",
    descriptionAr: "إيقاف تنفيذ بطاقة التشغيل وعكس المواد المصروفة",
    sensitivity: "high",
    legacyModule: "workorders",
      },
  {
    key: "workshop.job.print",
    domain: "workshop",
    resource: "job",
    action: "print",
    standardAction: "print",
    label: "طباعة بطاقة التشغيل وأمر الماكينة",
    labelAr: "طباعة بطاقة التشغيل وأمر الماكينة",
    description: "طباعة كارت العمل الفني مع الباركود والمواصفات للورشة",
    descriptionAr: "طباعة كارت العمل الفني مع الباركود والمواصفات للورشة",
    sensitivity: "normal",
    legacyModule: "workorders",
      },
  {
    key: "workshop.material.view",
    domain: "workshop",
    resource: "material",
    action: "view",
    standardAction: "view",
    label: "استعراض المواد الخام المخصصة للتشغيل",
    labelAr: "استعراض المواد الخام المخصصة للتشغيل",
    description: "عرض كميات الورق والأحبار المطلوبة والمنصرفة للأمر",
    descriptionAr: "عرض كميات الورق والأحبار المطلوبة والمنصرفة للأمر",
    sensitivity: "normal",
    legacyModule: "inventory",
      },
  {
    key: "workshop.waste.view",
    domain: "workshop",
    resource: "waste",
    action: "view",
    standardAction: "view",
    label: "استعراض سجل الهالك والتالف الصناعي",
    labelAr: "استعراض سجل الهالك والتالف الصناعي",
    description: "متابعة نسب هالك الخامات أثناء الطباعة والتشطيب",
    descriptionAr: "متابعة نسب هالك الخامات أثناء الطباعة والتشطيب",
    sensitivity: "normal",
    legacyModule: "inventory",
      },
  {
    key: "workshop.waste.approve",
    domain: "workshop",
    resource: "waste",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد شطب هالك الإنتاج والمطبعة",
    labelAr: "اعتماد شطب هالك الإنتاج والمطبعة",
    description: "الموافقة الإدارية على شطب المواد التالفة أثناء الإنتاج",
    descriptionAr: "الموافقة الإدارية على شطب المواد التالفة أثناء الإنتاج",
    sensitivity: "high",
    legacyModule: "inventory",
    isSpecialOperation: true,
  },
  {
    key: "workshop.rework.view",
    domain: "workshop",
    resource: "rework",
    action: "view",
    standardAction: "view",
    label: "استعراض طلبات إعادة التشغيل والطباعة",
    labelAr: "استعراض طلبات إعادة التشغيل والطباعة",
    description: "متابعة الأوامر التي تحتاج إعادة تنفيذ بسبب عيوب فنية",
    descriptionAr: "متابعة الأوامر التي تحتاج إعادة تنفيذ بسبب عيوب فنية",
    sensitivity: "normal",
    legacyModule: "workorders",
      },
  {
    key: "workshop.queue.view",
    domain: "workshop",
    resource: "queue",
    action: "view",
    standardAction: "view",
    label: "استعراض طابور وجدول الإنتاج والماكينات",
    labelAr: "استعراض طابور وجدول الإنتاج والماكينات",
    description: "متابعة أحمال الماكينات ومواعيد تسليم الأعمال الجارية",
    descriptionAr: "متابعة أحمال الماكينات ومواعيد تسليم الأعمال الجارية",
    sensitivity: "normal",
    legacyModule: "workorders",
      },
  {
    key: "workshop.pricing.view",
    domain: "workshop",
    resource: "pricing",
    action: "view",
    standardAction: "view",
    label: "استعراض جداول تكاليف الطباعة والتشطيب",
    labelAr: "استعراض جداول تكاليف الطباعة والتشطيب",
    description: "الاطلاع على معادلات حساب تكلفة المتر والورقة والخامات",
    descriptionAr: "الاطلاع على معادلات حساب تكلفة المتر والورقة والخامات",
    sensitivity: "normal",
    legacyModule: "workorders",
      },
  {
    key: "workshop.pricing.manage",
    domain: "workshop",
    resource: "pricing",
    action: "manage",
    standardAction: "edit",
    label: "تعديل معادلات وتكاليف خدمات الطباعة",
    labelAr: "تعديل معادلات وتكاليف خدمات الطباعة",
    description: "ضبط أسعار استهلاك الماكينات وهوامش الربح الفنية",
    descriptionAr: "ضبط أسعار استهلاك الماكينات وهوامش الربح الفنية",
    sensitivity: "high",
    legacyModule: "settings",
    isSpecialOperation: true,
  },
  {
    key: "inventory.item.create",
    domain: "inventory",
    resource: "item",
    action: "create",
    standardAction: "create",
    label: "إضافة صنف أو مادة خام جديدة للكتالوج",
    labelAr: "إضافة صنف أو مادة خام جديدة للكتالوج",
    description: "تسجيل بيانات الصنف الجديد والباركود والوحدات والأسعار",
    descriptionAr: "تسجيل بيانات الصنف الجديد والباركود والوحدات والأسعار",
    sensitivity: "normal",
    legacyModule: "inventory",
      },
  {
    key: "inventory.item.edit",
    domain: "inventory",
    resource: "item",
    action: "edit",
    standardAction: "edit",
    label: "تعديل بيانات الصنف والأسعار ومستويات الطلب",
    labelAr: "تعديل بيانات الصنف والأسعار ومستويات الطلب",
    description: "تحديث مسميات وأسعار بيع وحدود إعادة الطلب للأصناف",
    descriptionAr: "تحديث مسميات وأسعار بيع وحدود إعادة الطلب للأصناف",
    sensitivity: "normal",
    legacyModule: "inventory",
      },
  {
    key: "inventory.item.archive",
    domain: "inventory",
    resource: "item",
    action: "archive",
    standardAction: "cancel",
    label: "أرشفة أو حذف الصنف من النظام",
    labelAr: "أرشفة أو حذف الصنف من النظام",
    description: "تعطيل الصنف ومنع بيعه أو حذفه في حال عدم وجود حركات",
    descriptionAr: "تعطيل الصنف ومنع بيعه أو حذفه في حال عدم وجود حركات",
    sensitivity: "high",
    legacyModule: "inventory",
      },
  {
    key: "inventory.item.export",
    domain: "inventory",
    resource: "item",
    action: "export",
    standardAction: "export",
    label: "تصدير كتالوج الأصناف وقوائم الأسعار",
    labelAr: "تصدير كتالوج الأصناف وقوائم الأسعار",
    description: "تصدير بيانات الأصناف إلى ملفات إكسل أو ملفات خارجية",
    descriptionAr: "تصدير بيانات الأصناف إلى ملفات إكسل أو ملفات خارجية",
    sensitivity: "medium",
    legacyModule: "inventory",
      },
  {
    key: "inventory.transfer.view",
    domain: "inventory",
    resource: "transfer",
    action: "view",
    standardAction: "view",
    label: "استعراض سجل المناقلات والتحويلات المخزنية",
    labelAr: "استعراض سجل المناقلات والتحويلات المخزنية",
    description: "متابعة أوامر التحويل بين الفروع وحالة الشحنات المنقولة",
    descriptionAr: "متابعة أوامر التحويل بين الفروع وحالة الشحنات المنقولة",
    sensitivity: "normal",
    legacyModule: "inventory",
      },
  {
    key: "inventory.transfer.cancel",
    domain: "inventory",
    resource: "transfer",
    action: "cancel",
    standardAction: "cancel",
    label: "إلغاء أمر المناقلة المخزنية قبل الإرسال",
    labelAr: "إلغاء أمر المناقلة المخزنية قبل الإرسال",
    description: "إلغاء تحويل بضاعة وإعادة حجز الكميات بالمستودع الأصلي",
    descriptionAr: "إلغاء تحويل بضاعة وإعادة حجز الكميات بالمستودع الأصلي",
    sensitivity: "medium",
    legacyModule: "inventory",
      },
  {
    key: "inventory.transfer.print",
    domain: "inventory",
    resource: "transfer",
    action: "print",
    standardAction: "print",
    label: "طباعة سند ومنافيست التحويل المخزني",
    labelAr: "طباعة سند ومنافيست التحويل المخزني",
    description: "طباعة وثيقة المناقلة لتسليمها لسائق الشحنة وأمين المخزن",
    descriptionAr: "طباعة وثيقة المناقلة لتسليمها لسائق الشحنة وأمين المخزن",
    sensitivity: "normal",
    legacyModule: "inventory",
      },
  {
    key: "inventory.stocktake.view",
    domain: "inventory",
    resource: "stocktake",
    action: "view",
    standardAction: "view",
    label: "استعراض جلسات ودورات الجرد المخزني",
    labelAr: "استعراض جلسات ودورات الجرد المخزني",
    description: "عرض نتائج دورات الجرد ومقارنة الدفتري بالفعلي",
    descriptionAr: "عرض نتائج دورات الجرد ومقارنة الدفتري بالفعلي",
    sensitivity: "normal",
    legacyModule: "inventory",
      },
  {
    key: "inventory.stocktake.reconcile",
    domain: "inventory",
    resource: "stocktake",
    action: "reconcile",
    standardAction: "approve",
    label: "تسوية الفروقات واعتماد قيود تسوية الجرد",
    labelAr: "تسوية الفروقات واعتماد قيود تسوية الجرد",
    description: "ترحيل فروقات الجرد محاسبياً وضبط أرصدة الأصناف بالمخازن",
    descriptionAr: "ترحيل فروقات الجرد محاسبياً وضبط أرصدة الأصناف بالمخازن",
    sensitivity: "high",
    legacyModule: "inventory",
    isSpecialOperation: true,
  },
  {
    key: "inventory.stocktake.print",
    domain: "inventory",
    resource: "stocktake",
    action: "print",
    standardAction: "print",
    label: "طباعة قوائم العد وتقارير الجرد المخزني",
    labelAr: "طباعة قوائم العد وتقارير الجرد المخزني",
    description: "طباعة أوراق عد الجرد لأمناء المستودع وتقرير الفروقات",
    descriptionAr: "طباعة أوراق عد الجرد لأمناء المستودع وتقرير الفروقات",
    sensitivity: "normal",
    legacyModule: "inventory",
      },
  {
    key: "inventory.adjustment.view",
    domain: "inventory",
    resource: "adjustment",
    action: "view",
    standardAction: "view",
    label: "استعراض طلبات وسندات تسوية المخزون",
    labelAr: "استعراض طلبات وسندات تسوية المخزون",
    description: "متابعة التعديلات اليدوية المباشرة على كميات الأصناف",
    descriptionAr: "متابعة التعديلات اليدوية المباشرة على كميات الأصناف",
    sensitivity: "normal",
    legacyModule: "inventory",
      },
  {
    key: "inventory.scrap.view",
    domain: "inventory",
    resource: "scrap",
    action: "view",
    standardAction: "view",
    label: "استعراض سجل الأصناف التالفة والتالف المخزني",
    labelAr: "استعراض سجل الأصناف التالفة والتالف المخزني",
    description: "عرض كشوفات البضاعة التالفة أو المنتهية الصلاحية",
    descriptionAr: "عرض كشوفات البضاعة التالفة أو المنتهية الصلاحية",
    sensitivity: "normal",
    legacyModule: "inventory",
      },
  {
    key: "inventory.scrap.approve",
    domain: "inventory",
    resource: "scrap",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد شطب وإتلاف المخزون التالف",
    labelAr: "اعتماد شطب وإتلاف المخزون التالف",
    description: "الموافقة الرسمية على شطب الأصناف التالفة وإنزالها من العهدة",
    descriptionAr: "الموافقة الرسمية على شطب الأصناف التالفة وإنزالها من العهدة",
    sensitivity: "high",
    legacyModule: "inventory",
    isSpecialOperation: true,
  },
  {
    key: "inventory.consignment.view",
    domain: "inventory",
    resource: "consignment",
    action: "view",
    standardAction: "view",
    label: "استعراض بضاعة الأمانة وأرصدتها بالمستودعات",
    labelAr: "استعراض بضاعة الأمانة وأرصدتها بالمستودعات",
    description: "متابعة كميات بضاعة الأمانة المستلمة من الموردين",
    descriptionAr: "متابعة كميات بضاعة الأمانة المستلمة من الموردين",
    sensitivity: "normal",
    legacyModule: "consignments",
      },
  {
    key: "inventory.consignment.manage",
    domain: "inventory",
    resource: "consignment",
    action: "manage",
    standardAction: "edit",
    label: "إدارة بضاعة الأمانة وتسوية مبيعاتها وإعادتها",
    labelAr: "إدارة بضاعة الأمانة وتسوية مبيعاتها وإعادتها",
    description: "إثبات استلام أمانة جديدة وتصفية المستحقات ورد الفائض",
    descriptionAr: "إثبات استلام أمانة جديدة وتصفية المستحقات ورد الفائض",
    sensitivity: "high",
    legacyModule: "consignments",
    isSpecialOperation: true,
  },
  {
    key: "purchasing.supplier.block",
    domain: "purchasing",
    resource: "supplier",
    action: "block",
    standardAction: "cancel",
    label: "حظر أو تجميد التعامل مع المورد",
    labelAr: "حظر أو تجميد التعامل مع المورد",
    description: "منع إصدار أوامر شراء أو فواتير جديدة للمورد المحظور",
    descriptionAr: "منع إصدار أوامر شراء أو فواتير جديدة للمورد المحظور",
    sensitivity: "high",
    legacyModule: "suppliers",
    isSpecialOperation: true,
  },
  {
    key: "purchasing.supplier.statement",
    domain: "purchasing",
    resource: "supplier",
    action: "statement",
    standardAction: "view",
    label: "استخراج وطباعة كشف حساب المورد",
    labelAr: "استخراج وطباعة كشف حساب المورد",
    description: "كشف حركات وفواتير وسندات الصرف الخاصة بالمورد ومطابقة الرصيد",
    descriptionAr: "كشف حركات وفواتير وسندات الصرف الخاصة بالمورد ومطابقة الرصيد",
    sensitivity: "normal",
    legacyModule: "suppliers",
      },
  {
    key: "purchasing.supplier.export",
    domain: "purchasing",
    resource: "supplier",
    action: "export",
    standardAction: "export",
    label: "تصدير دليل وبيانات الموردين",
    labelAr: "تصدير دليل وبيانات الموردين",
    description: "تصدير قائمة الموردين وبيانات التواصل إلى ملف خارجي",
    descriptionAr: "تصدير قائمة الموردين وبيانات التواصل إلى ملف خارجي",
    sensitivity: "medium",
    legacyModule: "suppliers",
      },
  {
    key: "purchasing.po.view",
    domain: "purchasing",
    resource: "po",
    action: "view",
    standardAction: "view",
    label: "استعراض أوامر الشراء",
    labelAr: "استعراض أوامر الشراء",
    description: "عرض سجل وتفاصيل أوامر الشراء وحالات التوريد",
    descriptionAr: "عرض سجل وتفاصيل أوامر الشراء وحالات التوريد",
    sensitivity: "normal",
    legacyModule: "purchases",
      },
  {
    key: "purchasing.po.edit",
    domain: "purchasing",
    resource: "po",
    action: "edit",
    standardAction: "edit",
    label: "تعديل بنود أمر الشراء قيد الإعداد",
    labelAr: "تعديل بنود أمر الشراء قيد الإعداد",
    description: "تعديل الكميات والأسعار المتفق عليها قبل الاعتماد النهائي",
    descriptionAr: "تعديل الكميات والأسعار المتفق عليها قبل الاعتماد النهائي",
    sensitivity: "normal",
    legacyModule: "purchases",
      },
  {
    key: "purchasing.grn.view",
    domain: "purchasing",
    resource: "grn",
    action: "view",
    standardAction: "view",
    label: "استعراض أذونات استلام البضاعة GRN",
    labelAr: "استعراض أذونات استلام البضاعة GRN",
    description: "متابعة أذونات الفحص والاستلام المخزني للشحنات الواردة",
    descriptionAr: "متابعة أذونات الفحص والاستلام المخزني للشحنات الواردة",
    sensitivity: "normal",
    legacyModule: "purchases",
      },
  {
    key: "purchasing.grn.reverse",
    domain: "purchasing",
    resource: "grn",
    action: "reverse",
    standardAction: "cancel",
    label: "إلغاء وعكس إذن استلام بضاعة واردة",
    labelAr: "إلغاء وعكس إذن استلام بضاعة واردة",
    description: "إلغاء إذن الاستلام في حال وجود خطأ في العد أو رفض الشحنة",
    descriptionAr: "إلغاء إذن الاستلام في حال وجود خطأ في العد أو رفض الشحنة",
    sensitivity: "high",
    legacyModule: "purchases",
    isSpecialOperation: true,
  },
  {
    key: "purchasing.grn.print",
    domain: "purchasing",
    resource: "grn",
    action: "print",
    standardAction: "print",
    label: "طباعة إذن الاستلام المخزني الرسمي",
    labelAr: "طباعة إذن الاستلام المخزني الرسمي",
    description: "طباعة محضر فحص واستلام الشحنة وتوقيع أمين المستودع",
    descriptionAr: "طباعة محضر فحص واستلام الشحنة وتوقيع أمين المستودع",
    sensitivity: "normal",
    legacyModule: "purchases",
      },
  {
    key: "purchasing.invoice.view",
    domain: "purchasing",
    resource: "invoice",
    action: "view",
    standardAction: "view",
    label: "استعراض فواتير المشتريات من الموردين",
    labelAr: "استعراض فواتير المشتريات من الموردين",
    description: "عرض ومراجعة فواتير الموردين المسجلة واستحقاقاتها",
    descriptionAr: "عرض ومراجعة فواتير الموردين المسجلة واستحقاقاتها",
    sensitivity: "normal",
    legacyModule: "purchases",
      },
  {
    key: "purchasing.invoice.create",
    domain: "purchasing",
    resource: "invoice",
    action: "create",
    standardAction: "create",
    label: "تسجيل فاتورة شراء جديدة من مورد",
    labelAr: "تسجيل فاتورة شراء جديدة من مورد",
    description: "إدخال فاتورة المورد وربطها بأمر الشراء وإذن الاستلام",
    descriptionAr: "إدخال فاتورة المورد وربطها بأمر الشراء وإذن الاستلام",
    sensitivity: "normal",
    legacyModule: "purchases",
      },
  {
    key: "purchasing.invoice.approve",
    domain: "purchasing",
    resource: "invoice",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد فاتورة المشتريات للصرف المالي",
    labelAr: "اعتماد فاتورة المشتريات للصرف المالي",
    description: "الموافقة النهائية على صحة الفاتورة ومطابقتها للصرف",
    descriptionAr: "الموافقة النهائية على صحة الفاتورة ومطابقتها للصرف",
    sensitivity: "high",
    legacyModule: "purchases",
    isSpecialOperation: true,
  },
  {
    key: "purchasing.return.view",
    domain: "purchasing",
    resource: "return",
    action: "view",
    standardAction: "view",
    label: "استعراض مرتجعات المشتريات",
    labelAr: "استعراض مرتجعات المشتريات",
    description: "متابعة البضائع المعادة للموردين وإشعارات الخصم",
    descriptionAr: "متابعة البضائع المعادة للموردين وإشعارات الخصم",
    sensitivity: "normal",
    legacyModule: "purchases",
      },
  {
    key: "purchasing.return.approve",
    domain: "purchasing",
    resource: "return",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد مرتجع المشتريات والإشعار المدين",
    labelAr: "اعتماد مرتجع المشتريات والإشعار المدين",
    description: "الموافقة على إعادة البضاعة واسترداد المبالغ من المورد",
    descriptionAr: "الموافقة على إعادة البضاعة واسترداد المبالغ من المورد",
    sensitivity: "high",
    legacyModule: "purchases",
    isSpecialOperation: true,
  },
  {
    key: "purchasing.payment.view",
    domain: "purchasing",
    resource: "payment",
    action: "view",
    standardAction: "view",
    label: "استعراض سجل مدفوعات الموردين",
    labelAr: "استعراض سجل مدفوعات الموردين",
    description: "متابعة الدفعات المسددة للموردين وأرصدة الديون المتبقية",
    descriptionAr: "متابعة الدفعات المسددة للموردين وأرصدة الديون المتبقية",
    sensitivity: "normal",
    legacyModule: "purchases",
      },
  {
    key: "purchasing.charges.allocate",
    domain: "purchasing",
    resource: "charges",
    action: "allocate",
    standardAction: "edit",
    label: "توزيع مصاريف الشحن والجمارك على الأصناف",
    labelAr: "توزيع مصاريف الشحن والجمارك على الأصناف",
    description: "احتساب وتوزيع التكاليف الإضافية للشحنة على سعر تكلفة المخزون",
    descriptionAr: "احتساب وتوزيع التكاليف الإضافية للشحنة على سعر تكلفة المخزون",
    sensitivity: "high",
    legacyModule: "purchases",
    isSpecialOperation: true,
  },
  {
    key: "treasury.cashbox.transfer",
    domain: "treasury",
    resource: "cashbox",
    action: "transfer",
    standardAction: "create",
    label: "تحويل نقدية بين الخزائن والحسابات البنكية",
    labelAr: "تحويل نقدية بين الخزائن والحسابات البنكية",
    description: "مناقلة سيولة نقدية من صندوق لآخر أو إيداع بنكي",
    descriptionAr: "مناقلة سيولة نقدية من صندوق لآخر أو إيداع بنكي",
    sensitivity: "high",
    legacyModule: "treasury",
    isSpecialOperation: true,
  },
  {
    key: "treasury.cashbox.reconcile",
    domain: "treasury",
    resource: "cashbox",
    action: "reconcile",
    standardAction: "approve",
    label: "المطابقة والتسوية النقدية والبنكية",
    labelAr: "المطابقة والتسوية النقدية والبنكية",
    description: "مطابقة كشوف الحسابات البنكية وجرد الصناديق الدورية",
    descriptionAr: "مطابقة كشوف الحسابات البنكية وجرد الصناديق الدورية",
    sensitivity: "high",
    legacyModule: "treasury",
    isSpecialOperation: true,
  },
  {
    key: "treasury.voucher_in.view",
    domain: "treasury",
    resource: "voucher_in",
    action: "view",
    standardAction: "view",
    label: "استعراض سندات القبض",
    labelAr: "استعراض سندات القبض",
    description: "عرض سجل وتفاصيل سندات القبض النقدية والبنكية الصادرة",
    descriptionAr: "عرض سجل وتفاصيل سندات القبض النقدية والبنكية الصادرة",
    sensitivity: "normal",
    legacyModule: "treasury",
      },
  {
    key: "treasury.voucher_in.print",
    domain: "treasury",
    resource: "voucher_in",
    action: "print",
    standardAction: "print",
    label: "طباعة سند القبض الرسمي",
    labelAr: "طباعة سند القبض الرسمي",
    description: "طباعة إيصال سند القبض مع التواقيع لتسليمه للدافع",
    descriptionAr: "طباعة إيصال سند القبض مع التواقيع لتسليمه للدافع",
    sensitivity: "normal",
    legacyModule: "treasury",
      },
  {
    key: "treasury.voucher_out.view",
    domain: "treasury",
    resource: "voucher_out",
    action: "view",
    standardAction: "view",
    label: "استعراض سندات الصرف والمدفوعات",
    labelAr: "استعراض سندات الصرف والمدفوعات",
    description: "عرض سجل سندات الصرف والشيكات والتحويلات البنكية الصادرة",
    descriptionAr: "عرض سجل سندات الصرف والشيكات والتحويلات البنكية الصادرة",
    sensitivity: "normal",
    legacyModule: "treasury",
      },
  {
    key: "treasury.voucher_out.cancel",
    domain: "treasury",
    resource: "voucher_out",
    action: "cancel",
    standardAction: "cancel",
    label: "إلغاء سند الصرف وعكس القيد المالي",
    labelAr: "إلغاء سند الصرف وعكس القيد المالي",
    description: "إلغاء سند صرف صادر وإعادة المبلغ لرصيد الخزينة",
    descriptionAr: "إلغاء سند صرف صادر وإعادة المبلغ لرصيد الخزينة",
    sensitivity: "high",
    legacyModule: "treasury",
      },
  {
    key: "treasury.voucher_out.print",
    domain: "treasury",
    resource: "voucher_out",
    action: "print",
    standardAction: "print",
    label: "طباعة سند الصرف مع التواقيع والاعتمادات",
    labelAr: "طباعة سند الصرف مع التواقيع والاعتمادات",
    description: "طباعة نموذج سند الصرف الرسمي لأرشفة التواقيع المستندية",
    descriptionAr: "طباعة نموذج سند الصرف الرسمي لأرشفة التواقيع المستندية",
    sensitivity: "normal",
    legacyModule: "treasury",
      },
  {
    key: "treasury.expense.view",
    domain: "treasury",
    resource: "expense",
    action: "view",
    standardAction: "view",
    label: "استعراض سجل المصروفات والنثريات",
    labelAr: "استعراض سجل المصروفات والنثريات",
    description: "متابعة بنود المصروفات التشغيلية ومصروفات الفروع",
    descriptionAr: "متابعة بنود المصروفات التشغيلية ومصروفات الفروع",
    sensitivity: "normal",
    legacyModule: "expenses",
      },
  {
    key: "treasury.expense.cancel",
    domain: "treasury",
    resource: "expense",
    action: "cancel",
    standardAction: "cancel",
    label: "إلغاء أو رفض طلب المصروف",
    labelAr: "إلغاء أو رفض طلب المصروف",
    description: "رفض طلب الصرف أو إلغاء مصروف مسجل وعكس أثره",
    descriptionAr: "رفض طلب الصرف أو إلغاء مصروف مسجل وعكس أثره",
    sensitivity: "medium",
    legacyModule: "expenses",
      },
  {
    key: "treasury.transfer.view",
    domain: "treasury",
    resource: "transfer",
    action: "view",
    standardAction: "view",
    label: "استعراض سجل المناقلات المالية والبنكية",
    labelAr: "استعراض سجل المناقلات المالية والبنكية",
    description: "متابعة حركات التحويل الداخلي بين حسابات وخزائن الشركة",
    descriptionAr: "متابعة حركات التحويل الداخلي بين حسابات وخزائن الشركة",
    sensitivity: "normal",
    legacyModule: "treasury",
      },
  {
    key: "treasury.transfer.approve",
    domain: "treasury",
    resource: "transfer",
    action: "approve",
    standardAction: "approve",
    label: "اعتماد واستلام التحويلات النقدية والبنكية",
    labelAr: "اعتماد واستلام التحويلات النقدية والبنكية",
    description: "تأكيد استلام السيولة المنقولة في الخزينة أو الحساب المستلم",
    descriptionAr: "تأكيد استلام السيولة المنقولة في الخزينة أو الحساب المستلم",
    sensitivity: "high",
    legacyModule: "treasury",
    isSpecialOperation: true,
  },
  {
    key: "treasury.shift.view",
    domain: "treasury",
    resource: "shift",
    action: "view",
    standardAction: "view",
    label: "استعراض تسويات نقدية ورديات الكاشير",
    labelAr: "استعراض تسويات نقدية ورديات الكاشير",
    description: "متابعة إيرادات الصناديق وجرد النقدية لكل كاشير ووردية",
    descriptionAr: "متابعة إيرادات الصناديق وجرد النقدية لكل كاشير ووردية",
    sensitivity: "normal",
    legacyModule: "treasury",
      },
  {
    key: "treasury.period.view",
    domain: "treasury",
    resource: "period",
    action: "view",
    standardAction: "view",
    label: "استعراض الفترات المالية وحالات القفل المحاسبي",
    labelAr: "استعراض الفترات المالية وحالات القفل المحاسبي",
    description: "الاطلاع على الشهور المقفلة والمفتوحة للقيود المالية",
    descriptionAr: "الاطلاع على الشهور المقفلة والمفتوحة للقيود المالية",
    sensitivity: "normal",
    legacyModule: "settings",
      },
  {
    key: "treasury.period.year_end",
    domain: "treasury",
    resource: "period",
    action: "year_end",
    standardAction: "approve",
    label: "إجراء إقفال السنة المالية وترحيل الأرباح",
    labelAr: "إجراء إقفال السنة المالية وترحيل الأرباح",
    description: "إغلاق الحسابات الاسمية وتوليد قيود الإقفال السنوية النهائية",
    descriptionAr: "إغلاق الحسابات الاسمية وتوليد قيود الإقفال السنوية النهائية",
    sensitivity: "high",
    legacyModule: "settings",
    isSpecialOperation: true,
  },
  {
    key: "fieldsales.visit.view",
    domain: "fieldsales",
    resource: "visit",
    action: "view",
    standardAction: "view",
    label: "استعراض سجل زيارات المناديب الميدانية",
    labelAr: "استعراض سجل زيارات المناديب الميدانية",
    description: "متابعة خطط سير وزيارات مناديب المبيعات للعملاء",
    descriptionAr: "متابعة خطط سير وزيارات مناديب المبيعات للعملاء",
    sensitivity: "normal",
    legacyModule: "crm",
      },
  {
    key: "fieldsales.quote.view",
    domain: "fieldsales",
    resource: "quote",
    action: "view",
    standardAction: "view",
    label: "استعراض عروض أسعار المبيعات الميدانية",
    labelAr: "استعراض عروض أسعار المبيعات الميدانية",
    description: "عرض العروض السعرية المقدمة للشركات والتجار",
    descriptionAr: "عرض العروض السعرية المقدمة للشركات والتجار",
    sensitivity: "normal",
    legacyModule: "sales",
      },
  {
    key: "fieldsales.quote.convert",
    domain: "fieldsales",
    resource: "quote",
    action: "convert",
    standardAction: "edit",
    label: "تحويل عرض السعر المعتمد إلى فاتورة بيع",
    labelAr: "تحويل عرض السعر المعتمد إلى فاتورة بيع",
    description: "تثبيت الاتفاق وتحويل العرض مباشرة إلى فاتورة مبيعات ملزمة",
    descriptionAr: "تثبيت الاتفاق وتحويل العرض مباشرة إلى فاتورة مبيعات ملزمة",
    sensitivity: "high",
    legacyModule: "sales",
    isSpecialOperation: true,
  },
  {
    key: "fieldsales.quote.print",
    domain: "fieldsales",
    resource: "quote",
    action: "print",
    standardAction: "print",
    label: "طباعة وتصدير عروض الأسعار التجارية",
    labelAr: "طباعة وتصدير عروض الأسعار التجارية",
    description: "طباعة العرض الرسمي متضمناً شروط التوريد والدفع",
    descriptionAr: "طباعة العرض الرسمي متضمناً شروط التوريد والدفع",
    sensitivity: "normal",
    legacyModule: "sales",
      },
  {
    key: "fieldsales.order.view",
    domain: "fieldsales",
    resource: "order",
    action: "view",
    standardAction: "view",
    label: "استعراض طلبيات المبيعات الميدانية",
    labelAr: "استعراض طلبيات المبيعات الميدانية",
    description: "متابعة أوامر البيع وحالات التنفيذ والتسليم للعملاء",
    descriptionAr: "متابعة أوامر البيع وحالات التنفيذ والتسليم للعملاء",
    sensitivity: "normal",
    legacyModule: "sales",
      },
  {
    key: "fieldsales.order.approve",
    domain: "fieldsales",
    resource: "order",
    action: "approve",
    standardAction: "edit",
    label: "اعتماد طلبيات المبيعات وعقود التوريد",
    labelAr: "اعتماد طلبيات المبيعات وعقود التوريد",
    description: "الموافقة التجارية على طلبيات الجملة وعقود الشركات",
    descriptionAr: "الموافقة التجارية على طلبيات الجملة وعقود الشركات",
    sensitivity: "high",
    legacyModule: "sales",
    isSpecialOperation: true,
  },
  {
    key: "fieldsales.customer.view",
    domain: "fieldsales",
    resource: "customer",
    action: "view",
    standardAction: "view",
    label: "استعراض قاعدة بيانات العملاء التجاريين",
    labelAr: "استعراض قاعدة بيانات العملاء التجاريين",
    description: "الاطلاع على بيانات الشركات والتجار وسجلات الاتصال",
    descriptionAr: "الاطلاع على بيانات الشركات والتجار وسجلات الاتصال",
    sensitivity: "normal",
    legacyModule: "crm",
      },
  {
    key: "fieldsales.customer.edit",
    domain: "fieldsales",
    resource: "customer",
    action: "edit",
    standardAction: "edit",
    label: "تعديل بيانات العميل التجاري وشروط التعامل",
    labelAr: "تعديل بيانات العميل التجاري وشروط التعامل",
    description: "تحديث العناوين والمسؤولين وشروط التوريد للعملاء",
    descriptionAr: "تحديث العناوين والمسؤولين وشروط التوريد للعملاء",
    sensitivity: "normal",
    legacyModule: "crm",
      },
  {
    key: "fieldsales.customer.credit_limit",
    domain: "fieldsales",
    resource: "customer",
    action: "credit_limit",
    standardAction: "edit",
    label: "تعديل وتحديد سقف الائتمان للعميل",
    labelAr: "تعديل وتحديد سقف الائتمان للعميل",
    description: "ضبط الحد الأقصى للمديونية المسموحة وفترة السماح بالسداد",
    descriptionAr: "ضبط الحد الأقصى للمديونية المسموحة وفترة السماح بالسداد",
    sensitivity: "high",
    legacyModule: "crm",
    isSpecialOperation: true,
  },
  {
    key: "fieldsales.statement.print",
    domain: "fieldsales",
    resource: "statement",
    action: "print",
    standardAction: "print",
    label: "طباعة كشف حساب ومطابقة رصيد العميل",
    labelAr: "طباعة كشف حساب ومطابقة رصيد العميل",
    description: "طباعة كشف حساب تفصيلي لتسليمه للعميل للمصادقة",
    descriptionAr: "طباعة كشف حساب تفصيلي لتسليمه للعميل للمصادقة",
    sensitivity: "normal",
    legacyModule: "crm",
      },
  {
    key: "fieldsales.price_tier.apply",
    domain: "fieldsales",
    resource: "price_tier",
    action: "apply",
    standardAction: "edit",
    label: "تطبيق فئة أو شريحة تسعير خاصة للعميل",
    labelAr: "تطبيق فئة أو شريحة تسعير خاصة للعميل",
    description: "ربط العميل بسعر الجملة أو فئة أسعار مخصصة للشركات",
    descriptionAr: "ربط العميل بسعر الجملة أو فئة أسعار مخصصة للشركات",
    sensitivity: "medium",
    legacyModule: "sales",
      },
  {
    key: "delivery.dispatch.view",
    domain: "delivery",
    resource: "dispatch",
    action: "view",
    standardAction: "view",
    label: "استعراض سجل إرساليات وبوالص الشحن",
    labelAr: "استعراض سجل إرساليات وبوالص الشحن",
    description: "متابعة قوافل وإرساليات الشحن الموزعة على السائقين",
    descriptionAr: "متابعة قوافل وإرساليات الشحن الموزعة على السائقين",
    sensitivity: "normal",
    legacyModule: "courier",
      },
  {
    key: "delivery.dispatch.assign",
    domain: "delivery",
    resource: "dispatch",
    action: "assign",
    standardAction: "edit",
    label: "تعيين وإسناد الشحنات للمناديب والسائقين",
    labelAr: "تعيين وإسناد الشحنات للمناديب والسائقين",
    description: "توزيع الطرود وبوالص الشحن على خطوط سير المناديب",
    descriptionAr: "توزيع الطرود وبوالص الشحن على خطوط سير المناديب",
    sensitivity: "normal",
    legacyModule: "courier",
    isSpecialOperation: true,
  },
  {
    key: "delivery.dispatch.print",
    domain: "delivery",
    resource: "dispatch",
    action: "print",
    standardAction: "print",
    label: "طباعة بوالص الشحن ومنافيست التوزيع",
    labelAr: "طباعة بوالص الشحن ومنافيست التوزيع",
    description: "طباعة وثائق وبوالص الشحن وملصقات العناوين للطرود",
    descriptionAr: "طباعة وثائق وبوالص الشحن وملصقات العناوين للطرود",
    sensitivity: "normal",
    legacyModule: "courier",
      },
  {
    key: "delivery.parcel.status_update",
    domain: "delivery",
    resource: "parcel",
    action: "status_update",
    standardAction: "edit",
    label: "تحديث حالة التوصيل ومرحلة الشحنة",
    labelAr: "تحديث حالة التوصيل ومرحلة الشحنة",
    description: "تغيير حالة الطرد (قيد التوصيل، تم الوصول، مؤجل، راجع)",
    descriptionAr: "تغيير حالة الطرد (قيد التوصيل، تم الوصول، مؤجل، راجع)",
    sensitivity: "normal",
    legacyModule: "courier",
      },
  {
    key: "delivery.proof.view",
    domain: "delivery",
    resource: "proof",
    action: "view",
    standardAction: "view",
    label: "استعراض إثباتات وتسليمات الشحنات",
    labelAr: "استعراض إثباتات وتسليمات الشحنات",
    description: "معاينة توقيعات العملاء وصور إثبات التسليم للطرود",
    descriptionAr: "معاينة توقيعات العملاء وصور إثبات التسليم للطرود",
    sensitivity: "normal",
    legacyModule: "courier",
      },
  {
    key: "delivery.failure.view",
    domain: "delivery",
    resource: "failure",
    action: "view",
    standardAction: "view",
    label: "استعراض سجل الشحنات المتعثرة والراجعة",
    labelAr: "استعراض سجل الشحنات المتعثرة والراجعة",
    description: "متابعة أسباب تعذر التسليم وإعادة جدولة الشحنات",
    descriptionAr: "متابعة أسباب تعذر التسليم وإعادة جدولة الشحنات",
    sensitivity: "normal",
    legacyModule: "courier",
      },
  {
    key: "delivery.cod.view",
    domain: "delivery",
    resource: "cod",
    action: "view",
    standardAction: "view",
    label: "استعراض مبالغ التحصيل عند الاستلام COD",
    labelAr: "استعراض مبالغ التحصيل عند الاستلام COD",
    description: "متابعة الذمم المالية والمبالغ المحصلة في عهدة السائقين",
    descriptionAr: "متابعة الذمم المالية والمبالغ المحصلة في عهدة السائقين",
    sensitivity: "normal",
    legacyModule: "courier",
      },
  {
    key: "delivery.cod.receive",
    domain: "delivery",
    resource: "cod",
    action: "receive",
    standardAction: "create",
    label: "استلام وتوريد مبالغ الـ COD للخزينة",
    labelAr: "استلام وتوريد مبالغ الـ COD للخزينة",
    description: "توريد المبالغ المحصلة من السائق للصندوق وإصدار سند قبض",
    descriptionAr: "توريد المبالغ المحصلة من السائق للصندوق وإصدار سند قبض",
    sensitivity: "high",
    legacyModule: "treasury",
    isSpecialOperation: true,
  },
  {
    key: "delivery.shortfall.view",
    domain: "delivery",
    resource: "shortfall",
    action: "view",
    standardAction: "view",
    label: "استعراض سجل فروقات وعجز الشحن اللوجستي",
    labelAr: "استعراض سجل فروقات وعجز الشحن اللوجستي",
    description: "متابعة مبالغ العجز في التحصيل أو فقدان الطرود",
    descriptionAr: "متابعة مبالغ العجز في التحصيل أو فقدان الطرود",
    sensitivity: "normal",
    legacyModule: "courier",
      },
  {
    key: "hr.employee.create",
    domain: "hr",
    resource: "employee",
    action: "create",
    standardAction: "create",
    label: "إضافة ملف موظف جديد وتسجيل عقده",
    labelAr: "إضافة ملف موظف جديد وتسجيل عقده",
    description: "تسجيل بيانات الموظف والراتب والقسم وتاريخ التعيين",
    descriptionAr: "تسجيل بيانات الموظف والراتب والقسم وتاريخ التعيين",
    sensitivity: "high",
    legacyModule: "hr",
      },
  {
    key: "hr.employee.terminate",
    domain: "hr",
    resource: "employee",
    action: "terminate",
    standardAction: "cancel",
    label: "إنهاء خدمة موظف وتصفية مستحقاته",
    labelAr: "إنهاء خدمة موظف وتصفية مستحقاته",
    description: "إغلاق الملف الوظيفي، إنهاء العقد، وتوليد تصفية نهاية الخدمة",
    descriptionAr: "إغلاق الملف الوظيفي، إنهاء العقد، وتوليد تصفية نهاية الخدمة",
    sensitivity: "high",
    legacyModule: "hr",
    isSpecialOperation: true,
  },
  {
    key: "hr.employee.view_salary",
    domain: "hr",
    resource: "employee",
    action: "view_salary",
    standardAction: "view",
    label: "رؤية تفاصيل الراتب الأساسي والبدلات المالية",
    labelAr: "رؤية تفاصيل الراتب الأساسي والبدلات المالية",
    description: "الاطلاع على بنود الدخل والرواتب التعاقدية للموظفين",
    descriptionAr: "الاطلاع على بنود الدخل والرواتب التعاقدية للموظفين",
    sensitivity: "high",
    legacyModule: "hr",
    isSpecialOperation: true,
  },
  {
    key: "hr.attendance.view",
    domain: "hr",
    resource: "attendance",
    action: "view",
    standardAction: "view",
    label: "استعراض سجلات الحضور والانصراف والبصمة",
    labelAr: "استعراض سجلات الحضور والانصراف والبصمة",
    description: "متابعة أوقات الدخول والخروج والغياب اليومي للموظفين",
    descriptionAr: "متابعة أوقات الدخول والخروج والغياب اليومي للموظفين",
    sensitivity: "normal",
    legacyModule: "hr",
      },
  {
    key: "hr.attendance.override",
    domain: "hr",
    resource: "attendance",
    action: "override",
    standardAction: "approve",
    label: "اعتماد وتبرير الغياب وتعديل أوقات البصمة",
    labelAr: "اعتماد وتبرير الغياب وتعديل أوقات البصمة",
    description: "تعديل سجل البصمة استثنائياً وقبول مبررات التأخير",
    descriptionAr: "تعديل سجل البصمة استثنائياً وقبول مبررات التأخير",
    sensitivity: "high",
    legacyModule: "hr",
    isSpecialOperation: true,
  },
  {
    key: "hr.attendance.device_sync",
    domain: "hr",
    resource: "attendance",
    action: "device_sync",
    standardAction: "edit",
    label: "مزامنة وإدارة أجهزة البصمة البيومترية",
    labelAr: "مزامنة وإدارة أجهزة البصمة البيومترية",
    description: "سحب الحركات من أجهزة البصمة وتحديث بصمات الموظفين",
    descriptionAr: "سحب الحركات من أجهزة البصمة وتحديث بصمات الموظفين",
    sensitivity: "high",
    legacyModule: "hr",
    isSpecialOperation: true,
  },
  {
    key: "hr.leave.view",
    domain: "hr",
    resource: "leave",
    action: "view",
    standardAction: "view",
    label: "استعراض طلبات الإجازات وأرصدة الموظفين",
    labelAr: "استعراض طلبات الإجازات وأرصدة الموظفين",
    description: "متابعة الإجازات السنوية والمرضية والاضطرارية للموظفين",
    descriptionAr: "متابعة الإجازات السنوية والمرضية والاضطرارية للموظفين",
    sensitivity: "normal",
    legacyModule: "hr",
      },
  {
    key: "hr.leave.request",
    domain: "hr",
    resource: "leave",
    action: "request",
    standardAction: "create",
    label: "تقديم طلب إجازة أو مغادرة للموظف",
    labelAr: "تقديم طلب إجازة أو مغادرة للموظف",
    description: "تسجيل طلب إجازة وخصمها من الرصيد السنوي المتاح",
    descriptionAr: "تسجيل طلب إجازة وخصمها من الرصيد السنوي المتاح",
    sensitivity: "normal",
    legacyModule: "hr",
      },
  {
    key: "hr.payroll.view",
    domain: "hr",
    resource: "payroll",
    action: "view",
    standardAction: "view",
    label: "استعراض مسيرات الرواتب الشهرية",
    labelAr: "استعراض مسيرات الرواتب الشهرية",
    description: "مراجعة كشوفات الرواتب المحتسبة قبل وبعد الاعتماد",
    descriptionAr: "مراجعة كشوفات الرواتب المحتسبة قبل وبعد الاعتماد",
    sensitivity: "high",
    legacyModule: "hr",
      },
  {
    key: "hr.commission.view",
    domain: "hr",
    resource: "commission",
    action: "view",
    standardAction: "view",
    label: "استعراض سجل عمولات وحوافز المبيعات",
    labelAr: "استعراض سجل عمولات وحوافز المبيعات",
    description: "متابعة العمولات المستحقة لمناديب المبيعات والكاشير",
    descriptionAr: "متابعة العمولات المستحقة لمناديب المبيعات والكاشير",
    sensitivity: "normal",
    legacyModule: "commissions",
      },
  {
    key: "governance.audit.self_approval",
    domain: "governance",
    resource: "audit",
    action: "self_approval",
    standardAction: "view",
    label: "تدقيق تقارير الموافقات الذاتية والاستثناءات",
    labelAr: "تدقيق تقارير الموافقات الذاتية والاستثناءات",
    description: "فحص الحركات التي قام فيها الموظف باعتماد معاملاته بنفسه",
    descriptionAr: "فحص الحركات التي قام فيها الموظف باعتماد معاملاته بنفسه",
    sensitivity: "high",
    legacyModule: "settings",
    isSpecialOperation: true,
  },
  {
    key: "governance.user.view",
    domain: "governance",
    resource: "user",
    action: "view",
    standardAction: "view",
    label: "استعراض قائمة وحسابات مستخدمي النظام",
    labelAr: "استعراض قائمة وحسابات مستخدمي النظام",
    description: "عرض بيانات الحسابات وحالات النشاط وتواريخ الدخول",
    descriptionAr: "عرض بيانات الحسابات وحالات النشاط وتواريخ الدخول",
    sensitivity: "high",
    legacyModule: "users",
      },
  {
    key: "governance.user.create",
    domain: "governance",
    resource: "user",
    action: "create",
    standardAction: "create",
    label: "إنشاء حساب مستخدم جديد وتحديد دوره",
    labelAr: "إنشاء حساب مستخدم جديد وتحديد دوره",
    description: "إضافة مستخدم جديد للنظام وإسناد الفرع والدور الأساسي",
    descriptionAr: "إضافة مستخدم جديد للنظام وإسناد الفرع والدور الأساسي",
    sensitivity: "high",
    legacyModule: "users",
      },
  {
    key: "governance.user.freeze",
    domain: "governance",
    resource: "user",
    action: "freeze",
    standardAction: "cancel",
    label: "تجميد الحساب أو إنهاء الجلسات النشطة فوراً",
    labelAr: "تجميد الحساب أو إنهاء الجلسات النشطة فوراً",
    description: "إيقاف صلاحية الدخول وطرد المستخدم من كل جلساته المفتوحة",
    descriptionAr: "إيقاف صلاحية الدخول وطرد المستخدم من كل جلساته المفتوحة",
    sensitivity: "high",
    legacyModule: "users",
    isSpecialOperation: true,
  },
  {
    key: "governance.role.view",
    domain: "governance",
    resource: "role",
    action: "view",
    standardAction: "view",
    label: "استعراض الأدوار الوظيفية وقوالب الصلاحيات",
    labelAr: "استعراض الأدوار الوظيفية وقوالب الصلاحيات",
    description: "الاطلاع على قائمة الأدوار القياسية والمخصصة في الشركة",
    descriptionAr: "الاطلاع على قائمة الأدوار القياسية والمخصصة في الشركة",
    sensitivity: "high",
    legacyModule: "users",
      },
  {
    key: "governance.role.create",
    domain: "governance",
    resource: "role",
    action: "create",
    standardAction: "create",
    label: "إنشاء دور وظيفي مخصص جديد",
    labelAr: "إنشاء دور وظيفي مخصص جديد",
    description: "بناء دور جديد وتحديد مصفوفة الصلاحيات والسقوف الخاصة به",
    descriptionAr: "بناء دور جديد وتحديد مصفوفة الصلاحيات والسقوف الخاصة به",
    sensitivity: "high",
    legacyModule: "users",
      },
  {
    key: "governance.role.delete",
    domain: "governance",
    resource: "role",
    action: "delete",
    standardAction: "cancel",
    label: "حذف أو إلغاء دور وظيفي مخصص",
    labelAr: "حذف أو إلغاء دور وظيفي مخصص",
    description: "إزالة الدور من النظام شريطة عدم ارتباط أي موظف به",
    descriptionAr: "إزالة الدور من النظام شريطة عدم ارتباط أي موظف به",
    sensitivity: "high",
    legacyModule: "users",
      },
  {
    key: "governance.branch.view",
    domain: "governance",
    resource: "branch",
    action: "view",
    standardAction: "view",
    label: "استعراض بيانات الفروع ومستودعاتها",
    labelAr: "استعراض بيانات الفروع ومستودعاتها",
    description: "عرض مواقع الفروع ومراكز التكلفة والمخازن التابعة لها",
    descriptionAr: "عرض مواقع الفروع ومراكز التكلفة والمخازن التابعة لها",
    sensitivity: "normal",
    legacyModule: "settings",
      },
  {
    key: "governance.settings.view",
    domain: "governance",
    resource: "settings",
    action: "view",
    standardAction: "view",
    label: "استعراض إعدادات النظام العامة والتكاملات",
    labelAr: "استعراض إعدادات النظام العامة والتكاملات",
    description: "الاطلاع على سياسات العمل وإعدادات الخوادم والطباعة",
    descriptionAr: "الاطلاع على سياسات العمل وإعدادات الخوادم والطباعة",
    sensitivity: "high",
    legacyModule: "settings",
      },
  {
    key: "governance.backup.create",
    domain: "governance",
    resource: "backup",
    action: "create",
    standardAction: "create",
    label: "أخذ نسخة احتياطية فورية لقاعدة البيانات",
    labelAr: "أخذ نسخة احتياطية فورية لقاعدة البيانات",
    description: "توليد ملف نسخة احتياطية كاملة وتأمينه وتنزيله",
    descriptionAr: "توليد ملف نسخة احتياطية كاملة وتأمينه وتنزيله",
    sensitivity: "high",
    legacyModule: "settings",
    isSpecialOperation: true,
  },
  {
    key: "governance.backup.restore",
    domain: "governance",
    resource: "backup",
    action: "restore",
    standardAction: "approve",
    label: "استعادة نسخة احتياطية سابقة للنظام",
    labelAr: "استعادة نسخة احتياطية سابقة للنظام",
    description: "إعادة بناء قاعدة البيانات من لقطة احتياطية (صلاحية عليا)",
    descriptionAr: "إعادة بناء قاعدة البيانات من لقطة احتياطية (صلاحية عليا)",
    sensitivity: "high",
    legacyModule: "settings",
    isSpecialOperation: true,
  },
  {
    key: "governance.decisions.view",
    domain: "governance",
    resource: "decisions",
    action: "view",
    standardAction: "view",
    label: "استعراض سجل القرارات والتعاميم الإدارية",
    labelAr: "استعراض سجل القرارات والتعاميم الإدارية",
    description: "الاطلاع على القرارات الإدارية والتعاميم الداخلية المعتمدة",
    descriptionAr: "الاطلاع على القرارات الإدارية والتعاميم الداخلية المعتمدة",
    sensitivity: "normal",
    legacyModule: "settings",
      },
  {
    key: "governance.decisions.manage",
    domain: "governance",
    resource: "decisions",
    action: "manage",
    standardAction: "edit",
    label: "إصدار وإدارة القرارات والتعاميم الرسمية",
    labelAr: "إصدار وإدارة القرارات والتعاميم الرسمية",
    description: "صياغة وتعميم القرارات الإدارية على المستخدمين والأقسام",
    descriptionAr: "صياغة وتعميم القرارات الإدارية على المستخدمين والأقسام",
    sensitivity: "high",
    legacyModule: "settings",
    isSpecialOperation: true,
  },
];

export const ATOMIC_PERMISSION_DEFINITIONS: AtomicPermissionDefinition[] = [
  ...BASE_ATOMIC_PERMISSION_DEFINITIONS,
  ...ENTERPRISE_ATOMIC_DEFINITIONS,
];

export const ALL_ATOMIC_PERMISSION_KEYS: AtomicPermissionKey[] =
  ATOMIC_PERMISSION_DEFINITIONS.map((def) => def.key);

export const ATOMIC_PERMISSION_BY_KEY: Record<AtomicPermissionKey, AtomicPermissionDefinition> =
  Object.fromEntries(ATOMIC_PERMISSION_DEFINITIONS.map((def) => [def.key, def]));

const ATOMIC_KEYS_SET = new Set(ALL_ATOMIC_PERMISSION_KEYS);

const ATOMIC_PERMISSION_SEARCH_TEXTS = new Map<AtomicPermissionKey, string>();
for (const def of ATOMIC_PERMISSION_DEFINITIONS) {
  ATOMIC_PERMISSION_SEARCH_TEXTS.set(
    def.key,
    normalizeSearchText(
      `${def.label} ${def.labelAr} ${def.description} ${def.descriptionAr} ${def.key} ${def.resource} ${def.action}`,
    ),
  );
}

// ============================================================================
// ٣. أنواع ومخططات Zod للبيانات والمصفوفة
// ============================================================================

export type AtomicPermissionsMap = Record<AtomicPermissionKey, boolean>;

export const atomicPermissionKeySchema = z
  .string()
  .min(3)
  .regex(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/, "يجب أن يكون المفتاح بصيغة domain.resource.action")
  .refine((val) => ATOMIC_KEYS_SET.has(val), {
    message: "المفتاح غير مسجل في كتالوج الصلاحيات الذرية",
  });

export const atomicPermissionsMapSchema = z.record(z.string(), z.boolean());

export interface OperationalCaps {
  maxDiscountPercent?: number | null;
  maxDiscountAmountIqd?: string | null;
  maxCreditSaleLimitIqd?: string | null;
  maxPaymentVoucherAmountIqd?: string | null;
  maxExpenseVoucherAmountIqd?: string | null;
  maxRefundAmountIqd?: string | null;
}

const moneyCapStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "يجب أن يكون المبلغ المالي عدداً غير سالب بمنزلتين عشريتين كحد أقصى")
  .nullable()
  .optional();

export const operationalCapsSchema = z.object({
  maxDiscountPercent: z.number().min(0).max(100).nullable().optional(),
  maxDiscountAmountIqd: moneyCapStringSchema,
  maxCreditSaleLimitIqd: moneyCapStringSchema,
  maxPaymentVoucherAmountIqd: moneyCapStringSchema,
  maxExpenseVoucherAmountIqd: moneyCapStringSchema,
  maxRefundAmountIqd: moneyCapStringSchema,
});

export interface SensitiveDataMasking {
  maskPurchaseCost?: boolean | null;
  maskProfitMargin?: boolean | null;
  maskSupplierPhone?: boolean | null;
  maskCustomerContact?: boolean | null;
}

export const sensitiveDataMaskingSchema = z.object({
  maskPurchaseCost: z.boolean().nullable().optional(),
  maskProfitMargin: z.boolean().nullable().optional(),
  maskSupplierPhone: z.boolean().nullable().optional(),
  maskCustomerContact: z.boolean().nullable().optional(),
});

export interface PermissionEnvelope {
  modules?: Record<string, "FULL" | "READ" | "NONE">;
  atomic?: AtomicPermissionsMap;
  caps?: OperationalCaps;
  masking?: SensitiveDataMasking;
}

export const permissionEnvelopeSchema = z.object({
  modules: z.record(z.string(), z.enum(["FULL", "READ", "NONE"])).optional(),
  atomic: atomicPermissionsMapSchema.optional(),
  caps: operationalCapsSchema.optional(),
  masking: sensitiveDataMaskingSchema.optional(),
});

// ============================================================================
// ٤. القيم الافتراضية والقوالب للأدوار الـ11 + أدوار الكاشير الـ3
// ============================================================================

export const DEFAULT_ZERO_CAPS: Required<OperationalCaps> = {
  maxDiscountPercent: 0,
  maxDiscountAmountIqd: "0.00",
  maxCreditSaleLimitIqd: "0.00",
  maxPaymentVoucherAmountIqd: "0.00",
  maxExpenseVoucherAmountIqd: "0.00",
  maxRefundAmountIqd: "0.00",
};

export const DEFAULT_UNLIMITED_CAPS: Required<OperationalCaps> = {
  maxDiscountPercent: 100,
  maxDiscountAmountIqd: null,
  maxCreditSaleLimitIqd: null,
  maxPaymentVoucherAmountIqd: null,
  maxExpenseVoucherAmountIqd: null,
  maxRefundAmountIqd: null,
};

export const DEFAULT_MASKING_ALL_TRUE: Required<SensitiveDataMasking> = {
  maskPurchaseCost: true,
  maskProfitMargin: true,
  maskSupplierPhone: true,
  maskCustomerContact: true,
};

export const DEFAULT_MASKING_ALL_FALSE: Required<SensitiveDataMasking> = {
  maskPurchaseCost: false,
  maskProfitMargin: false,
  maskSupplierPhone: false,
  maskCustomerContact: false,
};

function createEmptyAtomicMap(): AtomicPermissionsMap {
  const map: AtomicPermissionsMap = {};
  for (const def of ATOMIC_PERMISSION_DEFINITIONS) {
    map[def.key] = false;
  }
  return map;
}

function buildAtomicPreset(grantedKeys: AtomicPermissionKey[]): AtomicPermissionsMap {
  const map = createEmptyAtomicMap();
  for (const k of grantedKeys) {
    if (k in map) {
      map[k] = true;
    }
  }
  return map;
}

// ----------------------------------------------------------------------------
// القوالب الافتراضية للأدوار (Atomic Role Presets)
// ----------------------------------------------------------------------------

const ADMIN_KEYS = ALL_ATOMIC_PERMISSION_KEYS;

const MANAGER_KEYS: AtomicPermissionKey[] = [
  "pos.shift.open",
  "pos.shift.close",
  "pos.invoice.create",
  "pos.invoice.view",
  "pos.invoice.reprint",
  "pos.invoice.print",
  "pos.invoice.export",
  "pos.invoice.void",
  "pos.return.create",
  "pos.discount.apply",
  "pos.price.override",
  "pos.drawer.open",
  "pos.digital_card.sell",
  "reception.order.create",
  "reception.order.view",
  "reception.order.update",
  "reception.order.cancel",
  "reception.order.deliver",
  "reception.order.print",
  "reception.deposit.collect",
  "reception.proof.send",
  "reception.proof.approve",
  "reception.quote.create",
  "reception.customer.create",
  "workshop.job.view",
  "workshop.job.start",
  "workshop.job.complete",
  "workshop.material.consume",
  "workshop.waste.record",
  "workshop.rework.request",
  "workshop.rework.approve",
  "workshop.queue.reorder",
  "inventory.balance.view",
  "inventory.balance.export",
  "inventory.item.view",
  "inventory.transfer.create",
  "inventory.transfer.dispatch",
  "inventory.transfer.receive",
  "inventory.stocktake.create",
  "inventory.stocktake.record",
  "inventory.stocktake.approve",
  "inventory.adjustment.request",
  "inventory.adjustment.approve",
  "inventory.scrap.write_off",
  "inventory.barcode.print",
  "purchasing.supplier.view",
  "purchasing.supplier.create",
  "purchasing.supplier.update",
  "purchasing.po.create",
  "purchasing.po.confirm",
  "purchasing.po.print",
  "purchasing.po.cancel",
  "purchasing.grn.receive",
  "purchasing.invoice.match",
  "purchasing.return.create",
  "purchasing.payment.request",
  "purchasing.payment.approve",
  "treasury.cashbox.view",
  "treasury.voucher_in.create",
  "treasury.voucher_in.cancel",
  "treasury.voucher_out.create",
  "treasury.voucher_out.approve",
  "treasury.voucher.print",
  "treasury.expense.create",
  "treasury.expense.approve",
  "treasury.transfer.execute",
  "treasury.shift.reconcile",
  "fieldsales.visit.record",
  "fieldsales.quote.create",
  "fieldsales.quote.discount",
  "fieldsales.order.submit",
  "fieldsales.customer.create",
  "fieldsales.statement.view",
  "fieldsales.price_tier.view",
  "delivery.dispatch.create",
  "delivery.parcel.view",
  "delivery.proof.confirm",
  "delivery.proof.partial",
  "delivery.failure.record",
  "delivery.cod.settle",
  "delivery.shortfall.assign",
  "hr.employee.view",
  "hr.attendance.record",
  "hr.attendance.adjust",
  "hr.leave.approve",
  "hr.commission.compute",
  "hr.commission.approve",
  "governance.audit.view",
  "governance.executive.view_kpi",
  "governance.cost_margin.view",
  "governance.limit.override",
];

const ACCOUNTANT_KEYS: AtomicPermissionKey[] = [
  "pos.invoice.view",
  "pos.invoice.reprint",
  "pos.invoice.export",
  "reception.order.view",
  "reception.quote.create",
  "workshop.job.view",
  "workshop.waste.record",
  "inventory.balance.view",
  "inventory.balance.export",
  "inventory.item.view",
  "inventory.stocktake.record",
  "inventory.stocktake.approve",
  "inventory.adjustment.approve",
  "purchasing.supplier.view",
  "purchasing.supplier.create",
  "purchasing.supplier.update",
  "purchasing.po.create",
  "purchasing.po.confirm",
  "purchasing.po.print",
  "purchasing.invoice.match",
  "purchasing.return.create",
  "purchasing.payment.request",
  "purchasing.payment.approve",
  "treasury.cashbox.view",
  "treasury.voucher_in.create",
  "treasury.voucher_in.cancel",
  "treasury.voucher_out.create",
  "treasury.voucher_out.approve",
  "treasury.voucher.print",
  "treasury.expense.create",
  "treasury.expense.approve",
  "treasury.transfer.execute",
  "treasury.shift.reconcile",
  "treasury.period.lock",
  "fieldsales.statement.view",
  "fieldsales.price_tier.view",
  "delivery.cod.settle",
  "delivery.shortfall.assign",
  "hr.employee.view",
  "hr.payroll.compute",
  "hr.payroll.approve",
  "hr.payroll.disburse",
  "hr.commission.compute",
  "hr.commission.approve",
  "governance.audit.view",
  "governance.audit.export",
  "governance.executive.view_kpi",
  "governance.cost_margin.view",
];

const CASHIER_KEYS: AtomicPermissionKey[] = [
  "pos.shift.open",
  "pos.shift.close",
  "pos.invoice.create",
  "pos.invoice.view",
  "pos.invoice.print",
  "pos.invoice.reprint",
  "pos.return.create",
  "pos.discount.apply",
  "pos.digital_card.sell",
  "reception.order.view",
  "reception.deposit.collect",
  "reception.customer.create",
  "inventory.balance.view",
  "inventory.item.view",
  "inventory.barcode.print",
];

const RETAIL_CASHIER_KEYS: AtomicPermissionKey[] = [
  "pos.shift.open",
  "pos.shift.close",
  "pos.invoice.create",
  "pos.invoice.view",
  "pos.invoice.print",
  "pos.invoice.reprint",
  "pos.return.create",
  "pos.discount.apply",
  "pos.digital_card.sell",
  "inventory.balance.view",
  "inventory.item.view",
  "inventory.barcode.print",
];

const PRINT_CASHIER_KEYS: AtomicPermissionKey[] = [
  "pos.shift.open",
  "pos.shift.close",
  "pos.invoice.create",
  "pos.invoice.view",
  "pos.invoice.print",
  "pos.invoice.reprint",
  "pos.return.create",
  "pos.discount.apply",
  "pos.digital_card.sell",
  "reception.order.view",
  "workshop.job.view",
  "inventory.balance.view",
];

const RECEPTION_CLERK_KEYS: AtomicPermissionKey[] = [
  "reception.order.create",
  "reception.order.view",
  "reception.order.update",
  "reception.order.cancel",
  "reception.order.deliver",
  "reception.order.print",
  "reception.deposit.collect",
  "reception.proof.send",
  "reception.proof.approve",
  "reception.quote.create",
  "reception.customer.create",
  "pos.invoice.view",
  "pos.invoice.reprint",
  "pos.return.create",
  "workshop.job.view",
  "inventory.balance.view",
  "inventory.item.view",
];

const WAREHOUSE_KEYS: AtomicPermissionKey[] = [
  "inventory.balance.view",
  "inventory.balance.export",
  "inventory.item.view",
  "inventory.transfer.create",
  "inventory.transfer.dispatch",
  "inventory.transfer.receive",
  "inventory.stocktake.create",
  "inventory.stocktake.record",
  "inventory.adjustment.request",
  "inventory.barcode.print",
  "purchasing.grn.receive",
  "purchasing.supplier.view",
  "workshop.material.consume",
];

const PURCHASING_KEYS: AtomicPermissionKey[] = [
  "purchasing.supplier.view",
  "purchasing.supplier.create",
  "purchasing.supplier.update",
  "purchasing.po.create",
  "purchasing.po.confirm",
  "purchasing.po.print",
  "purchasing.po.cancel",
  "purchasing.grn.receive",
  "purchasing.invoice.match",
  "purchasing.return.create",
  "purchasing.payment.request",
  "inventory.balance.view",
  "inventory.item.view",
];

const PRINT_OPERATOR_KEYS: AtomicPermissionKey[] = [
  "workshop.job.view",
  "workshop.job.start",
  "workshop.job.complete",
  "workshop.material.consume",
  "workshop.waste.record",
  "workshop.rework.request",
  "workshop.queue.reorder",
  "reception.order.view",
  "reception.proof.send",
  "inventory.balance.view",
  "inventory.item.view",
];

const SALES_REP_KEYS: AtomicPermissionKey[] = [
  "fieldsales.visit.record",
  "fieldsales.quote.create",
  "fieldsales.quote.discount",
  "fieldsales.order.submit",
  "fieldsales.customer.create",
  "fieldsales.statement.view",
  "fieldsales.price_tier.view",
  "inventory.balance.view",
  "inventory.item.view",
  "reception.quote.create",
  "reception.customer.create",
];

const COURIER_KEYS: AtomicPermissionKey[] = [
  "delivery.parcel.view",
  "delivery.proof.confirm",
  "delivery.proof.partial",
  "delivery.failure.record",
  "delivery.cod.settle",
];

// المدقق: استعراض وقراءة فقط حصراً (لا طباعة ولا تصدير ولا كتابة)
const AUDITOR_KEYS: AtomicPermissionKey[] = [
  "pos.invoice.view",
  "reception.order.view",
  "workshop.job.view",
  "inventory.balance.view",
  "inventory.item.view",
  "purchasing.supplier.view",
  "treasury.cashbox.view",
  "fieldsales.statement.view",
  "fieldsales.price_tier.view",
  "delivery.parcel.view",
  "hr.employee.view",
  "governance.audit.view",
  "governance.executive.view_kpi",
  "governance.cost_margin.view",
];

const USER_KEYS: AtomicPermissionKey[] = [
  "inventory.balance.view",
  "inventory.item.view",
];

export const ROLE_DEFAULT_ATOMIC_PERMISSIONS: Record<string, AtomicPermissionsMap> = {
  admin: buildAtomicPreset(ADMIN_KEYS),
  manager: buildAtomicPreset(MANAGER_KEYS),
  accountant: buildAtomicPreset(ACCOUNTANT_KEYS),
  cashier: buildAtomicPreset(CASHIER_KEYS),
  retail_cashier: buildAtomicPreset(RETAIL_CASHIER_KEYS),
  print_cashier: buildAtomicPreset(PRINT_CASHIER_KEYS),
  reception_clerk: buildAtomicPreset(RECEPTION_CLERK_KEYS),
  warehouse: buildAtomicPreset(WAREHOUSE_KEYS),
  purchasing: buildAtomicPreset(PURCHASING_KEYS),
  print_operator: buildAtomicPreset(PRINT_OPERATOR_KEYS),
  sales_rep: buildAtomicPreset(SALES_REP_KEYS),
  courier: buildAtomicPreset(COURIER_KEYS),
  auditor: buildAtomicPreset(AUDITOR_KEYS),
  user: buildAtomicPreset(USER_KEYS),
};

export const ROLE_DEFAULT_ATOMIC_TEMPLATES = ROLE_DEFAULT_ATOMIC_PERMISSIONS;

export const ROLE_DEFAULT_OPERATIONAL_CAPS: Record<string, Required<OperationalCaps>> = {
  admin: { ...DEFAULT_UNLIMITED_CAPS },
  manager: {
    maxDiscountPercent: 30,
    maxDiscountAmountIqd: "500000.00",
    maxCreditSaleLimitIqd: "5000000.00",
    maxPaymentVoucherAmountIqd: "10000000.00",
    maxExpenseVoucherAmountIqd: "2500000.00",
    maxRefundAmountIqd: "1000000.00",
  },
  accountant: {
    maxDiscountPercent: 0,
    maxDiscountAmountIqd: "0.00",
    maxCreditSaleLimitIqd: "0.00",
    maxPaymentVoucherAmountIqd: "1000000.00",
    maxExpenseVoucherAmountIqd: "500000.00",
    maxRefundAmountIqd: "0.00",
  },
  cashier: {
    maxDiscountPercent: 5,
    maxDiscountAmountIqd: "25000.00",
    maxCreditSaleLimitIqd: "0.00",
    maxPaymentVoucherAmountIqd: "0.00",
    maxExpenseVoucherAmountIqd: "0.00",
    maxRefundAmountIqd: "25000.00",
  },
  retail_cashier: {
    maxDiscountPercent: 5,
    maxDiscountAmountIqd: "25000.00",
    maxCreditSaleLimitIqd: "0.00",
    maxPaymentVoucherAmountIqd: "0.00",
    maxExpenseVoucherAmountIqd: "0.00",
    maxRefundAmountIqd: "25000.00",
  },
  print_cashier: {
    maxDiscountPercent: 5,
    maxDiscountAmountIqd: "25000.00",
    maxCreditSaleLimitIqd: "0.00",
    maxPaymentVoucherAmountIqd: "0.00",
    maxExpenseVoucherAmountIqd: "0.00",
    maxRefundAmountIqd: "25000.00",
  },
  reception_clerk: {
    maxDiscountPercent: 10,
    maxDiscountAmountIqd: "50000.00",
    maxCreditSaleLimitIqd: "50000.00",
    maxPaymentVoucherAmountIqd: "0.00",
    maxExpenseVoucherAmountIqd: "0.00",
    maxRefundAmountIqd: "50000.00",
  },
  sales_rep: {
    maxDiscountPercent: 15,
    maxDiscountAmountIqd: "150000.00",
    maxCreditSaleLimitIqd: "500000.00",
    maxPaymentVoucherAmountIqd: "0.00",
    maxExpenseVoucherAmountIqd: "0.00",
    maxRefundAmountIqd: "0.00",
  },
  warehouse: { ...DEFAULT_ZERO_CAPS },
  purchasing: { ...DEFAULT_ZERO_CAPS },
  print_operator: { ...DEFAULT_ZERO_CAPS },
  courier: { ...DEFAULT_ZERO_CAPS },
  auditor: { ...DEFAULT_ZERO_CAPS },
  user: { ...DEFAULT_ZERO_CAPS },
};

export const ROLE_DEFAULT_DATA_MASKING: Record<string, Required<SensitiveDataMasking>> = {
  admin: { ...DEFAULT_MASKING_ALL_FALSE },
  manager: { ...DEFAULT_MASKING_ALL_FALSE },
  accountant: { ...DEFAULT_MASKING_ALL_FALSE },
  purchasing: {
    maskPurchaseCost: false,
    maskProfitMargin: true,
    maskSupplierPhone: false,
    maskCustomerContact: true,
  },
  auditor: { ...DEFAULT_MASKING_ALL_FALSE },
  cashier: {
    maskPurchaseCost: true,
    maskProfitMargin: true,
    maskSupplierPhone: true,
    maskCustomerContact: false,
  },
  retail_cashier: {
    maskPurchaseCost: true,
    maskProfitMargin: true,
    maskSupplierPhone: true,
    maskCustomerContact: false,
  },
  print_cashier: {
    maskPurchaseCost: true,
    maskProfitMargin: true,
    maskSupplierPhone: true,
    maskCustomerContact: false,
  },
  reception_clerk: {
    maskPurchaseCost: true,
    maskProfitMargin: true,
    maskSupplierPhone: true,
    maskCustomerContact: false,
  },
  sales_rep: {
    maskPurchaseCost: true,
    maskProfitMargin: true,
    maskSupplierPhone: true,
    maskCustomerContact: false,
  },
  courier: {
    maskPurchaseCost: true,
    maskProfitMargin: true,
    maskSupplierPhone: true,
    maskCustomerContact: false,
  },
  warehouse: { ...DEFAULT_MASKING_ALL_TRUE },
  print_operator: { ...DEFAULT_MASKING_ALL_TRUE },
  user: { ...DEFAULT_MASKING_ALL_TRUE },
};

export const ROLE_DEFAULT_SENSITIVE_MASKING = ROLE_DEFAULT_DATA_MASKING;

// ============================================================================
// ٥. دوال حل واشتقاق الصلاحيات والسقوف (Resolution Engine)
// ============================================================================

export function resolveAtomicPermissions(
  role: string,
  customRoleAtomic?: AtomicPermissionsMap | null,
  userAtomicOverrides?: AtomicPermissionsMap | null,
): AtomicPermissionsMap {
  const basePreset =
    ROLE_DEFAULT_ATOMIC_PERMISSIONS[role] ?? ROLE_DEFAULT_ATOMIC_PERMISSIONS.user;
  const resolved: AtomicPermissionsMap = { ...basePreset };

  if (customRoleAtomic && typeof customRoleAtomic === "object") {
    for (const [key, val] of Object.entries(customRoleAtomic)) {
      if (typeof val === "boolean") {
        resolved[key] = val;
      }
    }
  }

  if (userAtomicOverrides && typeof userAtomicOverrides === "object") {
    for (const [key, val] of Object.entries(userAtomicOverrides)) {
      if (typeof val === "boolean") {
        resolved[key] = val;
      }
    }
  }

  return resolved;
}

export function resolveOperationalCaps(
  role: string,
  roleCaps?: OperationalCaps | null,
  userCapsOverrides?: OperationalCaps | null,
): Required<OperationalCaps> {
  const baseCaps =
    ROLE_DEFAULT_OPERATIONAL_CAPS[role] ?? DEFAULT_ZERO_CAPS;
  const resolved: Required<OperationalCaps> = { ...baseCaps };

  if (roleCaps && typeof roleCaps === "object") {
    if (roleCaps.maxDiscountPercent !== undefined) {
      resolved.maxDiscountPercent = roleCaps.maxDiscountPercent;
    }
    if (roleCaps.maxDiscountAmountIqd !== undefined) {
      resolved.maxDiscountAmountIqd = roleCaps.maxDiscountAmountIqd;
    }
    if (roleCaps.maxCreditSaleLimitIqd !== undefined) {
      resolved.maxCreditSaleLimitIqd = roleCaps.maxCreditSaleLimitIqd;
    }
    if (roleCaps.maxPaymentVoucherAmountIqd !== undefined) {
      resolved.maxPaymentVoucherAmountIqd = roleCaps.maxPaymentVoucherAmountIqd;
    }
    if (roleCaps.maxExpenseVoucherAmountIqd !== undefined) {
      resolved.maxExpenseVoucherAmountIqd = roleCaps.maxExpenseVoucherAmountIqd;
    }
    if (roleCaps.maxRefundAmountIqd !== undefined) {
      resolved.maxRefundAmountIqd = roleCaps.maxRefundAmountIqd;
    }
  }

  if (userCapsOverrides && typeof userCapsOverrides === "object") {
    if (userCapsOverrides.maxDiscountPercent !== undefined) {
      resolved.maxDiscountPercent = userCapsOverrides.maxDiscountPercent;
    }
    if (userCapsOverrides.maxDiscountAmountIqd !== undefined) {
      resolved.maxDiscountAmountIqd = userCapsOverrides.maxDiscountAmountIqd;
    }
    if (userCapsOverrides.maxCreditSaleLimitIqd !== undefined) {
      resolved.maxCreditSaleLimitIqd = userCapsOverrides.maxCreditSaleLimitIqd;
    }
    if (userCapsOverrides.maxPaymentVoucherAmountIqd !== undefined) {
      resolved.maxPaymentVoucherAmountIqd = userCapsOverrides.maxPaymentVoucherAmountIqd;
    }
    if (userCapsOverrides.maxExpenseVoucherAmountIqd !== undefined) {
      resolved.maxExpenseVoucherAmountIqd = userCapsOverrides.maxExpenseVoucherAmountIqd;
    }
    if (userCapsOverrides.maxRefundAmountIqd !== undefined) {
      resolved.maxRefundAmountIqd = userCapsOverrides.maxRefundAmountIqd;
    }
  }

  return resolved;
}

export function resolveSensitiveDataMasking(
  role: string,
  roleMasking?: SensitiveDataMasking | null,
  userMaskingOverrides?: SensitiveDataMasking | null,
): Required<SensitiveDataMasking> {
  const baseMasking =
    ROLE_DEFAULT_DATA_MASKING[role] ?? DEFAULT_MASKING_ALL_TRUE;
  const resolved: Required<SensitiveDataMasking> = { ...baseMasking };

  if (roleMasking && typeof roleMasking === "object") {
    if (roleMasking.maskPurchaseCost !== undefined && roleMasking.maskPurchaseCost !== null) {
      resolved.maskPurchaseCost = roleMasking.maskPurchaseCost;
    }
    if (roleMasking.maskProfitMargin !== undefined && roleMasking.maskProfitMargin !== null) {
      resolved.maskProfitMargin = roleMasking.maskProfitMargin;
    }
    if (roleMasking.maskSupplierPhone !== undefined && roleMasking.maskSupplierPhone !== null) {
      resolved.maskSupplierPhone = roleMasking.maskSupplierPhone;
    }
    if (roleMasking.maskCustomerContact !== undefined && roleMasking.maskCustomerContact !== null) {
      resolved.maskCustomerContact = roleMasking.maskCustomerContact;
    }
  }

  if (userMaskingOverrides && typeof userMaskingOverrides === "object") {
    if (userMaskingOverrides.maskPurchaseCost !== undefined && userMaskingOverrides.maskPurchaseCost !== null) {
      resolved.maskPurchaseCost = userMaskingOverrides.maskPurchaseCost;
    }
    if (userMaskingOverrides.maskProfitMargin !== undefined && userMaskingOverrides.maskProfitMargin !== null) {
      resolved.maskProfitMargin = userMaskingOverrides.maskProfitMargin;
    }
    if (userMaskingOverrides.maskSupplierPhone !== undefined && userMaskingOverrides.maskSupplierPhone !== null) {
      resolved.maskSupplierPhone = userMaskingOverrides.maskSupplierPhone;
    }
    if (userMaskingOverrides.maskCustomerContact !== undefined && userMaskingOverrides.maskCustomerContact !== null) {
      resolved.maskCustomerContact = userMaskingOverrides.maskCustomerContact;
    }
  }

  return resolved;
}

export function hasAtomicPermission(
  permissionsMap: AtomicPermissionsMap | null | undefined,
  key: AtomicPermissionKey,
): boolean {
  if (!permissionsMap) return false;
  return permissionsMap[key] === true;
}

// ============================================================================
// ٦. دوال التوافق الرجعي 100% مع الوحدات الـ29 (Backward Compatibility)
// ============================================================================

export type LegacyAccessLevel = "FULL" | "READ" | "NONE";

export function deriveLegacyModulesFromAtomic(
  atomicMap?: AtomicPermissionsMap | null,
  baseRole?: string,
): Record<string, LegacyAccessLevel> {
  const map = atomicMap ?? {};
  const result: Record<string, LegacyAccessLevel> = {};

  const hasAdminAuthority = Boolean(
    baseRole === "admin" ||
    (map["governance.user.manage"] === true &&
     map["governance.branch.manage"] === true &&
     map["governance.settings.manage"] === true),
  );

  const hasManagerAuthority =
    hasAdminAuthority ||
    Boolean(
      baseRole === "manager" ||
      map["governance.limit.override"] === true ||
      map["governance.branch.manage"] === true ||
      map["governance.settings.manage"] === true,
    );

  const initialModuleKeys = Array.from(
    new Set(ATOMIC_PERMISSION_DEFINITIONS.map((def) => def.legacyModule)),
  );

  for (const mod of initialModuleKeys) {
    const defs = ATOMIC_PERMISSION_DEFINITIONS.filter((def) => def.legacyModule === mod);
    let hasWrite = false;
    let hasRead = false;
    const writeDefs = defs.filter(
      (def) =>
        def.standardAction === "create" ||
        def.standardAction === "edit" ||
        def.standardAction === "cancel" ||
        def.standardAction === "approve",
    );

    for (const def of defs) {
      if (map[def.key] === true) {
        if (
          def.standardAction === "create" ||
          def.standardAction === "edit" ||
          def.standardAction === "cancel" ||
          def.standardAction === "approve"
        ) {
          hasWrite = true;
        } else {
          hasRead = true;
        }
      }
    }

    // إذا كانت كل أفعال الكتابة معطلة صراحة (false) ⇒ لا يُمنح FULL إطلاقاً
    if (writeDefs.length > 0 && writeDefs.every((def) => map[def.key] === false)) {
      hasWrite = false;
    }

    if (hasWrite) {
      result[mod] = "FULL";
    } else if (hasRead) {
      result[mod] = "READ";
    } else {
      result[mod] = "NONE";
    }
  }

  // products
  if (hasManagerAuthority) {
    result.products = "FULL";
  } else if (map["inventory.item.view"] === true || map["fieldsales.price_tier.view"] === true) {
    result.products = "READ";
  } else {
    result.products = "NONE";
  }

  // reports
  if (hasManagerAuthority) {
    result.reports = "FULL";
  } else if (map["governance.audit.export"] === true && map["treasury.expense.approve"] === true) {
    result.reports = "FULL";
  } else if (map["governance.executive.view_kpi"] === true || map["governance.cost_margin.view"] === true) {
    result.reports = "READ";
  } else {
    result.reports = "NONE";
  }

  // customers (alias for crm)
  result.customers = result.crm ?? "NONE";

  // channels
  if (hasManagerAuthority || map["pos.invoice.create"] === true || map["reception.order.create"] === true) {
    result.channels = "FULL";
  } else if (map["reception.order.view"] === true || map["pos.invoice.view"] === true) {
    result.channels = "READ";
  } else {
    result.channels = "NONE";
  }

  // campaigns
  if (hasManagerAuthority) {
    result.campaigns = "FULL";
  } else if (
    map["pos.discount.apply"] === true ||
    map["fieldsales.quote.discount"] === true ||
    map["reception.order.view"] === true ||
    map["governance.audit.view"] === true ||
    map["pos.invoice.view"] === true
  ) {
    result.campaigns = "READ";
  } else {
    result.campaigns = "NONE";
  }

  // store
  if (hasManagerAuthority || map["pos.invoice.create"] === true) {
    result.store = "FULL";
  } else if (
    map["delivery.parcel.view"] === true ||
    map["governance.audit.view"] === true ||
    map["pos.invoice.view"] === true
  ) {
    result.store = "READ";
  } else {
    result.store = "NONE";
  }

  // productStudio
  if (hasManagerAuthority) {
    result.productStudio = "FULL";
  } else if (map["governance.audit.view"] === true && !map["pos.invoice.create"]) {
    result.productStudio = "READ";
  } else {
    result.productStudio = "NONE";
  }

  // assets
  if (hasManagerAuthority) {
    result.assets = "FULL";
  } else if (
    map["inventory.balance.export"] === true ||
    map["inventory.stocktake.create"] === true ||
    map["governance.audit.view"] === true
  ) {
    result.assets = "READ";
  } else {
    result.assets = "NONE";
  }

  // consignments
  if (hasManagerAuthority) {
    result.consignments = "FULL";
  } else if (
    (map["inventory.stocktake.record"] === true && map["inventory.balance.view"] === true) ||
    map["inventory.transfer.create"] === true
  ) {
    result.consignments = "FULL";
  } else if (map["purchasing.supplier.view"] === true || map["governance.audit.view"] === true) {
    result.consignments = "READ";
  } else {
    result.consignments = "NONE";
  }

  // reservations
  if (hasManagerAuthority || map["pos.invoice.create"] === true) {
    result.reservations = "FULL";
  } else if (map["inventory.balance.view"] === true || map["governance.audit.view"] === true) {
    result.reservations = "READ";
  } else {
    result.reservations = "NONE";
  }

  // gifts
  if (hasManagerAuthority) {
    result.gifts = "FULL";
  } else if (
    (map["inventory.scrap.write_off"] === true || map["inventory.transfer.dispatch"] === true) &&
    !map["pos.invoice.create"]
  ) {
    result.gifts = "FULL";
  } else if (map["purchasing.supplier.view"] === true || map["governance.audit.view"] === true) {
    result.gifts = "READ";
  } else {
    result.gifts = "NONE";
  }

  // catalogAnomalies
  if (hasManagerAuthority) {
    result.catalogAnomalies = "FULL";
  } else if (map["governance.cost_margin.view"] === true || map["governance.audit.view"] === true) {
    result.catalogAnomalies = "READ";
  } else {
    result.catalogAnomalies = "NONE";
  }

  // announcements & tasks
  const hasAnyActive = Object.values(map).some((v) => v === true);
  if (hasManagerAuthority) {
    result.announcements = "FULL";
    result.tasks = "FULL";
  } else if (hasAnyActive) {
    result.announcements = "READ";
    result.tasks = "READ";
  } else {
    result.announcements = "NONE";
    result.tasks = "NONE";
  }

  // If admin authority, guarantee FULL for every legacy module
  if (hasAdminAuthority) {
    for (const k of ALL_PERMISSION_MODULE_KEYS) {
      result[k] = "FULL";
    }
  }

  // Ensure all 30 legacy modules from ALL_PERMISSION_MODULE_KEYS exist in result
  for (const k of ALL_PERMISSION_MODULE_KEYS) {
    if (!result[k]) {
      result[k] = "NONE";
    }
  }

  return result;
}

export function deriveAtomicFromLegacyModules(
  legacyModules?: Record<string, LegacyAccessLevel> | null,
  baseRole = "user",
): AtomicPermissionsMap {
  const mods = legacyModules ?? {};
  const baseMap =
    ROLE_DEFAULT_ATOMIC_PERMISSIONS[baseRole] ?? ROLE_DEFAULT_ATOMIC_PERMISSIONS.user;
  const derived: AtomicPermissionsMap = { ...baseMap };

  for (const def of ATOMIC_PERMISSION_DEFINITIONS) {
    const modLevel = mods[def.legacyModule];
    if (modLevel === "FULL") {
      if (def.sensitivity === "critical" && baseRole !== "admin") {
        derived[def.key] = baseMap[def.key] ?? false;
      } else {
        derived[def.key] = true;
      }
    } else if (modLevel === "READ") {
      derived[def.key] = def.standardAction === "view";
    } else if (modLevel === "NONE") {
      derived[def.key] = false;
    }
  }

  return derived;
}

export function isPermissionEnvelope(value: unknown): value is PermissionEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return "atomic" in obj || "caps" in obj || "masking" in obj || "modules" in obj;
}

export function normalizePermissionsInput(
  input: unknown,
  baseRole = "user",
): {
  legacy: Record<string, LegacyAccessLevel>;
  legacyModules: Record<string, LegacyAccessLevel>;
  atomic: AtomicPermissionsMap;
  caps: Required<OperationalCaps>;
  masking: Required<SensitiveDataMasking>;
} {
  const defaultCaps =
    ROLE_DEFAULT_OPERATIONAL_CAPS[baseRole] ?? DEFAULT_ZERO_CAPS;
  const defaultMasking =
    ROLE_DEFAULT_DATA_MASKING[baseRole] ?? DEFAULT_MASKING_ALL_TRUE;

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const atomic = resolveAtomicPermissions(baseRole);
    const legacy = deriveLegacyModulesFromAtomic(atomic, baseRole);
    return {
      legacy,
      legacyModules: legacy,
      atomic,
      caps: defaultCaps,
      masking: defaultMasking,
    };
  }

  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);

  // Fix 2: Handle empty object {}
  if (keys.length === 0) {
    const atomic = resolveAtomicPermissions(baseRole);
    const legacy = deriveLegacyModulesFromAtomic(atomic, baseRole);
    return {
      legacy,
      legacyModules: legacy,
      atomic,
      caps: defaultCaps,
      masking: defaultMasking,
    };
  }

  if (isPermissionEnvelope(input)) {
    const atomic = resolveAtomicPermissions(
      baseRole,
      input.atomic as AtomicPermissionsMap,
    );
    const caps = resolveOperationalCaps(
      baseRole,
      input.caps,
    );
    const masking = resolveSensitiveDataMasking(
      baseRole,
      input.masking,
    );
    const legacy = input.modules ?? deriveLegacyModulesFromAtomic(atomic, baseRole);
    return { legacy, legacyModules: legacy, atomic, caps, masking };
  }

  const isAtomicFlat = keys.some((k) => k.includes("."));

  if (isAtomicFlat) {
    const atomic = resolveAtomicPermissions(baseRole, obj as AtomicPermissionsMap);
    const legacy = deriveLegacyModulesFromAtomic(atomic, baseRole);
    return {
      legacy,
      legacyModules: legacy,
      atomic,
      caps: defaultCaps,
      masking: defaultMasking,
    };
  }

  const legacy = obj as Record<string, LegacyAccessLevel>;
  const atomic = deriveAtomicFromLegacyModules(legacy, baseRole);
  return {
    legacy,
    legacyModules: legacy,
    atomic,
    caps: defaultCaps,
    masking: defaultMasking,
  };
}

// ============================================================================
// ٧. مساعدات واجهة مصفوفة الصلاحيات والحوكمة (UI & Ergonomics Helpers)
// ============================================================================

export function getAtomicPermissionsByDomain(domain: DomainKey): AtomicPermissionDefinition[] {
  return ATOMIC_PERMISSION_DEFINITIONS.filter((def) => def.domain === domain);
}

export function getAtomicPermissionsByResource(
  domain: DomainKey,
  resource: string,
): AtomicPermissionDefinition[] {
  return ATOMIC_PERMISSION_DEFINITIONS.filter(
    (def) => def.domain === domain && def.resource === resource,
  );
}

export function searchAtomicPermissions(query?: string | null): AtomicPermissionDefinition[] {
  if (!query) return [...ATOMIC_PERMISSION_DEFINITIONS];
  const qTrim = query.trim();
  if (!qTrim) return [...ATOMIC_PERMISSION_DEFINITIONS];

  const normQ = normalizeSearchText(qTrim);
  const rawQ = qTrim.toLowerCase();

  return ATOMIC_PERMISSION_DEFINITIONS.filter((def) => {
    const normText = ATOMIC_PERMISSION_SEARCH_TEXTS.get(def.key);
    if (normText && normText.includes(normQ)) return true;

    return (
      def.key.toLowerCase().includes(rawQ) ||
      def.resource.toLowerCase().includes(rawQ) ||
      def.action.toLowerCase().includes(rawQ) ||
      def.label.toLowerCase().includes(rawQ) ||
      def.description.toLowerCase().includes(rawQ)
    );
  });
}

export function getDomainStats(
  arg1?: DomainKey | AtomicPermissionsMap | null,
  arg2?: DomainKey | AtomicPermissionsMap | null,
): {
  total: number;
  totalCount: number;
  granted: number;
  grantedCount: number;
  percent: number;
  percentage: number;
} {
  const domain = (typeof arg1 === "string" ? arg1 : typeof arg2 === "string" ? arg2 : "pos") as DomainKey;
  const permissions = (typeof arg1 === "object" && arg1 !== null ? arg1 : typeof arg2 === "object" && arg2 !== null ? arg2 : {}) as AtomicPermissionsMap;
  const defs = getAtomicPermissionsByDomain(domain);
  const total = defs.length;
  if (total === 0) {
    return {
      total: 0,
      totalCount: 0,
      granted: 0,
      grantedCount: 0,
      percent: 0,
      percentage: 0,
    };
  }

  const granted = defs.filter((d) => permissions && permissions[d.key] === true).length;
  const percent = Math.round((granted / total) * 100);
  return {
    total,
    totalCount: total,
    granted,
    grantedCount: granted,
    percent,
    percentage: percent,
  };
}

export interface AtomicOverrideDetail {
  overridden: boolean;
  granted: boolean;
  baseGranted: boolean;
}

export type AtomicOverrideStatus = AtomicOverrideDetail;

export function filterAtomicOverrides(
  current?: AtomicPermissionsMap | null,
  base?: AtomicPermissionsMap | null,
): Record<AtomicPermissionKey, AtomicOverrideDetail> {
  const result = {} as Record<AtomicPermissionKey, AtomicOverrideDetail>;
  const cur = current ?? {};
  const bas = base ?? {};

  for (const def of ATOMIC_PERMISSION_DEFINITIONS) {
    const baseVal = Boolean(bas[def.key]);
    const curVal = Boolean(cur[def.key]);
    const isOverridden = curVal !== baseVal;
    result[def.key] = {
      overridden: isOverridden,
      granted: curVal,
      baseGranted: baseVal,
    };
  }

  return result;
}

export function checkSodConflicts(
  permissions?: AtomicPermissionsMap | null,
): Array<{ group: string; conflictingKeys: [AtomicPermissionKey, AtomicPermissionKey] }> {
  if (!permissions) return [];
  const conflicts: Array<{
    group: string;
    conflictingKeys: [AtomicPermissionKey, AtomicPermissionKey];
  }> = [];

  const groups = Array.from(
    new Set(ATOMIC_PERMISSION_DEFINITIONS.filter((d) => Boolean(d.sodGroup)).map((d) => d.sodGroup!)),
  );

  for (const grp of groups) {
    const groupedDefs = ATOMIC_PERMISSION_DEFINITIONS.filter((d) => d.sodGroup === grp);
    const active = groupedDefs.filter((d) => permissions[d.key] === true);

    if (active.length >= 2) {
      conflicts.push({
        group: grp,
        conflictingKeys: [active[0].key, active[1].key],
      });
    }
  }

  return conflicts;
}

// ============================================================================
// ٨. دوال التحقق من السقوف الرقمية (Caps Enforcement Helpers)
// ============================================================================

function parseMoneyAmount(amount: string | number): number {
  if (typeof amount === "number") {
    return isNaN(amount) || !isFinite(amount) ? -1 : amount;
  }
  if (typeof amount !== "string" || !amount.trim()) return -1;
  const num = Number(amount);
  return isNaN(num) || !isFinite(num) ? -1 : num;
}

export function isDiscountPercentWithinCap(
  percent: number,
  caps?: OperationalCaps | null,
): boolean {
  if (isNaN(percent) || !isFinite(percent) || percent < 0 || percent > 100) return false;
  if (!caps || caps.maxDiscountPercent === null || caps.maxDiscountPercent === undefined) return true;
  return percent <= caps.maxDiscountPercent;
}

export function isDiscountAmountWithinCap(
  amountIqd: string | number,
  caps?: OperationalCaps | null,
): boolean {
  const num = parseMoneyAmount(amountIqd);
  if (num < 0) return false;
  if (!caps || caps.maxDiscountAmountIqd === null || caps.maxDiscountAmountIqd === undefined) return true;
  const cap = parseMoneyAmount(caps.maxDiscountAmountIqd);
  return num <= cap;
}

export function isCreditSaleWithinCap(
  creditAmountIqd: string | number,
  caps?: OperationalCaps | null,
): boolean {
  const num = parseMoneyAmount(creditAmountIqd);
  if (num < 0) return false;
  if (!caps || caps.maxCreditSaleLimitIqd === null || caps.maxCreditSaleLimitIqd === undefined) return true;
  const cap = parseMoneyAmount(caps.maxCreditSaleLimitIqd);
  return num <= cap;
}

export function isPaymentVoucherWithinCap(
  voucherAmountIqd: string | number,
  caps?: OperationalCaps | null,
): boolean {
  const num = parseMoneyAmount(voucherAmountIqd);
  if (num < 0) return false;
  if (!caps || caps.maxPaymentVoucherAmountIqd === null || caps.maxPaymentVoucherAmountIqd === undefined) return true;
  const cap = parseMoneyAmount(caps.maxPaymentVoucherAmountIqd);
  return num <= cap;
}

export function isExpenseWithinCap(
  expenseAmountIqd: string | number,
  caps?: OperationalCaps | null,
): boolean {
  const num = parseMoneyAmount(expenseAmountIqd);
  if (num < 0) return false;
  if (!caps || caps.maxExpenseVoucherAmountIqd === null || caps.maxExpenseVoucherAmountIqd === undefined) return true;
  const cap = parseMoneyAmount(caps.maxExpenseVoucherAmountIqd);
  return num <= cap;
}

export function isRefundWithinCap(
  refundAmountIqd: string | number,
  caps?: OperationalCaps | null,
): boolean {
  const num = parseMoneyAmount(refundAmountIqd);
  if (num < 0) return false;
  if (!caps || caps.maxRefundAmountIqd === null || caps.maxRefundAmountIqd === undefined) return true;
  const cap = parseMoneyAmount(caps.maxRefundAmountIqd);
  return num <= cap;
}


export interface ResourceMetadata {
  domain: DomainKey;
  resource: string;
  label: string;
  labelAr: string;
  description: string;
  descriptionAr: string;
  iconName: string;
}

const BASE_RESOURCE_METADATA: Record<string, ResourceMetadata> = {
  // pos
  "pos.shift": { domain: "pos", resource: "shift", label: "ورديات الصندوق وجرد Z", labelAr: "ورديات الصندوق وجرد Z", description: "فتح وإغلاق الورديات، جرد النقدية، وتقارير Z اليومية", descriptionAr: "فتح وإغلاق الورديات، جرد النقدية، وتقارير Z اليومية", iconName: "Clock" },
  "pos.invoice": { domain: "pos", resource: "invoice", label: "فواتير المبيعات الفورية", labelAr: "فواتير المبيعات الفورية", description: "إصدار، تعديل، إلغاء، طباعة، وتصدير إيصالات وفواتير الكاشير", descriptionAr: "إصدار، تعديل، إلغاء، طباعة، وتصدير إيصالات وفواتير الكاشير", iconName: "Receipt" },
  "pos.return": { domain: "pos", resource: "return", label: "المرتجع والاستبدال الفوري", labelAr: "المرتجع والاستبدال الفوري", description: "إصدار مرتجع مبيعات بفاتورة أو بدون، استبدال الأصناف، واعتماد الاسترداد", descriptionAr: "إصدار مرتجع مبيعات بفاتورة أو بدون، استبدال الأصناف، واعتماد الاسترداد", iconName: "RotateCcw" },
  "pos.discount": { domain: "pos", resource: "discount", label: "خصومات نقطة البيع", labelAr: "خصومات نقطة البيع", description: "تطبيق الخصم التجاري اليدوي وتجاوز سقف الخصم المصرح به", descriptionAr: "تطبيق الخصم التجاري اليدوي وتجاوز سقف الخصم المصرح به", iconName: "Percent" },
  "pos.price": { domain: "pos", resource: "price", label: "تسعير وبنود الفاتورة", labelAr: "تسعير وبنود الفاتورة", description: "تعديل أسعار بيع الأصناف يدوياً وتجاوز السعر النظامي بالوردية", descriptionAr: "تعديل أسعار بيع الأصناف يدوياً وتجاوز السعر النظامي بالوردية", iconName: "Tag" },
  "pos.drawer": { domain: "pos", resource: "drawer", label: "درج النقدية والخزينة", labelAr: "درج النقدية والخزينة", description: "فتح درج النقدية يدوياً بدون عملية بيع ومطابقة النقدية", descriptionAr: "فتح درج النقدية يدوياً بدون عملية بيع ومطابقة النقدية", iconName: "DollarSign" },
  "pos.digital_card": { domain: "pos", resource: "digital_card", label: "البطاقات الرقمية والشحن", labelAr: "البطاقات الرقمية والشحن", description: "بيع وشحن وطباعة أكواد بطاقات الإنترنت والاتصالات", descriptionAr: "بيع وشحن وطباعة أكواد بطاقات الإنترنت والاتصالات", iconName: "CreditCard" },
  "pos.operations": { domain: "pos", resource: "operations", label: "العمليات الاستثنائية للكاشير", labelAr: "العمليات الاستثنائية للكاشير", description: "تعليق واسترجاع الفواتير، تقسيم الفاتورة، والبيع الآجل على الحساب", descriptionAr: "تعليق واسترجاع الفواتير، تقسيم الفاتورة، والبيع الآجل على الحساب", iconName: "Sliders" },

  // reception
  "reception.order": { domain: "reception", resource: "order", label: "أوامر الشغل وطلبات العملاء", labelAr: "أوامر الشغل وطلبات العملاء", description: "فتح، تعديل، إلغاء، طباعة، وتسليم أوامر الشغل الفنية للعميل", descriptionAr: "فتح، تعديل، إلغاء، طباعة، وتسليم أوامر الشغل الفنية للعميل", iconName: "ClipboardList" },
  "reception.deposit": { domain: "reception", resource: "deposit", label: "العربون والدفعات المقدمة", labelAr: "العربون والدفعات المقدمة", description: "قبض العربون، ترحيل الدفعة المقدمة، واسترداد أو إلغاء العربون", descriptionAr: "قبض العربون، ترحيل الدفعة المقدمة، واسترداد أو إلغاء العربون", iconName: "Coins" },
  "reception.proof": { domain: "reception", resource: "proof", label: "البروفات والتصاميم الفنية", labelAr: "البروفات والتصاميم الفنية", description: "رفع واستعراض نماذج التصميم واعتماد بروفة الطباعة قبل التنفيذ", descriptionAr: "رفع واستعراض نماذج التصميم واعتماد بروفة الطباعة قبل التنفيذ", iconName: "Image" },
  "reception.quote": { domain: "reception", resource: "quote", label: "عروض أسعار الاستقبال", labelAr: "عروض أسعار الاستقبال", description: "إنشاء وطباعة عروض الأسعار التقديرية لخدمات الطباعة والتصميم", descriptionAr: "إنشاء وطباعة عروض الأسعار التقديرية لخدمات الطباعة والتصميم", iconName: "FileText" },
  "reception.customer": { domain: "reception", resource: "customer", label: "عملاء الاستقبال والزيارات", labelAr: "عملاء الاستقبال والزيارات", description: "تسجيل بيانات العملاء الجدد ومتابعة متطلباتهم الفنية", descriptionAr: "تسجيل بيانات العملاء الجدد ومتابعة متطلباتهم الفنية", iconName: "UserCheck" },

  // workshop
  "workshop.job": { domain: "workshop", resource: "job", label: "أوامر التشغيل والماكينات", labelAr: "أوامر التشغيل والماكينات", description: "جدولة، تشغيل، تعيين الماكينات والفنيين، وإتمام أوامر الإنتاج الصناعي", descriptionAr: "جدولة، تشغيل، تعيين الماكينات والفنيين، وإتمام أوامر الإنتاج الصناعي", iconName: "Wrench" },
  "workshop.material": { domain: "workshop", resource: "material", label: "استهلاك المواد الخام", labelAr: "استهلاك المواد الخام", description: "صرف وإثبات استهلاك الورق والأحبار والخامات من المستودع", descriptionAr: "صرف وإثبات استهلاك الورق والأحبار والخامات من المستودع", iconName: "Layers" },
  "workshop.waste": { domain: "workshop", resource: "waste", label: "الهالك والتالف الصناعي", labelAr: "الهالك والتالف الصناعي", description: "إثبات وتوثيق هالك الطباعة والتالف واعتماد نسب الفاقد", descriptionAr: "إثبات وتوثيق هالك الطباعة والتالف واعتماد نسب الفاقد", iconName: "Trash2" },
  "workshop.rework": { domain: "workshop", resource: "rework", label: "إعادة التشغيل والجودة", labelAr: "إعادة التشغيل والجودة", description: "طلب واعتماد إعادة الطباعة وفحص ومعايرة الجودة قبل التسليم", descriptionAr: "طلب واعتماد إعادة الطباعة وفحص ومعايرة الجودة قبل التسليم", iconName: "RefreshCw" },
  "workshop.queue": { domain: "workshop", resource: "queue", label: "خطوط الإنتاج والجدولة", labelAr: "خطوط الإنتاج والجدولة", description: "إعادة ترتيب أولويات التشغيل وجدولة مواعيد التسليم الفني", descriptionAr: "إعادة ترتيب أولويات التشغيل وجدولة مواعيد التسليم الفني", iconName: "ListOrdered" },
  "workshop.pricing": { domain: "workshop", resource: "pricing", label: "معادلات تسعير الطباعة", labelAr: "معادلات تسعير الطباعة", description: "استعراض وتعديل تكاليف التشغيل وجداول تسعير خدمات المطبعة", descriptionAr: "استعراض وتعديل تكاليف التشغيل وجداول تسعير خدمات المطبعة", iconName: "Calculator" },

  // inventory
  "inventory.item": { domain: "inventory", resource: "item", label: "كتالوج الأصناف والمنتجات", labelAr: "كتالوج الأصناف والمنتجات", description: "إضافة، تعديل، أرشفة، وتصدير الأصناف وتوليد ملصقات الباركود", descriptionAr: "إضافة، تعديل، أرشفة، وتصدير الأصناف وتوليد ملصقات الباركود", iconName: "Package" },
  "inventory.balance": { domain: "inventory", resource: "balance", label: "الأرصدة وحركات المخزون", labelAr: "الأرصدة وحركات المخزون", description: "استعراض كميات وأرصدة الفروع، تتبع حركات الصنف، وتصدير كشف الجرد", descriptionAr: "استعراض كميات وأرصدة الفروع، تتبع حركات الصنف، وتصدير كشف الجرد", iconName: "BarChart3" },
  "inventory.transfer": { domain: "inventory", resource: "transfer", label: "المناقلات بين الفروع", labelAr: "المناقلات بين الفروع", description: "إنشاء، إرسال، شحن، واستلام بضاعة المناقلات بين المستودعات", descriptionAr: "إنشاء، إرسال، شحن، واستلام بضاعة المناقلات بين المستودعات", iconName: "ArrowLeftRight" },
  "inventory.stocktake": { domain: "inventory", resource: "stocktake", label: "الجرد الدوري والمفاجئ", labelAr: "الجرد الدوري والمفاجئ", description: "فتح دورات الجرد، تسجيل العد الفعلي، اعتماد الفروقات، وتسوية المخزون", descriptionAr: "فتح دورات الجرد، تسجيل العد الفعلي، اعتماد الفروقات، وتسوية المخزون", iconName: "CheckSquare" },
  "inventory.adjustment": { domain: "inventory", resource: "adjustment", label: "تسويات المخزون المباشرة", labelAr: "تسويات المخزون المباشرة", description: "إجراء تسويات مخزنية مباشرة للكميات وتعديل الأرصدة المستندية", descriptionAr: "إجراء تسويات مخزنية مباشرة للكميات وتعديل الأرصدة المستندية", iconName: "SlidersHorizontal" },
  "inventory.scrap": { domain: "inventory", resource: "scrap", label: "الهالك وإتلاف المخزون", labelAr: "الهالك وإتلاف المخزون", description: "إثبات واعتماد شطب وإتلاف الأصناف التالفة والمنتهية الصلاحية", descriptionAr: "إثبات واعتماد شطب وإتلاف الأصناف التالفة والمنتهية الصلاحية", iconName: "ArchiveX" },
  "inventory.barcode": { domain: "inventory", resource: "barcode", label: "طباعة ملصقات الباركود", labelAr: "طباعة ملصقات الباركود", description: "تصميم وطباعة ملصقات الباركود وباركود الرفوف للأصناف", descriptionAr: "تصميم وطباعة ملصقات الباركود وباركود الرفوف للأصناف", iconName: "ScanLine" },
  "inventory.consignment": { domain: "inventory", resource: "consignment", label: "بضاعة الأمانة", labelAr: "بضاعة الأمانة", description: "استلام بضاعة أمانة من الموردين، تسوية مبيعاتها، وإعادتها", descriptionAr: "استلام بضاعة أمانة من الموردين، تسوية مبيعاتها، وإعادتها", iconName: "HandCoins" },

  // purchasing
  "purchasing.supplier": { domain: "purchasing", resource: "supplier", label: "سجل الموردين والتجار", labelAr: "سجل الموردين والتجار", description: "إضافة وتعديل بيانات الموردين، كشوف الحسابات، وحظر التعامل", descriptionAr: "إضافة وتعديل بيانات الموردين، كشوف الحسابات، وحظر التعامل", iconName: "Truck" },
  "purchasing.po": { domain: "purchasing", resource: "po", label: "أوامر الشراء الرسمية", labelAr: "أوامر الشراء الرسمية", description: "إنشاء، تعديل، إلغاء، اعتماد، وطباعة أوامر الشراء للموردين", descriptionAr: "إنشاء، تعديل، إلغاء، اعتماد، وطباعة أوامر الشراء للموردين", iconName: "FileCheck2" },
  "purchasing.grn": { domain: "purchasing", resource: "grn", label: "أذونات استلام البضاعة GRN", labelAr: "أذونات استلام البضاعة GRN", description: "إثبات استلام الشحنات، فحص الجودة، وعكس أذونات الاستلام", descriptionAr: "إثبات استلام الشحنات، فحص الجودة، وعكس أذونات الاستلام", iconName: "PackageCheck" },
  "purchasing.invoice": { domain: "purchasing", resource: "invoice", label: "فواتير المشتريات والمطابقة", labelAr: "فواتير المشتريات والمطابقة", description: "تسجيل فواتير الموردين، المطابقة الثلاثية، واعتماد الفواتير للصرف", descriptionAr: "تسجيل فواتير الموردين، المطابقة الثلاثية، واعتماد الفواتير للصرف", iconName: "FileSpreadsheet" },
  "purchasing.return": { domain: "purchasing", resource: "return", label: "مرتجعات المشتريات للموردين", labelAr: "مرتجعات المشتريات للموردين", description: "إنشاء مرتجع بضاعة للمورد، إصدار إشعار مدين، واعتماد الاسترداد", descriptionAr: "إنشاء مرتجع بضاعة للمورد، إصدار إشعار مدين، واعتماد الاسترداد", iconName: "Undo2" },
  "purchasing.payment": { domain: "purchasing", resource: "payment", label: "مدفوعات ومستحقات الموردين", labelAr: "مدفوعات ومستحقات الموردين", description: "طلب واعتماد مدفوعات الموردين وجدولة الديون والتحويلات", descriptionAr: "طلب واعتماد مدفوعات الموردين وجدولة الديون والتحويلات", iconName: "Wallet" },
  "purchasing.charges": { domain: "purchasing", resource: "charges", label: "تكاليف الشحن والجمارك", labelAr: "تكاليف الشحن والجمارك", description: "توزيع مصاريف الشحن والتخليص الجمركي على تكلفة المخزون", descriptionAr: "توزيع مصاريف الشحن والتخليص الجمركي على تكلفة المخزون", iconName: "Ship" },

  // treasury
  "treasury.cashbox": { domain: "treasury", resource: "cashbox", label: "الخزائن والصناديق والأرصدة", labelAr: "الخزائن والصناديق والأرصدة", description: "استعراض أرصدة الخزائن والبنوك، التحويل النقدي، والمطابقة الدورية", descriptionAr: "استعراض أرصدة الخزائن والبنوك، التحويل النقدي، والمطابقة الدورية", iconName: "Landmark" },
  "treasury.voucher_in": { domain: "treasury", resource: "voucher_in", label: "سندات القبض النقدية والبنكية", labelAr: "سندات القبض النقدية والبنكية", description: "تحرير، طباعة، وإلغاء سندات القبض النقدية والبنكية", descriptionAr: "تحرير، طباعة، وإلغاء سندات القبض النقدية والبنكية", iconName: "ArrowDownToLine" },
  "treasury.voucher_out": { domain: "treasury", resource: "voucher_out", label: "سندات الصرف والمدفوعات", labelAr: "سندات الصرف والمدفوعات", description: "تحرير، اعتماد، طباعة، وإلغاء سندات الصرف والشيكات", descriptionAr: "تحرير، اعتماد، طباعة، وإلغاء سندات الصرف والشيكات", iconName: "ArrowUpFromLine" },
  "treasury.voucher": { domain: "treasury", resource: "voucher", label: "طباعة وأرشفة السندات", labelAr: "طباعة وأرشفة السندات", description: "طباعة وتصدير نماذج السندات المالية الرسمية المعتمدة", descriptionAr: "طباعة وتصدير نماذج السندات المالية الرسمية المعتمدة", iconName: "Printer" },
  "treasury.expense": { domain: "treasury", resource: "expense", label: "المصروفات التشغيلية والنثريات", labelAr: "المصروفات التشغيلية والنثريات", description: "تسجيل، تصنيف، واعتماد طلبات المصروفات التشغيلية والإدارية", descriptionAr: "تسجيل، تصنيف، واعتماد طلبات المصروفات التشغيلية والإدارية", iconName: "CreditCard" },
  "treasury.transfer": { domain: "treasury", resource: "transfer", label: "المناقلات والتحويلات المالية", labelAr: "المناقلات والتحويلات المالية", description: "تنفيذ واعتماد التحويلات المالية بين الصناديق والحسابات البنكية", descriptionAr: "تنفيذ واعتماد التحويلات المالية بين الصناديق والحسابات البنكية", iconName: "Repeat" },
  "treasury.shift": { domain: "treasury", resource: "shift", label: "تسوية وتصفية الورديات", labelAr: "تسوية وتصفية الورديات", description: "مطابقة إيرادات الورديات مع نقدية الصندوق وترحيل الفروقات", descriptionAr: "مطابقة إيرادات الورديات مع نقدية الصندوق وترحيل الفروقات", iconName: "Scale" },
  "treasury.period": { domain: "treasury", resource: "period", label: "إقفال الفترات والسنة المالية", labelAr: "إقفال الفترات والسنة المالية", description: "قفل الشهر المحاسبي، إعادة فتح الفترات، وإجراء إقفال السنة المالية", descriptionAr: "إقفال الشهر المحاسبي، إعادة فتح الفترات، وإجراء إقفال السنة المالية", iconName: "Lock" },

  // fieldsales
  "fieldsales.customer": { domain: "fieldsales", resource: "customer", label: "العملاء والحسابات التجارية", labelAr: "العملاء والحسابات التجارية", description: "إضافة وتعديل العملاء، استخراج كشف الحساب، وتحديد سقف الائتمان", descriptionAr: "إضافة وتعديل العملاء، استخراج كشف الحساب، وتحديد سقف الائتمان", iconName: "Building2" },
  "fieldsales.quote": { domain: "fieldsales", resource: "quote", label: "عروض الأسعار والمفاوضات", labelAr: "عروض الأسعار والمفاوضات", description: "إنشاء، تعديل، تطبيق الخصم، طباعة، وتحويل عروض الأسعار لفواتير", descriptionAr: "إنشاء، تعديل، تطبيق الخصم، طباعة، وتحويل عروض الأسعار لفواتير", iconName: "FileSignature" },
  "fieldsales.order": { domain: "fieldsales", resource: "order", label: "طلبيات المبيعات وعقود التوريد", labelAr: "طلبيات المبيعات وعقود التوريد", description: "إنشاء، اعتماد، وتنفيذ طلبيات البيع التجارية وعقود التوريد", descriptionAr: "إنشاء، اعتماد، وتنفيذ طلبيات البيع التجارية وعقود التوريد", iconName: "ShoppingBag" },
  "fieldsales.visit": { domain: "fieldsales", resource: "visit", label: "الزيارات الميدانية والمتابعة", labelAr: "الزيارات الميدانية والمتابعة", description: "تسجيل زيارات المناديب للعملاء، متابعة التحصيل، وخطط السير", descriptionAr: "تسجيل زيارات المناديب للعملاء، متابعة التحصيل، وخطط السير", iconName: "MapPin" },
  "fieldsales.statement": { domain: "fieldsales", resource: "statement", label: "كشوفات الحساب والمطابقات", labelAr: "كشوفات الحساب والمطابقات", description: "استعراض وطباعة كشوفات حساب العملاء ومطابقة الأرصدة", descriptionAr: "استعراض وطباعة كشوفات حساب العملاء ومطابقة الأرصدة", iconName: "FileText" },
  "fieldsales.price_tier": { domain: "fieldsales", resource: "price_tier", label: "شرائح الأسعار والخصومات", labelAr: "شرائح الأسعار والخصومات", description: "استعراض وتطبيق فئات الأسعار الخاصة بالجملة والتجار", descriptionAr: "استعراض وتطبيق فئات الأسعار الخاصة بالجملة والتجار", iconName: "Tags" },

  // delivery
  "delivery.dispatch": { domain: "delivery", resource: "dispatch", label: "بوالص الشحن والإرساليات", labelAr: "بوالص الشحن والإرساليات", description: "إنشاء بوالص الشحن، تعيين السائق، طباعة البوليصة، وإلغاء الشحنة", descriptionAr: "إنشاء بوالص الشحن، تعيين السائق، طباعة البوليصة، وإلغاء الشحنة", iconName: "Navigation" },
  "delivery.parcel": { domain: "delivery", resource: "parcel", label: "تتبع الطرود والشحنات", labelAr: "تتبع الطرود والشحنات", description: "متابعة مسار الشحنات، تحديث مراحل التسليم، وتوثيق محاولات التوصيل", descriptionAr: "متابعة مسار الشحنات، تحديث مراحل التسليم، وتوثيق محاولات التوصيل", iconName: "Box" },
  "delivery.proof": { domain: "delivery", resource: "proof", label: "إثبات التسليم للعميل", labelAr: "إثبات التسليم للعميل", description: "تأكيد التسليم التام، إثبات التسليم الجزئي، وتوثيق التوقيع والصورة", descriptionAr: "تأكيد التسليم التام، إثبات التسليم الجزئي، وتوثيق التوقيع والصورة", iconName: "BadgeCheck" },
  "delivery.failure": { domain: "delivery", resource: "failure", label: "الشحنات الراجعة والمتعثرة", labelAr: "الشحنات الراجعة والمتعثرة", description: "تسجيل أسباب تعذر التسليم، إرجاع الشحنة للمستودع، وجدولة إعادة التوصيل", descriptionAr: "تسجيل أسباب تعذر التسليم، إرجاع الشحنة للمستودع، وجدولة إعادة التوصيل", iconName: "AlertOctagon" },
  "delivery.cod": { domain: "delivery", resource: "cod", label: "مبالغ الدفع عند الاستلام COD", labelAr: "مبالغ الدفع عند الاستلام COD", description: "استعراض وتوريد مبالغ الـ COD المحصلة من السائقين للخزينة", descriptionAr: "استعراض وتوريد مبالغ الـ COD المحصلة من السائقين للخزينة", iconName: "Banknote" },
  "delivery.shortfall": { domain: "delivery", resource: "shortfall", label: "تسوية عجز وفروقات التوصيل", labelAr: "تسوية عجز وفروقات التوصيل", description: "إثبات وتعيين عجز السائقين وتسوية أو شطب الفروقات اللوجستية", descriptionAr: "إثبات وتعيين عجز السائقين وتسوية أو شطب الفروقات اللوجستية", iconName: "AlertTriangle" },

  // hr
  "hr.employee": { domain: "hr", resource: "employee", label: "ملفات الموظفين والكوادر", labelAr: "ملفات الموظفين والكوادر", description: "إضافة، تعديل، إنهاء الخدمة، إدارة الوثائق، ورؤية تفاصيل الرواتب", descriptionAr: "إضافة، تعديل، إنهاء الخدمة، إدارة الوثائق، ورؤية تفاصيل الرواتب", iconName: "Users" },
  "hr.attendance": { domain: "hr", resource: "attendance", label: "الحضور وأجهزة البصمة", labelAr: "الحضور وأجهزة البصمة", description: "سجلات البصمة، التعديل اليدوي، اعتماد التجاوزات، ومزامنة أجهزة الحضور", descriptionAr: "سجلات البصمة، التعديل اليدوي، اعتماد التجاوزات، ومزامنة أجهزة الحضور", iconName: "Fingerprint" },
  "hr.leave": { domain: "hr", resource: "leave", label: "الإجازات والمغادرات", labelAr: "الإجازات والمغادرات", description: "تقديم طلبات الإجازات، استعراض الأرصدة، واعتماد أو رفض الإجازات", descriptionAr: "تقديم طلبات الإجازات، استعراض الأرصدة، واعتماد أو رفض الإجازات", iconName: "CalendarDays" },
  "hr.payroll": { domain: "hr", resource: "payroll", label: "مسير الرواتب والأجور والسلف", labelAr: "مسير الرواتب والأجور والسلف", description: "احتساب مسير الرواتب، خصم الغيابات، اعتماد وصرف الرواتب، وإدارة السلف", descriptionAr: "احتساب مسير الرواتب، خصم الغيابات، اعتماد وصرف الرواتب، وإدارة السلف", iconName: "BadgeDollarSign" },
  "hr.commission": { domain: "hr", resource: "commission", label: "عمولات وحوافز المبيعات", labelAr: "عمولات وحوافز المبيعات", description: "احتساب عمولات المناديب، اعتماد الترحيل، وصرف الحوافز", descriptionAr: "احتساب عمولات المناديب، اعتماد الترحيل، وصرف الحوافز", iconName: "Award" },

  // governance
  "governance.user": { domain: "governance", resource: "user", label: "إدارة المستخدمين والحسابات", labelAr: "إدارة المستخدمين والحسابات", description: "إضافة وتعديل الحسابات، تجميد المستخدم، وإعادة تعيين كلمات المرور و2FA", descriptionAr: "إضافة وتعديل الحسابات، تجميد المستخدم، وإعادة تعيين كلمات المرور و2FA", iconName: "UserCog" },
  "governance.role": { domain: "governance", resource: "role", label: "مصفوفة الأدوار والصلاحيات", labelAr: "مصفوفة الأدوار والصلاحيات", description: "إنشاء، تعديل، تخصيص، وحذف الأدوار ومصفوفات الصلاحيات والسقوف", descriptionAr: "إنشاء، تعديل، تخصيص، وحذف الأدوار ومصفوفات الصلاحيات والسقوف", iconName: "Shield" },
  "governance.branch": { domain: "governance", resource: "branch", label: "الفروع ومراكز التكلفة", labelAr: "الفروع ومراكز التكلفة", description: "إضافة وتعديل بيانات الفروع، المستودعات، وتراخيص التشغيل", descriptionAr: "إضافة وتعديل بيانات الفروع، المستودعات، وتراخيص التشغيل", iconName: "Building" },
  "governance.audit": { domain: "governance", resource: "audit", label: "سجلات التدقيق الأمني والرقابة", labelAr: "سجلات التدقيق الأمني والرقابة", description: "استعراض سجل الحركات، تدقيق الموافقات الذاتية، وتصدير التقارير الرقابية", descriptionAr: "استعراض سجل الحركات، تدقيق الموافقات الذاتية، وتصدير التقارير الرقابية", iconName: "ShieldAlert" },
  "governance.settings": { domain: "governance", resource: "settings", label: "إعدادات النظام وسياسات العمل", labelAr: "إعدادات النظام وسياسات العمل", description: "التحكم في سياسات النظام، أسعار الصرف، خوادم الطباعة، والتكاملات", descriptionAr: "التحكم في سياسات النظام، أسعار الصرف، خوادم الطباعة، والتكاملات", iconName: "Settings" },
  "governance.backup": { domain: "governance", resource: "backup", label: "النسخ الاحتياطي والاستعادة", labelAr: "النسخ الاحتياطي والاستعادة", description: "توليد وتأمين وتنزيل النسخ الاحتياطية وإجراء الاستعادة", descriptionAr: "توليد وتأمين وتنزيل النسخ الاحتياطية وإجراء الاستعادة", iconName: "DatabaseBackup" },
  "governance.decisions": { domain: "governance", resource: "decisions", label: "القرارات والتعاميم الإدارية", labelAr: "القرارات والتعاميم الإدارية", description: "إصدار وإدارة القرارات والتعاميم الإدارية الرسمية للشركة", descriptionAr: "إصدار وإدارة القرارات والتعاميم الإدارية الرسمية للشركة", iconName: "ScrollText" },
  "governance.executive": { domain: "governance", resource: "executive", label: "اللوحات والمؤشرات التنفيذية", labelAr: "اللوحات والمؤشرات التنفيذية", description: "استعراض مؤشرات الأداء العليا KPI وتقارير المبيعات الشاملة", descriptionAr: "استعراض مؤشرات الأداء العليا KPI وتقارير المبيعات الشاملة", iconName: "TrendingUp" },
  "governance.cost_margin": { domain: "governance", resource: "cost_margin", label: "أسعار التكلفة وهوامش الأرباح", labelAr: "أسعار التكلفة وهوامش الأرباح", description: "كشف تكاليف الشراء وهوامش الربح الصافية بالفواتير والمنتجات", descriptionAr: "كشف تكاليف الشراء وهوامش الربح الصافية بالفواتير والمنتجات", iconName: "BadgePercent" },
  "governance.limit": { domain: "governance", resource: "limit", label: "تجاوز السقوف والضوابط (Break-Glass)", labelAr: "تجاوز السقوف والضوابط (Break-Glass)", description: "إجازة وتمرير العمليات الاستثنائية التي تتجاوز السقوف الرقمية المحددة", descriptionAr: "إجازة وتمرير العمليات الاستثنائية التي تتجاوز السقوف الرقمية المحددة", iconName: "KeyRound" },
};

export const RESOURCE_METADATA: Record<string, ResourceMetadata> = {
  ...BASE_RESOURCE_METADATA,
  ...ENTERPRISE_RESOURCE_METADATA,
};

