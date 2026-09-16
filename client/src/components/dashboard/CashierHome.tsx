import type React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { hasModuleAccess, type PermissionMap } from "@shared/permissions";
import {
  BadgeDollarSign,
  Barcode,
  CalendarClock,
  CheckCircle2,
  CheckSquare,
  Clock,
  MessageSquare,
  Package,
  Printer,
  ReceiptText,
  ShoppingBag,
  Store,
  Ticket,
  Truck,
  User,
} from "lucide-react";

/* ═══════════ THEME — CSS variables in tokens.css ═══════════ */
const T = {
  bg:          "var(--dash-bg)",
  cardBg:      "var(--dash-card-bg)",
  cardBord:    "var(--dash-card-bord)",
  secLine:     "var(--dash-sec-line)",
  secLabel:    "var(--dash-sec-label)",
  text:        "var(--dash-text)",
  sub:         "var(--dash-sub)",
  muted:       "var(--dash-muted)",
  featuredBg:  "var(--dash-featured-bg)",
  featuredBd:  "var(--dash-featured-bd)",
} as const;

export interface Tile {
  href: string;
  name: string;
  desc: string;
  /** عدّادٌ يستحقّ نظرةً قبل فتح البطاقة (صفرٌ ⇒ لا يُعرَض — لا ضوضاءَ بلا خبر). */
  badge?: number;
  badgeHint?: string;
  badgeVariant?: "warn" | "success" | "info";
  icon?: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}

/** مجموعةُ بطاقاتٍ بعنوانٍ — الفاصلُ بينها هو ما يُنهي «صفَّ أزرارٍ متساوية الوزن». */
function TileGroup({
  label,
  hint,
  tiles,
}: {
  label: string;
  hint?: string;
  tiles: Tile[];
}) {
  if (tiles.length === 0) return null;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 14 }} aria-label={label}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <h2 style={{ fontSize: "0.8125rem", fontWeight: 800, color: T.secLabel, margin: 0, letterSpacing: "0.04em" }}>
          {label}
        </h2>
        {hint && <span style={{ fontSize: "0.75rem", color: T.muted }}>{hint}</span>}
        <div style={{ flex: 1, height: 1, background: T.secLine }} aria-hidden />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(264px, 1fr))", gap: 14 }}>
        {tiles.map((t) => {
          const Icon = t.icon;
          const badgeBg =
            t.badgeVariant === "success"
              ? "var(--sem-pos-bg)"
              : t.badgeVariant === "info"
                ? "var(--sem-info-bg)"
                : "var(--sem-warn-bg)";
          const badgeColor =
            t.badgeVariant === "success"
              ? "var(--sem-pos)"
              : t.badgeVariant === "info"
                ? "var(--sem-info)"
                : "var(--sem-warn)";

          return (
            <Link
              key={t.href}
              href={t.href}
              style={{
                position: "relative",
                background: T.cardBg,
                border: `1px solid ${T.cardBord}`,
                borderRadius: 14,
                padding: "18px 18px",
                textDecoration: "none",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                minHeight: 96,
                transition: "transform 0.1s ease, border-color 0.15s ease",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {Icon && (
                    <span
                      aria-hidden
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 32,
                        height: 32,
                        borderRadius: 9,
                        background: "var(--muted)",
                        color: "var(--foreground)",
                        flexShrink: 0,
                      }}
                    >
                      <Icon style={{ width: 17, height: 17 }} />
                    </span>
                  )}
                  <span style={{ fontSize: "1rem", fontWeight: 700, color: T.text }}>{t.name}</span>
                </div>
                {Boolean(t.badge && t.badge > 0) && (
                  <span
                    title={t.badgeHint}
                    style={{
                      minWidth: 24,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: badgeBg,
                      color: badgeColor,
                      fontSize: "0.75rem",
                      fontWeight: 800,
                      textAlign: "center",
                    }}
                  >
                    {t.badge && t.badge > 99 ? "99+" : t.badge}
                  </span>
                )}
              </div>
              <div style={{ fontSize: "0.8125rem", color: T.muted, lineHeight: 1.6 }}>{t.desc}</div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/* ═══════════ مساحة عمل الكاشير والاستقبال المركّزة (٢٤/٧) ═══════════ */

export function CashierHome({ tasksBrief }: { tasksBrief?: React.ReactNode }) {
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const roleLabel = me.data?.customRoleLabel ?? "كاشير";
  const branchId = me.data?.branchId ?? null;

  const can = (mod: string, lvl: "READ" | "FULL" = "READ") =>
    Boolean(role && hasModuleAccess(role, override, mod, lvl));
  // محطّة الاستقبال بوّابتها وحدة `workorders` (POS_STATION_GATES) — من لا يملكها لا يرى لوحاتها.
  const isReception = can("workorders", "FULL");

  // عدّادات التشغيل الحيّة
  const woCounts = trpc.workOrders.counts.useQuery(
    branchId != null ? { branchId } : {},
    { enabled: isReception && branchId != null, staleTime: 30_000 },
  );

  const deliveryReadyCountQ = trpc.delivery.readyForDispatchCount.useQuery(undefined, {
    enabled: isReception && can("store"),
    staleTime: 30_000,
  });

  const convs = trpc.conversations.list.useQuery(
    branchId != null ? { branchId, limit: 50 } : { limit: 50 },
    { enabled: isReception && can("channels") && branchId != null, staleTime: 30_000 },
  );
  const unread = (convs.data?.rows ?? []).reduce((n, c) => n + (c.unreadCount ?? 0), 0);

  // الوردية الحالية
  const shiftQ = trpc.shifts.current.useQuery(
    branchId != null ? { branchId, shiftType: isReception ? "RECEPTION" : "RETAIL" } : undefined as any,
    { enabled: branchId != null, staleTime: 30_000 },
  );
  const shift = shiftQ.data ?? null;

  /**
   * ① عمليات المنضدة والتسليم المباشر:
   * قلب العمل اليومي لموظف الاستقبال (التسليم المباشر بالباركود، الإسناد والتوصيل، وطوابير المتابعة).
   */
  const counterTiles: Tile[] = isReception
    ? [
        {
          href: "/reception/handover",
          name: "التسليم المباشر",
          desc: "مسح باركود فوري — تحصيل (نقدي/شبكة/محفظة) وإغلاق ذري للطلب",
          badge: woCounts.data?.ready ?? 0,
          badgeHint: "طلب جاهز بانتظار استلام العميل",
          badgeVariant: "success",
          icon: CheckCircle2,
        },
        {
          href: "/reception/workflow",
          name: "الإسناد والتوصيل",
          desc: "إسناد لمناديب الفرع وشركات الشحن — وتوريد الذمم والمرتجع",
          badge: deliveryReadyCountQ.data ?? 0,
          badgeHint: "شحنة جاهزة للتوصيل والإسناد",
          badgeVariant: "info",
          icon: Truck,
        },
        {
          href: "/reception/orders",
          name: "طلبات محطّتي",
          desc: "طابور أوامر الشغل — متابعة مراحل التنفيذ بالمطبعة والجاهز والمعلق",
          icon: Package,
        },
        {
          href: "/reception/invoices",
          name: "فواتير للتحصيل",
          desc: "المبالغ المتبقية والذمم المعلقة — اقبضها مباشرة من الصف",
          icon: BadgeDollarSign,
        },
      ]
    : [];

  /**
   * ② خدمة وقنوات العملاء:
   * المحادثات والتواصل والحجوزات الإلكترونية.
   */
  const channelTiles: Tile[] = isReception
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
        ...(can("store")
          ? [{
              href: "/store-admin?tab=orders",
              name: "طلبات الموقع",
              desc: "طلبات المتجر الإلكتروني — تثبيتها وإسنادها للمحطة",
              icon: ShoppingBag,
            }]
          : []),
      ]
    : [];

  /**
   * ③ أدوات العمل والمساندة:
   * قارئ الأسعار، لوحة الإنتاج، مطلوب مني الآن، فواتيري، والمهام.
   */
  const toolTiles: Tile[] = [
    { href: "/price-checker", name: "قارئ الأسعار", desc: "فحص سعر أي منتج سريعاً بالباركود", icon: Barcode },
    ...(isReception ? [{ href: "/work-orders", name: "لوحة الإنتاج", desc: "كانبان الطلبات ومراحل التنفيذ بالمطبعة", icon: Printer }] : []),
    { href: "/my-work", name: "مطلوب منّي الآن", desc: "قراراتٌ تنتظر موافقتك وما يخصّك من عمل", icon: CheckSquare },
    ...(can("sales") ? [{ href: "/invoices", name: "كل فواتيري", desc: "بحثٌ وفلترةٌ وإعادة طباعة الفواتير", icon: ReceiptText }] : []),
    ...(can("tasks") ? [{ href: "/tasks", name: "المهام والتذاكر", desc: "طلبات العملاء المُسنَدة إليك ومتابعتها", icon: Ticket }] : []),
    { href: "/account", name: "حسابي", desc: "بياناتك وكلمة المرور وجلساتك", icon: User },
  ];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: T.bg,
        direction: "rtl",
        fontFamily: "'Cairo', sans-serif",
        margin: "-24px",
        padding: "clamp(24px, 4vw, 44px) clamp(20px, 4vw, 48px) 56px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 32,
      }}
    >
      <div style={{ width: "100%", maxWidth: 1180, display: "flex", flexDirection: "column", gap: 32 }}>
        {/* الترويسة الترحيبية */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontSize: "clamp(22px, 2.4vw, 30px)", fontWeight: 800, color: T.text, margin: 0, letterSpacing: "-0.01em" }}>
              أهلاً {me.data?.name ?? ""}
            </h1>
            <p style={{ fontSize: "0.875rem", color: T.sub, margin: "8px 0 0", lineHeight: 1.7 }}>
              {roleLabel} · محطة عملك: افتح ورديتك، استقبل طلبات عملائك، سلّم بالباركود، أغلق وسلّم الصندوق.
            </p>
          </div>

          {/* مؤشر الوردية المباشر في الرأس */}
          <div>
            {shift ? (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 14px",
                  borderRadius: 999,
                  background: "var(--sem-pos-bg)",
                  border: "1px solid var(--sem-pos)",
                  color: "var(--sem-pos)",
                  fontSize: "0.8125rem",
                  fontWeight: 800,
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--sem-pos)", display: "inline-block" }} />
                <span>الوردية مفتوحة #{shift.id}</span>
              </div>
            ) : (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 14px",
                  borderRadius: 999,
                  background: "var(--sem-warn-bg)",
                  border: "1px solid var(--sem-warn)",
                  color: "var(--sem-warn)",
                  fontSize: "0.8125rem",
                  fontWeight: 800,
                }}
              >
                <Clock style={{ width: 14, height: 14 }} />
                <span>لا توجد وردية مفتوحة</span>
              </div>
            )}
          </div>
        </div>

        {/* بطاقة المحطة الرئيسية (Hero Card) */}
        <Link
          href={isReception ? "/pos?mode=RECEPTION" : "/pos"}
          style={{
            display: "block",
            background: T.featuredBg,
            border: `2px solid ${T.featuredBd}`,
            borderRadius: 18,
            padding: "clamp(24px, 3vw, 36px) clamp(22px, 3vw, 32px)",
            textDecoration: "none",
            transition: "all 0.15s ease",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  aria-hidden
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    background: "var(--dash-card-bg)",
                    border: "1px solid var(--dash-card-bord)",
                    color: "var(--dash-text)",
                  }}
                >
                  <Store style={{ width: 22, height: 22 }} />
                </span>
                <div style={{ fontSize: "clamp(22px, 2.4vw, 30px)", fontWeight: 800, color: T.text, letterSpacing: "-0.01em" }}>
                  {isReception ? "محطة خدمة العملاء" : "نقطة البيع"}
                </div>
              </div>
              <div style={{ fontSize: "0.875rem", color: T.sub, lineHeight: 1.7, maxWidth: "68ch" }}>
                {isReception
                  ? "افتح الوردية واستقبل الطلب — السلّة والعميل وتسعير وتخصيص الطباعة والدفع في شاشة واحدة، وعند نهاية عملك أغلقها وسلّم المبلغ من الشاشة نفسها."
                  : "افتح الوردية وابدأ البيع المباشر — وعند نهاية عملك أغلقها وسلّم المبلغ من الشاشة نفسها."}
              </div>
            </div>

            <div style={{ alignSelf: "center" }}>
              {shift ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 16px",
                    borderRadius: 12,
                    background: "var(--dash-card-bg)",
                    border: "1px solid var(--dash-card-bord)",
                    color: T.text,
                    fontSize: "0.8125rem",
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
                    padding: "8px 16px",
                    borderRadius: 12,
                    background: "var(--dash-card-bg)",
                    border: "1px solid var(--dash-card-bord)",
                    color: T.text,
                    fontSize: "0.8125rem",
                    fontWeight: 800,
                  }}
                >
                  فتح وردية جديدة ←
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

        {/* المجموعة 3: أدوات ومتابعة */}
        <TileGroup
          label="أدوات ومتابعة"
          hint="الأسعار والإنتاج والمهام وحسابك"
          tiles={toolTiles}
        />
      </div>

      {/* طابور المهام الشخصي إن وُجد */}
      {tasksBrief && (
        <div style={{ width: "100%", maxWidth: 1180 }}>
          {tasksBrief}
        </div>
      )}
    </div>
  );
}
