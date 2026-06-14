ALTER TABLE `employees` ADD `fatherName` varchar(100);--> statement-breakpoint
ALTER TABLE `employees` ADD `grandfatherName` varchar(100);--> statement-breakpoint
ALTER TABLE `employees` ADD `managerId` bigint;--> statement-breakpoint
ALTER TABLE `employees` ADD `payType` enum('monthly','hourly') DEFAULT 'monthly' NOT NULL;--> statement-breakpoint
ALTER TABLE `employees` ADD `allowances` decimal(15,2) DEFAULT '0';--> statement-breakpoint
ALTER TABLE `employees` ADD `dayRates` json;--> statement-breakpoint
ALTER TABLE `employees` ADD `employmentStatus` enum('active','leave','terminated') DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `employees` ADD `gender` varchar(10);--> statement-breakpoint
ALTER TABLE `employees` ADD `birthDate` date;--> statement-breakpoint
ALTER TABLE `employees` ADD `maritalStatus` varchar(20);--> statement-breakpoint
ALTER TABLE `employees` ADD `nationality` varchar(50);--> statement-breakpoint
ALTER TABLE `employees` ADD `governorate` varchar(80);--> statement-breakpoint
ALTER TABLE `employees` ADD `district` varchar(120);--> statement-breakpoint
ALTER TABLE `employees` ADD `addressLandmark` varchar(255);--> statement-breakpoint
ALTER TABLE `employees` ADD `nationalId` varchar(40);--> statement-breakpoint
ALTER TABLE `employees` ADD `emergencyContactName` varchar(150);--> statement-breakpoint
ALTER TABLE `employees` ADD `emergencyContactPhone` varchar(20);--> statement-breakpoint
ALTER TABLE `employees` ADD `colorTag` varchar(20);--> statement-breakpoint
ALTER TABLE `employees` ADD `photoUrl` mediumtext;--> statement-breakpoint
ALTER TABLE `employees` ADD `education` json;--> statement-breakpoint
ALTER TABLE `employees` ADD `annualLeaveBalance` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `employees` ADD `sickLeaveBalance` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `employees` ADD `terminationDate` date;--> statement-breakpoint
ALTER TABLE `employees` ADD `terminationReason` varchar(255);--> statement-breakpoint
CREATE INDEX `idx_emp_status` ON `employees` (`employmentStatus`);--> statement-breakpoint
CREATE INDEX `idx_emp_dept` ON `employees` (`department`);