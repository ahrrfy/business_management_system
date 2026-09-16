import { useMemo, useState } from "react";
import { Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { AnimatedReveal } from "@/components/AnimatedReveal";
import { ExperienceState, SyncStatus } from "@/components/ExperienceState";
import { PreviewBanner } from "@/components/PreviewBanner";
import { FocusedTaskCard } from "@/components/FocusedTaskCard";
import { AppMasthead, SectionTitle } from "@/components/Ui";
import { colors, radius, space } from "@/constants/theme";
import { useWorkspaceAccess } from "@/lib/workspaceAccess";

type WorkView = "tasks" | "approvals";
type TaskStatus = "NEW" | "IN_PROGRESS" | "DONE";

type PreviewTask = {
  bucket: "عاجل" | "اليوم" | "لاحقاً";
  due: string;
  icon: "cube-outline" | "chatbox-ellipses-outline" | "clipboard-outline" | "person-outline";
  id: string;
  meta: string;
  status: TaskStatus;
  title: string;
  tone: string;
};

const initialTasks: PreviewTask[] = [
  { bucket: "عاجل", due: "اليوم 11:00 ص", icon: "cube-outline", id: "order-4587", meta: "مستودع المنصور", status: "NEW", title: "تجهيز طلب رقم 4587", tone: colors.danger },
  { bucket: "عاجل", due: "اليوم 02:00 م", icon: "chatbox-ellipses-outline", id: "customer-nour", meta: "شركة النور", status: "IN_PROGRESS", title: "الرد على استفسار عميل", tone: colors.danger },
  { bucket: "اليوم", due: "اليوم 04:00 م", icon: "clipboard-outline", id: "stock-monthly", meta: "قسم المستودعات", status: "NEW", title: "جرد المخزون الشهري", tone: colors.warning },
  { bucket: "لاحقاً", due: "غداً", icon: "person-outline", id: "customer-followup", meta: "المسندة إليك", status: "NEW", title: "متابعة شكاوى العملاء", tone: colors.info },
];

const buckets: PreviewTask["bucket"][] = ["عاجل", "اليوم", "لاحقاً"];

function taskStatusCopy(status: TaskStatus): string {
  return ({ NEW: "جديدة", IN_PROGRESS: "قيد التنفيذ", DONE: "مكتملة" })[status];
}

export default function WorkScreen() {
  const access = useWorkspaceAccess();

  if (access.mode === "preview") return <PreviewWorkScreen />;
  if (access.mode === "checking") {
    return <WorkMessage detail="نتأكد من جلسة الجهاز قبل عرض أي مهمة." state="loading" title="تحميل مساحة العمل" />;
  }
  if (access.mode === "signedOut") {
    return (
      <WorkMessage
        actionLabel="تسجيل الدخول"
        detail="بعد الدخول سترى المهمة التي خصصها الخادم لحسابك فقط."
        onAction={() => router.push("/sign-in")}
        state="offline"
        title="سجّل الدخول لعرض عملك"
      />
    );
  }
  if (access.mode === "error" || !access.today) {
    return (
      <WorkMessage
        actionLabel="المحاولة مجدداً"
        detail="لم نعرض مهام مخزنة أو افتراضية. تحقق من الشبكة ثم أعد المحاولة."
        onAction={() => void access.refreshWorkspace()}
        state="error"
        title="تعذر تحديث مساحة العمل"
      />
    );
  }
  if (!access.today.navigation.work || access.today.personal.state !== "READY" || !access.today.personal.employee) {
    return <WorkMessage detail="لا يوجد ملف موظف مرتبط بهذه الجلسة، لذلك لا نعرض طابوراً عاماً أو مهام زملاء." state="empty" title="لا توجد مساحة مهام شخصية" />;
  }

  const employee = access.today.personal.employee;
  const focus = access.today.personal.focus;
  const due = focus?.dueAt
    ? new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        month: "short",
        timeZone: "Asia/Baghdad",
      }).format(new Date(focus.dueAt))
    : null;

  return (
    <ScrollView accessibilityLabel="العمل" contentContainerStyle={styles.content} style={styles.page}>
      <AppMasthead
        avatar={employee.displayName.trim().charAt(0) || "م"}
        name={employee.displayName}
        role={employee.position || employee.department || "موظف"}
        subtitle="مهمتك الحالية من النظام، بلا اختيار موظف أو فرع"
        title="العمل"
      >
        <SyncStatus label="متصل بالمسار الآمن" state="synced" />
      </AppMasthead>
      <SectionTitle>المهمة الحالية</SectionTitle>
      <FocusedTaskCard
        detail={focus ? `${due ? `الاستحقاق: ${due} · ` : ""}الأولوية: ${focus.priority}` : "لا توجد مهمة نشطة مسندة إلى حسابك الآن."}
        focus={focus}
        onChanged={async () => { await access.refreshWorkspace(); }}
      />
      <ExperienceState
        compact
        detail="إدارة طوابير الموظفين والموافقات الشاملة تبقى في النظام الأساسي وفق صلاحيات الدور."
        state="pending"
        title="نطاق شخصي محكوم من الخادم"
      />
    </ScrollView>
  );
}

function WorkMessage({
  actionLabel,
  detail,
  onAction,
  state,
  title,
}: {
  actionLabel?: string;
  detail: string;
  onAction?: () => void;
  state: "loading" | "empty" | "offline" | "error";
  title: string;
}) {
  return (
    <ScrollView accessibilityLabel="العمل" contentContainerStyle={styles.content} style={styles.page}>
      <AppMasthead avatar="س" name="سوبر العربية" role="مساحة عمل محمية" subtitle="يعرض التطبيق ما تسمح به جلستك فقط" title="العمل" />
      <ExperienceState actionLabel={actionLabel} detail={detail} onAction={onAction} state={state} title={title} />
    </ScrollView>
  );
}

function PreviewWorkScreen() {
  const [view, setView] = useState<WorkView>("tasks");
  const [tasks, setTasks] = useState<PreviewTask[]>(initialTasks);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [attached, setAttached] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const urgentCount = tasks.filter((task) => task.bucket === "عاجل" && task.status !== "DONE").length;
  const completedCount = tasks.filter((task) => task.status === "DONE").length;

  const grouped = useMemo(
    () => buckets.map((bucket) => ({ bucket, items: tasks.filter((task) => task.bucket === bucket) })),
    [tasks],
  );

  const chooseView = (next: WorkView) => {
    void Haptics.selectionAsync().catch(() => undefined);
    setView(next);
  };

  const openTask = (task: PreviewTask) => {
    void Haptics.selectionAsync().catch(() => undefined);
    setSelectedId(task.id);
    setNote("");
    setAttached(false);
  };

  const advanceTask = () => {
    if (!selected) return;
    const nextStatus: TaskStatus = selected.status === "NEW" ? "IN_PROGRESS" : "DONE";
    setTasks((current) => current.map((task) => task.id === selected.id ? { ...task, status: nextStatus } : task));
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    setFeedback(nextStatus === "IN_PROGRESS" ? `بدأت «${selected.title}» في هذه المعاينة.` : `اكتملت «${selected.title}» في هذه المعاينة.`);
    if (nextStatus === "DONE") setSelectedId(null);
  };

  const refresh = async () => {
    setRefreshing(true);
    setFeedback(null);
    await new Promise((resolve) => setTimeout(resolve, 360));
    setRefreshing(false);
  };

  return (
    <>
      <ScrollView
        accessibilityLabel="العمل"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl onRefresh={() => void refresh()} refreshing={refreshing} tintColor={colors.brand} />}
        style={styles.page}
      >
        <AppMasthead avatar="س" name="سارة كريم" role="موظفة دعم" subtitle="مهامك وموافقاتك في مكان واحد" title="العمل">
          <PreviewBanner tone="dark" />
          <View style={styles.workSummary}>
            <View style={styles.summaryLead}>
              <View style={styles.summaryPulse}><Ionicons color="#35D796" name="pulse" size={20} /></View>
              <View style={styles.identityBody}>
                <Text style={styles.summaryTitle}>خطتك قابلة للتنفيذ</Text>
                <Text style={styles.summaryText}>ابدئي بالعاجل، وسجّلي التقدم والمرفقات داخل المهمة</Text>
              </View>
            </View>
            <View style={styles.summaryFacts}>
              <View style={styles.summaryFact}><Text style={styles.summaryNumber}>{tasks.length}</Text><Text style={styles.summaryLabel}>مهام</Text></View>
              <View style={styles.summaryFact}><Text style={[styles.summaryNumber, styles.summaryUrgent]}>{urgentCount}</Text><Text style={styles.summaryLabel}>عاجلة</Text></View>
              <View style={styles.summaryFact}><Text style={styles.summaryNumber}>{completedCount}</Text><Text style={styles.summaryLabel}>مكتملة</Text></View>
            </View>
          </View>
        </AppMasthead>

        <View accessibilityRole="tablist" style={styles.segmented}>
          <Pressable accessibilityRole="tab" accessibilityState={{ selected: view === "tasks" }} onPress={() => chooseView("tasks")} style={[styles.segment, view === "tasks" && styles.segmentActive]}>
            <Text style={[styles.segmentText, view === "tasks" && styles.segmentTextActive]}>مهامي</Text>
          </Pressable>
          <Pressable accessibilityRole="tab" accessibilityState={{ selected: view === "approvals" }} onPress={() => chooseView("approvals")} style={[styles.segment, view === "approvals" && styles.segmentActive]}>
            <Text style={[styles.segmentText, view === "approvals" && styles.segmentTextActive]}>الموافقات</Text>
          </Pressable>
        </View>

        {feedback ? <ExperienceState compact detail="التغيير محلي للعرض ولن يُرسل إلى الخادم." state="success" title={feedback} /> : null}
        <SyncStatus label="وضع معاينة · التغييرات غير مرسلة" state="pending" />

        {view === "tasks" ? (
          <View style={styles.groups}>
            {grouped.map((group, groupIndex) => (
              <AnimatedReveal delay={80 + groupIndex * 70} key={group.bucket}>
                <View style={styles.groupHeader}>
                  <Text style={styles.groupTitle}>{group.bucket}</Text>
                  <View style={styles.countBadge}><Text style={styles.countText}>{group.items.length}</Text></View>
                </View>
                <View style={styles.listSurface}>
                  {group.items.map((item, index) => (
                    <Pressable
                      accessibilityHint="يفتح تفاصيل المهمة ومسار تقدمها"
                      accessibilityLabel={`${item.title}، ${taskStatusCopy(item.status)}، ${item.due}`}
                      accessibilityRole="button"
                      key={item.id}
                      onPress={() => openTask(item)}
                      style={({ pressed }) => [styles.workRow, index > 0 && styles.rowDivider, pressed && styles.pressed]}
                    >
                      <View style={styles.iconBox}><Ionicons color={item.status === "DONE" ? colors.success : colors.brand} name={item.status === "DONE" ? "checkmark-done-outline" : item.icon} size={21} /></View>
                      <View style={styles.rowBody}>
                        <View style={styles.rowTitleLine}>
                          <View style={[styles.statusDot, { backgroundColor: item.status === "DONE" ? colors.success : item.tone }]} />
                          <Text numberOfLines={1} style={[styles.rowTitle, item.status === "DONE" && styles.rowTitleDone]}>{item.title}</Text>
                        </View>
                        <Text numberOfLines={1} style={styles.rowMeta}>{item.meta} · {taskStatusCopy(item.status)}</Text>
                        <Text style={[styles.rowDue, { color: item.status === "DONE" ? colors.success : item.tone }]}>{item.status === "DONE" ? "تم الإنجاز" : item.due}</Text>
                      </View>
                      <Ionicons color={colors.mutedInk} name="chevron-back" size={18} />
                    </Pressable>
                  ))}
                </View>
              </AnimatedReveal>
            ))}
          </View>
        ) : (
          <ExperienceState actionLabel="العودة إلى مهامي" detail="ستظهر هنا الطلبات المصرح لك بمراجعتها فقط." onAction={() => chooseView("tasks")} state="empty" title="لا توجد موافقات بانتظارك" />
        )}
      </ScrollView>

      <Modal animationType="slide" onRequestClose={() => setSelectedId(null)} transparent visible={selected !== null}>
        <Pressable onPress={() => setSelectedId(null)} style={styles.backdrop}>
          <Pressable onPress={(event) => event.stopPropagation()} style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <View style={styles.iconBox}><Ionicons color={colors.brand} name={selected?.icon ?? "clipboard-outline"} size={22} /></View>
              <View style={styles.identityBody}>
                <Text style={styles.sheetTitle}>{selected?.title}</Text>
                <Text style={styles.sheetMeta}>{selected?.meta} · {selected ? taskStatusCopy(selected.status) : ""}</Text>
              </View>
              <Pressable accessibilityLabel="إغلاق تفاصيل المهمة" accessibilityRole="button" onPress={() => setSelectedId(null)} style={styles.closeIcon}>
                <Ionicons color={colors.mutedInk} name="close" size={23} />
              </Pressable>
            </View>

            <TextInput
              accessibilityLabel="تعليق المهمة"
              maxLength={1000}
              multiline
              onChangeText={(value) => setNote(value.replace(/[\r\n]+/g, " "))}
              placeholder="أضف تعليقاً قصيراً للفريق"
              placeholderTextColor={colors.mutedInk}
              style={styles.input}
              textAlignVertical="top"
              value={note}
            />
            <Pressable accessibilityRole="button" onPress={() => setAttached((value) => !value)} style={({ pressed }) => [styles.attachment, pressed && styles.pressed]}>
              <Ionicons color={colors.brand} name={attached ? "checkmark-circle-outline" : "attach-outline"} size={21} />
              <Text style={styles.attachmentText}>{attached ? "أُضيف مرفق تجريبي" : "إضافة صورة أو ملف"}</Text>
            </Pressable>
            <ExperienceState compact detail="الحفظ الفعلي ينتظر الاتصال والجلسة الموثقة؛ لا تضيع ملاحظتك في المسار الإنتاجي." state="pending" title="بانتظار المزامنة الآمنة" />
            {selected?.status !== "DONE" ? (
              <Pressable accessibilityRole="button" onPress={advanceTask} style={styles.primaryAction}>
                <Ionicons color={colors.surface} name={selected?.status === "NEW" ? "play-outline" : "checkmark-circle-outline"} size={21} />
                <Text style={styles.primaryActionText}>{selected?.status === "NEW" ? "بدء المهمة" : "إتمام المهمة"}</Text>
              </Pressable>
            ) : (
              <ExperienceState compact detail="يمكن الرجوع للسجل والتعليق، ولا تحتاج هذه المهمة إجراءً آخر." state="success" title="المهمة مكتملة" />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.canvas, flex: 1 },
  content: { gap: space.lg, padding: space.md, paddingBottom: 32 },
  identityBody: { flex: 1 },
  segmented: { backgroundColor: colors.surfaceMuted, borderRadius: radius.field, flexDirection: "row-reverse", padding: 4 },
  segment: { alignItems: "center", borderRadius: radius.compact, flex: 1, justifyContent: "center", minHeight: 44 },
  segmentActive: { backgroundColor: colors.brand },
  segmentText: { color: colors.mutedInk, fontFamily: "Cairo_600SemiBold", fontSize: 14 },
  segmentTextActive: { color: colors.surface },
  groups: { gap: space.xl },
  groupHeader: { alignItems: "center", flexDirection: "row-reverse", gap: space.xs, marginBottom: space.xs },
  groupTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 18, textAlign: "right" },
  countBadge: { alignItems: "center", backgroundColor: colors.surfaceMuted, borderRadius: radius.pill, height: 26, justifyContent: "center", minWidth: 26, paddingHorizontal: 7 },
  countText: { color: colors.mutedInk, fontFamily: "Cairo_700Bold", fontSize: 12 },
  listSurface: { backgroundColor: colors.surface, borderColor: colors.outline, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  workRow: { alignItems: "center", flexDirection: "row-reverse", gap: space.sm, minHeight: 92, padding: space.sm },
  rowDivider: { borderTopColor: colors.outline, borderTopWidth: StyleSheet.hairlineWidth },
  pressed: { opacity: 0.68 },
  iconBox: { alignItems: "center", backgroundColor: colors.brandSoft, borderRadius: radius.compact, height: 44, justifyContent: "center", width: 44 },
  rowBody: { flex: 1 },
  rowTitleLine: { alignItems: "center", flexDirection: "row-reverse", gap: 7 },
  statusDot: { borderRadius: 4, height: 8, width: 8 },
  rowTitle: { color: colors.ink, flex: 1, fontFamily: "Cairo_700Bold", fontSize: 14, lineHeight: 23, textAlign: "right" },
  rowTitleDone: { color: colors.mutedInk, textDecorationLine: "line-through" },
  rowMeta: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, textAlign: "right" },
  rowDue: { fontFamily: "Cairo_600SemiBold", fontSize: 12, lineHeight: 19, marginTop: 2, textAlign: "right" },
  workSummary: { backgroundColor: "#FFFFFF12", borderColor: "#FFFFFF38", borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, gap: space.sm, padding: space.sm },
  summaryLead: { alignItems: "center", flexDirection: "row-reverse", gap: space.sm },
  summaryPulse: { alignItems: "center", backgroundColor: "#35D79618", borderRadius: radius.field, height: 44, justifyContent: "center", width: 44 },
  summaryTitle: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 14, textAlign: "right" },
  summaryText: { color: "#D1D7F3", fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 19, textAlign: "right" },
  summaryFacts: { borderTopColor: "#FFFFFF2F", borderTopWidth: StyleSheet.hairlineWidth, flexDirection: "row-reverse", paddingTop: space.sm },
  summaryFact: { alignItems: "center", flex: 1 },
  summaryNumber: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 18 },
  summaryUrgent: { color: "#FFB1B1" },
  summaryLabel: { color: "#D1D7F3", fontFamily: "Cairo_400Regular", fontSize: 12 },
  backdrop: { backgroundColor: colors.scrim, flex: 1, justifyContent: "flex-end", padding: space.md },
  sheet: { backgroundColor: colors.surface, borderRadius: 26, gap: space.sm, padding: space.lg },
  sheetHandle: { alignSelf: "center", backgroundColor: colors.outline, borderRadius: radius.pill, height: 4, width: 46 },
  sheetHeader: { alignItems: "center", flexDirection: "row-reverse", gap: space.sm },
  sheetTitle: { color: colors.ink, fontFamily: "Cairo_700Bold", fontSize: 18, lineHeight: 27, textAlign: "right" },
  sheetMeta: { color: colors.mutedInk, fontFamily: "Cairo_400Regular", fontSize: 12, lineHeight: 20, textAlign: "right" },
  closeIcon: { alignItems: "center", justifyContent: "center", minHeight: 44, minWidth: 44 },
  input: { backgroundColor: colors.canvas, borderColor: colors.outline, borderRadius: radius.field, borderWidth: 1, color: colors.ink, fontFamily: "Cairo_400Regular", fontSize: 14, minHeight: 88, padding: space.sm, textAlign: "right" },
  attachment: { alignItems: "center", borderColor: colors.outline, borderRadius: radius.field, borderWidth: 1, flexDirection: "row-reverse", gap: space.xs, justifyContent: "center", minHeight: 48 },
  attachmentText: { color: colors.brand, fontFamily: "Cairo_700Bold", fontSize: 13 },
  primaryAction: { alignItems: "center", backgroundColor: colors.brand, borderRadius: radius.field, flexDirection: "row-reverse", gap: space.xs, justifyContent: "center", minHeight: 50 },
  primaryActionText: { color: colors.surface, fontFamily: "Cairo_700Bold", fontSize: 14 },
});
