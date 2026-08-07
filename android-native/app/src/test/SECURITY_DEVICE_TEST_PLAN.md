# Android session-security device verification

These cases require Android Keystore, BiometricPrompt, lifecycle, or screenshot behavior and
therefore cannot be proven by local JVM tests. Run them on at least one physical Android device
with a Class 3 (strong) biometric and one supported device without a strong biometric.

## Release-blocking cases

1. Sign in, enable biometric protection, close and relaunch the app, and verify that protected API
   data is unavailable until the system biometric prompt succeeds.
2. Send the app to the background from every sensitive surface (dashboard, payroll, approvals,
   customer and financial detail), then return and verify an immediate locked screen and fresh
   biometric prompt. Repeat after screen-off, task switching, process death, and device reboot.
3. Cancel the prompt, fail authentication, and dismiss it with the password action. Verify that no
   cached business data appears and that the password action clears the local session.
4. Add or remove a biometric after enabling protection. Reopen the app and verify that Android
   invalidates the Keystore key, the local bearer session is destroyed, and password sign-in is
   required. No fallback decryption is allowed.
5. Capture a screenshot, screen recording, and the recent-apps thumbnail on every sensitive
   surface. Android must block or blank all three through `FLAG_SECURE`.
6. On a device without Class 3 biometrics, verify the biometric option is unavailable and normal
   password/2FA authentication still works. Weak biometrics and device PIN must not unlock the
   encrypted session key.
7. Revoke the server session while the app is locked, then authenticate. The first protected API
   request must receive the revocation and return the user to sign-in.
8. Confirm login passwords and 2FA codes are absent from SharedPreferences, saved instance state,
   logs, crash reports, screenshots, and process-restoration state.

## Attendance boundary

Mobile biometrics protect only the local application session. Verify that the Android client has
no attendance check-in/check-out mutation. Attendance events must continue to originate from the
company's physical fingerprint device, be validated server-side, and reach the app as read-only
status or notifications.
