/**
 * المصدر الحاكم لمسار العملاء المحتملين والفرص.
 * لا تُعاد كتابة الحالات أو الانتقالات في الخادم أو الواجهة.
 */

export const SALES_LEAD_SOURCES = [
  "WALK_IN",
  "PHONE",
  "WHATSAPP",
  "INSTAGRAM",
  "FACEBOOK",
  "WEBSITE",
  "REFERRAL",
  "CAMPAIGN",
  "OTHER",
] as const;
export type SalesLeadSource = (typeof SALES_LEAD_SOURCES)[number];

export const SALES_LEAD_SOURCE_LABELS: Record<SalesLeadSource, string> = {
  WALK_IN: "زيارة مباشرة",
  PHONE: "اتصال هاتفي",
  WHATSAPP: "واتساب",
  INSTAGRAM: "إنستغرام",
  FACEBOOK: "فيسبوك",
  WEBSITE: "الموقع الإلكتروني",
  REFERRAL: "ترشيح",
  CAMPAIGN: "حملة تسويقية",
  OTHER: "مصدر آخر",
};

export const SALES_LEAD_STATUSES = [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "DISQUALIFIED",
  "CONVERTED",
] as const;
export type SalesLeadStatus = (typeof SALES_LEAD_STATUSES)[number];

export const SALES_LEAD_STATUS_LABELS: Record<SalesLeadStatus, string> = {
  NEW: "جديد",
  CONTACTED: "تم التواصل",
  QUALIFIED: "مؤهل",
  DISQUALIFIED: "غير مؤهل",
  CONVERTED: "محوّل إلى فرصة",
};

export const SALES_OPPORTUNITY_STAGES = [
  "DISCOVERY",
  "PROPOSAL",
  "NEGOTIATION",
  "WON",
  "LOST",
] as const;
export type SalesOpportunityStage = (typeof SALES_OPPORTUNITY_STAGES)[number];

export const SALES_OPPORTUNITY_STAGE_LABELS: Record<
  SalesOpportunityStage,
  string
> = {
  DISCOVERY: "استكشاف الاحتياج",
  PROPOSAL: "عرض مقدم",
  NEGOTIATION: "تفاوض",
  WON: "مغلقة رابحة",
  LOST: "مغلقة خاسرة",
};

export const LEAD_ALLOWED_TRANSITIONS: Readonly<
  Record<SalesLeadStatus, readonly SalesLeadStatus[]>
> = {
  NEW: ["CONTACTED", "DISQUALIFIED"],
  CONTACTED: ["QUALIFIED", "DISQUALIFIED"],
  QUALIFIED: ["CONTACTED", "DISQUALIFIED"],
  DISQUALIFIED: ["CONTACTED"],
  CONVERTED: [],
};

export const OPPORTUNITY_ALLOWED_TRANSITIONS: Readonly<
  Record<SalesOpportunityStage, readonly SalesOpportunityStage[]>
> = {
  DISCOVERY: ["PROPOSAL", "LOST"],
  PROPOSAL: ["DISCOVERY", "NEGOTIATION", "LOST"],
  NEGOTIATION: ["PROPOSAL", "WON", "LOST"],
  WON: [],
  LOST: ["DISCOVERY"],
};

export function canTransitionLead(
  from: SalesLeadStatus,
  to: SalesLeadStatus,
): boolean {
  return LEAD_ALLOWED_TRANSITIONS[from].includes(to);
}

export function canTransitionOpportunity(
  from: SalesOpportunityStage,
  to: SalesOpportunityStage,
): boolean {
  return OPPORTUNITY_ALLOWED_TRANSITIONS[from].includes(to);
}

export function leadReasonRequired(to: SalesLeadStatus): boolean {
  return to === "DISQUALIFIED";
}

export function opportunityReasonRequired(to: SalesOpportunityStage): boolean {
  return to === "LOST";
}

export function isOpenLeadStatus(status: SalesLeadStatus): boolean {
  return status !== "DISQUALIFIED" && status !== "CONVERTED";
}

export function isOpenOpportunityStage(stage: SalesOpportunityStage): boolean {
  return stage !== "WON" && stage !== "LOST";
}
