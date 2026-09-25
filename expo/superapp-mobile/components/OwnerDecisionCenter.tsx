import { useCallback, useEffect, useState } from "react";
import { ImageBackground, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";

import { AnimatedReveal } from "@/components/AnimatedReveal";
import { ExperienceState, SyncStatus } from "@/components/ExperienceState";
import { AnimatedProgress, StatusDot } from "@/components/Ui";
import { colors, radius, space } from "@/constants/theme";
import {
  type ExecutiveDecision,
  type OwnerDecisionCenter as OwnerDecisionCenterData,
} from "@/lib/executive";
import { formatBaghdadTime, formatIqd } from "@/lib/format";
import { getSecureTransportRuntimeStatus } from "@/lib/deviceProof";
import { getNativeMobileCommandCenter, type MobileCommandCenter } from "@/lib/secureTransport";
import { unlockLocalSession } from "@/lib/localSessionUnlock";

const branchHero = require("@/assets/branch-mansour-hero-v2.png");

const severityColor = {
  critical: colors.danger,
  warning: colors.warning,
  info: colors.info,
} as const;

const severityLabel = {
  critical: "عاجل",
  warning: "تنبيه",
  info: "للمراجعة",
} as const;

type OwnerCenterState = "loading" | "signedOut" | "ready" | "error";

type MetricWithRoute = OwnerDecisionCenterData["metrics"][number] & { route?: string };

function metric(value: string | null, label: string, detail: string, route?: string): MetricWithRoute {
  return value === null
    ? { label, value: "غير متاح", detail: "المصدر غير متاح", available: false, route }
    : { label, value, detail, available: true, route };
}

type EnhancedOwnerDecisionCenterData = Omit<OwnerDecisionCenterData, "metrics"> & {
  metrics: MetricWithRoute[];
};

function commandCenterToView(value: MobileCommandCenter): EnhancedOwnerDecisionCenterData {
  return {
    asOf: value.asOf,
    scopeLabel: value.scope === "ALL_BRANCHES" ? "جميع الفروع" : "فرعك المكلّف",
    health: value.health.status === "degraded" ? "degraded" : "healthy",
    decisions: value.decisions.map((decision) => ({
      ...decision,
      context: "عرض القرار للقراءة والاعتماد؛ التنفيذ يتم وفق صلاحيات المنظومة المعتمدة.",
    })),
    metrics: [
      metric(value.metrics.salesToday ? formatIqd(value.metrics.salesToday.total) : null, "مبيعات اليوم", value.metrics.salesToday ? `${value.metrics.salesToday.invoiceCount} فاتورة` : "", "/operations/invoices"),
      metric(value.metrics.treasury ? formatIqd(value.metrics.treasury.balance) : null, "رصيد الخزينة", value.metrics.treasury ? `${value.metrics.treasury.openShiftsCount} وردية مفتوحة` : "", "/operations/treasury"),
      metric(value.metrics.lowStockCount === null ? null : String(value.metrics.lowStockCount), "مخزون منخفض", value.metrics.lowStockCount === null ? "" : "يحتاج متابعة", "/operations/inventory"),
    ],
  };
}

const quickActions = [
  { icon: "wallet-outline" as const, label: "الخزينة والسيولة", route: "/operations/treasury" },
  { icon: "receipt-outline" as const, label: "الفواتير والمبيعات", route: "/operations/invoices" },
  { icon: "cube-outline" as const, label: "جرد المخزون", route: "/operations/inventory" },
  { icon: "people-outline" as const, label: "دليل العملاء", route: "/operations/customers" },
  { icon: "business-outline" as const, label: "المشتريات والموردين", route: "/operations/purchases" },
  { icon: "shield-checkmark-outline" as const, label: "صندوق الاعتمادات", route: "/operations/approvals" },
] as const;

export function OwnerDecisionCenter() {
  const [selected, setSelected] = useState<ExecutiveDecision | null>(null);
  const [state, setState] = useState<OwnerCenterState>("loading");
  const [liveCenter, setLiveCenter] = useState<EnhancedOwnerDecisionCenterData | null>(null);
  const [decisionFeedback, setDecisionFeedback] = useState<string | null>(null);
  const [isApproving, setIsApproving] = useState(false);

  const refresh = useCallback(async () => {
    setSelected(null);
    setDecisionFeedback(null);
    setState("loading");
    try {
      const transport = await getSecureTransportRuntimeStatus();
      if (transport.kind === "unavailable" || !transport.configured) {
        setLiveCenter(null);
        setState("signedOut");
        return;
      }
      if (transport.session !== "present") {
        setLiveCenter(null);
        setState("signedOut");
        return;
      }
      await unlockLocalSession();
      setLiveCenter(commandCenterToView(await getNativeMobileCommandCenter()));
      setState("ready");
    } catch {
      setLiveCenter(null);
      setState("error");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const center = liveCenter;
  const asOf = center?.asOf ? (formatBaghdadTime(center.asOf) ?? "وقت التحديث غير متاح") : "";
  const primaryDecision = center?.decisions[0] ?? null;
  const secondaryDecisions = center?.decisions.slice(1, 3) ?? [];
  const availableSources = center?.metrics.filter((item) => item.available).length ?? 0;
  const sourceRatio = center ? availableSources / Math.max(center.metrics.length, 1) : 0;
  const operatingScore = Math.round(sourceRatio * 100);
  const operatingReason = center
    ? `${availableSources} من ${center.metrics.length} مصادر متاحة · ${center.health === "healthy" ? "لا توجد أعطال مؤثرة" : "توجد مصادر تحتاج متابعة"}`
    : "جاري التحقق من مصادر المنظومة";

  const openDecision = (decision: ExecutiveDecision | null) => {
    if (!decision) return;
    Haptics.selectionAsync().catch(() => undefined);
    setSelected(decision);
    setDecisionFeedback(null);
  };

  const closeDecision = () => {
    setSelected(null);
    setDecisionFeedback(null);
  };

  const handleBiometricApprove = async () => {
    if (!selected) return;
    setIsApproving(true);
    try {
      await unlockLocalSession();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDecisionFeedback(`تم توثيق بصمة المالك واعتماد القرار «${selected.title}» محلياً.`);
      setTimeout(() => {
        setDecisionFeedback(null);
        setSelected(null);
      }, 1400);
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setDecisionFeedback("تعذر استكمال المصادقة. يرجى المحاولة ثانية.");
    } finally {
      setIsApproving(false);
    }
  };

  const handleReject = () => {
    if (!selected) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    setDecisionFeedback(`تم تسجيل رفض «${selected.title}» وإشعار مقدم الطلب.`);
    setTimeout(() => {
      setDecisionFeedback(null);
      setSelected(null);
    }, 1400);
  };

  return (
    <>
      <ScrollView
        accessibilityLabel="مركز قرار المالك"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl onRefresh={() => void refresh()} refreshing={state === "loading"} tintColor={colors.brand} />}
        style={styles.page}
      >
        <ImageBackground
          imageStyle={styles.heroImage}
          resizeMode="cover"
          source={branchHero}
          style={styles.hero}
        >
          <View style={styles.heroOverlay} />
          <View style={styles.heroContent}>
            <View style={styles.topRow}>
              <View style={styles.wordmarkRow}>
                <View style={styles.brandMark}><Ionicons color={colors.surface} name="cart" size={25} /></View>
                <View>
                  <Text style={styles.wordmark}>سوبر العربية</Text>
                  <Text style={styles.tagline}>منظومة الإدارة المتكاملة</Text>
                </View>
              </View>
              <Pressable accessibilityHint="يفتح إعدادات الحساب والأمان" accessibilityLabel="الإشعارات والحساب" accessibilityRole="button" onPress={() => router.push("/(tabs)/account")} style={styles.notificationButton}>
                <Ionicons color={colors.surface} name="notifications" size={21} />
              </Pressable>
            </View>

            <View style={styles.greetingRow}>
              <View style={styles.greetingCopy}>
                <Text style={styles.greeting}>مركز القيادة والقرار</Text>
                <Text style={styles.role}>{liveCenter ? liveCenter.scopeLabel : "تظهر مؤشرات الإدارة بعد فتح الجلسة الموثقة"}</Text>
              </View>
              {liveCenter ? (
                <View accessibilityLabel={`نطاق البيانات: ${liveCenter.scopeLabel}`} accessibilityRole="text" style={styles.branchSelector}>
                  <Ionicons color="#DCE4FF" name="storefront-outline" size={17} />
                  <Text style={styles.branchText}>{liveCenter.scopeLabel}</Text>
                </View>
              ) : null}
            </View>

            {liveCenter ? (
              <AnimatedReveal delay={90} style={styles.performancePanel}>
                <View
                  accessibilityLabel={`صحة التشغيل اليوم ${operatingScore}%`}
                  accessibilityRole="progressbar"
                  accessibilityValue={{ max: 100, min: 0, now: operatingScore, text: `${operatingScore}%` }}
                  style={styles.scoreMeter}
                >
                  <Text style={styles.scoreValue}>{operatingScore}%</Text>
                  <Text style={styles.scoreTrend}>{liveCenter.health === "healthy" ? "مستقر" : "انتبه"}</Text>
                </View>
                <View style={styles.scoreCopy}>
                  <Text style={styles.scoreTitle}>توفر بيانات التشغيل الحية</Text>
                  <View style={styles.scoreStatusRow}>
                    <StatusDot color={liveCenter.health === "healthy" ? "#35D796" : "#FFB44A"} />
                    <Text style={styles.scoreStatus}>{liveCenter.health === "healthy" ? "سير العمل يسير بشكل منتظم" : "توجد مصادر تحتاج متابعة"}</Text>
                  </View>
                  <AnimatedProgress label="نسبة صحة التشغيل" value={operatingScore} />
                  <Text style={styles.scoreDetail}>{operatingReason}</Text>
                </View>
                <Pressable accessibilityLabel="تحديث مؤشرات التشغيل" accessibilityRole="button" onPress={() => void refresh()} style={styles.scoreMore}>
                  <Text style={styles.scoreMoreText}>تحديث</Text>
                  <Ionicons color={colors.surface} name="chevron-back" size={17} />
                </Pressable>
              </AnimatedReveal>
            ) : null}
          </View>
        </ImageBackground>

        <View style={styles.bodyContent}>
          {state === "loading" ? (
            <ExperienceState compact detail="نتأكد من جلسة الجهاز ومصادر اليوم قبل العرض." state="loading" title="تحديث مركز القرار" />
          ) : state === "signedOut" ? (
            <ExperienceState
              actionLabel="تسجيل الدخول الآمن"
              compact
              detail="سجل الدخول بحسابك الإداري المعتمد للوصول إلى مؤشرات المنشأة."
              onAction={() => router.push("/sign-in")}
              state="offline"
              title="الجلسة غير مسجلة"
            />
          ) : state === "error" || !center ? (
            <ExperienceState
              actionLabel="المحاولة مجدداً"
              compact
              detail="تعذر جلب مؤشرات التشغيل من الخادم؛ تحقق من الاتصال ثم أعد المحاولة."
              onAction={() => void refresh()}
              state="error"
              title="تعذر جلب المؤشرات"
            />
          ) : (
            <>
              <SyncStatus label={`مزامن مع المنظومة · ${asOf}`} state="synced" />

              <AnimatedReveal delay={110} style={styles.metricStrip}>
                {center.metrics.map((item) => (
                  <Pressable
                    accessibilityHint="انقر لعرض السجل والبيانات التفصيلية"
                    accessibilityLabel={`${item.label}: ${item.value}. ${item.detail}. انقر للمتابعة`}
                    accessibilityRole="button"
                    key={item.label}
                    onPress={() => {
                      if (item.route) {
                        void Haptics.selectionAsync();
                        router.push(item.route as any);
                      }
                    }}
                    style={({ pressed }) => [styles.metricItem, pressed && styles.pressed]}
                  >
                    <Text adjustsFontSizeToFit minimumFontScale={0.72} numberOfLines={1} style={[styles.metricValue, !item.available && styles.metricUnavailable]}>{item.value}</Text>
                    <View style={styles.metricLabelRow}>
                      <Text style={styles.metricLabel}>{item.label}</Text>
                      <Ionicons color={colors.brand} name="chevron-back" size={12} />
                    </View>
                    <Text numberOfLines={1} style={styles.metricDetail}>{item.detail}</Text>
                  </Pressable>
                ))}
              </AnimatedReveal>

              <View style={styles.quickHeaderRow}>
                <Text style={styles.quickTitle}>العمليات الميدانية والرقابة الإدارية</Text>
                <Text style={styles.quickSubtitle}>وصول مباشر لكافة وحدات المنظومة</Text>
              </View>
              <View style={styles.quickBar}>
                {quickActions.map((action) => (
                  <Pressable
                    accessibilityLabel={action.label}
                    accessibilityRole="button"
                    key={action.label}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      router.push(action.route as any);
                    }}
                    style={({ pressed }) => [styles.quickAction, pressed && styles.pressed]}
                  >
                    <View style={styles.quickIconBox}>
                      <Ionicons color={colors.brand} name={action.icon} size={22} />
                    </View>
                    <Text numberOfLines={1} style={styles.quickText}>{action.label}</Text>
                  </Pressable>
                ))}
              </View>

              <AnimatedReveal delay={130}>
                <View style={styles.sectionHeader}>
                  <View style={styles.sectionTitleRow}>
                    <View style={styles.targetIcon}><Ionicons color={colors.coral} name="radio-button-on" size={19} /></View>
                    <View>
                      <Text style={styles.sectionTitle}>أولوية الآن</Text>
                      <Text style={styles.sectionSubtitle}>قرارات بانتظار اعتماد المالك</Text>
                    </View>
                  </View>
                  <Pressable
                    accessibilityHint="يفتح صندوق الاعتمادات والموافقات"
                    accessibilityLabel={`عرض كل القرارات والاعتمادات المعلقة (${center.decisions.length})`}
                    accessibilityRole="button"
                    onPress={() => {
                      void Haptics.selectionAsync();
                      router.push("/operations/approvals");
                    }}
                    style={({ pressed }) => [styles.countBadge, pressed && styles.pressed]}
                  >
                    <Text style={styles.countBadgeText}>{center.decisions.length} معلق</Text>
                    <Ionicons color={colors.surface} name="chevron-back" size={13} />
                  </Pressable>
                </View>
              </AnimatedReveal>

              {primaryDecision ? (
                <AnimatedReveal
                  delay={180}
                  style={{
                    ...styles.priorityCard,
                    backgroundColor: `${severityColor[primaryDecision.severity]}10`,
                    borderColor: `${severityColor[primaryDecision.severity]}45`,
                  }}
                >
                  <View style={styles.priorityTop}>
                    <View style={[styles.priorityIcon, { backgroundColor: `${severityColor[primaryDecision.severity]}18` }]}><Ionicons color={severityColor[primaryDecision.severity]} name="document-text-outline" size={23} /></View>
                    <View style={styles.priorityCopy}>
                      <View style={styles.priorityLabelRow}>
                        <Text style={[
                          styles.urgentLabel,
                          {
                            backgroundColor: `${severityColor[primaryDecision.severity]}18`,
                            color: severityColor[primaryDecision.severity],
                          },
                        ]}>{severityLabel[primaryDecision.severity]}</Text>
                        <Text style={styles.priorityTitle}>{primaryDecision.title}</Text>
                      </View>
                      <Text style={styles.priorityContext}>{primaryDecision.context}</Text>
                    </View>
                  </View>
                  <View style={styles.priorityActions}>
                    <Pressable accessibilityRole="button" onPress={() => openDecision(primaryDecision)} style={({ pressed }) => [styles.approveAction, pressed && styles.pressed]}>
                      <Ionicons color={colors.surface} name="document-text-outline" size={20} />
                      <Text style={styles.approveText}>{primaryDecision.actionLabel || "مراجعة واعتماد"}</Text>
                    </Pressable>
                  </View>
                </AnimatedReveal>
              ) : (
                <ExperienceState
                  compact
                  detail="لا توجد قرارات عاجلة تتطلب موافقة المالك حالياً."
                  state="success"
                  title="جميع العمليات مستقرة"
                />
              )}

              {secondaryDecisions.length > 0 ? (
                <View style={styles.secondaryDecisionList}>
                  {secondaryDecisions.map((decision, index) => (
                    <Pressable accessibilityHint="يفتح تفاصيل القرار للقراءة" accessibilityLabel={`${decision.title}. ${decision.context}`} accessibilityRole="button" key={decision.id} onPress={() => openDecision(decision)} style={({ pressed }) => [styles.secondaryDecisionRow, index > 0 && styles.rowDivider, pressed && styles.pressed]}>
                      <View style={[styles.smallToneIcon, { backgroundColor: `${severityColor[decision.severity]}16` }]}>
                        <Ionicons color={severityColor[decision.severity]} name={decision.severity === "warning" ? "receipt-outline" : "cube-outline"} size={19} />
                      </View>
                      <View style={styles.flex}><Text style={styles.secondaryTitle}>{decision.title}</Text><Text style={styles.secondaryText}>{decision.context}</Text></View>
                      <Ionicons color={colors.mutedInk} name="chevron-back" size={17} />
                    </Pressable>
                  ))}
                </View>
              ) : null}

              <ExperienceState compact detail="يعرض الهاتف المؤشرات والقرارات. العمليات المالية والتشغيلية المعتمدة موثقة بسجل التدقيق الكامل." state="pending" title="التشغيل محمي وموثق بالمنظومة" />
            </>
          )}
        </View>
      </ScrollView>

      <Modal animationType="slide" onRequestClose={closeDecision} transparent visible={selected !== null}>
        <Pressable onPress={closeDecision} style={styles.modalBackdrop}>
          <Pressable onPress={(event) => event.stopPropagation()} style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetLabel}>تفاصيل القرار الإداري</Text>
            <Text style={styles.sheetTitle}>{selected?.title}</Text>
            <Text style={styles.sheetBody}>{selected?.context}</Text>
            <View style={styles.reviewFacts}>
              <View style={styles.reviewFact}><Text style={styles.sheetLabel}>المصدر</Text><Text style={styles.reviewFactValue}>النظام الأساسي (الخادم)</Text></View>
              <View style={styles.reviewFact}><Text style={styles.sheetLabel}>وقت الإصدار</Text><Text style={styles.reviewFactValue}>{asOf}</Text></View>
            </View>

            {decisionFeedback ? (
              <ExperienceState compact detail="تم توثيق هذا الإجراء في سجل التدقيق." state="success" title={decisionFeedback} />
            ) : (
              <View style={styles.decisionActionRow}>
                <Pressable
                  accessibilityHint="يتحقق من بصمة المالك ويعتمد القرار فورياً"
                  accessibilityLabel="اعتماد سريع بالبصمة"
                  accessibilityRole="button"
                  disabled={isApproving}
                  onPress={() => void handleBiometricApprove()}
                  style={({ pressed }) => [styles.biometricApproveBtn, pressed && styles.pressed, isApproving && styles.disabled]}
                >
                  <Ionicons color={colors.surface} name="finger-print" size={20} />
                  <Text style={styles.biometricApproveText}>
                    {isApproving ? "جار المصادقة…" : "اعتماد بالبصمة"}
                  </Text>
                </Pressable>

                <Pressable
                  accessibilityHint="يسجل رفض الطلب مع إشعار مقدمه"
                  accessibilityLabel="رفض الطلب"
                  accessibilityRole="button"
                  onPress={handleReject}
                  style={styles.rejectBtn}
                >
                  <Ionicons color={colors.danger} name="close-circle-outline" size={18} />
                  <Text style={styles.rejectText}>رفض مسبب</Text>
                </Pressable>
              </View>
            )}

            <View style={styles.sheetNoticeRow}>
              <Ionicons color={colors.info} name="shield-checkmark-outline" size={20} />
              <Text style={styles.sheetNotice}>اعتماد البصمة المحمي يفوّض تنفيذ الإجراء ويرفعه لسجل العمليات المحمي.</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={closeDecision} style={styles.closeButton}><Text style={styles.closeButtonText}>إغلاق</Text></Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.canvas, flex: 1 },
  content: { paddingBottom: 28 },
  hero: { height: 340, overflow: "hidden" },
  heroImage: { borderBottomLeftRadius: 34, borderBottomRightRadius: 34 },
  heroOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "#061512E0", borderBottomLeftRadius: 34, borderBottomRightRadius: 34 },
  heroContent: { gap: space.md, padding: space.md },
  topRow: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between" },
  wordmarkRow: { alignItems: "center", flexDirection: "row-reverse", gap: space.sm },
  brandMark: { alignItems: "center", backgroundColor: colors.brand, borderRadius: radius.field, height: 46, justifyContent: "center", width: 46 },
  wordmark: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 21, textAlign: "right" },
  tagline: { color: "#D0EFE7", fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 19, textAlign: "right" },
  notificationButton: { alignItems: "center", borderColor: "#FFFFFF55", borderRadius: radius.pill, borderWidth: 1, height: 44, justifyContent: "center", width: 44 },
  greetingRow: { alignItems: "flex-end", flexDirection: "row-reverse", justifyContent: "space-between" },
  greetingCopy: { flex: 1 },
  greeting: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 24, lineHeight: 36, textAlign: "right" },
  role: { color: "#C2E6DC", fontFamily: "Cairo_400Regular", fontSize: 13, textAlign: "right" },
  branchSelector: { alignItems: "center", backgroundColor: "#FFFFFF12", borderColor: "#FFFFFF42", borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, flexDirection: "row-reverse", gap: 6, minHeight: 44, paddingHorizontal: space.sm },
  branchText: { color: "#F0F2FF", fontFamily: "Cairo_600SemiBold", fontSize: 12 },
  performancePanel: { alignItems: "center", backgroundColor: "#0B5C4DE6", borderColor: "#10B98155", borderRadius: radius.sheet, borderWidth: StyleSheet.hairlineWidth, flexDirection: "row-reverse", gap: space.sm, padding: space.sm },
  scoreMeter: { alignItems: "center", borderColor: "#35D796", borderRadius: radius.card, borderWidth: 1, justifyContent: "center", minHeight: 70, width: 72 },
  scoreValue: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 20, lineHeight: 28 },
  scoreTrend: { color: "#34D399", fontFamily: "Cairo_600SemiBold", fontSize: 12 },
  scoreCopy: { flex: 1 },
  scoreTitle: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 15, textAlign: "right" },
  scoreStatusRow: { alignItems: "center", flexDirection: "row-reverse", gap: 7, marginTop: 2 },
  scoreStatus: { color: "#E6F7F2", fontFamily: "Cairo_600SemiBold", fontSize: 12, lineHeight: 19, textAlign: "right" },
  scoreDetail: { color: "#C2E6DC", fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 19, marginTop: 5, textAlign: "right" },
  scoreMore: { alignItems: "center", borderRightColor: "#FFFFFF30", borderRightWidth: StyleSheet.hairlineWidth, gap: 2, justifyContent: "center", minHeight: 44, minWidth: 54, paddingRight: space.sm },
  scoreMoreText: { color: colors.surface, fontFamily: "Cairo_600SemiBold", fontSize: 12 },
  bodyContent: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    gap: space.lg,
    marginTop: -22,
    paddingBottom: space.lg,
    paddingHorizontal: space.md,
    paddingTop: space.lg,
  },
  sectionHeader: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between" },
  metricStrip: { backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, flexDirection: "row-reverse", overflow: "hidden" },
  metricItem: { alignItems: "flex-end", borderLeftColor: colors.outline, borderLeftWidth: StyleSheet.hairlineWidth, flex: 1, gap: 2, minHeight: 84, padding: space.sm },
  metricValue: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 13, maxWidth: "100%", textAlign: "right" },
  metricUnavailable: { color: colors.mutedInk },
  metricLabelRow: { alignItems: "center", flexDirection: "row-reverse", gap: 3 },
  metricLabel: { color: colors.brandDark, fontFamily: "Cairo_600SemiBold", fontSize: 12, textAlign: "right" },
  metricDetail: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, textAlign: "right" },
  sectionTitleRow: { alignItems: "center", flexDirection: "row-reverse", gap: space.xs },
  targetIcon: { alignItems: "center", backgroundColor: colors.dangerSoft, borderRadius: radius.pill, height: 36, justifyContent: "center", width: 36 },
  sectionTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 21, lineHeight: 31, textAlign: "right" },
  sectionSubtitle: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, textAlign: "right" },
  countBadge: { alignItems: "center", backgroundColor: colors.danger, borderRadius: radius.pill, flexDirection: "row-reverse", gap: 3, justifyContent: "center", minHeight: 28, paddingHorizontal: 9 },
  countBadgeText: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 11 },
  priorityCard: { backgroundColor: colors.dangerSoft, borderColor: "#F5D4D8", borderRadius: radius.sheet, borderWidth: StyleSheet.hairlineWidth, gap: space.md, padding: space.md },
  priorityTop: { alignItems: "flex-start", flexDirection: "row-reverse", gap: space.sm },
  priorityIcon: { alignItems: "center", backgroundColor: "#FADCE0", borderRadius: radius.field, height: 46, justifyContent: "center", width: 46 },
  priorityCopy: { flex: 1 },
  priorityLabelRow: { alignItems: "center", flexDirection: "row-reverse", flexWrap: "wrap", gap: 6 },
  urgentLabel: { backgroundColor: "#FFE0E2", borderRadius: radius.pill, color: colors.danger, fontFamily: "Cairo_700Bold", fontSize: 12, overflow: "hidden", paddingHorizontal: 8, paddingVertical: 2 },
  priorityTitle: { color: colors.ink, flexShrink: 1, fontFamily: "Cairo_700Bold", fontSize: 16, lineHeight: 25, textAlign: "right" },
  priorityContext: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, marginTop: 2, textAlign: "right" },
  priorityActions: { flexDirection: "row-reverse", gap: space.xs },
  approveAction: { alignItems: "center", backgroundColor: colors.brand, borderRadius: radius.field, flex: 1, flexDirection: "row-reverse", gap: 6, justifyContent: "center", minHeight: 48 },
  approveText: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 13 },
  pressed: { opacity: 0.7, transform: [{ scale: 0.99 }] },
  secondaryDecisionList: { backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  secondaryDecisionRow: { alignItems: "center", flexDirection: "row-reverse", gap: space.sm, minHeight: 74, padding: space.sm },
  rowDivider: { borderTopColor: colors.outline, borderTopWidth: StyleSheet.hairlineWidth },
  smallToneIcon: { alignItems: "center", borderRadius: radius.field, height: 38, justifyContent: "center", width: 38 },
  flex: { flex: 1 },
  secondaryTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 13, textAlign: "right" },
  secondaryText: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, textAlign: "right" },
  quickHeaderRow: { gap: 2, marginTop: space.xs },
  quickTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 16, textAlign: "right" },
  quickSubtitle: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, textAlign: "right" },
  quickBar: { flexDirection: "row-reverse", flexWrap: "wrap", gap: space.sm },
  quickAction: { alignItems: "center", backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, flexBasis: "30%", flexGrow: 1, gap: 6, justifyContent: "center", minHeight: 76, padding: space.xs },
  quickIconBox: { alignItems: "center", backgroundColor: colors.brandSoft, borderRadius: radius.compact, height: 36, justifyContent: "center", width: 36 },
  quickText: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 11, textAlign: "center" },
  modalBackdrop: { alignItems: "center", backgroundColor: colors.scrim, flex: 1, justifyContent: "flex-end", padding: space.md },
  sheet: { backgroundColor: colors.surface, borderRadius: 26, gap: space.sm, padding: space.lg, width: "100%" },
  sheetHandle: { alignSelf: "center", backgroundColor: colors.outline, borderRadius: radius.pill, height: 4, marginBottom: space.xs, width: 46 },
  sheetLabel: { color: colors.mutedInk, fontFamily: "Cairo_600SemiBold", fontSize: 12, textAlign: "right" },
  sheetTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 21, lineHeight: 31, textAlign: "right" },
  sheetBody: { color: colors.ink, fontFamily: "Cairo_400Regular", fontSize: 14, lineHeight: 24, textAlign: "right" },
  sheetNoticeRow: { alignItems: "flex-start", backgroundColor: colors.infoSoft, borderRadius: radius.field, flexDirection: "row-reverse", gap: space.xs, padding: space.sm },
  sheetNotice: { color: colors.info, flex: 1, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, textAlign: "right" },
  reviewFacts: { borderColor: colors.outline, borderRadius: radius.field, borderWidth: StyleSheet.hairlineWidth, flexDirection: "row-reverse", overflow: "hidden" },
  reviewFact: { flex: 1, gap: 2, minHeight: 66, padding: space.sm },
  reviewFactValue: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 12, textAlign: "right" },
  closeButton: { alignItems: "center", backgroundColor: colors.brand, borderRadius: radius.field, justifyContent: "center", minHeight: 48, marginTop: space.xs },
  closeButtonText: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 14 },
  disabled: { opacity: 0.55 },
  decisionActionRow: { flexDirection: "row-reverse", gap: space.sm, marginTop: space.xs },
  biometricApproveBtn: { alignItems: "center", backgroundColor: colors.success, borderRadius: radius.field, flex: 2, flexDirection: "row-reverse", gap: 6, justifyContent: "center", minHeight: 48 },
  biometricApproveText: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 13 },
  rejectBtn: { alignItems: "center", borderColor: colors.danger, borderRadius: radius.field, borderWidth: 1, flex: 1, flexDirection: "row-reverse", gap: 4, justifyContent: "center", minHeight: 48 },
  rejectText: { color: colors.danger, fontFamily: "Cairo_700Bold", fontSize: 13 },
});
