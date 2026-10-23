import { ReceptionProductSearch } from "@/components/reception/ReceptionProductSearch";
import type { RouterOutputs } from "@/lib/trpc";
import {
  WORK_ORDER_CHANNELS,
  receptionChannelOptions,
} from "@shared/receptionChannel";
import { ChannelMark } from "@/components/ChannelBadge";
import { createPortal } from "react-dom";
import {
  Check,
  Copy,
  Globe,
  HandCoins,
  MessageCircle,
  Printer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReceptionCustomerSection } from "@/components/reception/ReceptionCustomerSection";
import { useCustomerByPhone } from "@/components/customer/useCustomerByPhone";

import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { DraftStrip } from "@/components/reception/DraftStrip";
import { type ReceptionServerDraftPointer } from "@/lib/receptionWorkspaceState";
import {
  type CartLine,
  type LastSaleSummary,
  type PosRow,
  type Tier,
} from "@/components/reception/cartMath";
import { isWebUsbSupported } from "@/lib/printing/print";
export interface ReceptionWorkspaceHeaderInput {
  compactHeader: boolean;
  customerSectionRef: React.RefObject<HTMLDivElement | null>;
  canReadChannels: boolean;
  setShowInbox: React.Dispatch<React.SetStateAction<boolean>>;
  channel: "OTHER" | "WALK_IN" | "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "PHONE";
  setChannel: React.Dispatch<
    React.SetStateAction<
      "OTHER" | "WALK_IN" | "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "PHONE"
    >
  >;
  setChannelHandle: React.Dispatch<React.SetStateAction<string>>;
  channelHandle: string;
  phoneCustomer: ReturnType<typeof useCustomerByPhone>;
  canCreateCustomer: boolean;
  canReadCustomerContext: boolean;
  effectiveTier: import("@/components/reception/cartMath").Tier;
  tierOverride: import("@/components/reception/cartMath").Tier | null;
  setTierOverride: React.Dispatch<
    React.SetStateAction<import("@/components/reception/cartMath").Tier | null>
  >;
  setHydratedAutomaticTier: React.Dispatch<
    React.SetStateAction<import("@/components/reception/cartMath").Tier | null>
  >;
  setDeferred: React.Dispatch<React.SetStateAction<boolean>>;
  clearCouponIfApplied: () => void;
  setCustomerContextId: React.Dispatch<React.SetStateAction<number | null>>;
  searchWrapRef: React.RefObject<HTMLDivElement | null>;
  searchRef: React.RefObject<HTMLInputElement | null>;
  search: string;
  setSearch: React.Dispatch<React.SetStateAction<string>>;
  setShowDrop: React.Dispatch<React.SetStateAction<boolean>>;
  handleSearchScan: (code: string) => void;
  searchSettled: boolean;
  results: import("@/components/reception/cartMath").PosRow[];
  addRow: (row: import("@/components/reception/cartMath").PosRow) => void;
  showDrop: boolean;
  debounced: string;
  resultsEmpty: boolean;
  addManualService: () => void;
  canActionRef: React.RefObject<(path: string) => boolean>;
  setCardsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  offline: boolean;
  canAction: (path: string) => boolean;
  headerActionsNode: HTMLElement | null;
  bridge: { enabled: boolean; description: string };
  testServerPrint: () => Promise<void>;
  connectPrinter: () => Promise<void>;
  printerReady: boolean;
  lastSale: import("@/components/reception/cartMath").LastSaleSummary | null;
  setCashDropping: React.Dispatch<React.SetStateAction<boolean>>;
  setClosing: React.Dispatch<React.SetStateAction<boolean>>;
  shift: NonNullable<RouterOutputs["shifts"]["current"]>;
  branchId: number;
  me: { data: RouterOutputs["auth"]["me"] | undefined };
  activeDraft: { id: number; version: number } | null;
  cart: import("@/components/reception/cartMath").CartLine[];
  hasDigitalCards: boolean;
  draftPromotionPending: boolean;
  saveDraft: () => Promise<string | number | undefined>;
  resumeDraft: (
    draftId: number,
    isHydrationCurrent?: () => boolean,
    forceReload?: boolean,
    shadow?:
      | import("@/lib/receptionWorkspaceState").ReceptionServerDraftPointer
      | undefined,
  ) => Promise<boolean>;
  printDraftTicketById: (draftId: number) => Promise<void>;
}
export function ReceptionWorkspaceHeader({
  compactHeader,
  customerSectionRef,
  canReadChannels,
  setShowInbox,
  channel,
  setChannel,
  setChannelHandle,
  channelHandle,
  phoneCustomer,
  canCreateCustomer,
  canReadCustomerContext,
  effectiveTier,
  tierOverride,
  setTierOverride,
  setHydratedAutomaticTier,
  setDeferred,
  clearCouponIfApplied,
  setCustomerContextId,
  searchWrapRef,
  searchRef,
  search,
  setSearch,
  setShowDrop,
  handleSearchScan,
  searchSettled,
  results,
  addRow,
  showDrop,
  debounced,
  resultsEmpty,
  addManualService,
  canActionRef,
  setCardsOpen,
  offline,
  canAction,
  headerActionsNode,
  bridge,
  testServerPrint,
  connectPrinter,
  printerReady,
  lastSale,
  setCashDropping,
  setClosing,
  shift,
  branchId,
  me,
  activeDraft,
  cart,
  hasDigitalCards,
  draftPromotionPending,
  saveDraft,
  resumeDraft,
  printDraftTicketById,
}: ReceptionWorkspaceHeaderInput) {
  return (
    <div
      className={cn(
        "flex-shrink-0 border-b bg-card px-3",
        compactHeader ? "space-y-1 py-1" : "space-y-1.5 py-1.5",
      )}
    >
      {/* إصلاح (٧/٨): شريط التسلسل العلوي (١-٤ بأسماء مختلفة) حُذف — كان يكرّر حرفياً نفس
            ترقيم «١. العميل…» و«٢. أضف…» أدناه بتسميةٍ ثانية، بلا وظيفةٍ فريدة (الانتقال يبقى
            متاحاً بالنقر على المناطق نفسها وبـF2/F4). إزالته توفّر مساحة رأسية دائماً، لا عند
            ضيق الارتفاع فقط. */}
      <div
        ref={customerSectionRef}
        className="grid gap-1.5 rounded-xl border border-border/80 bg-muted/20 p-1.5 xl:grid-cols-[minmax(260px,0.85fr)_minmax(380px,1.15fr)_minmax(280px,0.95fr)]"
      >
        {/* ١ — قناة الوصول: قرار سريع واضح، مع إبقاء هوية العميل عند تبديل القناة. */}
        <section
          className="rounded-lg border bg-card p-1.5"
          aria-labelledby="reception-channel-title"
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="grid size-4 place-items-center rounded-full bg-primary text-[9px] font-black text-primary-foreground">
              ١
            </span>
            <h2 id="reception-channel-title" className="text-2xs font-black">
              قناة وصول الطلب
            </h2>
            {canReadChannels && (
              <button
                type="button"
                onClick={() => setShowInbox(true)}
                className="ms-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-extrabold text-muted-foreground hover:bg-muted hover:text-foreground"
                title="افتح طلباً من رسالة زبون"
              >
                <MessageCircle aria-hidden className="size-3" /> من محادثة
              </button>
            )}
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-1">
            {receptionChannelOptions(WORK_ORDER_CHANNELS).map(
              ({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={channel === value}
                  onClick={() => {
                    setChannel(value);
                    if (value !== "INSTAGRAM" && value !== "TIKTOK")
                      setChannelHandle("");
                  }}
                  className={cn(
                    "flex h-9 min-w-0 flex-col items-center justify-center gap-0.5 rounded-md border text-[9px] font-extrabold transition-colors",
                    channel === value
                      ? "border-primary bg-primary/10 text-primary shadow-sm"
                      : "bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
                  )}
                >
                  <ChannelMark channel={value} />
                  <span className="truncate">{label}</span>
                </button>
              ),
            )}
          </div>
          {(channel === "INSTAGRAM" || channel === "TIKTOK") && (
            <Input
              value={channelHandle}
              onChange={(event) => setChannelHandle(event.target.value)}
              placeholder="معرّف الحساب (اختياري)"
              aria-label="معرّف حساب القناة"
              className="mt-1 h-7 text-[11px]"
              dir="ltr"
            />
          )}
        </section>

        {/* ٢+٣ — الهاتف مفتاح الهوية + هوية العميل ومنتقي العملاء الموحد. */}
        <ReceptionCustomerSection
          phoneCustomer={phoneCustomer}
          canCreateCustomer={canCreateCustomer}
          canReadCustomerContext={canReadCustomerContext}
          effectiveTier={effectiveTier}
          tierOverride={tierOverride}
          setTierOverride={setTierOverride}
          setHydratedAutomaticTier={setHydratedAutomaticTier}
          setDeferred={setDeferred}
          clearCouponIfApplied={clearCouponIfApplied}
          setCustomerContextId={setCustomerContextId}
        />
      </div>

      <ReceptionProductSearch
        searchWrapRef={searchWrapRef}
        searchRef={searchRef}
        search={search}
        setSearch={setSearch}
        setShowDrop={setShowDrop}
        handleSearchScan={handleSearchScan}
        searchSettled={searchSettled}
        results={results}
        addRow={addRow}
        showDrop={showDrop}
        debounced={debounced}
        resultsEmpty={resultsEmpty}
        addManualService={addManualService}
        canActionRef={canActionRef}
        setCardsOpen={setCardsOpen}
        offline={offline}
        canAction={canAction}
      />

      {headerActionsNode &&
        createPortal(
          <>
            {bridge.enabled && (
              <button
                type="button"
                onClick={() => void testServerPrint()}
                title={`جسر طباعة صامت: ${bridge.description} — اضغط لطباعة تذكرة اختبار`}
                aria-label="جسر طباعة على الخادم — تذكرة اختبار"
                className="inline-flex h-[var(--ui-control)] items-center gap-1 rounded-lg border border-[var(--sem-pos)] bg-card px-2.5 text-[var(--sem-pos)] hover:bg-[var(--sem-pos-bg)]"
              >
                <Printer aria-hidden className="size-4" />
                <Globe aria-hidden className="size-3.5" />
              </button>
            )}
            {isWebUsbSupported() && (
              <button
                type="button"
                onClick={() => void connectPrinter()}
                title={
                  printerReady
                    ? "الطابعة الافتراضية مربوطة تلقائياً — اضغط لتبديلها"
                    : "اربط طابعة حرارية — ستُربط تلقائياً في المرات القادمة"
                }
                aria-label={
                  printerReady
                    ? "الطابعة الافتراضية مربوطة"
                    : "ربط طابعة حرارية"
                }
                className={cn(
                  "inline-flex h-[var(--ui-control)] items-center gap-1 rounded-lg border bg-card px-2.5 hover:bg-muted/60",
                  printerReady
                    ? "border-[var(--sem-pos)] text-[var(--sem-pos)]"
                    : "border-border text-muted-foreground",
                )}
              >
                <Printer aria-hidden className="size-4" />
                {printerReady && (
                  <Check aria-hidden className="size-3.5" strokeWidth={3} />
                )}
              </button>
            )}
            {lastSale && lastSale.invoiceNumbers[0] && (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(
                    lastSale.invoiceNumbers[0],
                  );
                  notify.ok("نُسخ رقم الفاتورة", lastSale.invoiceNumbers[0]);
                }}
                title="آخر فاتورة — اضغط لنسخ الرقم (F9 لإعادة الطباعة)"
                className="inline-flex h-[var(--ui-control)] items-center gap-1 rounded-lg border bg-card px-2.5 text-xs font-bold text-muted-foreground hover:bg-muted/60"
                dir="ltr"
              >
                <Copy aria-hidden className="size-3" />{" "}
                {lastSale.invoiceNumbers[0]}
              </button>
            )}
            <button
              type="button"
              disabled={!canAction("shifts.cashDrop")}
              onClick={() =>
                canActionRef.current("shifts.cashDrop") && setCashDropping(true)
              }
              title="سحب نقدي من الدرج إلى الخزينة"
              className="inline-flex h-[var(--ui-control)] items-center gap-1 rounded-lg border bg-muted/40 px-2.5 text-sm font-bold hover:bg-muted"
            >
              <HandCoins aria-hidden className="size-4" />
              <span className="hidden lg:inline">سحب نقدي</span>
            </button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canAction("shifts.close")}
              onClick={() =>
                canActionRef.current("shifts.close") && setClosing(true)
              }
              title={`إنهاء وردية الاستقبال #${shift.id}`}
            >
              إنهاء الوردية
            </Button>
          </>,
          headerActionsNode,
        )}

      <DraftStrip
        branchId={branchId}
        meUserId={Number(me.data?.id ?? 0)}
        activeDraftId={activeDraft?.id ?? null}
        offline={offline}
        compact={compactHeader}
        canSave={
          cart.length > 0 &&
          !hasDigitalCards &&
          (draftPromotionPending
            ? canAction("reception.draftResolvePromotion")
            : canAction("reception.draftPromote"))
        }
        onSave={saveDraft}
        onResume={(id) => void resumeDraft(id)}
        onPrintTicket={(id) => void printDraftTicketById(id)}
      />
    </div>
  );
}
