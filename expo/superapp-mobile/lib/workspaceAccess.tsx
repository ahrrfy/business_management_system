import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import {
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AppStateStatus,
} from "react-native";
import {
  enableAppSwitcherProtectionAsync,
  usePreventScreenCapture,
} from "expo-screen-capture";

import { colors, radius, space } from "@/constants/theme";
import { getSecureTransportRuntimeStatus } from "@/lib/deviceProof";
import { unlockLocalSession } from "@/lib/localSessionUnlock";
import { getNativeMobileToday, type MobileToday } from "@/lib/secureTransport";

export type WorkspaceSnapshot = Readonly<{
  mode: "checking" | "signedOut" | "ready" | "error";
  today: MobileToday | null;
}>;

export type WorkspaceRefreshOptions = Readonly<{
  /** Reuse the short Android authentication window opened by the caller. */
  localProtectionAlreadyConfirmed?: boolean;
}>;

type WorkspaceAccessContextValue = WorkspaceSnapshot & {
  clearWorkspace(): void;
  refreshWorkspace(
    options?: WorkspaceRefreshOptions,
  ): Promise<WorkspaceSnapshot>;
};

const WorkspaceAccessContext =
  createContext<WorkspaceAccessContextValue | null>(null);
const checking: WorkspaceSnapshot = { mode: "checking", today: null };

function NativeCaptureGuard() {
  usePreventScreenCapture("superapp-protected-workspace");

  useEffect(() => {
    void enableAppSwitcherProtectionAsync(0.92).catch(() => undefined);
  }, []);

  return null;
}

/**
 * Security boundary for the whole native tree. Leaving the foreground unmounts
 * all routed screens, which clears attendance, task, and revealed payslip state.
 * Returning requires a new local unlock before any protected screen is mounted.
 */
export function WorkspaceAccessProvider({ children }: PropsWithChildren) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(checking);
  const [unlocked, setUnlocked] = useState(false);
  const [unlockFailed, setUnlockFailed] = useState(false);
  const appState = useRef<AppStateStatus>(AppState.currentState);
  const checkingRef = useRef(false);
  const refreshGenerationRef = useRef(0);
  const snapshotRef = useRef<WorkspaceSnapshot>(checking);

  const publish = useCallback((next: WorkspaceSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const clearWorkspace = useCallback(() => {
    refreshGenerationRef.current += 1;
    checkingRef.current = false;
    publish({ mode: "signedOut", today: null });
    setUnlocked(true);
    setUnlockFailed(false);
  }, [publish]);

  const refreshWorkspace = useCallback(
    async (
      options: WorkspaceRefreshOptions = {},
    ): Promise<WorkspaceSnapshot> => {
      if (checkingRef.current) return snapshotRef.current;
      checkingRef.current = true;
      const generation = refreshGenerationRef.current;
      const isCurrent = () => refreshGenerationRef.current === generation;
      setUnlockFailed(false);
      try {
        const transport = await getSecureTransportRuntimeStatus();
        if (!isCurrent()) return snapshotRef.current;
        if (transport.kind === "unavailable" || !transport.configured) {
          // A store build must fail closed. Rendering sample data here hid a
          // broken native configuration behind a convincing but false product.
          const next: WorkspaceSnapshot = { mode: "error", today: null };
          publish(next);
          setUnlocked(true);
          return next;
        }
        if (transport.session !== "present") {
          const next: WorkspaceSnapshot = { mode: "signedOut", today: null };
          publish(next);
          setUnlocked(true);
          return next;
        }

        if (!options.localProtectionAlreadyConfirmed) {
          try {
            await unlockLocalSession();
          } catch {
            if (!isCurrent()) return snapshotRef.current;
            publish(checking);
            setUnlocked(false);
            setUnlockFailed(true);
            return checking;
          }
        }

        if (!isCurrent()) return snapshotRef.current;
        setUnlocked(true);
        try {
          const today = await getNativeMobileToday();
          if (!isCurrent()) return snapshotRef.current;
          const next: WorkspaceSnapshot = { mode: "ready", today };
          publish(next);
          return next;
        } catch {
          if (!isCurrent()) return snapshotRef.current;
          const next: WorkspaceSnapshot = { mode: "error", today: null };
          publish(next);
          return next;
        }
      } finally {
        checkingRef.current = false;
      }
    },
    [publish],
  );

  useEffect(() => {
    void refreshWorkspace();
    const subscription = AppState.addEventListener("change", (next) => {
      const wasActive = appState.current === "active";
      appState.current = next;
      if (next !== "active") {
        refreshGenerationRef.current += 1;
        checkingRef.current = false;
        publish(checking);
        setUnlocked(false);
        setUnlockFailed(false);
        return;
      }
      if (!wasActive) void refreshWorkspace();
    });
    return () => subscription.remove();
  }, [publish, refreshWorkspace]);

  return (
    <WorkspaceAccessContext.Provider
      value={{ ...snapshot, clearWorkspace, refreshWorkspace }}
    >
      {Platform.OS === "web" ? null : <NativeCaptureGuard />}
      {unlocked ? (
        children
      ) : (
        <View
          accessibilityLabel="شاشة حماية سوبر العربية"
          style={styles.lockedPage}
        >
          <View style={styles.lockedCard}>
            <Text style={styles.brand}>سوبر العربية</Text>
            <Text style={styles.title}>
              {unlockFailed
                ? "يلزم فتح حماية الجهاز"
                : "جارٍ تأمين مساحة العمل"}
            </Text>
            <Text style={styles.detail}>
              {unlockFailed
                ? "استخدم البصمة أو رمز قفل الجهاز للعودة إلى بياناتك."
                : "لا تُعرض بيانات العمل أثناء انتقال التطبيق أو وجوده في الخلفية."}
            </Text>
            {unlockFailed ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void refreshWorkspace()}
                style={styles.unlockButton}
              >
                <Text style={styles.unlockText}>فتح التطبيق</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      )}
    </WorkspaceAccessContext.Provider>
  );
}

export function useWorkspaceAccess(): WorkspaceAccessContextValue {
  const value = useContext(WorkspaceAccessContext);
  if (!value) throw new Error("WorkspaceAccessProvider is required");
  return value;
}

const styles = StyleSheet.create({
  lockedPage: {
    alignItems: "center",
    backgroundColor: colors.canvas,
    flex: 1,
    justifyContent: "center",
    padding: space.lg,
  },
  lockedCard: {
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
    maxWidth: 420,
    padding: space.xl,
    width: "100%",
  },
  brand: {
    color: colors.brand,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
    textAlign: "right",
  },
  title: {
    color: colors.ink,
    fontFamily: "Cairo_700Bold",
    fontSize: 22,
    lineHeight: 34,
    textAlign: "right",
  },
  detail: {
    color: colors.mutedInk,
    fontFamily: "Cairo_400Regular",
    fontSize: 14,
    lineHeight: 24,
    textAlign: "right",
  },
  unlockButton: {
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: radius.field,
    justifyContent: "center",
    minHeight: 52,
    marginTop: space.sm,
  },
  unlockText: {
    color: colors.surface,
    fontFamily: "Cairo_700Bold",
    fontSize: 15,
  },
});
