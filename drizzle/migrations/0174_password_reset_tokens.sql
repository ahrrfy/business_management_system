-- تدفق استعادة لا يكشف كلمة المرور للأدمن: يُعرض الرمز الخام مرّة واحدة فقط، بينما
-- تحفظ القاعدة SHA-256 للرمز الكامل. lookupId عشوائي غير سري يتيح تحديد الصف وعدّ
-- محاولات سرٍّ خاطئ بلا استعمال البريد أو اسم المستخدم في الواجهة العامة.
CREATE TABLE `passwordResetTokens` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `userId` int NOT NULL,
  `lookupId` char(16) NOT NULL,
  `tokenHash` char(64) NOT NULL,
  `failedAttempts` int NOT NULL DEFAULT 0,
  `expiresAt` timestamp NOT NULL,
  `consumedAt` timestamp NULL,
  `invalidatedAt` timestamp NULL,
  `createdByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `passwordResetTokens_id` PRIMARY KEY(`id`),
  CONSTRAINT `passwordResetTokens_lookupId_unique` UNIQUE(`lookupId`),
  CONSTRAINT `passwordResetTokens_tokenHash_unique` UNIQUE(`tokenHash`),
  CONSTRAINT `fk_password_reset_user`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action,
  CONSTRAINT `fk_password_reset_creator`
    FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_password_reset_user_active`
  ON `passwordResetTokens` (`userId`,`consumedAt`,`invalidatedAt`,`expiresAt`);
