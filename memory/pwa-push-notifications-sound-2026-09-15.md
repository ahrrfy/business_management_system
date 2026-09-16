# PWA and Native Notifications Sound

## Context

Push notifications should request the platform's normal audible and vibration feedback without
shipping a custom sound that browsers ignore or replaying the same native notification twice.

## Changes

- **Web PWA**: `client/public/push-handler.js` sets `silent: false`, provides an explicit vibration
  pattern, and sets `renotify` for tagged notifications. Untagged notifications receive a unique tag,
  so they alert naturally without the invalid `renotify: true` plus empty-tag combination. Browser and
  operating-system notification settings still control whether sound or vibration is actually played.
- **Android native app**: `NativeNotificationRenderer.kt` uses
  `setDefaults(NotificationCompat.DEFAULT_ALL)` so pre-Android 8 devices request the default ringtone
  and vibration. Android 8+ uses the existing high-importance notification channels, whose user-facing
  settings remain authoritative.
- **Duplicate delivery**: `setOnlyAlertOnce(true)` remains enabled. Redelivery of the same notification
  ID updates the notification without replaying its sound, while a new notification ID alerts normally.
- **Assets**: No custom `notification.wav` is shipped or added to the Vite PWA precache because the Web
  Notifications API does not support a portable custom `sound` option.
