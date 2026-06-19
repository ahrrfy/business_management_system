# دليل تثبيت نظام الرؤية على حواسيب المتجر

> هذا الدليل لمالك النظام/مديره. لشرح خطوات النقر للكاشير العادي، استعمل `installer-source/README.txt`.

## ١. نظرة عامة

نظام الرؤية يعمل على خادم سحابي (`https://srv1548487.hstgr.cloud`). كل حاسوب في المتجر يصل إليه بصفحة ويب مثبَّتة كتطبيق سطح مكتب (PWA). الحواسيب التي تحوي طابعة (الكاشير) تشغّل أيضاً **جسر طباعة محلي** صغير (`alroya-bridge.exe`) يستقبل أوامر الطباعة من السحابة ويرسلها للطابعة المحلّية.

```
[سحابة]  ─────HTTPS──────  [Edge --app على جهاز المتجر]
                                  │
                                  │ HTTP localhost:9101
                                  ▼
                          [alroya-bridge.exe]
                                  │
                                  ▼
                  [أي طابعة: USB أو شبكة، أي علامة]
```

**مكوّنات المُثبِّت (محايد العتاد):**
- `تثبيت-الرؤية.bat` — نقطة الدخول، نقرة مزدوجة.
- اختصار PWA على سطح المكتب (Edge `--app` بنافذة بلا شريط عناوين، أيقونة الشركة).
- `alroya-bridge.exe` — جسر Node 22 SEA (~50 MB).
- مهام Task Scheduler: `AlroyaBridge` (تشغيل عند الدخول) + `AlroyaUpdate` (تحقّق يومي).
- لا Electron، لا MSI، لا UAC، لا تعديل في system32.

## ٢. إنتاج حزمة التوزيع (مرة واحدة على جهاز المطوّر)

```powershell
# داخل مستودع المشروع
cd installer-source\bridge
pnpm install --ignore-workspace     # تبعيات الجسر فقط (express + esbuild + postject)
cd ..\..
node installer-source\build-package.mjs
```

**الخطوات داخل `build-package.mjs`:**
1. توليد `installer-source/icons/الرؤية.ico` من `client/public/icon-192.png` و `icon-512.png` (بلا تبعيات native، فقط Node Buffer).
2. بناء `installer-source/bridge/dist/alroya-bridge.exe`:
   - esbuild يحزم TypeScript → `dist/bundle.cjs`
   - `node --experimental-sea-config` ينتج `sea-prep.blob`
   - نسخ `node.exe` كقاعدة، حقن الـblob بـ `postject`
3. تجميع كل شيء في `installer-source/dist/alroya-installer/`:
   - `تثبيت-الرؤية.bat` + `حذف-الرؤية.bat` + `README.txt`
   - `scripts/*.ps1`
   - `resources/bridge/alroya-bridge.exe`
   - `resources/icons/الرؤية.ico`
4. ضغط ZIP بـNode `zlib` (لا أداة خارجية) → `installer-source/dist/alroya-installer.zip` (~٦٠ MB).

**الناتج جاهز للتوزيع:** يكفي نسخ `alroya-installer.zip` لكل جهاز.

## ٣. التثبيت على جهاز المتجر

١) انسخ `alroya-installer.zip` للجهاز عبر USB أو الشبكة.
٢) فك الضغط.
٣) اضغط مرّتين على **`تثبيت-الرؤية.bat`**.
٤) أجب عن الأسئلة:

| السؤال | المعنى | الافتراضي الموصى به |
|---|---|---|
| نوع الجهاز؟ | كاشير = كل شيء، إدارة = PWA فقط | كاشير في الفروع، إدارة في المكاتب |
| اختر طابعة الإيصالات | قائمة الطابعات المكتشفة + شبكة + تخطّي | اختر طابعتك الحرارية المثبَّتة بتعريف Windows |
| هل لديك طابعة ملصقات منفصلة؟ | لطبع ملصقات الباركود | نعم إن وُجدت |
| يفتح درج النقد عبر الطابعة؟ | إشارة pulse عبر RJ-11 | نعم — معظم الأدراج |
| فتح النظام عند إقلاع Windows؟ | كاشير على وضع التشغيل الفوري | نعم للكاشير |

النتيجة بعد ≤ ٦٠ ثانية: اختصار «الرؤية العربية» على سطح المكتب + الجسر يعمل + اختبار طباعة + Edge يفتح النظام تلقائياً.

## ٤. الطابعات المدعومة

| نوع | المسار (mode) | يدعم | لا يحتاج |
|---|---|---|---|
| **أي طابعة بتعريف Windows** | `spooler` | جميع علامات الطابعات (Epson, Star, BIXOLON, Citizen, Brother, HPRT, Zebra, Rongta, Xprinter, …) — USB أو شبكة مثبَّتة بتعريف | Zadig، WinUSB |
| **طابعة شبكة بمنفذ RAW 9100** | `network` | Star TSP*LAN، Epson TM-i، BIXOLON SRP*LAN، أي طابعة بـIP | تعريف Windows |
| **(قديم — استثنائي) WebUSB** | يبقى كاحتياط في المتصفّح | الطابعات التي طُبِّق عليها Zadig يدوياً | — |

**القاعدة:** إن كانت الطابعة تطبع من Notepad، فالجسر سيطبع عليها. الجسر يستعمل Windows Winspool API بـ`pData = "RAW"` ⇒ يتجاوز نافذة Print تماماً ويرسل البايتات مباشرة.

## ٥. التحديث الذاتي

- المالك يرفع نسخة جديدة من `alroya-bridge.exe` إلى `https://srv1548487.hstgr.cloud/installer-assets/<version>/` ثم يحدّث `installer-source/version.json` (يحدِّد `bridge`, `installer`, `url`, `sha256`).
- `/api/installer/latest-version` يعيد القيمة المُلتزَمة (publicProcedure + REST).
- مهمة `AlroyaUpdate` على كل جهاز تستعلم يومياً الساعة ٣ صباحاً (`check-update.ps1`):
  - تتحقّق من الإصدار البعيد
  - تنزل، تطابق `sha256`، تحفظ كـ`.new`
  - تستبدل عند إعادة تشغيل الجسر التالية (`MOVEFILE_DELAY_UNTIL_REBOOT` إن كان يعمل)
  - تحتفظ بـ`.bak` للـrollback التلقائي
- تحديث الـPWA: مُعدَّل أصلاً عبر `vite-plugin-pwa` (`registerType: "prompt"`) — لا عمل إضافي.

## ٦. منع التعارض الأمني

- **منفذ 127.0.0.1 فقط:** الجسر لا يستمع على الشبكة الخارجية.
- **CORS مقيَّد:** يقبل فقط Origin = `cloudUrl` المُكوَّن في `config.json`.
- **HMAC-SHA256 إجباري:** كل طلب طباعة موقَّع بـ`X-Alroya-Sig`. السرّ ١٦+ بايت عشوائي (يولِّده المُثبِّت).
- **localhost استثناء mixed-content:** Chromium/Edge يسمحان بـHTTPS→`http://127.0.0.1:*` (موثَّق في W3C Secure Contexts §5.2). لا يحتاج تكوين خاص.
- **لا UAC للتثبيت العادي.** الاستثناء الوحيد: تعريف WinUSB لطابعة بلا driver — نادر، اختياري، نَطلبه صراحةً برسالة عربية واضحة.

## ٧. التحقّق

### بناء الحزمة:
```bash
node installer-source/build-package.mjs
# ينتج installer-source/dist/alroya-installer.zip
```

### اختبار الجسر محلياً (بلا بناء SEA):
```bash
cd installer-source/bridge
pnpm install --ignore-workspace
# أنشئ config.json يدوياً في %LOCALAPPDATA%\AlruyaERP\config.json
node src/server.ts  # (يتطلب tsx) — أو tsx src/server.ts
curl http://127.0.0.1:9101/health
```

### اختبار التثبيت الكامل على Windows 11 نظيف:
انسخ الـZIP، فك ضغطه، شغّل `تثبيت-الرؤية.bat`، اختر الدور، اختر طابعة، تأكّد:
- ظهور اختصار سطح المكتب
- `Get-ScheduledTask -TaskName AlroyaBridge` (Status: Ready)
- `curl http://127.0.0.1:9101/health` يعيد JSON
- من الـPWA: «طباعة فاتورة تجريبية» تنجح، مؤشّر الجسر أخضر في الـheader

### الحذف:
```cmd
حذف-الرؤية.bat
```
يزيل: كل الاختصارات، المهام المجدولة، مجلد `%LOCALAPPDATA%\AlruyaERP`، مجلد `%APPDATA%\AlruyaERP`.

## ٨. استكشاف الأعطال

| العَرَض | السبب الأرجح | الحل |
|---|---|---|
| Edge يفتح لكن النظام لا يظهر | الإنترنت معطّل، لكن PWA قد يعمل offline لقراءة فقط | تحقّق من الشبكة |
| الجسر غير متصل (مؤشّر رمادي) | المهمّة لم تُسجَّل، أو الجسر متعطّل | `Get-ScheduledTask AlroyaBridge` + شغّله يدوياً من `%LOCALAPPDATA%\AlruyaERP\bridge\` |
| الجسر متصل لكن الطباعة فاشلة | الطابعة غير جاهزة (ورق، توصيل) | `Get-Printer` + اطبع من Notepad للتأكّد. السجلات في `%APPDATA%\AlruyaERP\logs\bridge.log` |
| SmartScreen يعرض «الناشر غير معروف» | لا توقيع كود (متوقَّع) | اضغط «المزيد من المعلومات» ثم «تشغيل بأيّة حال» — مرة واحدة |
| `pnpm install --ignore-workspace` يفشل في bridge | pnpm-lock.yaml للمشروع الكبير يتعارض | استعمل `npm install` داخل `installer-source/bridge` بدلاً |
| الـPWA لا يعرض زر «تثبيت كتطبيق» | المتصفّح ليس Chromium، أو تطبيق مُثبَّت أصلاً | استعمل `تثبيت-الرؤية.bat` بدلاً |

## ٩. مسار التطوير المستقبلي

- **توقيع كود (Authenticode):** ~$200/سنة عبر Sectigo أو DigiCert ⇒ يلغي SmartScreen warning.
- **MSI installer مع MDM:** لو نمت الشبكة إلى ١٠+ أجهزة، استعمل توزيعاً مركزياً.
- **MSIX من Microsoft Store:** بديل احترافي بلا توقيع منفصل.
- **escpos-usb مسار direct:** يحتاج `node-usb` (native module) — مُغلَق حالياً لأنه يُكسر SEA. البديل عبر spooler يكفي.

## ١٠. مراجع

- الإنتاج: `docs/deployment-vps.md`
- ذاكرة الـWinUSB: `~/.claude/projects/.../memory/thermal-print-winusb.md`
- ملف الإصدار: `installer-source/version.json`
- خطّة الشريحة: `~/.claude/plans/effervescent-bouncing-moonbeam.md`
