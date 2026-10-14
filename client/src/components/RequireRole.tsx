/**
 * RequireRole — حارس وصول على مستوى الواجهة للشاشات الإدارية.
 *
 * مهم: هذا حارس واجهة فقط (UX/تجربة استخدام) — الإنفاذ الحقيقي للأمان
 * يقع في الخادم عبر بوّابات server/trpc.ts.
 *
 * ٦/٧/٢٦: كان يفحص اسم الدور فقط ويتجاهل الصلاحيات الممنوحة (permissionsOverride)
 * تماماً ⇒ منح المالك وحدةً لمستخدم لا يغيّر شيئاً في الواجهة («لا تملك صلاحية» رغم
 * المنح). الآن: عند تمرير `module` تُطبَّق قاعدة الخادم نفسها (moduleAccessAllowed
 * المشتركة): دور القائمة يخضع لخريطته المحلولة، ودور خارجها يمرّ بمنح صريح للوحدة.
 *
 * يعتمد على trpc.auth.me — يُستخدم داخل <Protected> الذي ضمن وجود جلسة،
 * فلا حاجة للتعامل مع حالة "بلا مستخدم" هنا.
 */
import {
  getOfflineUnlockedProfile,
  isOfflineUnlocked,
  subscribeOfflineUnlock,
} from "@/lib/offline/pinLock";
import { isDisconnected, useConnectivity } from "@/lib/offline/connectivity";
import { trpc } from "@/lib/trpc";
import { hasModuleAccess, moduleAccessAllowed, type AccessLevel, type PermissionMap, type RoleKey } from "@shared/permissions";
import {
  canSeeGate,
  RETURNS_WORKSPACE_GATE,
  type RoleGate,
} from "@/lib/navVisibility";
import { Lock } from "lucide-react";
import { useSyncExternalStore } from "react";
import { ACTION_LABELS } from "@shared/actionLabels";
import type { OperationPolicy } from "@shared/operationPermissions";

const RETURNS_ARCHIVE_GATE: RoleGate = {
  operations: ["returns.list", "purchaseReturns.list"],
};

const LEGACY_RETURNS_STATION_GATE: RoleGate = {
  anyOf: [
    { roles: ["cashier", "manager", "print_operator"], module: "workorders", level: "FULL" },
    { roles: ["cashier", "manager", "print_operator"], module: "pos", level: "FULL" },
  ],
};

type Props = {
  /** Compound exact operation contract for alternative workflows in the same editor. */
  canonicalGate?: RoleGate;
  /** Exact canonical actions needed to open this editor; legacy gates remain below. */
  operations?: string[];
  /** الأدوار المسموح لها بالوصول. لا تقبل قائمة فارغة. */
  roles?: RoleKey[];
  /** بوابة مركبة (anyOf/allOf) للمسارات التي لا تختزل في وحدة واحدة. */
  gate?: RoleGate;
  /**
   * مفتاح الوحدة في مصفوفة الصلاحيات (pos/sales/reports/…). عند تمريره يُفتح الوصول
   * أيضاً لمن مُنح الوحدة صراحةً بالمستوى المطلوب، وتُنفَّذ خريطة الدور على أدوار القائمة.
   */
  module?: string;
  /** المستوى الأدنى المطلوب عند تمرير module (الافتراضي READ). */
  level?: AccessLevel;
  /** لا يمرر إلا من بوابة PIN+مطابقة الهوية لمسار Studio البارد. */
  localOfflineActor?: { userId: number; role: string } | null;
  children: React.ReactNode;
};

export function RequireRole({
  canonicalGate,
  operations,
  roles,
  gate,
  module,
  level,
  localOfflineActor,
  children,
}: Props) {
  const connectivity = useConnectivity();
  const unlocked = useSyncExternalStore(
    subscribeOfflineUnlock,
    isOfflineUnlocked,
    isOfflineUnlocked,
  );
  const offline =
    isDisconnected(connectivity) ||
    (typeof navigator !== "undefined" && !navigator.onLine);
  const localActor =
    offline && unlocked && localOfflineActor !== undefined
      ? localOfflineActor
      : undefined;
  const me = trpc.auth.me.useQuery(undefined, { enabled: localActor === undefined });

  // أثناء التحميل: لا نكشف عن المحتوى — تجربة هادئة بلا وميض.
  if (localActor === undefined && me.isLoading) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center text-muted-foreground">
        {ACTION_LABELS.verifyingPermissions}
      </div>
    );
  }

  const role = (localActor?.role ?? (me.data?.isOwner ? "admin" : me.data?.role)) as RoleKey | undefined;
  const override = (me.data?.isOwner ? null : me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const operationPolicy =
    !localActor &&
    !me.data?.isOwner &&
    (me.data as { operationPolicyEnabled?: boolean })?.operationPolicyEnabled
      ? (me.data as { resolvedOperationPolicy?: OperationPolicy })
          .resolvedOperationPolicy
      : null;
  const allowed =
    !!role &&
    (operationPolicy && canonicalGate
      ? canSeeGate(canonicalGate, role, override, operationPolicy) ||
        (canonicalGate === RETURNS_WORKSPACE_GATE &&
          canSeeGate(RETURNS_ARCHIVE_GATE, role, override, operationPolicy))
      : operationPolicy && operations?.length
      ? canSeeGate({ operations }, role, override, operationPolicy)
      : gate
      ? canSeeGate(gate, role, override, operationPolicy)
      : module
        ? canSeeGate({ roles, module, level }, role, override, operationPolicy) ||
          (canonicalGate === RETURNS_WORKSPACE_GATE &&
            canSeeGate(LEGACY_RETURNS_STATION_GATE, role, override, operationPolicy))
        : role === "admin" || !!roles?.includes(role));
  if (!allowed) {
    return <Forbidden />;
  }

  return <>{children}</>;
}

function Forbidden() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center gap-3 text-center px-4">
      <Lock aria-hidden className="size-16 text-muted-foreground" />
      <h1 className="text-xl font-semibold">لا تملك صلاحية للوصول إلى هذه الصفحة</h1>
      <p className="text-sm text-muted-foreground max-w-md">
        هذه الشاشة مخصّصة للإدارة. إن كنت تحتاج إليها فعلاً، تواصل مع مدير النظام لمنحك الصلاحية المناسبة.
      </p>
      <a href="/" className="text-sm text-primary hover:underline mt-2">
        العودة إلى لوحة التحكم
      </a>
    </div>
  );
}
