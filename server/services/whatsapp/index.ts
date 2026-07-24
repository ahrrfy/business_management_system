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
