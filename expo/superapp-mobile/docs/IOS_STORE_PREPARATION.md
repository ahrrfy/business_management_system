# تجهيز iOS اللاحق

هوية iOS للإنتاج هي `online.alarabiya.superapp` وملف EAS هو `store-ios`. هذا تجهيز للبناء فقط ولا يعني أن التطبيق رُفع إلى Apple.

قبل TestFlight يلزم حساب Apple Developer، إنشاء App Store Connect record مطابق، اعتماد التوقيع وPush Notifications، بناء EAS ناجح، ثم اختبار iPhone فعلي لـFace ID/Keychain وتثبيت TLS والقفل و2FA وPDF والإشعارات وRTL والنص الكبير. بعد ذلك يرفع البناء إلى TestFlight للمراجعة الداخلية، ولا يرسل إلى App Store Production تلقائياً.
