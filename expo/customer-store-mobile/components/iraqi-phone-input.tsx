import { StyleSheet, Text, TextInput, View } from "react-native";

import { canonicalIraqiLocalPhone } from "@/lib/iraqi-phone";

type IraqiPhoneInputProps = {
  value: string;
  onChangeText: (value: string) => void;
  editable?: boolean;
  accessibilityLabel?: string;
};

/**
 * كتلة رقمية مستقلة عن RTL: الشارة مثبتة في اليسار الفيزيائي والنص المحلي LTR إلى يمينها.
 * لا تدخل البادئة في نص العميل، لذلك لا يمكن حذفها أو قلب موضعها بالكتابة العربية.
 */
export function IraqiPhoneInput({ value, onChangeText, editable = true, accessibilityLabel = "رقم الهاتف العراقي" }: IraqiPhoneInputProps) {
  return (
    <View style={styles.shell}>
      <TextInput
        accessibilityLabel={accessibilityLabel}
        editable={editable}
        keyboardType="phone-pad"
        maxLength={20}
        onChangeText={(next) => onChangeText(canonicalIraqiLocalPhone(next))}
        placeholder="7XXXXXXXXX"
        placeholderTextColor="#8A9992"
        style={styles.input}
        textAlign="left"
        value={value}
      />
      <View pointerEvents="none" style={styles.prefix}>
        <Text style={styles.prefixText}>+964</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { backgroundColor: "#FFFFFF", borderColor: "#E3E8E3", borderRadius: 16, borderWidth: 1, height: 58, overflow: "hidden", position: "relative" },
  input: { color: "#20372F", fontFamily: "Cairo_600SemiBold", fontSize: 17, height: "100%", letterSpacing: 0.7, paddingLeft: 96, paddingRight: 15, writingDirection: "ltr" },
  prefix: { alignItems: "center", backgroundColor: "#E8F5EF", borderRightColor: "#D6E7DE", borderRightWidth: 1, height: "100%", justifyContent: "center", left: 0, position: "absolute", top: 0, width: 82 },
  prefixText: { color: "#0E806A", fontFamily: "Cairo_800ExtraBold", fontSize: 17, writingDirection: "ltr" },
});
