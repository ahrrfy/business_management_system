import { ScrollView, StyleSheet, Text, View, Pressable } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { AnimatedReveal } from "@/components/AnimatedReveal";
import { ExperienceState, SyncStatus } from "@/components/ExperienceState";
import { FocusedTaskCard } from "@/components/FocusedTaskCard";
import { AppMasthead, SectionTitle } from "@/components/Ui";
import { colors, radius, space } from "@/constants/theme";
import { useWorkspaceAccess } from "@/lib/workspaceAccess";

import { ShiftHandoverCard } from "@/components/ShiftHandoverCard";
import { MobileStockAuditCard } from "@/components/MobileStockAuditCard";

const operationsShortcuts = [
  { icon: "receipt-outline" as const, label: "سجل الفواتير والمبيعات", route: "/operations/invoices" },
  { icon: "cube-outline" as const, label: "جرد وبحث المخزون", route: "/operations/inventory" },
  { icon: "wallet-outline" as const, label: "الخزينة والسيولة والورديات", route: "/operations/treasury" },
  { icon: "business-outline" as const, label: "المشتريات وحسابات الموردين", route: "/operations/purchases" },
  { icon: "people-outline" as const, label: "دليل العملاء والذمم", route: "/operations/customers" },
  { icon: "shield-checkmark-outline" as const, label: "صندوق الاعتمادات والموافقات", route: "/operations/approvals" },
] as const;

export default function WorkScreen() {
  const access = useWorkspaceAccess();

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
        avatar={employee?.displayName.trim().charAt(0) || "ع"}
        name={employee?.displayName || "مساحة العمليات والتشغيل"}
        role={employee?.position || employee?.department || "تشغيل العمليات"}
        subtitle="مركز العمليات والرقابة التنفيذية المباشرة للأنظمة"
        title="العمليات"
      >
        <SyncStatus label="متصل بالمسار الآمن" state="synced" />
      </AppMasthead>

      <SectionTitle>المهمة الحالية المخصصة</SectionTitle>
      <FocusedTaskCard
        detail={focus ? `${due ? `الاستحقاق: ${due} · ` : ""}الأولوية: ${focus.priority}` : "لا توجد مهمة نشطة مسندة إلى حسابك الآن."}
        focus={focus}
        onChanged={async () => { await access.refreshWorkspace(); }}
      />

      <SectionTitle>تسليم الوردية وإغلاق الصندوق</SectionTitle>
      <ShiftHandoverCard />

      <SectionTitle>جرد المخزون الفوري بالباركود</SectionTitle>
      <MobileStockAuditCard />

      <SectionTitle>وحدات التشغيل المعتمدة</SectionTitle>
      <View style={styles.shortcutsList}>
        {operationsShortcuts.map((shortcut, idx) => (
          <AnimatedReveal delay={80 + idx * 40} key={shortcut.label}>
            <Pressable
              accessibilityLabel={shortcut.label}
              accessibilityRole="button"
              onPress={() => {
                void Haptics.selectionAsync();
                router.push(shortcut.route as any);
              }}
              style={({ pressed }) => [styles.shortcutRow, pressed && styles.pressed]}
            >
              <View style={styles.shortcutIconBox}>
                <Ionicons color={colors.brand} name={shortcut.icon} size={20} />
              </View>
              <Text style={styles.shortcutLabel}>{shortcut.label}</Text>
              <Ionicons color={colors.mutedInk} name="chevron-back" size={18} />
            </Pressable>
          </AnimatedReveal>
        ))}
      </View>

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

const styles = StyleSheet.create({
  page: { backgroundColor: colors.canvas, flex: 1 },
  content: { gap: space.lg, padding: space.md, paddingBottom: 40 },
  shortcutsList: {
    backgroundColor: colors.surface,
    borderColor: colors.outline,
    borderRadius: radius.card,
    borderWidth: 1,
    overflow: "hidden",
  },
  shortcutRow: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: space.sm,
    minHeight: 56,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  pressed: { opacity: 0.72 },
  shortcutIconBox: {
    alignItems: "center",
    backgroundColor: colors.brandSoft,
    borderRadius: radius.compact,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  shortcutLabel: {
    color: colors.ink,
    flex: 1,
    fontFamily: "Cairo_700Bold",
    fontSize: 14,
    textAlign: "right",
  },
});
