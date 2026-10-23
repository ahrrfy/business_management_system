import { CASHIER_THEME as T, TileGroup, type Tile } from "./CashierHomeTiles";
export type { Tile } from "./CashierHomeTiles";
import { ACTION_LABELS } from "@shared/actionLabels";
import { ErrorState } from "@/components/PageState";
import type React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { FinancialCellProvenanceHover } from "@/components/financial";
import type { WorkspaceNavItem } from "@/lib/workspaceProfiles";
import {
  cashierProfileActions,
  type CashierActionIcon,
} from "@/lib/cashierWorkspace";
import { visibleReceptionOperationTabs } from "@/lib/receptionOperationsHub";
import {
  hasModuleAccess,
  type PermissionMap,
  type PosStation,
} from "@shared/permissions";
import { useRealtimeEvent } from "@/lib/realtime";
import { REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";
import {
  BadgeDollarSign,
  Barcode,
  CalendarClock,
  CheckCircle2,
  Clock,
  MapPinOff,
  MessageSquare,
  Package,
  Printer,
  ReceiptText,
  RotateCcw,
  ShoppingBag,
  Store,
  Truck,
} from "lucide-react";

/* ═══════════ THEME — CSS variables in tokens.css ═══════════ */
function cashierActionIcon(icon: CashierActionIcon): Tile["icon"] {
  switch (icon) {
    case "station": return Store;
    case "invoice": return ReceiptText;
    case "returns": return RotateCcw;
    case "workorders": return Printer;
    case "price": return Barcode;
  }
}

/* ═══════════ مساحة عمل الكاشير والاستقبال المركّزة (٢٤/٧) ═══════════ */

export function CashierHome({
  station,
  defaultAction,
  primaryNav,
}: {
  station: PosStation;
  defaultAction: WorkspaceNavItem;
  primaryNav: readonly WorkspaceNavItem[];
}) {
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const roleLabel = me.data?.customRoleLabel ?? "كاشير";
  const branchId = me.data?.branchId ?? null;

  const can = (mod: string, lvl: "READ" | "FULL" = "READ") =>
    Boolean(role && hasModuleAccess(role, override, mod, lvl));
  const isReception = station === "RECEPTION";
  const isPrintServices = station === "PRINT_SERVICES";
  const canViewShift = can("treasury", "READ");
  const canViewStore = can("store", "READ");
  const visibleReceptionTabs = new Set(visibleReceptionOperationTabs({
    hasBranch: branchId != null,
    role,
    permissionsOverride: override,
  }));
  const stationTitle = isReception
    ? "محطة خدمة العملاء"
    : isPrintServices
      ? "كاشير خدمات الطباعة"
      : "نقطة البيع";
  const stationDescription = isReception
    ? "افتح الوردية واستقبل الطلب — السلّة والعميل وتسعير وتخصيص الطباعة والدفع في شاشة واحدة، وعند نهاية عملك أغلقها وسلّم المبلغ من الشاشة نفسها."
    : isPrintServices
      ? "افتح وردية خدمات الطباعة وابدأ تسعير الطلبات وتحصيلها من المحطة المخصّصة."
      : "افتح الوردية وابدأ البيع المباشر — وعند نهاية عملك أغلقها وسلّم المبلغ من الشاشة نفسها.";
  const stationHref = station === "RETAIL" ? "/pos" : defaultAction.href;

  // عدّادات التشغيل الحيّة
  const woCounts = trpc.workOrders.counts.useQuery(
    branchId != null ? { branchId } : {},
    { enabled: isReception && branchId != null, staleTime: 30_000 },
  );

  const deliveryReadyCountQ = trpc.delivery.readyForDispatchCount.useQuery(undefined, {
    enabled: isReception && visibleReceptionTabs.has("workflow"),
    staleTime: 30_000,
  });

  const utils = trpc.useUtils?.();
  useRealtimeEvent(REALTIME_EVENT_TYPES.STOREFRONT_ORDER_PLACED, () => {
    void utils?.storeAdmin?.orders?.counts?.invalidate?.();
  });

  const storeOrderCountsQ = trpc.storeAdmin.orders.counts.useQuery(undefined, {
    enabled: canViewStore,
    staleTime: 30_000,
  });
  const pendingStoreOrders =
    (storeOrderCountsQ.data?.PENDING ?? 0) +
    (storeOrderCountsQ.data?.CONFIRMED ?? 0);

  const convs = trpc.conversations.list.useQuery(
    branchId != null ? { branchId, limit: 50 } : { limit: 50 },
    { enabled: isReception && can("channels") && branchId != null, staleTime: 30_000 },
  );
  const unread = (convs.data?.rows ?? []).reduce((n, c) => n + (c.unreadCount ?? 0), 0);

  // الوردية الحالية
  const shiftQ = trpc.shifts.current.useQuery(
    branchId != null ? { branchId, shiftType: station } : undefined as any,
    { enabled: canViewShift && branchId != null, staleTime: 30_000 },
  );
  const shift = shiftQ.data ?? null;

  /**
   * ① عمليات المنضدة والتسليم المباشر:
   * قلب العمل اليومي لموظف الاستقبال (التسليم المباشر بالباركود، الإسناد والتوصيل، وطوابير المتابعة).
   */
  const counterTiles: Tile[] = isReception
    ? [
          ...(visibleReceptionTabs.has("handover")
            ? [{
                href: "/reception/handover",
                name: "تسليم للعميل",
                desc: "فرز الطلبات الجاهزة / تسليم (كامل/جزئي/نقدي) للعملاء في الفرع",
                badge: woCounts.data?.ready ?? 0,
                badgeHint: "أمر عمل جاهز للتسليم الآن",
                badgeVariant: "success" as const,
                icon: CheckCircle2,
              }]
            : []),
          ...(visibleReceptionTabs.has("workflow")
            ? [{
                href: "/reception/workflow",
                name: "التوصيل والإسناد",
                desc: "إسناد الطلبات الجاهزة لمندوب / تحصيل ذمم المندوبين وتعديلها",
                badge: deliveryReadyCountQ.data ?? 0,
                badgeHint: "طرد جاهز للإسناد لمندوب",
                badgeVariant: "info" as const,
                icon: Truck,
              }]
            : []),
          ...(visibleReceptionTabs.has("orders")
            ? [{
                href: "/reception/orders",
                name: "سجل الطلبات",
                desc: "سجل طلبات الفرع / متابعة حالة التصميم والإنتاج والمرفقات",
                icon: Package,
              }]
            : []),
          ...(visibleReceptionTabs.has("invoices")
            ? [{
                href: "/reception/invoices",
                name: "فواتير المبيعات",
                desc: "الفواتير الضريبية للفرع / تعديل الفواتير / تحصيل الذمم",
                icon: BadgeDollarSign,
              }]
            : []),
      ]
    : [];

  /**
   * ② خدمة وقنوات العملاء:
   * المحادثات والتواصل والحجوزات الإلكترونية.
   */
  const channelTiles: Tile[] = isReception && branchId != null
    ? [
        ...(can("channels")
          ? [{
              href: "/crm?tab=inbox",
              name: "رسائل العملاء",
              desc: "واتساب والاتصالات — محادثات وفتح طلبات مباشرة للعميل",
              badge: unread,
              badgeHint: "رسالة لم تُقرأ",
              badgeVariant: "warn" as const,
              icon: MessageSquare,
            }]
          : []),
        ...(can("reservations")
          ? [{
              href: "/reservations",
              name: "الحجوزات",
              desc: "حجز صنف أو ملف لعميل حتى موعد الاستلام",
              icon: CalendarClock,
            }]
          : []),
        ...(canViewStore
          ? [{
              href: "/store-admin?tab=orders",
              name: "طلبات الموقع",
              desc: "طلبات المتجر الإلكتروني — تثبيتها وإسنادها للمحطة",
              badge: pendingStoreOrders > 0 ? pendingStoreOrders : undefined,
              badgeHint: "طلبات متجر بانتظار التجهيز",
              badgeVariant: "warn" as const,
              icon: ShoppingBag,
            }]
          : []),
      ]
    : [];

  // ما بعد بطاقة المحطة يأتي حصراً من profile المحلول؛ لا إعادة تخمين للصلاحية بحسب sales
  // ولا فقد لمحطات الطباعة/الاستقبال أو الفواتير ذات النطاق المقصور.
  const profileTiles: Tile[] = cashierProfileActions(
    primaryNav,
    defaultAction.id,
    { hasBranch: branchId != null },
  ).map((item) => ({
    href: item.href,
    name: item.name,
    desc: item.description,
    icon: cashierActionIcon(item.icon),
  }));

  // المستخدم التشغيلي بلا فرع لا يستطيع عبور branchScopedProcedure. نوقف المحطة وكل
  // المسارات التشغيلية هنا بدلاً من إرساله إلى صفحات تنتهي بـFORBIDDEN؛ قارئ الأسعار
  // وحده غير مقصور بفرع ويمكن أن يبقى إن كان ضمن profile المصرح به.
  if (branchId == null) {
    return (
      <div
        style={{
          minHeight: "auto",
          background: T.bg,
          direction: "rtl",
          fontFamily: "'Cairo', sans-serif",
          margin: "0",
          padding: "clamp(24px, 4vw, 44px) clamp(20px, 4vw, 48px) 56px",
        }}
      >
        <div style={{ width: "100%", maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
          <section
            role="status"
            aria-live="polite"
            style={{
              background: T.cardBg,
              border: `1px solid ${T.cardBord}`,
              borderRadius: 16,
              padding: "28px 24px",
              display: "flex",
              alignItems: "flex-start",
              gap: 14,
            }}
          >
            <MapPinOff aria-hidden style={{ width: 24, height: 24, color: "var(--sem-warn)", flexShrink: 0 }} />
            <div>
              <h1 style={{ fontSize: "1.25rem", fontWeight: 800, color: T.text, margin: 0 }}>
                {me.isLoading ? "جارٍ تحميل مساحة العمل" : "لا يوجد فرع مسند لهذا الحساب"}
              </h1>
              <p style={{ fontSize: "0.875rem", color: T.sub, lineHeight: 1.8, margin: "8px 0 0" }}>
                {me.isLoading
                  ? "انتظر لحظة حتى يكتمل تحميل بيانات الحساب."
                  : "لا يمكن فتح محطة البيع أو المسارات التشغيلية قبل إسناد فرع. راجع مدير النظام لتحديد فرعك ثم أعد تحميل الصفحة."}
              </p>
            </div>
          </section>

          {!me.isLoading && (
            <TileGroup
              label="أدوات متاحة دون فرع"
              hint="لا تتطلب نطاقاً تشغيلياً"
              tiles={profileTiles}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: T.bg,
        direction: "rtl",
        fontFamily: "'Cairo', sans-serif",
        margin: "-24px",
        padding: "0 0 16px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 20,
      }}
    >
      <div style={{ width: "100%", maxWidth: 1180, display: "flex", flexDirection: "column", gap: 20 }}>
        {/* الترويسة الترحيبية */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontSize: "clamp(18px, 2vw, 24px)", fontWeight: 800, color: T.text, margin: 0, letterSpacing: "-0.01em" }}>
              أهلاً {me.data?.name ?? ""}
            </h1>
            <p style={{ fontSize: "0.8125rem", color: T.sub, margin: "4px 0 0", lineHeight: 1.5 }}>
              {roleLabel} · محطة عملك: افتح ورديتك، استقبل طلبات عملائك، سلّم بالباركود، أغلق وسلّم الصندوق.
            </p>
          </div>

          {/* مؤشر الوردية المباشر في الرأس */}
          {canViewShift && <div>
            {shiftQ.isLoading ? <span>{ACTION_LABELS.loading}</span> : shiftQ.isError && !shift ? <ErrorState message={shiftQ.error.message} onRetry={() => void shiftQ.refetch()} /> : shift ? (
              <FinancialCellProvenanceHover data={(shift as any).provenance}>
                <div
                  className="cursor-pointer hover:opacity-90 transition-opacity"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 12px",
                    borderRadius: 999,
                    background: "var(--sem-pos-bg)",
                    border: "1px solid var(--sem-pos)",
                    color: "var(--sem-pos)",
                    fontSize: "0.75rem",
                    fontWeight: 800,
                  }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--sem-pos)", display: "inline-block" }} />
                  <span>الوردية مفتوحة #{shift.id}</span>
                </div>
              </FinancialCellProvenanceHover>
            ) : (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 12px",
                  borderRadius: 999,
                  background: "var(--sem-warn-bg)",
                  border: "1px solid var(--sem-warn)",
                  color: "var(--sem-warn)",
                  fontSize: "0.75rem",
                  fontWeight: 800,
                }}
              >
                <Clock style={{ width: 13, height: 13 }} />
                <span>لا توجد وردية مفتوحة</span>
              </div>
            )}
          </div>}
        </div>

        {/* شريط تنبيه عاجل لطلبات المتجر الواردة */}
        {canViewStore && pendingStoreOrders > 0 && (
          <Link
            href="/store-admin?tab=orders"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              padding: "9px 14px",
              borderRadius: 10,
              background: "var(--sem-warn-bg)",
              border: "1px solid var(--sem-warn)",
              color: "var(--sem-warn)",
              textDecoration: "none",
              fontSize: "0.8125rem",
              fontWeight: 700,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ShoppingBag style={{ width: 16, height: 16, flexShrink: 0 }} />
              <span>
                تنبيه: يوجد {pendingStoreOrders.toLocaleString("ar-IQ-u-nu-latn")} طلب متجر إلكتروني بحاجة للمتابعة والتجهيز
              </span>
            </div>
            <span style={{ fontSize: "0.75rem", textDecoration: "underline" }}>
              فتح شاشة التجهيز
            </span>
          </Link>
        )}

        {/* بطاقة المحطة الرئيسية (Hero Card) */}
        <Link
          href={stationHref}
          style={{
            display: "block",
            background: T.featuredBg,
            border: `2px solid ${T.featuredBd}`,
            borderRadius: 14,
            padding: "clamp(16px, 2vw, 22px) clamp(16px, 2.2vw, 24px)",
            textDecoration: "none",
            transition: "all 0.15s ease",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  aria-hidden
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    background: "var(--dash-card-bg)",
                    border: "1px solid var(--dash-card-bord)",
                    color: "var(--dash-text)",
                  }}
                >
                  <Store style={{ width: 18, height: 18 }} />
                </span>
                <div style={{ fontSize: "clamp(18px, 2vw, 24px)", fontWeight: 800, color: T.text, letterSpacing: "-0.01em" }}>
                  {stationTitle}
                </div>
              </div>
              <div style={{ fontSize: "0.8125rem", color: T.sub, lineHeight: 1.55, maxWidth: "68ch" }}>
                {stationDescription}
              </div>
            </div>

            <div style={{ alignSelf: "center" }}>
              {canViewShift && shift ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 14px",
                    borderRadius: 10,
                    background: "var(--dash-card-bg)",
                    border: "1px solid var(--dash-card-bord)",
                    color: T.text,
                    fontSize: "0.75rem",
                    fontWeight: 800,
                  }}
                >
                  دخول المحطة ←
                </span>
              ) : (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 14px",
                    borderRadius: 10,
                    background: "var(--dash-card-bg)",
                    border: "1px solid var(--dash-card-bord)",
                    color: T.text,
                    fontSize: "0.75rem",
                    fontWeight: 800,
                  }}
                >
                  {canViewShift ? "فتح وردية جديدة ←" : "دخول المحطة ←"}
                </span>
              )}
            </div>
          </div>
        </Link>

        {/* المجموعة 1: عمليات المنضدة والتسليم المباشر */}
        {counterTiles.length > 0 && (
          <TileGroup
            label="عمليات المنضدة والتسليم"
            hint="إجراءات الاستقبال المباشر والتسليم بالباركود"
            tiles={counterTiles}
          />
        )}

        {/* المجموعة 2: قنوات وخدمة العملاء */}
        {channelTiles.length > 0 && (
          <TileGroup
            label="قنوات وخدمة العملاء"
            hint="المحادثات والحجوزات والمتجر الإلكتروني"
            tiles={channelTiles}
          />
        )}

        {/* المجموعة 3: بقية إجراءات profile المصرح بها (المحطة الافتراضية ممثلة بالبطاقة الكبرى). */}
        <TileGroup
          label="مسارات عملي"
          hint="المداخل اليومية المصرح بها لهذا الحساب"
          tiles={profileTiles}
        />
      </div>
    </div>
  );
}
