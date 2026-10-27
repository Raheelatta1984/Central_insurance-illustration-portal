/** Minimal database port. Real callers adapt a pg client; tests may use embedded Postgres. */
export interface SqlResult<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly T[];
}

export interface SqlConnection {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, parameters?: readonly unknown[],
  ): Promise<SqlResult<T>>;
  /** Execute migration SQL which may contain more than one statement. */
  exec(sql: string): Promise<void>;
  /** Destroy a potentially contaminated connection after an uncertain transaction. */
  release(destroy?: boolean): void;
}

export interface SqlPool {
  connect(): Promise<SqlConnection>;
}
