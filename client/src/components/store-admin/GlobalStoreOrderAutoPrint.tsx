import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, Printer } from "lucide-react";
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
import {
  createStoreOrderAlertCoordinator,
  hasConnectedAlertThermalPrinter,
  printStoreOrderAlertAuto,
  readStoreOrderAutoPrintStationSetting,
  setStoreOrderAutoPrintStationSetting,
  shouldRunStoreOrderAutoPrintOnRoute,
  STORE_ORDER_AUTOPRINT_STATION_EVENT,
} from "@/lib/printing/storeOrderAlertSlip";
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

function useStationAutoPrintSetting(): [boolean | null, (next: boolean | null) => void] {
  const [explicitSetting, setExplicitSetting] = useState<boolean | null>(() =>
    readStoreOrderAutoPrintStationSetting(),
  );

  useEffect(() => {
    const sync = () => setExplicitSetting(readStoreOrderAutoPrintStationSetting());
    window.addEventListener(STORE_ORDER_AUTOPRINT_STATION_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(STORE_ORDER_AUTOPRINT_STATION_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const update = (next: boolean | null) => {
    setStoreOrderAutoPrintStationSetting(next);
    setExplicitSetting(next);
  };

  return [explicitSetting, update];
}

function StoreOrderAutoPrintSessionRuntime({
  isAutoPrintStationActive,
  isStoreAlertRecipient,
  stationOptIn,
  offline,
}: {
  isAutoPrintStationActive: boolean;
  isStoreAlertRecipient: boolean;
  stationOptIn: boolean;
  offline: boolean;
}) {
  const isAutoPrintStationActiveRef = useRef(isAutoPrintStationActive);
  isAutoPrintStationActiveRef.current = isAutoPrintStationActive;
  const stationOptInRef = useRef(stationOptIn);
  stationOptInRef.current = stationOptIn;

  const claimAlertPrintM = trpc.storeAdmin.orders.claimNotificationPrint.useMutation();
  const releaseAlertPrintM = trpc.storeAdmin.orders.releaseNotificationPrint.useMutation();
  const claimAlertMutateRef = useRef(claimAlertPrintM.mutateAsync);
  claimAlertMutateRef.current = claimAlertPrintM.mutateAsync;
  const releaseAlertMutateRef = useRef(releaseAlertPrintM.mutateAsync);
  releaseAlertMutateRef.current = releaseAlertPrintM.mutateAsync;

  useEffect(() => {
    if (!isAutoPrintStationActive) return;
    return retainRealtimeIdleExemption();
  }, [isAutoPrintStationActive]);

  const alertCoordinator = useMemo(
    () =>
      createStoreOrderAlertCoordinator({
        hasPrinter: async () =>
          isAutoPrintStationActiveRef.current && (await hasConnectedAlertThermalPrinter()),
        canBrowserFallback: () =>
          isAutoPrintStationActiveRef.current && typeof document !== "undefined",
        claimHeadStartMs: () =>
          typeof document !== "undefined" && document.visibilityState === "hidden" ? 180 : 0,
        browserFallbackHeadStartMs: () =>
          typeof document !== "undefined" && document.visibilityState === "hidden" ? 2_200 : 700,
        claim: (orderId) =>
          claimAlertMutateRef.current({ id: orderId, stationOptIn: stationOptInRef.current }),
        renew: (orderId, leaseToken) =>
          releaseAlertMutateRef.current({
            id: orderId,
            leaseToken,
            renew: true,
            stationOptIn: stationOptInRef.current,
          }),
        confirm: (orderId, leaseToken) =>
          releaseAlertMutateRef.current({
            id: orderId,
            leaseToken,
            completed: true,
            stationOptIn: stationOptInRef.current,
          }),
        release: (orderId, leaseToken) =>
          releaseAlertMutateRef.current({
            id: orderId,
            leaseToken,
            completed: false,
            stationOptIn: stationOptInRef.current,
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
    { stationOptIn },
    {
      enabled: isAutoPrintStationActive && !offline,
      refetchOnWindowFocus: true,
      refetchInterval: 30_000,
      refetchIntervalInBackground: true,
    },
  );

  useEffect(() => {
    if (!isAutoPrintStationActive || !pendingAlertPrintsQ.data?.length) return;
    for (const pending of pendingAlertPrintsQ.data) {
      void alertCoordinator.handleEvent(pending);
    }
  }, [
    alertCoordinator,
    isAutoPrintStationActive,
    pendingAlertPrintsQ.data,
    pendingAlertPrintsQ.dataUpdatedAt,
  ]);

  useRealtimeEvent(REALTIME_EVENT_TYPES.CONNECTED, () => {
    if (isAutoPrintStationActive) {
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

  const me = trpc.auth.me.useQuery(undefined, {
    enabled: routeEligible && !(offline && unlocked),
  });

  const [stationExplicitSetting] = useStationAutoPrintSetting();
  const canAutoPrint = routeEligible && canUserAutoPrintStoreOrders(me.data);
  const isStoreAlertRecipient = routeEligible && isStoreOrderAlertRecipientUser(me.data);
  const isAutoPrintStationActive =
    canAutoPrint &&
    (stationExplicitSetting !== null ? stationExplicitSetting : isStoreAlertRecipient);
  const stationOptIn = stationExplicitSetting === true && !isStoreAlertRecipient;

  if (!routeEligible || !me.data?.id || (!canAutoPrint && !isStoreAlertRecipient)) {
    return null;
  }

  return (
    <StoreOrderAutoPrintSessionRuntime
      key={String(me.data.id)}
      isAutoPrintStationActive={isAutoPrintStationActive}
      isStoreAlertRecipient={isStoreAlertRecipient}
      stationOptIn={stationOptIn}
      offline={offline}
    />
  );
}

/**
 * زرّ تحكم سريع ومؤشر حالة مدمج لشريط نقطة البيع الموحد (/pos بكافة أوضاعه)
 * يتيح للكاشير أو موظف الاستقبال معرفة حالة الطباعة التلقائية لطلبات المتجر وتفعيلها/إيقافها فوراً.
 */
export function StoreOrderAutoPrintQuickToggle({
  user,
}: {
  user: AuthMeUser | null | undefined;
}) {
  const printer = usePrinterConnection("receipt");
  const [explicitSetting, setExplicitSetting] = useStationAutoPrintSetting();
  const canAutoPrint = canUserAutoPrintStoreOrders(user);
  if (!canAutoPrint) return null;

  const defaultRecipient = isStoreOrderAlertRecipientUser(user);
  const stationActive = explicitSetting !== null ? explicitSetting : defaultRecipient;

  return (
    <button
      type="button"
      onClick={() => {
        const next = !stationActive;
        setExplicitSetting(next);
        notify.ok(
          next
            ? "فعلت الطباعة التلقائية لطلبات المتجر على هذا الجهاز"
            : "أوقفت الطباعة التلقائية لطلبات المتجر على هذا الجهاز",
        );
      }}
      aria-pressed={stationActive}
      aria-label={
        stationActive
          ? "الطباعة التلقائية لطلبات المتجر نشطة — اضغط للإيقاف"
          : "تفعيل الطباعة التلقائية لطلبات المتجر على هذا الجهاز"
      }
      title={
        stationActive
          ? printer.printerReady
            ? "تلقائي طلبات المتجر: نشط (طباعة حرارية صامتة عبر كافة الشاشات) — اضغط للإيقاف"
            : "تلقائي طلبات المتجر: نشط (طابعة النظام 80مم عبر كافة الشاشات) — اضغط للإيقاف"
          : "الطباعة التلقائية لطلبات المتجر متوقفة على هذا الجهاز — اضغط للتفعيل"
      }
      className={cn(
        "inline-flex h-[var(--ui-control)] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-bold transition-colors",
        stationActive
          ? "border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
          : "border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Printer aria-hidden className="size-3.5" />
      <span className="hidden xl:inline">تلقائي المتجر</span>
      {stationActive && <Check aria-hidden className="size-3" strokeWidth={3} />}
    </button>
  );
}
