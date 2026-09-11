import { ScrollView, StyleSheet } from "react-native";
import { router } from "expo-router";

import { ExperienceState, SyncStatus } from "@/components/ExperienceState";
import { FocusedTaskCard } from "@/components/FocusedTaskCard";
import { AppMasthead, SectionTitle } from "@/components/Ui";
import { colors, space } from "@/constants/theme";
import { useWorkspaceAccess } from "@/lib/workspaceAccess";

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
        detail="تعذر الاتصال بالنظام الأساسي. لم نعرض أي مهمة بديلة أو بيانات محلية."
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
        <SyncStatus label="متصل بالنظام الأساسي" state="synced" />
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

const styles = StyleSheet.create({
  page: { backgroundColor: colors.canvas, flex: 1 },
  content: { gap: space.lg, padding: space.md, paddingBottom: 32 },
});
