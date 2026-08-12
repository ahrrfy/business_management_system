-- CVs live in a separate binary table so applicant list queries stay small and
-- the files remain part of the tenant database backup/restore lifecycle.
CREATE TABLE `jobApplicantCvFiles` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `applicantId` bigint NOT NULL,
  `publicKey` char(43) NOT NULL,
  `fileName` varchar(180) NOT NULL,
  `mimeType` varchar(100) NOT NULL,
  `sizeBytes` int NOT NULL,
  `bytes` mediumblob NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `jobApplicantCvFiles_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_jobApplicantCv_applicant` UNIQUE(`applicantId`),
  CONSTRAINT `uq_jobApplicantCv_publicKey` UNIQUE(`publicKey`),
  CONSTRAINT `fk_jobApplicantCv_applicant`
    FOREIGN KEY (`applicantId`) REFERENCES `jobApplicants`(`id`) ON DELETE cascade ON UPDATE no action,
  CONSTRAINT `chk_jobApplicantCv_size` CHECK (`sizeBytes` > 0 AND `sizeBytes` <= 2097152)
);
