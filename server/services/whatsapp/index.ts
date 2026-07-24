/* برميل حزمة مركز واتساب الأعمال — الاستهلاك الخارجي (راوترات/كنّاس/اختبارات لاحقة) من هنا حصراً. */
export { GRAPH_VERSION, graphBaseUrl, graphFetch } from "./graph";
export type { GraphFetchInit, GraphFetchResult, GraphIntegration } from "./graph";

export {
  GRAPH_ERROR_AR,
  classifyGraphError,
  sendInteractiveButtons,
  sendSessionText,
  sendTemplate,
  toWaId,
} from "./sendService";
export type { GraphErrorClassification, GraphErrorInfo, SendFailure, SendResult, SendSuccess } from "./sendService";

export {
  dispatchClaimedRow,
  dispatchOutboxRow,
  enqueueAndDispatch,
  enqueueOutbox,
  getActiveWaIntegration,
  hasAnyActiveWaIntegration,
} from "./outboxService";
export type { ActiveWaIntegration, EnqueueOutboxInput } from "./outboxService";

export { fetchInboundMedia, getMediaForServing } from "./mediaService";
export type { MediaFetchResult } from "./mediaService";

export { startWaOutboxSweeper, stopWaOutboxSweeper, sweepWaOutboxOnce } from "./outboxSweeper";
export type { WaOutboxSweepResult } from "./outboxSweeper";

export {
  getActiveWaTemplateIntegration,
  getUsableTemplate,
  listTemplates,
  syncTemplatesFromGraph,
} from "./templateService";
export type { ListTemplatesFilter, SyncTemplatesResult, WaTemplateIntegration } from "./templateService";

export {
  baghdadYmdCompact,
  checkAutomationGate,
  flowNotify,
  getWaHubSettings,
  isOutsideBusinessHours,
} from "./flowNotify";
export type {
  AutomationFlagKey,
  AutomationFlowKey,
  AutomationGateResult,
  BusinessHoursConfig,
  FlowNotifyInput,
  FlowNotifyResult,
  FlowNotifySkipReason,
} from "./flowNotify";

// البث التسويقي (S5، T5.1): باني شرائح RFM + معاينة عدد/كلفة + إنشاء/إطلاق/اعتماد (SOD)/عرض.
export {
  RFM_AT_RISK_MIN_FREQUENCY,
  RFM_AT_RISK_RECENCY_DAYS,
  RFM_DORMANT_RECENCY_DAYS,
  RFM_NEW_WITHIN_DAYS,
  RFM_VIP_MIN_FREQUENCY,
  RFM_VIP_MIN_SPEND,
  resolveSegmentCount,
  resolveSegmentList,
} from "./segmentService";
export type {
  CustomerTypeValue,
  PriceTierValue,
  RfmCriteria,
  RfmPreset,
  SegmentCriteria,
  SegmentRecipient,
} from "./segmentService";

export {
  MARKETING_MSG_COST,
  approveBroadcast,
  broadcastResults,
  cancelBroadcast,
  createBroadcast,
  getBroadcast,
  launchBroadcast,
  listBroadcasts,
  pauseBroadcast,
  previewAudience,
  resumeBroadcast,
} from "./broadcastService";
export type {
  ApproveBroadcastResult,
  BroadcastDetail,
  BroadcastListRow,
  BroadcastResults,
  CreateBroadcastInput,
  CreateBroadcastResult,
  LaunchBroadcastResult,
  LaunchBroadcastStatus,
  PreviewAudienceResult,
} from "./broadcastService";

// تقطير البث عبر الكنّاس (S5، T5.2): إدراج كسول يحترم opt-in/opt-out + تقطير مقنَّن + قاطع جودة
// + ربط حالات التسليم بالمستلمين (تُستهلك من webhookProcessor.ts).
export { dripRunningBroadcasts, syncBroadcastRecipientFromOutbox } from "./broadcastDispatch";
export type { BroadcastDeliveryStatus, DripBroadcastsResult } from "./broadcastDispatch";
