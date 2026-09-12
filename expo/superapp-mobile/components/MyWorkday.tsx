import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { AnimatedReveal } from "@/components/AnimatedReveal";
import { ExperienceState, SyncStatus } from "@/components/ExperienceState";
import { AnimatedProgress, AppMasthead, Card, SectionTitle, StatusDot } from "@/components/Ui";
import { colors, radius, space } from "@/constants/theme";
import { PreviewBanner } from "@/components/PreviewBanner";
import { SensitivePayslipCard } from "@/components/SensitivePayslipCard";
import { SelfLeaveCard } from "@/components/SelfLeaveCard";
import { FocusedTaskCard } from "@/components/FocusedTaskCard";
import { getSecureTransportRuntimeStatus } from "@/lib/deviceProof";
import {
  getNativeMobileAttendanceHistory,
  getNativeMobileToday,
  type MobileAttendanceHistory,
  type MobileToday,
} from "@/lib/secureTransport";
import { unlockLocalSession } from "@/lib/localSessionUnlock";
import { exportPersonalAttendancePdf } from "@/lib/attendanceExport";

type WorkdayState = "loading" | "preview" | "signedOut" | "ready" | "error";

function time(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
    hour: "numeric",
    minute: "2-digit",
    // سجل الحضور مربوط بيوم عمل بغداد؛ لا يغيّر سفر الجهاز وقت البصمة المعروض.
    timeZone: "Asia/Baghdad",
  }).format(date);
}

function attendanceCopy(today: MobileToday["personal"]["attendance"]): { title: string; detail: string; color: string } {
  if (!today) return { title: "لا يوجد سجل حضور اليوم", detail: "لا يظهر سجل افتراضي عند غياب المصدر.", color: colors.mutedInk };
  switch (today.state) {
    case "CHECKED_IN":
      return { title: "تم تسجيل الحضور", detail: `وقت الحضور: ${time(today.checkIn)} · لم يُسجل الانصراف بعد`, color: colors.info };
    case "COMPLETE":
      return { title: "اكتمل سجل الحضور", detail: `الحضور ${time(today.checkIn)} · الانصراف ${time(today.checkOut)}`, color: colors.success };
    case "NEEDS_REVIEW":
      return { title: "سجل الحضور يحتاج مراجعة", detail: "لن يعرض التطبيق وقتاً بديلاً حتى تراجعه الإدارة.", color: colors.warning };
    default:
      return { title: "لم يُسجل حضور اليوم", detail: "لا ينفذ التطبيق إجراء حضور من هذه الشاشة بعد.", color: colors.mutedInk };
  }
}

export function MyWorkday() {
  const [state, setState] = useState<WorkdayState>("loading");
  const [today, setToday] = useState<MobileToday | null>(null);
  const [attendanceHistory, setAttendanceHistory] = useState<MobileAttendanceHistory | null>(null);

  const refresh = useCallback(async () => {
    setState("loading");
    setAttendanceHistory(null);
    try {
      const transport = await getSecureTransportRuntimeStatus();
      if (transport.kind === "unavailable" || !transport.configured) {
        setToday(null);
        setState("preview");
        return;
      }
      if (transport.session !== "present") {
        setToday(null);
        setState("signedOut");
        return;
      }
      await unlockLocalSession();
      const nextToday = await getNativeMobileToday();
      setToday(nextToday);
      // Attendance history is an independent, bounded read model. A temporary
      // failure must not turn an otherwise valid personal day into fake data.
      try {
        setAttendanceHistory(await getNativeMobileAttendanceHistory());
      } catch {
        setAttendanceHistory(null);
      }
      setState("ready");
    } catch {
      setToday(null);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (state === "loading") return <WorkdayMessage loading onRefresh={refresh} />;
  if (state === "preview") return <PreviewWorkday onRefresh={refresh} />;
  if (state === "signedOut") return <SignedOutWorkday onRefresh={refresh} />;
  if (state === "error" || !today) return <WorkdayMessage onRefresh={refresh} />;
  return <LiveWorkday attendanceHistory={attendanceHistory} onRefresh={refresh} today={today} />;
}

function WorkdayMessage({ loading = false, onRefresh }: { loading?: boolean; onRefresh(): Promise<void> }) {
  return (
    <ScrollView accessibilityLabel="يومي" contentContainerStyle={styles.content} style={styles.page}>
      <View style={styles.header}>
        <Text style={styles.overline}>مساحتي</Text>
        <Text style={styles.title}>يوم العمل</Text>
      </View>
      <ExperienceState
        actionLabel={loading ? undefined : "المحاولة مجدداً"}
        detail={loading ? "لا نعرض بيانات الموظف قبل التأكد من جلسة الجهاز." : "لم تُعرض بيانات مخزنة أو بديلة. أعد المحاولة عند استقرار الشبكة."}
        onAction={loading ? undefined : () => void onRefresh()}
        state={loading ? "loading" : "error"}
        title={loading ? "التحقق من الجلسة المحمية" : "تعذر تحديث يوم العمل"}
      />
    </ScrollView>
  );
}

function PreviewWorkday({ onRefresh }: { onRefresh(): Promise<void> }) {
  const [feedback, setFeedback] = useState<"correction" | "permission" | null>(null);

  const previewAction = (next: "correction" | "permission") => {
    Haptics.selectionAsync().catch(() => undefined);
    setFeedback(next);
  };

  return (
    <ScrollView
      accessibilityLabel="يومي"
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl onRefresh={() => void onRefresh()} refreshing={false} tintColor={colors.brand} />}
      style={styles.page}
    >
      <AppMasthead
        avatar="ع"
        name="علي حسن"
        role="موظف مبيعات"
        subtitle="الخميس، 10 أيلول 2026"
        title="يومي"
      >
        <PreviewBanner tone="dark" />
        <View style={styles.dayStatusPanel}>
          <View style={styles.dayStatusIcon}><Ionicons color="#35D796" name="radio-button-on" size={22} /></View>
          <View style={styles.identityBody}>
            <Text style={styles.dayStatusTitle}>أنت على رأس العمل</Text>
            <Text style={styles.dayStatusText}>متبقي 3 ساعات و40 دقيقة · فرع المنصور</Text>
          </View>
          <Text style={styles.dayStatusPercent}>40%</Text>
        </View>
      </AppMasthead>

      <AnimatedReveal delay={80} style={styles.shiftSummary}>
        <View style={styles.shiftTimes}>
          <View style={styles.shiftTimeBlock}>
            <Text style={styles.shiftTime}>8:00 ص</Text>
            <Text style={styles.shiftLabel}>بداية الدوام</Text>
          </View>
          <View style={styles.shiftTimeBlock}>
            <Text style={styles.shiftTime}>4:00 م</Text>
            <Text style={styles.shiftLabel}>نهاية الدوام</Text>
          </View>
        </View>
        <AnimatedProgress label="انقضى 40% من الوردية" tone="light" value={40} />
        <View style={styles.shiftFacts}>
          <View style={styles.shiftFact}>
            <Ionicons color={colors.brand} name="location-outline" size={19} />
            <View><Text style={styles.shiftFactValue}>فرع المنصور</Text><Text style={styles.shiftFactLabel}>موقع العمل</Text></View>
          </View>
          <View style={styles.shiftFact}>
            <Ionicons color={colors.brand} name="time-outline" size={19} />
            <View><Text style={styles.shiftFactValue}>8 ساعات</Text><Text style={styles.shiftFactLabel}>مدة الوردية</Text></View>
          </View>
        </View>
        <View style={styles.presenceStatusRow}>
          <SyncStatus label="داخل نطاق الفرع" state="synced" />
          <SyncStatus label="مزامن منذ دقيقة" state="synced" />
        </View>
      </AnimatedReveal>

      <AnimatedReveal delay={140}>
      <Pressable
        accessibilityHint="يعرض رسالة توضيحية فقط في وضع المعاينة"
        accessibilityRole="button"
        onPress={() => Alert.alert("تسجيل الانصراف", "هذه معاينة تصميمية؛ لا تُرسل أي بصمة إلى الخادم.")}
        style={({ pressed }) => [styles.attendanceActionPremium, pressed && styles.previewPressed]}
      >
        <View style={styles.attendanceActionIcon}><Ionicons color={colors.surface} name="log-out-outline" size={25} /></View>
        <View style={styles.identityBody}>
          <Text style={styles.attendanceActionTitle}>تسجيل الانصراف</Text>
          <Text style={styles.attendanceActionHint}>سيطلب التطبيق تأكيد الجهاز قبل التسجيل</Text>
        </View>
        <Ionicons color="#D8DDFC" name="chevron-back" size={19} />
      </Pressable>
      </AnimatedReveal>

      <View style={styles.supportActions}>
        <Pressable accessibilityRole="button" onPress={() => previewAction("correction")} style={({ pressed }) => [styles.supportAction, pressed && styles.previewPressed]}>
          <Ionicons color={colors.brand} name="create-outline" size={20} />
          <Text style={styles.supportActionText}>تصحيح بصمة</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => previewAction("permission")} style={({ pressed }) => [styles.supportAction, pressed && styles.previewPressed]}>
          <Ionicons color={colors.brand} name="calendar-outline" size={20} />
          <Text style={styles.supportActionText}>طلب إذن سريع</Text>
        </Pressable>
      </View>
      {feedback ? (
        <ExperienceState
          compact
          detail={feedback === "correction" ? "ستُرسل الملاحظة للمراجعة بعد الدخول الآمن؛ لم تتغير البصمة الآن." : "ستُستكمل المدة والسبب بعد الدخول الآمن؛ لم يُرسل طلب الآن."}
          state="pending"
          title={feedback === "correction" ? "تصحيح الحضور جاهز للمتابعة" : "طلب الإذن جاهز للمتابعة"}
        />
      ) : null}

      <View style={styles.sectionRow}>
        <View><Text style={styles.previewSectionTitle}>مهمتي التالية</Text><Text style={styles.sectionCaption}>خطوتك الأهم في الوردية</Text></View>
        <View style={styles.taskCountBadge}><Text style={styles.taskCountText}>1 من 1</Text></View>
      </View>
      <AnimatedReveal delay={210}>
      <Pressable
        accessibilityRole="button"
        onPress={() => Alert.alert("جرد رف المنتجات", "تفتح المهمة بتفاصيلها بعد تسجيل الدخول الآمن.")}
        style={({ pressed }) => [styles.taskRowPremium, pressed && styles.previewPressed]}
      >
        <View style={styles.taskIcon}><Ionicons color={colors.brand} name="scan-outline" size={23} /></View>
        <View style={styles.identityBody}>
          <Text style={styles.taskTitle}>جرد رف المنتجات</Text>
          <Text style={styles.taskText}>المنطقة B · الطابق الأول</Text>
          <View style={styles.taskMeta}><Ionicons color={colors.warning} name="time-outline" size={14} /><Text style={styles.taskMetaText}>قبل 3:30 م</Text></View>
        </View>
        <Ionicons color={colors.mutedInk} name="chevron-back" size={18} />
      </Pressable>
      </AnimatedReveal>
      <RefreshButton onRefresh={onRefresh} />
    </ScrollView>
  );
}

function SignedOutWorkday({ onRefresh }: { onRefresh(): Promise<void> }) {
  return (
    <ScrollView accessibilityLabel="يومي" contentContainerStyle={styles.content} style={styles.page}>
      <View style={styles.header}>
        <Text style={styles.overline}>مساحتي</Text>
        <Text style={styles.title}>يوم العمل</Text>
        <Text style={styles.subTitle}>سجّل الدخول لعرض ما يخصك فقط.</Text>
      </View>
      <ExperienceState
        detail="لا يعرض التطبيق سجلاً قديماً أو تفاصيل خاصة قبل التحقق من الجهاز."
        state="offline"
        title="لا توجد جلسة عمل على هذا الجهاز"
      />
      <Card>
        <Pressable accessibilityRole="button" onPress={() => router.push("../sign-in")} style={styles.primary}>
          <Text style={styles.primaryText}>بدء الدخول الآمن</Text>
        </Pressable>
        <RefreshButton onRefresh={onRefresh} />
      </Card>
    </ScrollView>
  );
}

function LiveWorkday({
  attendanceHistory,
  onRefresh,
  today,
}: {
  attendanceHistory: MobileAttendanceHistory | null;
  onRefresh(): Promise<void>;
  today: MobileToday;
}) {
  if (today.personal.state === "NOT_LINKED" || !today.personal.employee) {
    return (
      <ScrollView accessibilityLabel="يومي" contentContainerStyle={styles.content} style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.overline}>مساحتي</Text>
          <Text style={styles.title}>يوم العمل</Text>
        </View>
        <Card>
          <Text accessibilityRole="alert" style={styles.itemTitle}>لا يوجد ملف موظف مرتبط بهذه الجلسة</Text>
          <Text style={styles.itemText}>لم يطلب التطبيق أي رقم موظف أو فرع من الهاتف. تواصل مع الإدارة لربط الحساب الصحيح.</Text>
          <RefreshButton onRefresh={onRefresh} />
        </Card>
      </ScrollView>
    );
  }

  const attendance = attendanceCopy(today.personal.attendance);
  return (
    <ScrollView
      accessibilityLabel="يومي"
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl onRefresh={() => void onRefresh()} refreshing={false} tintColor={colors.brand} />}
      style={styles.page}
    >
      <View style={styles.header}>
        <Text style={styles.overline}>{today.personal.employee.position || "مساحتي"}</Text>
        <Text style={styles.title}>أهلاً، {today.personal.employee.displayName}</Text>
        <Text style={styles.subTitle}>{today.personal.employee.department || "يوم العمل"} · {today.date}</Text>
      </View>

      <SectionTitle>أولوية اليوم</SectionTitle>
      <FocusedTaskCard
        detail={today.personal.focus?.dueAt ? `الاستحقاق: ${time(today.personal.focus.dueAt)} · الأولوية: ${today.personal.focus.priority}` : "لن ينشئ التطبيق مهمة افتراضية عند غياب البيانات."}
        focus={today.personal.focus}
        onChanged={onRefresh}
      />

      <SectionTitle>الحضور</SectionTitle>
      <DataCard color={attendance.color} detail={attendance.detail} title={attendance.title} />
      <AttendanceHistoryCard
        employeeName={today.personal.employee.displayName}
        history={attendanceHistory}
      />

      <SectionTitle>متابعاتك</SectionTitle>
      <SelfLeaveCard leave={today.personal.leave} todayDate={today.date} onChanged={onRefresh} />
      <SensitivePayslipCard
        employeeName={today.personal.employee.displayName}
        payroll={today.personal.payroll}
      />
      <RefreshButton onRefresh={onRefresh} />
    </ScrollView>
  );
}

function AttendanceHistoryCard({
  employeeName,
  history,
}: {
  employeeName: string;
  history: MobileAttendanceHistory | null;
}) {
  const [exporting, setExporting] = useState(false);

  if (history === null) {
    return (
      <Card>
        <Text style={styles.itemTitle}>لم يُحدّث سجل الحضور الأخير</Text>
        <Text style={styles.itemText}>لا تعرض الشاشة سجلاً مخزناً أو بديلًا. استخدم «تحديث» عند استقرار الشبكة.</Text>
      </Card>
    );
  }
  if (history.personal.state === "NOT_LINKED") {
    return (
      <Card>
        <Text style={styles.itemTitle}>لا يوجد ملف موظف مرتبط بهذه الجلسة</Text>
        <Text style={styles.itemText}>لا يمكن الوصول إلى سجل حضور بلا ربط خادمي صحيح.</Text>
      </Card>
    );
  }
  if (history.personal.entries.length === 0) {
    return (
      <Card>
        <Text style={styles.itemTitle}>لا توجد سجلات حضور في آخر 31 يوماً</Text>
        <Text style={styles.itemText}>لا يفترض التطبيق غياباً أو حضوراً عندما لا يصل سجل من المصدر.</Text>
      </Card>
    );
  }

  const recent = history.personal.entries.slice(0, 5);
  const onExport = async () => {
    setExporting(true);
    try {
      await unlockLocalSession();
      await exportPersonalAttendancePdf({ employeeName, history });
    } catch (error) {
      Alert.alert(
        "تعذر تصدير كشف الحضور",
        error instanceof Error ? error.message : "أعد المحاولة لاحقاً.",
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card>
      <Text style={styles.itemTitle}>آخر سجل حضور</Text>
      <Text style={styles.itemText}>من {history.range.from} إلى {history.range.to} · تُعرض بياناتك فقط.</Text>
      <View style={styles.historyList}>
        {recent.map((entry) => (
          <View key={entry.date} style={styles.historyRow}>
            <View style={styles.body}>
              <Text style={styles.historyTitle}>{entry.date} · {attendanceStatus(entry.status)}</Text>
              <Text style={styles.itemText}>
                {entry.state === "NEEDS_REVIEW"
                  ? "السجل يحتاج مراجعة الإدارة"
                  : `دخول ${time(entry.checkIn)} · انصراف ${time(entry.checkOut)} · ${entry.hours ?? "—"} ساعة`}
              </Text>
            </View>
            <StatusDot color={entry.state === "NEEDS_REVIEW" ? colors.warning : colors.success} />
          </View>
        ))}
      </View>
      <Pressable
        accessibilityLabel="تصدير كشف الحضور الشخصي PDF"
        accessibilityRole="button"
        disabled={exporting}
        onPress={() => void onExport()}
        style={[styles.export, exporting && styles.disabled]}
      >
        <Text style={styles.exportText}>{exporting ? "جارٍ تجهيز ملف PDF…" : "تصدير كشف حضور PDF"}</Text>
      </Pressable>
      <Text style={styles.exportHint}>يُنشأ الملف مؤقتاً داخل التطبيق ثم تختار أنت جهة مشاركته؛ لا يُحفظ تلقائياً في التنزيلات.</Text>
    </Card>
  );
}

function attendanceStatus(status: MobileAttendanceHistory["personal"]["entries"][number]["status"]): string {
  return ({ PRESENT: "حاضر", ABSENT: "غائب", LATE: "متأخر", LEAVE: "إجازة" })[status];
}

function DataCard({ color, detail, title }: { color: string; detail: string; title: string }) {
  return (
    <Card>
      <View style={styles.row}>
        <StatusDot color={color} />
        <View style={styles.body}>
          <Text style={styles.itemTitle}>{title}</Text>
          <Text style={styles.itemText}>{detail}</Text>
        </View>
      </View>
    </Card>
  );
}

function RefreshButton({ onRefresh }: { onRefresh(): Promise<void> }) {
  return (
    <Pressable accessibilityRole="button" onPress={() => void onRefresh()} style={styles.refresh}>
      <Text style={styles.refreshText}>تحديث</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.canvas, flex: 1 },
  content: { gap: space.lg, padding: space.md, paddingBottom: 36 },
  identityRow: { alignItems: "center", flexDirection: "row-reverse", gap: space.sm },
  avatar: { alignItems: "center", backgroundColor: colors.brandSoft, borderRadius: radius.pill, height: 42, justifyContent: "center", width: 42 },
  avatarText: { color: colors.brand, fontFamily: "Cairo_700Bold", fontSize: 16 },
  identityBody: { flex: 1 },
  brand: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 16, textAlign: "right" },
  role: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, textAlign: "right" },
  header: { backgroundColor: colors.surfaceMuted, borderRadius: radius.sheet, gap: space.xxs, padding: space.lg },
  overline: { color: colors.brand, fontFamily: "Cairo_600SemiBold", fontSize: 13, textAlign: "right" },
  title: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 27, lineHeight: 39, textAlign: "right" },
  subTitle: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 14, lineHeight: 23, textAlign: "right" },
  activeStatus: { alignItems: "center", backgroundColor: colors.successSoft, borderRadius: radius.field, flexDirection: "row-reverse", gap: space.sm, padding: space.md },
  activeStatusBody: { flex: 1 },
  activeStatusTitle: { color: colors.success, fontFamily: "Cairo_700Bold", fontSize: 16, textAlign: "right" },
  activeStatusText: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, marginTop: 1, textAlign: "right" },
  activeDot: { backgroundColor: colors.success, borderRadius: 6, height: 12, width: 12 },
  shiftBlock: { gap: space.sm },
  shiftTimes: { flexDirection: "row-reverse", justifyContent: "space-between" },
  shiftTime: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 16, textAlign: "right" },
  shiftLabel: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, textAlign: "right" },
  alignLeft: { textAlign: "left" },
  progressMeta: { flexDirection: "row", justifyContent: "space-between" },
  progressValue: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 13 },
  progressText: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, textAlign: "right" },
  shiftCards: { flexDirection: "row-reverse", gap: space.sm },
  shiftCard: { backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.field, borderWidth: StyleSheet.hairlineWidth, flex: 1, gap: 2, padding: space.sm },
  shiftCardTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 13, marginTop: space.xs, textAlign: "right" },
  shiftCardText: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, textAlign: "right" },
  attendanceAction: { alignItems: "center", alignSelf: "center", backgroundColor: colors.brand, borderRadius: radius.pill, height: 156, justifyContent: "center", width: 156 },
  attendanceActionText: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 15, marginTop: space.xs },
  previewPressed: { opacity: 0.72, transform: [{ scale: 0.985 }] },
  sectionRow: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between" },
  previewSectionTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 18, textAlign: "right" },
  previewCount: { color: colors.mutedInk, fontFamily: "Cairo_600SemiBold", fontSize: 12 },
  taskRow: { alignItems: "center", backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, flexDirection: "row-reverse", gap: space.sm, minHeight: 76, padding: space.sm },
  taskCheck: { borderColor: colors.mutedInk, borderRadius: radius.pill, borderWidth: 2, height: 28, width: 28 },
  taskTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 14, textAlign: "right" },
  taskText: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, textAlign: "right" },
  row: { alignItems: "flex-start", flexDirection: "row-reverse", gap: space.sm },
  body: { flex: 1 },
  itemTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 16, lineHeight: 25, textAlign: "right" },
  itemText: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 13, lineHeight: 22, marginTop: space.xxs, textAlign: "right" },
  primary: { alignItems: "center", backgroundColor: colors.brand, borderRadius: radius.field, justifyContent: "center", marginTop: space.md, minHeight: 48 },
  primaryText: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 14 },
  historyList: { borderTopColor: colors.outline, borderTopWidth: 1, gap: space.sm, marginTop: space.md, paddingTop: space.md },
  historyRow: { alignItems: "flex-start", flexDirection: "row-reverse", gap: space.sm },
  historyTitle: { color: colors.ink, fontFamily: "Cairo_600SemiBold", fontSize: 13, lineHeight: 22, textAlign: "right" },
  export: { alignItems: "center", borderColor: colors.brand, borderRadius: radius.field, borderWidth: 1, justifyContent: "center", marginTop: space.md, minHeight: 48, paddingHorizontal: space.md },
  exportText: { color: colors.brand, fontFamily: "Cairo_700Bold", fontSize: 13, textAlign: "center" },
  exportHint: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, marginTop: space.sm, textAlign: "right" },
  disabled: { opacity: 0.55 },
  refresh: { alignSelf: "flex-end", borderColor: colors.brand, borderRadius: radius.field, borderWidth: 1, justifyContent: "center", marginTop: space.md, minHeight: 44, minWidth: 96, paddingHorizontal: space.md },
  refreshText: { color: colors.brand, fontFamily: "Cairo_700Bold", fontSize: 13, textAlign: "center" },
  dayStatusPanel: {
    alignItems: "center",
    backgroundColor: "#FFFFFF12",
    borderColor: "#FFFFFF38",
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row-reverse",
    gap: space.sm,
    padding: space.sm,
  },
  dayStatusIcon: { alignItems: "center", backgroundColor: "#35D79618", borderRadius: radius.pill, height: 40, justifyContent: "center", width: 40 },
  dayStatusTitle: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 14, textAlign: "right" },
  dayStatusText: { color: "#D1D7F3", fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 19, marginTop: 1, textAlign: "right" },
  dayStatusPercent: { color: "#35D796", fontFamily: "Cairo_700Bold", fontSize: 17 },
  shiftSummary: { backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.sheet, borderWidth: StyleSheet.hairlineWidth, gap: space.md, marginTop: -8, padding: space.md },
  shiftTimeBlock: { gap: 1 },
  shiftFacts: { borderTopColor: colors.outline, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: "row-reverse", paddingTop: space.sm },
  shiftFact: { alignItems: "center", flex: 1, flexDirection: "row-reverse", gap: space.xs },
  shiftFactValue: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 12, textAlign: "right" },
  shiftFactLabel: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, textAlign: "right" },
  presenceStatusRow: { flexDirection: "row-reverse", flexWrap: "wrap", gap: space.xs },
  attendanceActionPremium: { alignItems: "center", backgroundColor: colors.brand, borderRadius: radius.card, flexDirection: "row-reverse", gap: space.sm, minHeight: 74, padding: space.sm },
  attendanceActionIcon: { alignItems: "center", backgroundColor: "#FFFFFF18", borderRadius: radius.field, height: 46, justifyContent: "center", width: 46 },
  attendanceActionTitle: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 15, textAlign: "right" },
  attendanceActionHint: { color: "#EEF0FF", fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 19, textAlign: "right" },
  supportActions: { flexDirection: "row-reverse", gap: space.xs },
  supportAction: { alignItems: "center", backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.field, borderWidth: StyleSheet.hairlineWidth, flex: 1, flexDirection: "row-reverse", gap: 7, justifyContent: "center", minHeight: 48, paddingHorizontal: space.sm },
  supportActionText: { color: colors.brand, fontFamily: "Cairo_700Bold", fontSize: 12 },
  sectionCaption: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 19, textAlign: "right" },
  taskCountBadge: { backgroundColor: colors.brandSoft, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 5 },
  taskCountText: { color: colors.brand, fontFamily: "Cairo_700Bold", fontSize: 12 },
  taskRowPremium: { alignItems: "center", backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, flexDirection: "row-reverse", gap: space.sm, minHeight: 92, padding: space.sm },
  taskIcon: { alignItems: "center", backgroundColor: colors.brandSoft, borderRadius: radius.field, height: 46, justifyContent: "center", width: 46 },
  taskMeta: { alignItems: "center", flexDirection: "row-reverse", gap: 4, marginTop: 3 },
  taskMetaText: { color: colors.warning, fontFamily: "Cairo_600SemiBold", fontSize: 12 },
});
