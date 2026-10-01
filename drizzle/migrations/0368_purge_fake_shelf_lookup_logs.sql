-- 0368_purge_fake_shelf_lookup_logs.sql
-- تطهير ومسح سجلات استعلامات الرفوف المزروعة تلقائياً كبيانات وهمية

DELETE FROM `shelfLookupLogs` WHERE `ipHash` IS NULL AND `userAgent` IS NULL;
