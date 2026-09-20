-- Personal preferences span contacts, so the existing contact_id index cannot
-- serve this query. Match sales-preferences.ts JSON text equality predicates.
-- Apply this statement separately (outside a transaction) to avoid blocking
-- writes to contact_events while its index is built.
CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_events_sales_preference_owner_idx
ON public.contact_events ((payload->>'orgId'), (payload->>'userId'), created_at, id)
WHERE event_type = 'ai_extracted' AND payload->>'schema' = 'sales-preference.v1';
