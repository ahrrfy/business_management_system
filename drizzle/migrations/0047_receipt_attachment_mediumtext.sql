-- 0047 (٥/٧/٢٦): تكبير receipts.attachmentUrl من TEXT (٦٤ك) إلى MEDIUMTEXT (~١٦م) — يتّسع لصور
-- مرفقات السند المضغوطة (data URL base64، نمط productImages/workOrderImages/paymentReceiptUrl).
-- MODIFY COLUMN آمن التكرار طبيعياً (لا حاجة لحارس IF NOT EXISTS — ذاك يخصّ ADD COLUMN فقط).

ALTER TABLE `receipts` MODIFY COLUMN `attachmentUrl` mediumtext;
