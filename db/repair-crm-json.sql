-- One-time data repair after deploying the corrected pgDriver JSON serializer.
-- Repeatable: properly typed values are unchanged; invalid nested JSON aborts the transaction.
begin;
set local lock_timeout = '5s';
update clowzy.crm_meta set tags = (tags #>> '{}')::jsonb
where jsonb_typeof(tags) = 'string' and jsonb_typeof((tags #>> '{}')::jsonb) = 'array';
update clowzy.saved_audiences set filters = (filters #>> '{}')::jsonb
where jsonb_typeof(filters) = 'string' and jsonb_typeof((filters #>> '{}')::jsonb) = 'object';
update clowzy.lead_catalog set payload = (payload #>> '{}')::jsonb
where jsonb_typeof(payload) = 'string' and jsonb_typeof((payload #>> '{}')::jsonb) = 'object';
commit;
