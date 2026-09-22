-- Canonicalize the legacy carrier reference with the same rules as shared/barcodeScanner.ts.
-- The temporary UNIQUE key is a fail-before-write collision audit: if two legacy rows of the
-- same party collapse to one canonical value, this INSERT fails before deliveryConsignments changes.
CREATE TEMPORARY TABLE `_delivery_tracking_ref_canonical_0358` AS
SELECT `id`, `partyId`, `externalTrackingRef` AS `canonicalRef`
FROM `deliveryConsignments`
WHERE 1 = 0;
--> statement-breakpoint
ALTER TABLE `_delivery_tracking_ref_canonical_0358`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `tracking_ref_preflight_0358` (`partyId`, `canonicalRef`);
--> statement-breakpoint
INSERT INTO `_delivery_tracking_ref_canonical_0358` (`id`, `partyId`, `canonicalRef`)
WITH RECURSIVE
`cleaned` AS (
  SELECT
    `id`,
    `partyId`,
    REGEXP_REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(
                REPLACE(
                  REPLACE(
                    REPLACE(
                      REPLACE(
                        REPLACE(
                          REPLACE(
                            REPLACE(
                              REPLACE(
                                REPLACE(
                                  REPLACE(
                                    REPLACE(
                                      REPLACE(
                                        REPLACE(
                                          REPLACE(
                                            REPLACE(
                                              REPLACE(
                                                REPLACE((`externalTrackingRef` COLLATE utf8mb4_bin), CONVERT(0xc2ad USING utf8mb4) COLLATE utf8mb4_bin, ''),
                                                CONVERT(0xd89c USING utf8mb4) COLLATE utf8mb4_bin, ''),
                                              CONVERT(0xe2808b USING utf8mb4) COLLATE utf8mb4_bin, ''),
                                            CONVERT(0xe2808c USING utf8mb4) COLLATE utf8mb4_bin, ''),
                                          CONVERT(0xe2808d USING utf8mb4) COLLATE utf8mb4_bin, ''),
                                        CONVERT(0xe2808e USING utf8mb4) COLLATE utf8mb4_bin, ''),
                                      CONVERT(0xe2808f USING utf8mb4) COLLATE utf8mb4_bin, ''),
                                    CONVERT(0xe280aa USING utf8mb4) COLLATE utf8mb4_bin, ''),
                                  CONVERT(0xe280ab USING utf8mb4) COLLATE utf8mb4_bin, ''),
                                CONVERT(0xe280ac USING utf8mb4) COLLATE utf8mb4_bin, ''),
                              CONVERT(0xe280ad USING utf8mb4) COLLATE utf8mb4_bin, ''),
                            CONVERT(0xe280ae USING utf8mb4) COLLATE utf8mb4_bin, ''),
                          CONVERT(0xe281a0 USING utf8mb4) COLLATE utf8mb4_bin, ''),
                        CONVERT(0xe281a1 USING utf8mb4) COLLATE utf8mb4_bin, ''),
                      CONVERT(0xe281a2 USING utf8mb4) COLLATE utf8mb4_bin, ''),
                    CONVERT(0xe281a3 USING utf8mb4) COLLATE utf8mb4_bin, ''),
                  CONVERT(0xe281a4 USING utf8mb4) COLLATE utf8mb4_bin, ''),
                CONVERT(0xe281a6 USING utf8mb4) COLLATE utf8mb4_bin, ''),
              CONVERT(0xe281a7 USING utf8mb4) COLLATE utf8mb4_bin, ''),
            CONVERT(0xe281a8 USING utf8mb4) COLLATE utf8mb4_bin, ''),
          CONVERT(0xe281a9 USING utf8mb4) COLLATE utf8mb4_bin, ''),
        CONVERT(0xefbbbf USING utf8mb4) COLLATE utf8mb4_bin, ''),
      '^[[:space:]]+|[[:space:]]+$',
      ''
    ) AS `cleanedRef`
  FROM `deliveryConsignments`
  WHERE `externalTrackingRef` IS NOT NULL
),
`payload` AS (
  SELECT
    `id`,
    `partyId`,
    TRIM(
      CASE
        WHEN LEFT(`cleanedRef`, 1) = ']'
          AND (ASCII(SUBSTRING(`cleanedRef`, 2, 1)) BETWEEN 65 AND 90
            OR ASCII(SUBSTRING(`cleanedRef`, 2, 1)) BETWEEN 97 AND 122)
          AND (ASCII(SUBSTRING(`cleanedRef`, 3, 1)) BETWEEN 48 AND 57
            OR ASCII(SUBSTRING(`cleanedRef`, 3, 1)) BETWEEN 65 AND 90
            OR ASCII(SUBSTRING(`cleanedRef`, 3, 1)) BETWEEN 97 AND 122)
        THEN SUBSTRING(`cleanedRef`, 4)
        ELSE `cleanedRef`
      END
    ) AS `scannerRef`
  FROM `cleaned`
),
`source` AS (
  SELECT
    `id`,
    `partyId`,
    `scannerRef`,
    REGEXP_LIKE(`scannerRef`, '[؀-ۿݐ-ݿࢠ-ࣿ÷×‘’]', 'c') AS `translateLayout`
  FROM `payload`
),
`scan` (`id`, `partyId`, `scannerRef`, `translateLayout`, `position`, `normalized`) AS (
  SELECT
    `id`,
    `partyId`,
    `scannerRef`,
    `translateLayout`,
    1,
    CAST('' AS CHAR(100) CHARACTER SET utf8mb4)
  FROM `source`

  UNION ALL

  SELECT
    `id`,
    `partyId`,
    `scannerRef`,
    `translateLayout`,
    `position` + CASE
      WHEN `translateLayout` AND SUBSTRING(`scannerRef`, `position`, 2) IN ('لإ', 'لأ', 'لآ', 'لا') THEN 2
      ELSE 1
    END,
    CONCAT(
      `normalized`,
      CASE
        WHEN `translateLayout` AND SUBSTRING(`scannerRef`, `position`, 2) = 'لإ' THEN 'T'
        WHEN `translateLayout` AND SUBSTRING(`scannerRef`, `position`, 2) = 'لأ' THEN 'G'
        WHEN `translateLayout` AND SUBSTRING(`scannerRef`, `position`, 2) = 'لآ' THEN 'B'
        WHEN `translateLayout` AND SUBSTRING(`scannerRef`, `position`, 2) = 'لا' THEN 'b'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '٠' THEN '0'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '١' THEN '1'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '٢' THEN '2'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '٣' THEN '3'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '٤' THEN '4'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '٥' THEN '5'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '٦' THEN '6'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '٧' THEN '7'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '٨' THEN '8'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '٩' THEN '9'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '۰' THEN '0'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '۱' THEN '1'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '۲' THEN '2'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '۳' THEN '3'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '۴' THEN '4'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '۵' THEN '5'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '۶' THEN '6'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '۷' THEN '7'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '۸' THEN '8'
        WHEN SUBSTRING(`scannerRef`, `position`, 1) = '۹' THEN '9'
        WHEN `translateLayout` THEN CASE SUBSTRING(`scannerRef`, `position`, 1)
          WHEN 'ذ' THEN '`' WHEN 'ّ' THEN '~'
          WHEN 'ض' THEN 'q' WHEN 'ص' THEN 'w' WHEN 'ث' THEN 'e' WHEN 'ق' THEN 'r' WHEN 'ف' THEN 't'
          WHEN 'غ' THEN 'y' WHEN 'ع' THEN 'u' WHEN 'ه' THEN 'i' WHEN 'خ' THEN 'o' WHEN 'ح' THEN 'p'
          WHEN 'ج' THEN '[' WHEN 'د' THEN ']'
          WHEN 'َ' THEN 'Q' WHEN 'ً' THEN 'W' WHEN 'ُ' THEN 'E' WHEN 'ٌ' THEN 'R' WHEN 'إ' THEN 'Y'
          WHEN '‘' THEN 'U' WHEN '÷' THEN 'I' WHEN '×' THEN 'O' WHEN '؛' THEN 'P'
          WHEN '<' THEN '{' WHEN '>' THEN '}'
          WHEN 'ش' THEN 'a' WHEN 'س' THEN 's' WHEN 'ي' THEN 'd' WHEN 'ب' THEN 'f' WHEN 'ل' THEN 'g'
          WHEN 'ا' THEN 'h' WHEN 'ت' THEN 'j' WHEN 'ن' THEN 'k' WHEN 'م' THEN 'l' WHEN 'ك' THEN ';'
          WHEN 'ط' THEN ''''
          WHEN 'ِ' THEN 'A' WHEN 'ٍ' THEN 'S' WHEN ']' THEN 'D' WHEN '[' THEN 'F' WHEN 'أ' THEN 'H'
          WHEN 'ـ' THEN 'J' WHEN '،' THEN 'K' WHEN '/' THEN 'L'
          WHEN 'ئ' THEN 'z' WHEN 'ء' THEN 'x' WHEN 'ؤ' THEN 'c' WHEN 'ر' THEN 'v' WHEN 'ى' THEN 'n'
          WHEN 'ة' THEN 'm' WHEN 'و' THEN ',' WHEN 'ز' THEN '.' WHEN 'ظ' THEN '/'
          WHEN 'ْ' THEN 'X' WHEN '}' THEN 'C' WHEN '{' THEN 'V' WHEN 'آ' THEN 'N' WHEN '’' THEN 'M'
          WHEN ',' THEN '<' WHEN '.' THEN '>' WHEN '؟' THEN '?'
          ELSE SUBSTRING(`scannerRef`, `position`, 1)
        END
        ELSE SUBSTRING(`scannerRef`, `position`, 1)
      END
    )
  FROM `scan`
  WHERE `position` <= CHAR_LENGTH(`scannerRef`)
),
`canonical` AS (
  SELECT `id`, `partyId`, TRIM(`normalized`) AS `canonicalRef`
  FROM `scan`
  WHERE `position` > CHAR_LENGTH(`scannerRef`)
)
SELECT
  `id`,
  `partyId`,
  NULLIF(
    TRIM(
      CASE
        WHEN LEFT(`canonicalRef`, 1) = ']'
          AND (ASCII(SUBSTRING(`canonicalRef`, 2, 1)) BETWEEN 65 AND 90
            OR ASCII(SUBSTRING(`canonicalRef`, 2, 1)) BETWEEN 97 AND 122)
          AND (ASCII(SUBSTRING(`canonicalRef`, 3, 1)) BETWEEN 48 AND 57
            OR ASCII(SUBSTRING(`canonicalRef`, 3, 1)) BETWEEN 65 AND 90
            OR ASCII(SUBSTRING(`canonicalRef`, 3, 1)) BETWEEN 97 AND 122)
        THEN SUBSTRING(`canonicalRef`, 4)
        ELSE `canonicalRef`
      END
    ),
    ''
  )
FROM `canonical`;
--> statement-breakpoint
UPDATE `deliveryConsignments` AS `consignment`
INNER JOIN `_delivery_tracking_ref_canonical_0358` AS `canonical`
  ON `canonical`.`id` = `consignment`.`id`
SET `consignment`.`externalTrackingRef` = `canonical`.`canonicalRef`;
--> statement-breakpoint
ALTER TABLE `deliveryConsignments`
  ADD UNIQUE KEY `uq_consignment_party_tracking_ref` (`partyId`, `externalTrackingRef`);
--> statement-breakpoint
DROP TEMPORARY TABLE `_delivery_tracking_ref_canonical_0358`;
