-- 0398: حزمة استمارة التقديم للتوظيف الكاملة — بيانات شخصية ومؤهلات وتفضيلات عمل ومراجعة HR
ALTER TABLE `jobApplicants`
  MODIFY COLUMN `jobTitle` varchar(200) NULL,
  ADD COLUMN `whatsappPhone` varchar(20) NULL AFTER `phone`,
  ADD COLUMN `birthDate` date NULL AFTER `email`,
  ADD COLUMN `gender` varchar(16) NULL AFTER `birthDate`,
  ADD COLUMN `maritalStatus` varchar(24) NULL AFTER `gender`,
  ADD COLUMN `governorate` varchar(80) NULL AFTER `maritalStatus`,
  ADD COLUMN `district` varchar(120) NULL AFTER `governorate`,
  ADD COLUMN `degree` varchar(40) NULL AFTER `district`,
  ADD COLUMN `major` varchar(160) NULL AFTER `degree`,
  ADD COLUMN `availabilityStatus` varchar(30) NULL AFTER `major`,
  ADD COLUMN `previousEmployer` varchar(200) NULL AFTER `experience`,
  ADD COLUMN `skills` varchar(500) NULL AFTER `education`,
  ADD COLUMN `department` varchar(120) NULL AFTER `residentialAddress`,
  ADD COLUMN `preferredBranch` varchar(120) NULL AFTER `department`,
  ADD COLUMN `employmentType` varchar(30) NULL AFTER `preferredBranch`,
  ADD COLUMN `shiftPreference` varchar(30) NULL AFTER `employmentType`,
  ADD COLUMN `expectedSalary` decimal(15,2) NULL AFTER `shiftPreference`,
  ADD COLUMN `availableFrom` date NULL AFTER `expectedSalary`,
  ADD COLUMN `interviewDate` date NULL AFTER `rating`,
  ADD COLUMN `rejectionReason` varchar(500) NULL AFTER `interviewDate`,
  ADD COLUMN `convertedEmployeeId` int DEFAULT NULL,
  ADD COLUMN `hrNotes` text NULL AFTER `notes`;

UPDATE `jobApplicants`
SET `hrNotes` = `notes`, `notes` = NULL
WHERE `source` IN ('paper', 'archive') AND `notes` IS NOT NULL AND `hrNotes` IS NULL;

UPDATE `jobApplicants`
SET
  `degree` = CASE
    WHEN TRIM(`education`) LIKE 'دكتوراه%' THEN 'دكتوراه'
    WHEN TRIM(`education`) LIKE 'ماجستير%' THEN 'ماجستير'
    WHEN TRIM(`education`) LIKE 'بكالوريوس%' THEN 'بكالوريوس'
    WHEN TRIM(`education`) LIKE 'دبلوم%' THEN 'دبلوم'
    WHEN TRIM(`education`) LIKE 'إعدادية%' OR TRIM(`education`) LIKE 'اعدادية%' THEN 'إعدادية'
    WHEN TRIM(`education`) LIKE 'متوسطة%' THEN 'متوسطة'
    WHEN TRIM(`education`) LIKE 'ابتدائية%' THEN 'ابتدائية'
    ELSE NULL
  END,
  `major` = CASE
    WHEN TRIM(`education`) REGEXP '^(دكتوراه|ماجستير|بكالوريوس|دبلوم|إعدادية|اعدادية|متوسطة|ابتدائية)[[:space:]]+.+'
      THEN SUBSTRING(TRIM(REGEXP_REPLACE(TRIM(`education`), '^(دكتوراه|ماجستير|بكالوريوس|دبلوم|إعدادية|اعدادية|متوسطة|ابتدائية)[[:space:]]+', '')), 1, 160)
    ELSE `major`
  END,
  `education` = CASE
    WHEN TRIM(`education`) REGEXP '^(دكتوراه|ماجستير|بكالوريوس|دبلوم|إعدادية|اعدادية|متوسطة|ابتدائية)([[:space:]]+.*)?$'
      THEN NULL
    ELSE `education`
  END
WHERE `degree` IS NULL AND `education` IS NOT NULL;

