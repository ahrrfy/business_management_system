import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { reportCrash } from "@/lib/crash-reporting";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * جدارٌ يمنع crash صامتاً على شاشةٍ ما من إسقاط التطبيق كاملاً على شاشةٍ بيضاء.
 * حين يقع خطأٌ داخل شجرة العرض:
 *   ١) يُبلَّغ Crashlytics فوراً (إن كان مركَّباً — يفشل صامتاً وإلّا)
 *   ٢) يُعرض للعميل زرّ «حاول مرة أخرى» بالعربيّة بدل الشاشة البيضاء المخيفة
 *
 * لا يمسك أخطاء الطلبات غير المتزامنة (fetch/Promise rejection) — تلك تُعالَج
 * في كل نداءٍ عبر classifyNetworkError.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportCrash(error, { componentStack: info.componentStack ?? null, source: "ErrorBoundary" });
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.container}>
        <View style={styles.iconWrap}>
          <MaterialIcons color="#B64B24" name="error-outline" size={44} />
        </View>
        <Text style={styles.title}>تعثّرت الشاشة</Text>
        <Text style={styles.copy}>حصل خطأٌ غير متوقّع أثناء عرض هذه الصفحة. أرسلنا تفاصيلاً تشخيصيّة للفريق التقنيّ. يمكنك المحاولة مرّة أخرى الآن.</Text>
        <TouchableOpacity accessibilityLabel="حاول مرّة أخرى" accessibilityRole="button" activeOpacity={0.86} onPress={this.reset} style={styles.cta}>
          <MaterialIcons color="#FFFFFF" name="refresh" size={20} />
          <Text style={styles.ctaText}>حاول مرّة أخرى</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { alignItems: "center", backgroundColor: "#FFF8F2", flex: 1, justifyContent: "center", padding: 32 },
  iconWrap: { alignItems: "center", backgroundColor: "#FFEDE4", borderRadius: 48, height: 96, justifyContent: "center", width: 96 },
  title: { color: "#183D36", fontFamily: "Cairo_800ExtraBold", fontSize: 22, marginTop: 24, textAlign: "center" },
  copy: { color: "#5D756B", fontFamily: "Cairo_400Regular", fontSize: 14, lineHeight: 24, marginTop: 12, maxWidth: 320, textAlign: "center" },
  cta: { alignItems: "center", backgroundColor: "#0E806A", borderRadius: 16, flexDirection: "row-reverse", gap: 8, marginTop: 28, paddingHorizontal: 24, paddingVertical: 14 },
  ctaText: { color: "#FFFFFF", fontFamily: "Cairo_800ExtraBold", fontSize: 14 },
});
