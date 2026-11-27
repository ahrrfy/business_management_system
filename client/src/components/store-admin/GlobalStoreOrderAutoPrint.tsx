import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, Printer, Usb } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { isStoreOrderAlertRecipientUser, type PermissionMap } from "@shared/permissions";
import { REALTIME_EVENT_TYPES, type StorefrontOrderPlacedPayload } from "@shared/realtimeEvents";
import { usePrinterConnection } from "@/hooks/usePrinterConnection";
import { playAudioFeedback } from "@/lib/audioFeedback";
import { canSeeGate } from "@/lib/navVisibility";
import { notify } from "@/lib/notify";
import { isDisconnected, useConnectivity } from "@/lib/offline/connectivity";
import {
  getOfflineUnlockedProfile,
  isOfflineUnlocked,
  subscribeOfflineUnlock,
} from "@/lib/offline/pinLock";
import { isServerBridgeEnabled } from "@/lib/printing/serverBridge";
import {
  computeStoreOrderAlertTimingPolicy,
  createStoreOrderAlertCoordinator,
  hasConnectedAlertThermalPrinter,
  printStoreOrderAlertAuto,
  shouldRunStoreOrderAutoPrintOnRoute,
  STORE_ORDER_AUTOPRINT_STATION_KEY,
} from "@/lib/printing/storeOrderAlertSlip";
import { THERMAL_PRINTER_CHANGE_EVENT } from "@/lib/printing/thermal";
import { shouldSkipColdStudioAuth } from "@/lib/productStudio/coldOfflinePolicy";
import { retainRealtimeIdleExemption, useRealtimeEvent } from "@/lib/realtime";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type AuthMeUser = RouterOutputs["auth"]["me"];

const STORE_AUTOPRINT_GATE = {
  operations: ["storeAdmin.orders.claimNotificationPrint"],
  roles: ["manager", "cashier", "sales_rep"] as ("manager" | "cashier" | "sales_rep")[],
  module: "store",
  level: "FULL" as const,
};

export function canUserAutoPrintStoreOrders(user: AuthMeUser | null | undefined): boolean {
  if (!user) return false;
  const roleForGate = user.isOwner ? "admin" : (user.role ?? "");
  const overrideForGate = (user.isOwner ? null : user.permissionsOverride ?? null) as
    | PermissionMap
    | null;
  const policyForGate =
    user.operationPolicyEnabled && !user.isOwner
      ? user.resolvedOperationPolicy
      : null;
  return canSeeGate(STORE_AUTOPRINT_GATE, roleForGate, overrideForGate, policyForGate);
}

function useServerBridgeAvailable(enabled: boolean): boolean {
  const [bridgeEnabled, setBridgeEnabled] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setBridgeEnabled(false);
      return;
    }
    let active = true;
    const syncBridge = () => {
      void isServerBridgeEnabled()
        .then((ok) => {
          if (active) setBridgeEnabled(ok);
        })
        .catch(() => {
          if (active) setBridgeEnabled(false);
        });
    };
    syncBridge();
    window.addEventListener(THERMAL_PRINTER_CHANGE_EVENT, syncBridge);
    return () => {
      active = false;
      window.removeEventListener(THERMAL_PRINTER_CHANGE_EVENT, syncBridge);
    };
  }, [enabled]);

  return bridgeEnabled;
}

function StoreOrderAutoPrintSessionRuntime({
  isAutoPrintStationActive,
  isStoreAlertRecipient,
  isOwner,
  offline,
}: {
  isAutoPrintStationActive: boolean;
  isStoreAlertRecipient: boolean;
  isOwner: boolean;
  offline: boolean;
}) {
  const printer = usePrinterConnection("receipt");
  const bridgeEnabled = useServerBridgeAvailable(isAutoPrintStationActive);
  const hasThermalPrinter = printer.printerReady || bridgeEnabled;
  const canExecuteAutoPrint =
    isAutoPrintStationActive && (isStoreAlertRecipient || hasThermalPrinter);

  const isAutoPrintStationActiveRef = useRef(isAutoPrintStationActive);
  isAutoPrintStationActiveRef.current = isAutoPrintStationActive;
  const isStoreAlertRecipientRef = useRef(isStoreAlertRecipient);
  isStoreAlertRecipientRef.current = isStoreAlertRecipient;
  const isOwnerRef = useRef(isOwner);
  isOwnerRef.current = isOwner;
  const hasThermalPrinterRef = useRef(hasThermalPrinter);
  hasThermalPrinterRef.current = hasThermalPrinter;

  const claimAlertPrintM = trpc.storeAdmin.orders.claimNotificationPrint.useMutation();
  const releaseAlertPrintM = trpc.storeAdmin.orders.releaseNotificationPrint.useMutation();
  const claimAlertMutateRef = useRef(claimAlertPrintM.mutateAsync);
  claimAlertMutateRef.current = claimAlertPrintM.mutateAsync;
  const releaseAlertMutateRef = useRef(releaseAlertPrintM.mutateAsync);
  releaseAlertMutateRef.current = releaseAlertPrintM.mutateAsync;

  useEffect(() => {
    if (!canExecuteAutoPrint) return;
    return retainRealtimeIdleExemption();
  }, [canExecuteAutoPrint]);

  const alertCoordinator = useMemo(
    () =>
      createStoreOrderAlertCoordinator({
        hasPrinter: async () =>
          isAutoPrintStationActiveRef.current && (await hasConnectedAlertThermalPrinter()),
        canBrowserFallback: () =>
          computeStoreOrderAlertTimingPolicy({
            isAutoPrintActive: isAutoPrintStationActiveRef.current,
            isStoreAlertRecipient: isStoreAlertRecipientRef.current,
            isOwner: isOwnerRef.current,
            hasThermalPrinter: hasThermalPrinterRef.current,
            isHiddenTab:
              typeof document !== "undefined" && document.visibilityState === "hidden",
            hasDocument: typeof document !== "undefined",
          }).canBrowserFallback,
        claimHeadStartMs: () =>
          computeStoreOrderAlertTimingPolicy({
            isAutoPrintActive: isAutoPrintStationActiveRef.current,
            isStoreAlertRecipient: isStoreAlertRecipientRef.current,
            isOwner: isOwnerRef.current,
            hasThermalPrinter: true,
            isHiddenTab:
              typeof document !== "undefined" && document.visibilityState === "hidden",
            hasDocument: typeof document !== "undefined",
          }).claimHeadStartMs,
        browserFallbackHeadStartMs: () =>
          computeStoreOrderAlertTimingPolicy({
            isAutoPrintActive: isAutoPrintStationActiveRef.current,
            isStoreAlertRecipient: isStoreAlertRecipientRef.current,
            isOwner: isOwnerRef.current,
            hasThermalPrinter: false,
            isHiddenTab:
              typeof document !== "undefined" && document.visibilityState === "hidden",
            hasDocument: typeof document !== "undefined",
          }).browserFallbackHeadStartMs,
        claim: (orderId) => claimAlertMutateRef.current({ id: orderId }),
        renew: (orderId, leaseToken) =>
          releaseAlertMutateRef.current({
            id: orderId,
            leaseToken,
            renew: true,
          }),
        confirm: (orderId, leaseToken) =>
          releaseAlertMutateRef.current({
            id: orderId,
            leaseToken,
            completed: true,
          }),
        release: (orderId, leaseToken) =>
          releaseAlertMutateRef.current({
            id: orderId,
            leaseToken,
            completed: false,
          }),
        print: printStoreOrderAlertAuto,
        onBrowserDialogOpened: ({ orderNumber, confirmPrinted, retryOrRelease }) => {
          toast(`تأكيد طباعة قصاصة الطلب ${orderNumber}`, {
            description: "اضغط تأكيد بعد خروج الورقة، أو إعادة المحاولة إذا أغلقت نافذة الطباعة.",
            duration: 90_000,
            action: {
              label: "تأكيد الطباعة",
              onClick: () => {
                void confirmPrinted();
              },
            },
            cancel: {
              label: "لم تطبع",
              onClick: () => {
                void retryOrRelease();
              },
            },
          });
        },
        onNotify: (payload) => {
          playAudioFeedback("notification");
          notify.info(`وصل طلب متجر جديد: ${payload.orderNumber}`);
        },
      }),
    [],
  );

  useEffect(() => () => alertCoordinator.dispose(), [alertCoordinator]);

  const pendingAlertPrintsQ = trpc.storeAdmin.orders.pendingNotificationPrint.useQuery(
    undefined,
    {
      enabled: canExecuteAutoPrint && !offline,
      refetchOnWindowFocus: true,
      refetchInterval: 30_000,
      refetchIntervalInBackground: true,
    },
  );

  const refetchPendingRef = useRef(pendingAlertPrintsQ.refetch);
  refetchPendingRef.current = pendingAlertPrintsQ.refetch;
  const prevHasThermalRef = useRef(hasThermalPrinter);
  useEffect(() => {
    const prev = prevHasThermalRef.current;
    prevHasThermalRef.current = hasThermalPrinter;
    if (!prev && hasThermalPrinter && canExecuteAutoPrint && !offline) {
      void refetchPendingRef.current();
    }
  }, [hasThermalPrinter, canExecuteAutoPrint, offline]);

  useEffect(() => {
    if (!canExecuteAutoPrint || !pendingAlertPrintsQ.data?.length) return;
    for (const pending of pendingAlertPrintsQ.data) {
      void alertCoordinator.handleEvent(pending);
    }
  }, [
    alertCoordinator,
    canExecuteAutoPrint,
    pendingAlertPrintsQ.data,
    pendingAlertPrintsQ.dataUpdatedAt,
  ]);

  useRealtimeEvent(REALTIME_EVENT_TYPES.CONNECTED, () => {
    if (canExecuteAutoPrint) {
      void pendingAlertPrintsQ.refetch();
    }
  });

  useRealtimeEvent<StorefrontOrderPlacedPayload>(
    REALTIME_EVENT_TYPES.STOREFRONT_ORDER_PLACED,
    (event) => {
      if ((!isStoreAlertRecipient && !isAutoPrintStationActive) || !event.payload) return;
      void alertCoordinator.handleEvent(event.payload);
    },
  );

  return null;
}

/**
 * خدمة الطباعة التلقائية العامة لطلبات المتجر الواردة — تُركَّب مرة واحدة على جذر التطبيق App.tsx
 * (خارج Switch وخارج AppLayout) لتعمل بنفس السرعة والاعتمادية في نقطة البيع (/pos و /print-pos
 * و /reception) وفي كافة شاشات النظام دون إعادة تهيئة أو فقدان الحجوزات عند التنقل بين الشاشات.
 */
export function GlobalStoreOrderAutoPrint() {
  const [loc] = useLocation();
  const connectivity = useConnectivity();
  const offline =
    isDisconnected(connectivity) ||
    (typeof navigator !== "undefined" && !navigator.onLine);
  const unlocked = useSyncExternalStore(
    subscribeOfflineUnlock,
    isOfflineUnlocked,
    isOfflineUnlocked,
  );
  const coldStudio = shouldSkipColdStudioAuth({
    location: loc,
    offline,
    pinVerified: unlocked,
    localProfile: getOfflineUnlockedProfile(),
  });
  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  const routeEligible = !coldStudio && shouldRunStoreOrderAutoPrintOnRoute(loc, hostname);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem(STORE_ORDER_AUTOPRINT_STATION_KEY) === "0") {
        window.localStorage.removeItem(STORE_ORDER_AUTOPRINT_STATION_KEY);
      }
    } catch {
      /* ignore storage error */
    }
  }, []);

  const me = trpc.auth.me.useQuery(undefined, {
    enabled: routeEligible && !(offline && unlocked),
  });

  const canAutoPrint = routeEligible && canUserAutoPrintStoreOrders(me.data);
  const isStoreAlertRecipient = routeEligible && isStoreOrderAlertRecipientUser(me.data);
  const isAutoPrintStationActive = canAutoPrint;

  if (!routeEligible || !me.data?.id || (!canAutoPrint && !isStoreAlertRecipient)) {
    return null;
  }

  return (
    <StoreOrderAutoPrintSessionRuntime
      key={String(me.data.id)}
      isAutoPrintStationActive={isAutoPrintStationActive}
      isStoreAlertRecipient={isStoreAlertRecipient}
      isOwner={Boolean(me.data.isOwner)}
      offline={offline}
    />
  );
}

/**
 * شارة حالة رقابية غير قابلة للإيقاف لشريط نقطة البيع الموحد (/pos بكافة أوضاعه)
 * تعرض حالة الطباعة التلقائية الإلزامية لطلبات المتجر، مع زر صامت لربط طابعة USB عند انفصالها.
 */
export function StoreOrderAutoPrintQuickToggle({
  user,
}: {
  user: AuthMeUser | null | undefined;
}) {
  const printer = usePrinterConnection("receipt");
  const canAutoPrint = canUserAutoPrintStoreOrders(user);
  const bridgeEnabled = useServerBridgeAvailable(canAutoPrint);
  if (!canAutoPrint) return null;

  const defaultRecipient = isStoreOrderAlertRecipientUser(user);
  const printerReady = printer.printerReady || bridgeEnabled;
  const activeReady = printerReady || defaultRecipient;

  const statusTitle = printerReady
    ? defaultRecipient
      ? "الطباعة التلقائية الإلزامية لطلبات المتجر: نشطة (طابعة حرارية صامتة — أولوية الاستقبال)"
      : "الطباعة التلقائية الإلزامية لطلبات المتجر: نشطة (احتياط حراري صامت)"
    : defaultRecipient
      ? "الطباعة التلقائية الإلزامية لطلبات المتجر: نشطة (طابعة النظام 80مم)"
      : "الطباعة التلقائية الإلزامية لطلبات المتجر مفعلة — اربط طابعة USB لتعمل هذه المحطة كاحتياط صامت";

  return (
    <div className="inline-flex shrink-0 items-center gap-1">
      <span
        role="status"
        aria-label={statusTitle}
        title={statusTitle}
        className={cn(
          "inline-flex h-[var(--ui-control)] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-bold select-none",
          activeReady
            ? "border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
            : "border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
        )}
      >
        <Printer aria-hidden className="size-3.5" />
        <span className="hidden xl:inline">
          {activeReady ? "تلقائي المتجر" : "تلقائي (اربط USB)"}
        </span>
        {activeReady && <Check aria-hidden className="size-3" strokeWidth={3} />}
      </span>

      {printer.supported && !printer.printerReady && (
        <button
          type="button"
          onClick={() => void printer.connect()}
          title="ربط طابعة الإيصالات عبر WebUSB للطباعة التلقائية الصامتة"
          className="inline-flex h-[var(--ui-control)] shrink-0 items-center gap-1 rounded-lg border border-border bg-muted/40 px-2 text-xs font-bold text-foreground transition-colors hover:bg-muted"
        >
          <Usb aria-hidden className="size-3.5" />
          <span className="hidden sm:inline">ربط USB</span>
        </button>
      )}
    </div>
  );
}
