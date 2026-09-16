# PWA and Native Notifications Sound

## Context
We updated the push notifications so they behave like native apps, including sound and vibration.

## Changes
- **Web PWA**: Added sound (notification.wav) and ibrate options, and most importantly set enotify: true in client/public/push-handler.js to ensure browsers actively alert users for every new notification.
- **Android Native App**: Removed setOnlyAlertOnce(true) and added setDefaults(NotificationCompat.DEFAULT_ALL) in ndroid-native/app/src/main/java/online/alarabiya/superapp/core/notifications/NativeNotificationRenderer.kt so Android system plays the default notification ringtone.
- **Config**: Added .wav file to Vite PWA precache.