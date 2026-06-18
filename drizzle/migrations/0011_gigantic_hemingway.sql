-- إصلاح ١٨/٦/٢٠٢٦: حُذف CREATE TABLE jobVacancies + FK + index + ALTER jobApplicants vacancyId
-- لأنّها مُكرَّرة مع 0011_job_vacancies.sql الذي يَسبقها (idx 10). كانت تَفشل deploy إنتاجي
-- بـ«Table 'jobVacancies' already exists». تَبقى ٣ تَغييرات فَريدة لـcash-treasury-mode فقط.
ALTER TABLE `customers` MODIFY COLUMN `creditLimit` decimal(15,2);--> statement-breakpoint
ALTER TABLE `expenses` ADD `expenseCashBucket` enum('DRAWER','TREASURY');--> statement-breakpoint
ALTER TABLE `receipts` ADD `cashBucket` enum('DRAWER','TREASURY');
