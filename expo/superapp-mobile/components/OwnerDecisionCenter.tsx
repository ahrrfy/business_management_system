import { useCallback, useEffect, useState } from "react";
import { ImageBackground, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";

import { PreviewBanner } from "@/components/PreviewBanner";
import { AnimatedReveal } from "@/components/AnimatedReveal";
import { ExperienceState, SyncStatus } from "@/components/ExperienceState";
import { AnimatedProgress, StatusDot } from "@/components/Ui";
import { colors, radius, space } from "@/constants/theme";
import {
  ownerDecisionCenterPreview,
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

type OwnerCenterState = "loading" | "preview" | "signedOut" | "ready" | "error";

function metric(value: string | null, label: string, detail: string): OwnerDecisionCenterData["metrics"][number] {
  return value === null
    ? { label, value: "غير متاح", detail: "المصدر غير متاح", available: false }
    : { label, value, detail, available: true };
}

function commandCenterToView(value: MobileCommandCenter): OwnerDecisionCenterData {
  return {
    asOf: value.asOf,
    scopeLabel: value.scope === "ALL_BRANCHES" ? "جميع الفروع" : "فرعك المكلّف",
    health: value.health.status === "degraded" ? "degraded" : "healthy",
    decisions: value.decisions.map((decision) => ({
      ...decision,
      context: "عرض القرار للقراءة فقط؛ التنفيذ يبقى في شاشة الاعتماد المعتمدة.",
    })),
    metrics: [
      metric(value.metrics.salesToday ? formatIqd(value.metrics.salesToday.total) : null, "مبيعات اليوم", value.metrics.salesToday ? `${value.metrics.salesToday.invoiceCount} فاتورة` : ""),
      metric(value.metrics.treasury ? formatIqd(value.metrics.treasury.balance) : null, "رصيد الخزينة", value.metrics.treasury ? `${value.metrics.treasury.openShiftsCount} وردية مفتوحة` : ""),
      metric(value.metrics.lowStockCount === null ? null : String(value.metrics.lowStockCount), "مخزون منخفض", value.metrics.lowStockCount === null ? "" : "يحتاج متابعة"),
    ],
  };
}

const previewEvents = [
  { icon: "cash-outline" as const, title: "تمت تسوية الصندوق", branch: "فرع الكرادة", detail: "أُغلقت وردية الصباح بمبلغ 2,350,000 د.ع", time: "منذ 20 دقيقة", tone: colors.success },
  { icon: "construct-outline" as const, title: "طلب دعم فني", branch: "فرع زيونة", detail: "تنبيه من جهاز نقاط البيع رقم 3", time: "منذ ساعة", tone: colors.warning },
];

const quickActions = [
  { icon: "add-circle-outline" as const, label: "طلب جديد" },
  { icon: "receipt-outline" as const, label: "الفواتير" },
  { icon: "people-outline" as const, label: "العملاء" },
  { icon: "cube-outline" as const, label: "المخزون" },
];

export function OwnerDecisionCenter() {
  const [selected, setSelected] = useState<ExecutiveDecision | null>(null);
  const [state, setState] = useState<OwnerCenterState>("loading");
  const [liveCenter, setLiveCenter] = useState<OwnerDecisionCenterData | null>(null);

  const refresh = useCallback(async () => {
    setState("loading");
    try {
      const transport = await getSecureTransportRuntimeStatus();
      if (transport.kind === "unavailable" || !transport.configured) {
        setLiveCenter(null);
        setState("preview");
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

  const isLive = state === "ready" && liveCenter !== null;
  const showWorkspace = state === "preview" || isLive;
  const center = liveCenter ?? ownerDecisionCenterPreview;
  const asOf = formatBaghdadTime(center.asOf) ?? "وقت التحديث غير متاح";
  const primaryDecision = center.decisions[0] ?? null;
  const secondaryDecisions = center.decisions.slice(1, 3);
  const availableSources = center.metrics.filter((item) => item.available).length;
  const sourceRatio = availableSources / Math.max(center.metrics.length, 1);
  const operatingScore = isLive ? Math.round(sourceRatio * 100) : 78;
  const operatingReason = isLive
    ? `${availableSources} من ${center.metrics.length} مصادر متاحة · ${center.health === "healthy" ? "لا توجد أعطال مؤثرة" : "توجد مصادر تحتاج متابعة"}`
    : "المبيعات +12% عن أمس · 5 من 6 فروع نشطة";

  const openDecision = (decision: ExecutiveDecision | null) => {
    if (!decision) return;
    Haptics.selectionAsync().catch(() => undefined);
    setSelected(decision);
  };

  const closeDecision = () => {
    setSelected(null);
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
            {state === "preview" ? <PreviewBanner tone="dark" /> : null}
            <View style={styles.topRow}>
              <View style={styles.wordmarkRow}>
                <View style={styles.brandMark}><Ionicons color={colors.surface} name="cart" size={25} /></View>
                <View>
                  <Text style={styles.wordmark}>سوبر العربية</Text>
                  <Text style={styles.tagline}>معك في كل فرع</Text>
                </View>
              </View>
              <Pressable accessibilityHint="يفتح إعدادات الإشعارات الخاصة بالحساب" accessibilityLabel="الإشعارات" accessibilityRole="button" onPress={() => router.push("/(tabs)/account")} style={styles.notificationButton}>
                <Ionicons color={colors.surface} name="notifications" size={21} />
                {state === "preview" ? <View style={styles.notificationDot} /> : null}
              </Pressable>
            </View>

            <View style={styles.greetingRow}>
              <View style={styles.greetingCopy}>
                <Text style={styles.greeting}>{isLive ? "مركز القرار" : state === "preview" ? "صباح الخير، أحمد" : "مركز القرار"}</Text>
                <Text style={styles.role}>{showWorkspace ? (isLive ? center.scopeLabel : "مالك المنشأة") : "تظهر بيانات الإدارة بعد فتح الجلسة المخولة"}</Text>
              </View>
              {showWorkspace ? <View accessibilityLabel={`نطاق البيانات: ${center.scopeLabel}`} accessibilityRole="text" style={styles.branchSelector}>
                <Ionicons color="#DCE4FF" name="storefront-outline" size={17} />
                <Text style={styles.branchText}>{center.scopeLabel}</Text>
              </View> : null}
            </View>

            {showWorkspace ? <AnimatedReveal delay={90} style={styles.performancePanel}>
              <View
                accessibilityLabel={`صحة التشغيل اليوم ${operatingScore}%`}
                accessibilityRole="progressbar"
                accessibilityValue={{ max: 100, min: 0, now: operatingScore, text: `${operatingScore}%` }}
                style={styles.scoreMeter}
              >
                <Text style={styles.scoreValue}>{operatingScore}%</Text>
                <Text style={styles.scoreTrend}>{center.health === "healthy" ? "مستقر" : "انتبه"}</Text>
              </View>
              <View style={styles.scoreCopy}>
                <Text style={styles.scoreTitle}>{isLive ? "توفر بيانات التشغيل" : "صحة التشغيل اليوم"}</Text>
                <View style={styles.scoreStatusRow}>
                  <StatusDot color={center.health === "healthy" ? "#35D796" : "#FFB44A"} />
                  <Text style={styles.scoreStatus}>{center.health === "healthy" ? "سير العمل يسير بشكل جيد" : "توجد مؤشرات تحتاج متابعة"}</Text>
                </View>
                <AnimatedProgress label="نسبة صحة التشغيل" value={operatingScore} />
                <Text style={styles.scoreDetail}>{operatingReason}</Text>
              </View>
              <Pressable accessibilityLabel="تحديث مؤشرات التشغيل" accessibilityRole="button" onPress={() => void refresh()} style={styles.scoreMore}>
                <Text style={styles.scoreMoreText}>تحديث</Text>
                <Ionicons color={colors.surface} name="chevron-back" size={17} />
              </Pressable>
            </AnimatedReveal> : null}
          </View>
        </ImageBackground>

        <View style={styles.bodyContent}>
          {state === "loading" ? (
            <ExperienceState compact detail="نتأكد من جلسة الجهاز ومصادر اليوم قبل العرض." state="loading" title="تحديث مركز القرار" />
          ) : state === "signedOut" ? (
            <ExperienceState actionLabel="إعادة الفحص" compact detail="افتح جلسة الجهاز الموثق لقراءة بيانات المنشأة." onAction={() => void refresh()} state="offline" title="الجلسة غير مفتوحة" />
          ) : state === "error" ? (
            <ExperienceState actionLabel="المحاولة مجدداً" compact detail="لم نعرض نسخة مخزنة؛ تحقق من الشبكة ثم أعد التحديث." onAction={() => void refresh()} state="error" title="تعذر جلب المؤشرات" />
          ) : (
            <SyncStatus label={isLive ? `مزامن · ${asOf}` : "بيانات تجريبية محلية"} state={isLive ? "synced" : "offline"} />
          )}
          {showWorkspace ? <>
          <AnimatedReveal delay={110} style={styles.metricStrip}>
            {center.metrics.map((item) => (
              <View accessibilityLabel={`${item.label}: ${item.value}. ${item.detail}`} key={item.label} style={styles.metricItem}>
                <Text adjustsFontSizeToFit minimumFontScale={0.72} numberOfLines={1} style={[styles.metricValue, !item.available && styles.metricUnavailable]}>{item.value}</Text>
                <Text style={styles.metricLabel}>{item.label}</Text>
                <Text numberOfLines={1} style={styles.metricDetail}>{item.detail}</Text>
              </View>
            ))}
          </AnimatedReveal>
          <AnimatedReveal delay={130}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <View style={styles.targetIcon}><Ionicons color={colors.coral} name="radio-button-on" size={19} /></View>
              <View>
                <Text style={styles.sectionTitle}>أولوية الآن</Text>
                <Text style={styles.sectionSubtitle}>مهمة تحتاج إلى قرارك الآن</Text>
              </View>
            </View>
            <View style={styles.countBadge}><Text style={styles.countBadgeText}>{center.decisions.length}</Text></View>
          </View>
          </AnimatedReveal>

          {primaryDecision ? (
            <AnimatedReveal delay={180} style={styles.priorityCard}>
              <View style={styles.priorityTop}>
                <View style={styles.priorityIcon}><Ionicons color={colors.danger} name="document-text-outline" size={23} /></View>
                <View style={styles.priorityCopy}>
                  <View style={styles.priorityLabelRow}>
                    <Text style={styles.urgentLabel}>عاجل</Text>
                    <Text style={styles.priorityTitle}>{primaryDecision.title}</Text>
                  </View>
                  <Text style={styles.priorityContext}>{primaryDecision.context}</Text>
                </View>
                {!isLive ? <View style={styles.deadlinePill}>
                  <Ionicons color={colors.danger} name="time-outline" size={15} />
                  <Text style={styles.deadlineText}>قبل 4:30 م</Text>
                </View> : null}
              </View>
              {!isLive ? <View style={styles.priorityFacts}>
                <View style={styles.fact}><Text style={styles.factLabel}>مقدم الطلب</Text><Text style={styles.factValue}>سارة كريم</Text></View>
                <View style={styles.fact}><Text style={styles.factLabel}>الفرع</Text><Text style={styles.factValue}>فرع المنصور</Text></View>
                <View style={styles.fact}><Text style={styles.factLabel}>المبلغ</Text><Text style={styles.factValue}>4,800 د.ع</Text></View>
              </View> : null}
              <View style={styles.priorityActions}>
                <Pressable accessibilityRole="button" onPress={() => openDecision(primaryDecision)} style={({ pressed }) => [styles.approveAction, pressed && styles.pressed]}>
                  <Ionicons color={colors.surface} name="document-text-outline" size={20} />
                  <Text style={styles.approveText}>{isLive ? primaryDecision.actionLabel : "مراجعة الطلب"}</Text>
                </Pressable>
              </View>
            </AnimatedReveal>
          ) : null}

          {secondaryDecisions.length ? (
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

          {!isLive ? <>
          <AnimatedReveal delay={240} style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>آخر الأحداث</Text>
              <Text style={styles.sectionSubtitle}>مباشر من فروعك اليوم</Text>
            </View>
            <Ionicons color={colors.brand} name="pulse-outline" size={22} />
          </AnimatedReveal>
          <View style={styles.eventList}>
            {previewEvents.map((event, index) => (
              <View key={event.title} style={[styles.eventRow, index > 0 && styles.rowDivider]}>
                <View style={[styles.eventIcon, { backgroundColor: `${event.tone}18` }]}><Ionicons color={event.tone} name={event.icon} size={20} /></View>
                <View style={styles.flex}><Text style={styles.eventTitle}>{event.title}</Text><Text style={styles.eventBranch}>{event.branch}</Text><Text style={styles.eventDetail}>{event.detail}</Text></View>
                <View style={styles.eventTimeRow}><StatusDot color={event.tone} /><Text style={styles.eventTime}>{event.time}</Text></View>
              </View>
            ))}
          </View>

          <Text style={styles.quickTitle}>إجراءات سريعة</Text>
          <View style={styles.quickBar}>
            {quickActions.map((action) => (
              <View accessibilityLabel={`${action.label}، عنصر معاينة غير تشغيلي`} accessibilityRole="text" key={action.label} style={styles.quickAction}>
                <Ionicons color={colors.brand} name={action.icon} size={22} />
                <Text style={styles.quickText}>{action.label}</Text>
              </View>
            ))}
          </View>
          </> : (
            <ExperienceState compact detail="يعرض الهاتف القرار ونطاقه فقط. التنفيذ المالي أو التشغيلي يتم داخل الوحدة المعتمدة في النظام الأساسي مع سجل التدقيق." state="pending" title="التنفيذ محمي في النظام الأساسي" />
          )}
          </> : null}
        </View>
      </ScrollView>

      <Modal animationType="slide" onRequestClose={closeDecision} transparent visible={selected !== null}>
        <Pressable onPress={closeDecision} style={styles.modalBackdrop}>
          <Pressable onPress={(event) => event.stopPropagation()} style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetLabel}>{isLive ? "تفاصيل القرار" : "معاينة تفاصيل القرار"}</Text>
            <Text style={styles.sheetTitle}>{selected?.title}</Text>
            <Text style={styles.sheetBody}>{selected?.context}</Text>
            <View style={styles.reviewFacts}>
              <View style={styles.reviewFact}><Text style={styles.sheetLabel}>المصدر</Text><Text style={styles.reviewFactValue}>{isLive ? "النظام الأساسي" : "بيانات المعاينة"}</Text></View>
              <View style={styles.reviewFact}><Text style={styles.sheetLabel}>آخر تحديث</Text><Text style={styles.reviewFactValue}>{asOf}</Text></View>
            </View>
            <View style={styles.sheetNoticeRow}>
              <Ionicons color={colors.info} name="shield-checkmark-outline" size={20} />
              <Text style={styles.sheetNotice}>{isLive ? "هذه الشاشة للقراءة فقط. لا ترسل اعتماداً أو حركة مالية؛ التنفيذ يبقى في الوحدة المعتمدة داخل النظام الأساسي." : "هذه معاينة تصميمية ولا تغيّر أي بيانات."}</Text>
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
  heroOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "#06145BCF", borderBottomLeftRadius: 34, borderBottomRightRadius: 34 },
  heroContent: { gap: space.md, padding: space.md },
  topRow: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between" },
  wordmarkRow: { alignItems: "center", flexDirection: "row-reverse", gap: space.sm },
  brandMark: { alignItems: "center", backgroundColor: colors.brand, borderRadius: radius.field, height: 46, justifyContent: "center", width: 46 },
  wordmark: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 21, textAlign: "right" },
  tagline: { color: "#D0D7F4", fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 19, textAlign: "right" },
  notificationButton: { alignItems: "center", borderColor: "#FFFFFF55", borderRadius: radius.pill, borderWidth: 1, height: 44, justifyContent: "center", width: 44 },
  notificationDot: { backgroundColor: colors.coral, borderColor: colors.brandDark, borderRadius: 5, borderWidth: 2, height: 10, position: "absolute", right: 7, top: 6, width: 10 },
  greetingRow: { alignItems: "flex-end", flexDirection: "row-reverse", justifyContent: "space-between" },
  greetingCopy: { flex: 1 },
  greeting: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 24, lineHeight: 36, textAlign: "right" },
  role: { color: "#C5CCEA", fontFamily: "Cairo_400Regular", fontSize: 13, textAlign: "right" },
  branchSelector: { alignItems: "center", backgroundColor: "#FFFFFF12", borderColor: "#FFFFFF42", borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, flexDirection: "row-reverse", gap: 6, minHeight: 44, paddingHorizontal: space.sm },
  branchText: { color: "#F0F2FF", fontFamily: "Cairo_600SemiBold", fontSize: 12 },
  performancePanel: { alignItems: "center", backgroundColor: "#162A8EEB", borderColor: "#7183D5", borderRadius: radius.sheet, borderWidth: StyleSheet.hairlineWidth, flexDirection: "row-reverse", gap: space.sm, padding: space.sm },
  scoreMeter: { alignItems: "center", borderColor: "#35D796", borderRadius: radius.card, borderWidth: 1, justifyContent: "center", minHeight: 70, width: 72 },
  scoreValue: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 20, lineHeight: 28 },
  scoreTrend: { color: "#7AEBBE", fontFamily: "Cairo_600SemiBold", fontSize: 12 },
  scoreCopy: { flex: 1 },
  scoreTitle: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 15, textAlign: "right" },
  scoreStatusRow: { alignItems: "center", flexDirection: "row-reverse", gap: 7, marginTop: 2 },
  scoreStatus: { color: "#F2F4FF", fontFamily: "Cairo_600SemiBold", fontSize: 12, lineHeight: 19, textAlign: "right" },
  scoreDetail: { color: "#CCD3F1", fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 19, marginTop: 5, textAlign: "right" },
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
  metricItem: { alignItems: "flex-end", borderLeftColor: colors.outline, borderLeftWidth: StyleSheet.hairlineWidth, flex: 1, gap: 1, minHeight: 82, padding: space.sm },
  metricValue: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 13, maxWidth: "100%", textAlign: "right" },
  metricUnavailable: { color: colors.mutedInk },
  metricLabel: { color: colors.brandDark, fontFamily: "Cairo_600SemiBold", fontSize: 12, textAlign: "right" },
  metricDetail: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, textAlign: "right" },
  sectionTitleRow: { alignItems: "center", flexDirection: "row-reverse", gap: space.xs },
  targetIcon: { alignItems: "center", backgroundColor: colors.dangerSoft, borderRadius: radius.pill, height: 36, justifyContent: "center", width: 36 },
  sectionTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 21, lineHeight: 31, textAlign: "right" },
  sectionSubtitle: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, textAlign: "right" },
  countBadge: { alignItems: "center", backgroundColor: colors.danger, borderRadius: radius.pill, height: 30, justifyContent: "center", width: 30 },
  countBadgeText: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 13 },
  priorityCard: { backgroundColor: colors.dangerSoft, borderColor: "#F5D4D8", borderRadius: radius.sheet, borderWidth: StyleSheet.hairlineWidth, gap: space.md, padding: space.md },
  priorityTop: { alignItems: "flex-start", flexDirection: "row-reverse", gap: space.sm },
  priorityIcon: { alignItems: "center", backgroundColor: "#FADCE0", borderRadius: radius.field, height: 46, justifyContent: "center", width: 46 },
  priorityCopy: { flex: 1 },
  priorityLabelRow: { alignItems: "center", flexDirection: "row-reverse", flexWrap: "wrap", gap: 6 },
  urgentLabel: { backgroundColor: "#FFE0E2", borderRadius: radius.pill, color: colors.danger, fontFamily: "Cairo_700Bold", fontSize: 12, overflow: "hidden", paddingHorizontal: 8, paddingVertical: 2 },
  priorityTitle: { color: colors.ink, flexShrink: 1, fontFamily: "Cairo_700Bold", fontSize: 16, lineHeight: 25, textAlign: "right" },
  priorityContext: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, marginTop: 2, textAlign: "right" },
  deadlinePill: { alignItems: "center", borderColor: "#F1B7BE", borderRadius: radius.pill, borderWidth: 1, flexDirection: "row-reverse", gap: 4, paddingHorizontal: 8, paddingVertical: 5 },
  deadlineText: { color: colors.danger, fontFamily: "Cairo_700Bold", fontSize: 12 },
  priorityFacts: { borderTopColor: "#EFD8DA", borderTopWidth: StyleSheet.hairlineWidth, flexDirection: "row-reverse", paddingTop: space.sm },
  fact: { borderLeftColor: "#EFD8DA", borderLeftWidth: StyleSheet.hairlineWidth, flex: 1, paddingHorizontal: 6 },
  factLabel: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, textAlign: "right" },
  factValue: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 12, marginTop: 2, textAlign: "right" },
  priorityActions: { flexDirection: "row-reverse", gap: space.xs },
  approveAction: { alignItems: "center", backgroundColor: colors.brand, borderRadius: radius.field, flex: 1.35, flexDirection: "row-reverse", gap: 6, justifyContent: "center", minHeight: 48 },
  approveText: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 13 },
  reviewAction: { alignItems: "center", borderColor: colors.brand, borderRadius: radius.field, borderWidth: 1, flex: 1, justifyContent: "center", minHeight: 48 },
  reviewText: { color: colors.brand, fontFamily: "Cairo_700Bold", fontSize: 12 },
  pressed: { opacity: 0.7, transform: [{ scale: 0.99 }] },
  secondaryDecisionList: { backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  secondaryDecisionRow: { alignItems: "center", flexDirection: "row-reverse", gap: space.sm, minHeight: 74, padding: space.sm },
  rowDivider: { borderTopColor: colors.outline, borderTopWidth: StyleSheet.hairlineWidth },
  smallToneIcon: { alignItems: "center", borderRadius: radius.field, height: 38, justifyContent: "center", width: 38 },
  flex: { flex: 1 },
  secondaryTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 13, textAlign: "right" },
  secondaryText: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, textAlign: "right" },
  eventList: { backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  eventRow: { alignItems: "flex-start", flexDirection: "row-reverse", gap: space.sm, minHeight: 86, padding: space.sm },
  eventIcon: { alignItems: "center", borderRadius: radius.field, height: 40, justifyContent: "center", width: 40 },
  eventTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 13, textAlign: "right" },
  eventBranch: { color: colors.mutedInk, fontFamily: "Cairo_600SemiBold", fontSize: 12, textAlign: "right" },
  eventDetail: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 19, marginTop: 2, textAlign: "right" },
  eventTimeRow: { alignItems: "center", flexDirection: "row-reverse", gap: 4 },
  eventTime: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12 },
  quickTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 17, textAlign: "right" },
  quickBar: { backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, flexDirection: "row-reverse", overflow: "hidden" },
  quickAction: { alignItems: "center", borderLeftColor: colors.outline, borderLeftWidth: StyleSheet.hairlineWidth, flex: 1, gap: 4, justifyContent: "center", minHeight: 70 },
  quickText: { color: colors.ink, fontFamily: "Cairo_600SemiBold", fontSize: 12 },
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
  secondarySheetButton: { alignItems: "center", justifyContent: "center", minHeight: 44 },
  secondarySheetText: { color: colors.brand, fontFamily: "Cairo_700Bold", fontSize: 13 },
  disabled: { opacity: 0.55 },
});
