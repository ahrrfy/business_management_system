import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

import { loadVerifiedCustomerSession } from "@/lib/customer-session";
import { getStorefrontProductReviews, submitStorefrontProductReview, type StorefrontProductReviews } from "@/lib/storefront-api";

export function ProductReviews({ productId }: { productId: number }) {
  const [data, setData] = useState<StorefrontProductReviews | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([getStorefrontProductReviews(productId), loadVerifiedCustomerSession()]).then(([reviews, session]) => {
      if (!active) return;
      setData(reviews);
      setSessionToken(session?.token ?? null);
    }).catch(() => { if (active) setData({ summary: { count: 0, average: 0 }, items: [] }); });
    return () => { active = false; };
  }, [productId]);

  const send = async () => {
    if (!sessionToken) { router.push("/verify-phone" as never); return; }
    if (!rating || comment.trim().length < 8) { setMessage("اختر التقييم واكتب 8 أحرف على الأقل."); return; }
    setSending(true); setMessage(null);
    try {
      await submitStorefrontProductReview({ customerSessionToken: sessionToken, productId, rating, comment: comment.trim() });
      setComposerOpen(false); setComment(""); setRating(0); setMessage("تم إرسال مراجعتك. ستظهر بعد اعتمادها من المكتبة.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "تعذر إرسال المراجعة الآن."); }
    finally { setSending(false); }
  };

  const average = data?.summary.average ?? 0;
  return <View style={styles.box}>
    <View style={styles.heading}><View><Text style={styles.title}>مراجعات العملاء</Text><Text style={styles.caption}>تظهر المراجعات بعد اعتمادها من المكتبة.</Text></View><View style={styles.score}><MaterialIcons color="#B97917" name="star" size={16} /><Text style={styles.scoreText}>{data?.summary.count ? average.toFixed(1) : "جديد"}</Text></View></View>
    {data === null ? <ActivityIndicator color="#0E806A" style={styles.loader} /> : data.items.length ? <View>{data.items.slice(0, 3).map((review) => <View key={review.id} style={styles.review}><View style={styles.reviewMeta}><View style={styles.stars}>{[1, 2, 3, 4, 5].map((star) => <MaterialIcons color={star <= review.rating ? "#F3B85A" : "#E4DCD1"} key={star} name="star" size={14} />)}</View><Text style={styles.verified}>مشتري موثق</Text></View><Text style={styles.reviewText}>{review.comment}</Text></View>)}</View> : <View style={styles.empty}><MaterialIcons color="#B97917" name="rate-review" size={21} /><Text style={styles.emptyText}>لا توجد مراجعات موثقة بعد. شارك تجربتك بعد استلام طلبك.</Text></View>}
    {message && <Text style={styles.message}>{message}</Text>}
    {composerOpen ? <View style={styles.composer}><Text style={styles.composerTitle}>اكتب تجربتك مع المنتج</Text><View style={styles.rateRow}>{[1, 2, 3, 4, 5].map((star) => <TouchableOpacity accessibilityLabel={`تقييم ${star} من 5`} activeOpacity={0.8} key={star} onPress={() => setRating(star)}><MaterialIcons color={star <= rating ? "#F3B85A" : "#D9D4CC"} name="star" size={30} /></TouchableOpacity>)}</View><TextInput multiline onChangeText={setComment} placeholder="ما الذي أعجبك في المنتج؟" placeholderTextColor="#8A9891" style={styles.input} textAlign="right" value={comment} /><View style={styles.composerActions}><TouchableOpacity activeOpacity={0.85} onPress={() => setComposerOpen(false)} style={styles.cancel}><Text style={styles.cancelText}>إلغاء</Text></TouchableOpacity><TouchableOpacity activeOpacity={0.85} disabled={sending} onPress={send} style={styles.send}><Text style={styles.sendText}>{sending ? "جار الإرسال…" : "إرسال للمراجعة"}</Text></TouchableOpacity></View></View> : <TouchableOpacity activeOpacity={0.85} onPress={() => sessionToken ? setComposerOpen(true) : router.push("/verify-phone" as never)} style={styles.cta}><MaterialIcons color="#0E806A" name="edit" size={17} /><Text style={styles.ctaText}>{sessionToken ? "اكتب مراجعتك بعد الشراء" : "تحقق بهاتفك لكتابة مراجعة"}</Text></TouchableOpacity>}
  </View>;
}

const styles = StyleSheet.create({
  box: { backgroundColor: "#FFF7E7", borderRadius: 17, marginTop: 14, padding: 13 }, heading: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between" }, title: { color: "#6F531A", fontFamily: "Cairo_800ExtraBold", fontSize: 14, textAlign: "right" }, caption: { color: "#806E47", fontFamily: "Cairo_400Regular", fontSize: 10, marginTop: 2, textAlign: "right" }, score: { alignItems: "center", backgroundColor: "#FFF0CE", borderRadius: 12, flexDirection: "row-reverse", gap: 3, paddingHorizontal: 8, paddingVertical: 5 }, scoreText: { color: "#725516", fontFamily: "Cairo_800ExtraBold", fontSize: 11 }, loader: { marginVertical: 18 }, empty: { alignItems: "center", flexDirection: "row-reverse", gap: 8, paddingVertical: 15 }, emptyText: { color: "#7E6B46", flex: 1, fontFamily: "Cairo_400Regular", fontSize: 10, lineHeight: 17, textAlign: "right" }, review: { backgroundColor: "#FFFFFF", borderColor: "#F0E1C4", borderRadius: 12, borderWidth: 1, marginTop: 10, padding: 10 }, reviewMeta: { alignItems: "center", flexDirection: "row-reverse", justifyContent: "space-between" }, stars: { flexDirection: "row-reverse" }, verified: { color: "#56806F", fontFamily: "Cairo_700Bold", fontSize: 9 }, reviewText: { color: "#50675E", fontFamily: "Cairo_400Regular", fontSize: 11, lineHeight: 18, marginTop: 7, textAlign: "right" }, message: { color: "#526A61", fontFamily: "Cairo_600SemiBold", fontSize: 10, lineHeight: 17, marginTop: 10, textAlign: "right" }, cta: { alignItems: "center", backgroundColor: "#FFFFFF", borderColor: "#EBD6AA", borderRadius: 12, borderWidth: 1, flexDirection: "row-reverse", gap: 6, justifyContent: "center", marginTop: 11, minHeight: 42 }, ctaText: { color: "#0E806A", fontFamily: "Cairo_700Bold", fontSize: 11 }, composer: { backgroundColor: "#FFFFFF", borderColor: "#EBD6AA", borderRadius: 14, borderWidth: 1, marginTop: 12, padding: 11 }, composerTitle: { color: "#6F531A", fontFamily: "Cairo_800ExtraBold", fontSize: 12, textAlign: "right" }, rateRow: { flexDirection: "row-reverse", gap: 5, justifyContent: "flex-start", marginTop: 8 }, input: { backgroundColor: "#FFFCF7", borderColor: "#E8DDD0", borderRadius: 11, borderWidth: 1, color: "#183D36", fontFamily: "Cairo_400Regular", fontSize: 11, lineHeight: 18, marginTop: 9, minHeight: 76, padding: 9, textAlignVertical: "top" }, composerActions: { flexDirection: "row-reverse", gap: 8, marginTop: 10 }, send: { alignItems: "center", backgroundColor: "#0E806A", borderRadius: 11, flex: 1, justifyContent: "center", minHeight: 39 }, sendText: { color: "#FFFFFF", fontFamily: "Cairo_700Bold", fontSize: 11 }, cancel: { alignItems: "center", backgroundColor: "#F1EEE9", borderRadius: 11, justifyContent: "center", minWidth: 70 }, cancelText: { color: "#627269", fontFamily: "Cairo_700Bold", fontSize: 11 },
});
