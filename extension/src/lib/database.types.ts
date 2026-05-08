export type CustomerStage =
  | 'new'
  | 'qualifying'
  | 'negotiating'
  | 'stalled'
  | 'quoted'
  | 'won'
  | 'lost';

export type CustomerQuality = 'big' | 'potential' | 'normal' | 'spam';

export type MemberRole = 'owner' | 'admin' | 'member';
export type VehicleCondition = 'new' | 'used';
export type VehicleSteering = 'LHD' | 'RHD';
export type TaskStatus = 'open' | 'done' | 'cancelled';
export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected';
export type ContactEventType =
  | 'created'
  | 'stage_changed'
  | 'tag_added'
  | 'vehicle_added'
  | 'quote_created'
  | 'task_created'
  | 'ai_extracted';
export type FuelType = 'gas' | 'diesel' | 'hybrid' | 'ev';
export type SaleStatus = 'available' | 'paused' | 'expired';
export type MessageDirection = 'inbound' | 'outbound';
export type VehicleMediaType = 'image' | 'video' | 'spec';

export interface PricingTier {
  label: string;
  price_usd: number;
}

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: { id: string; name: string; created_at: string };
        Insert: { id?: string; name: string; created_at?: string };
        Update: { name?: string };
        Relationships: [];
      };
      organization_members: {
        Row: {
          org_id: string;
          user_id: string;
          role: MemberRole;
          created_at: string;
        };
        Insert: {
          org_id: string;
          user_id: string;
          role?: MemberRole;
        };
        Update: { role?: MemberRole };
        Relationships: [
          {
            foreignKeyName: 'organization_members_org_id_fkey';
            columns: ['org_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
        ];
      };
      contacts: {
        Row: {
          id: string;
          org_id: string;
          phone: string;
          wa_name: string | null;
          name: string | null;
          country: string | null;
          language: string | null;
          budget_usd: number | null;
          customer_stage: CustomerStage;
          quality: CustomerQuality;
          reminder_ack_at: string | null;
          reminder_disabled: boolean;
          destination_port: string | null;
          notes: string | null;
          google_resource_name: string | null;
          google_synced_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          phone: string;
          wa_name?: string | null;
          name?: string | null;
          country?: string | null;
          language?: string | null;
          budget_usd?: number | null;
          customer_stage?: CustomerStage;
          quality?: CustomerQuality;
          reminder_ack_at?: string | null;
          reminder_disabled?: boolean;
          destination_port?: string | null;
          notes?: string | null;
          google_resource_name?: string | null;
          google_synced_at?: string | null;
          created_by?: string | null;
        };
        Update: {
          wa_name?: string | null;
          name?: string | null;
          country?: string | null;
          language?: string | null;
          budget_usd?: number | null;
          customer_stage?: CustomerStage;
          quality?: CustomerQuality;
          reminder_ack_at?: string | null;
          reminder_disabled?: boolean;
          destination_port?: string | null;
          notes?: string | null;
          google_resource_name?: string | null;
          google_synced_at?: string | null;
        };
        Relationships: [];
      };
      contact_tags: {
        Row: { contact_id: string; tag: string; created_at: string };
        Insert: { contact_id: string; tag: string };
        Update: Record<string, never>;
        Relationships: [];
      };
      vehicle_interests: {
        Row: {
          id: string;
          contact_id: string;
          model: string;
          year: number | null;
          condition: VehicleCondition | null;
          steering: VehicleSteering | null;
          target_price_usd: number | null;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          contact_id: string;
          model: string;
          year?: number | null;
          condition?: VehicleCondition | null;
          steering?: VehicleSteering | null;
          target_price_usd?: number | null;
          notes?: string | null;
        };
        Update: {
          model?: string;
          year?: number | null;
          condition?: VehicleCondition | null;
          steering?: VehicleSteering | null;
          target_price_usd?: number | null;
          notes?: string | null;
        };
        Relationships: [];
      };
      vehicles: {
        Row: {
          id: string;
          org_id: string;
          brand: string;
          model: string;
          year: number | null;
          version: string | null;
          vehicle_condition: VehicleCondition;
          fuel_type: FuelType | null;
          steering: VehicleSteering | null;
          base_price: number | null;
          currency: string;
          logistics_cost: number | null;
          sale_status: SaleStatus;
          short_spec: string | null;
          pricing_tiers: PricingTier[];
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          brand: string;
          model: string;
          year?: number | null;
          version?: string | null;
          vehicle_condition?: VehicleCondition;
          fuel_type?: FuelType | null;
          steering?: VehicleSteering | null;
          base_price?: number | null;
          currency?: string;
          logistics_cost?: number | null;
          sale_status?: SaleStatus;
          short_spec?: string | null;
          pricing_tiers?: PricingTier[];
          created_by?: string | null;
        };
        Update: {
          brand?: string;
          model?: string;
          year?: number | null;
          version?: string | null;
          vehicle_condition?: VehicleCondition;
          fuel_type?: FuelType | null;
          steering?: VehicleSteering | null;
          base_price?: number | null;
          currency?: string;
          logistics_cost?: number | null;
          sale_status?: SaleStatus;
          short_spec?: string | null;
          pricing_tiers?: PricingTier[];
        };
        Relationships: [];
      };
      vehicle_media: {
        Row: {
          id: string;
          vehicle_id: string;
          media_type: VehicleMediaType;
          url: string;
          public_id: string | null;
          caption: string | null;
          mime_type: string | null;
          file_size_bytes: number | null;
          sort_order: number;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          vehicle_id: string;
          media_type: VehicleMediaType;
          url: string;
          public_id?: string | null;
          caption?: string | null;
          mime_type?: string | null;
          file_size_bytes?: number | null;
          sort_order?: number;
          created_by?: string | null;
        };
        Update: {
          media_type?: VehicleMediaType;
          url?: string;
          public_id?: string | null;
          caption?: string | null;
          sort_order?: number;
        };
        Relationships: [];
      };
      vehicle_tags: {
        Row: { vehicle_id: string; tag: string; created_at: string };
        Insert: { vehicle_id: string; tag: string };
        Update: Record<string, never>;
        Relationships: [];
      };
      tasks: {
        Row: {
          id: string;
          org_id: string;
          contact_id: string;
          title: string;
          due_at: string | null;
          status: TaskStatus;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          contact_id: string;
          title: string;
          due_at?: string | null;
          status?: TaskStatus;
          created_by?: string | null;
        };
        Update: {
          title?: string;
          contact_id?: string;
          due_at?: string | null;
          status?: TaskStatus;
        };
        Relationships: [];
      };
      contact_events: {
        Row: {
          id: string;
          contact_id: string;
          event_type: ContactEventType;
          payload: Record<string, unknown>;
          created_at: string;
        };
        Insert: {
          id?: string;
          contact_id: string;
          event_type: ContactEventType;
          payload?: Record<string, unknown>;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      quotes: {
        Row: {
          id: string;
          contact_id: string;
          vehicle_model: string;
          price_usd: number;
          sent_at: string | null;
          status: QuoteStatus;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          contact_id: string;
          vehicle_model: string;
          price_usd: number;
          sent_at?: string | null;
          status?: QuoteStatus;
          notes?: string | null;
        };
        Update: {
          vehicle_model?: string;
          price_usd?: number;
          sent_at?: string | null;
          status?: QuoteStatus;
          notes?: string | null;
        };
        Relationships: [];
      };
      gem_templates: {
        Row: {
          id: string;
          org_id: string;
          name: string;
          gem_url: string;
          description: string | null;
          is_default: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          name: string;
          gem_url: string;
          description?: string | null;
          is_default?: boolean;
          created_by?: string | null;
        };
        Update: {
          name?: string;
          gem_url?: string;
          description?: string | null;
          is_default?: boolean;
        };
        Relationships: [];
      };
      gem_conversations: {
        Row: {
          id: string;
          contact_id: string;
          template_id: string;
          gem_chat_url: string;
          last_used_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          contact_id: string;
          template_id: string;
          gem_chat_url: string;
          last_used_at?: string;
        };
        Update: {
          gem_chat_url?: string;
          last_used_at?: string;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          contact_id: string;
          wa_message_id: string;
          direction: MessageDirection;
          text: string;
          sent_at: string | null;
          synced_at: string;
        };
        Insert: {
          id?: string;
          contact_id: string;
          wa_message_id: string;
          direction: MessageDirection;
          text: string;
          sent_at?: string | null;
          synced_at?: string;
        };
        Update: {
          text?: string;
          sent_at?: string | null;
        };
        Relationships: [];
      };
      contact_handlers: {
        Row: {
          contact_id: string;
          user_id: string;
          last_seen_at: string;
        };
        Insert: {
          contact_id: string;
          user_id: string;
          last_seen_at?: string;
        };
        Update: {
          last_seen_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      create_organization: {
        Args: { org_name: string };
        Returns: string;
      };
      is_org_member: {
        Args: { target_org: string };
        Returns: boolean;
      };
      invite_user_to_org: {
        Args: {
          target_email: string;
          target_role?: string;
          target_org?: string;
        };
        Returns: string;
      };
      list_org_members: {
        Args: { target_org: string };
        Returns: Array<{
          user_id: string;
          email: string;
          role: string;
          joined_at: string;
          is_self: boolean;
        }>;
      };
      remove_org_member: {
        Args: { target_user_id: string; target_org: string };
        Returns: string;
      };
      update_org_member_role: {
        Args: {
          target_user_id: string;
          target_org: string;
          new_role: string;
        };
        Returns: string;
      };
    };
  };
}
