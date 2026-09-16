-- الطلب التجاري يبقى استعلاماً حتى يُصدر الموظف عرضاً رسمياً واحداً؛ الرابط يمنع التكرار ويتيح العودة للمستند المؤرخ.
ALTER TABLE `storefrontQuoteRequests`
  ADD COLUMN `officialQuotationId` bigint NULL AFTER `staffNote`,
  ADD CONSTRAINT `uq_store_quote_request_official_quotation` UNIQUE(`officialQuotationId`),
  ADD CONSTRAINT `fk_store_quote_request_official_quotation`
    FOREIGN KEY (`officialQuotationId`) REFERENCES `quotations`(`id`);
