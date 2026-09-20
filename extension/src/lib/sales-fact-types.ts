export type FactCategory = 'price' | 'freight' | 'payment' | 'warranty' | 'logistics' | 'insurance';
export type FactScope = 'org' | 'product' | 'customer' | 'order';
export type FactStatus = 'approved' | 'reference' | 'candidate' | 'retired';
export type FactAuthority = 'owner_statement' | 'approved_template' | 'sales_message' | 'supplier_quote' | 'inventory' | 'model_research' | 'manual';
export type SalesFact = {
  id: string; org_id: string; fact_key: string; category: FactCategory; scope: FactScope;
  product_key: string | null; contact_id: string | null; scope_id: string | null;
  title: string; statement: string; value: Record<string, unknown>; status: FactStatus; authority: FactAuthority;
  source: Record<string, unknown>; observed_at: string; valid_until: string | null; dedupe_key: string;
  version: number; created_by: string | null; created_at: string; updated_at: string;
};
export type NewSalesFact = Omit<SalesFact, 'id' | 'version' | 'created_by' | 'created_at' | 'updated_at'> & {
  id?: string; created_by?: string | null;
};
export interface SalesFactSelection {
  usable: SalesFact[];
  unavailable: { id: string; title: string; reason: string }[];
}
