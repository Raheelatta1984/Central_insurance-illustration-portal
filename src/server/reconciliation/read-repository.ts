import type { SqlConnection, SqlPool } from './sql.js';

const trustedContext = Symbol('trusted reconciliation read context');
export interface TrustedReadContext {
  readonly insurerId: string;
  readonly subjectId: string;
  readonly [trustedContext]: true;
}

function identifier(value: string, description: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 200 || value.includes('\0')) {
    throw new Error(`Invalid ${description}`);
  }
  return value;
}

/**
 * Server-internal boundary only: the caller MUST verify identity and insurer access
 * using a trusted IdP/session before calling. This constructor does not authenticate.
 * Nothing in this slice calls it from HTTP or accepts its values from request headers.
 */
export function trustedReadContext(claims: { insurerId: string; subjectId: string }): TrustedReadContext {
  return Object.freeze({
    insurerId: identifier(claims.insurerId, 'insurer identifier'),
    subjectId: identifier(claims.subjectId, 'subject identifier'),
    [trustedContext]: true as const,
  });
}

export type OwnedResourceKind = 'policy' | 'source_file' | 'reconciliation_run' | 'statement' | 'payment_instruction';
export interface OwnedMetadata {
  readonly insurerId: string;
  readonly resourceId: string;
  readonly channelPartnerId: string;
  readonly subpartnerId: string | null;
  readonly ownerPartnerId: string;
  readonly createdAt: string;
}
export interface ChannelType {
  readonly code: string;
  readonly name: string;
}
export interface SubchannelType extends ChannelType {
  readonly channelTypeCode: string;
}

const resources = new Set<string>(['policy', 'source_file', 'reconciliation_run', 'statement', 'payment_instruction']);
type RoleState = Record<string, unknown> & {
  unsafe_role: boolean;
  owns_table: boolean;
  insecure_table: boolean;
  can_write: boolean;
  private_access: boolean;
};
type OwnedRow = Record<string, unknown> & {
  insurer_id: string; resource_id: string; channel_partner_id: string;
  subpartner_id: string | null; owner_partner_id: string; created_at: Date | string;
};

/** Internal, least-privilege, read-only access to foundation metadata. */
export class ReconciliationReadRepository {
  constructor(private readonly pool: SqlPool) {}

  private async read<T>(context: TrustedReadContext, table: string, operation: (db: SqlConnection) => Promise<T>): Promise<T> {
    if (!context || context[trustedContext] !== true) throw new Error('Trusted read context required');
    const db = await this.pool.connect();
    let discard = false;
    try {
      await db.exec('BEGIN READ ONLY');
      // Settings last only for this transaction. Never trust client-supplied SQL settings.
      await db.query('SELECT set_config($1, $2, true), set_config($3, $4, true)', [
        'reconciliation.insurer_id', context.insurerId, 'reconciliation.subject_id', context.subjectId,
      ]);
      const { rows } = await db.query<RoleState>(`
        SELECT (r.rolsuper OR r.rolbypassrls) AS unsafe_role,
          pg_has_role(r.oid, c.relowner, 'MEMBER') AS owns_table,
          (NOT c.relrowsecurity OR NOT c.relforcerowsecurity) AS insecure_table,
          has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_write,
          has_schema_privilege(r.oid, private_schema.oid, 'USAGE') AS private_access
        FROM pg_catalog.pg_roles r
        JOIN pg_catalog.pg_class c ON c.relname = $1 AND c.relkind = 'r'
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'reconciliation'
        JOIN pg_catalog.pg_namespace private_schema ON private_schema.nspname = 'reconciliation_private'
        WHERE r.rolname = current_user
      `, [table]);
      const role = rows[0];
      if (!role || role.unsafe_role || role.owns_table || role.insecure_table || role.can_write || role.private_access) {
        throw new Error('Reconciliation reader role or RLS is not safely configured');
      }
      const result = await operation(db);
      await db.exec('COMMIT');
      return result;
    } catch (error) {
      try { await db.exec('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally {
      db.release(discard);
    }
  }

  async findOwned(context: TrustedReadContext, kind: OwnedResourceKind, resourceId: string): Promise<OwnedMetadata | null> {
    if (!resources.has(kind)) throw new Error('Unknown owned resource kind');
    identifier(resourceId, 'resource identifier');
    return this.read(context, kind, async (db) => {
      // kind is an internal allowlist, never raw SQL. RLS AND an explicit predicate
      // must agree; neither protects against a compromised application server.
      const { rows } = await db.query<OwnedRow>(`
        SELECT insurer_id, resource_id, channel_partner_id, subpartner_id, owner_partner_id, created_at
        FROM reconciliation.${kind}
        WHERE insurer_id = $1 AND resource_id = $2
          AND reconciliation.can_view(insurer_id, channel_partner_id, owner_partner_id)
      `, [context.insurerId, resourceId]);
      const row = rows[0];
      return row ? {
        insurerId: row.insurer_id, resourceId: row.resource_id,
        channelPartnerId: row.channel_partner_id, subpartnerId: row.subpartner_id,
        ownerPartnerId: row.owner_partner_id, createdAt: new Date(row.created_at).toISOString(),
      } : null;
    });
  }

  async listChannelTypes(context: TrustedReadContext): Promise<ChannelType[]> {
    return this.read(context, 'channel_type', async (db) => {
      const { rows } = await db.query<Record<string, unknown> & { code: string; name: string }>(`
        SELECT code, name FROM reconciliation.channel_type
        WHERE insurer_id = $1 AND reconciliation.can_access_insurer(insurer_id) ORDER BY code
      `, [context.insurerId]);
      return rows.map(({ code, name }) => ({ code, name }));
    });
  }

  async listSubchannelTypes(context: TrustedReadContext): Promise<SubchannelType[]> {
    return this.read(context, 'subchannel_type', async (db) => {
      const { rows } = await db.query<Record<string, unknown> & { code: string; name: string; channel_type_code: string }>(`
        SELECT code, name, channel_type_code FROM reconciliation.subchannel_type
        WHERE insurer_id = $1 AND reconciliation.can_access_insurer(insurer_id) ORDER BY channel_type_code, code
      `, [context.insurerId]);
      return rows.map(({ code, name, channel_type_code }) => ({ code, name, channelTypeCode: channel_type_code }));
    });
  }
}
