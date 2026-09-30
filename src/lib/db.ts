import { AsyncLocalStorage } from 'node:async_hooks';
import postgres from 'postgres';
import { SUPABASE_ROOT_CA } from './supabase-ca';

export type Row = Record<string, unknown>;
// The smallest surface both drivers share: postgres.js in production, PGlite (in-process Postgres) in tests.
export interface Driver {
  query(text: string, params: unknown[]): Promise<{ rows: Row[]; count: number }>;
  begin<T>(fn: (tx: Driver) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

// SQL is written with `?` placeholders (no literal `?` inside statements); they become $1..$n here.
const numbered = (sql: string) => { let i = 0; return sql.replace(/\?/g, () => '$' + ++i); };

// Inside transaction(), every query from the same async flow runs on the transaction's connection, so Store
// methods can call each other (user -> credit -> ledger) without passing a handle around. Nested calls join it.
export class Db {
  private tx = new AsyncLocalStorage<Driver>();
  constructor(private driver: Driver) {}
  private current() { return this.tx.getStore() ?? this.driver; }
  async all<T = Row>(sql: string, ...params: unknown[]) { return (await this.current().query(numbered(sql), params)).rows as T[]; }
  async get<T = Row>(sql: string, ...params: unknown[]): Promise<T | undefined> { return (await this.all<T>(sql, ...params))[0]; }
  // Returns the number of affected rows: the conditional UPDATE/INSERT "claims" rely on it.
  async run(sql: string, ...params: unknown[]) { return (await this.current().query(numbered(sql), params)).count; }
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.tx.getStore()) return fn();
    return this.driver.begin(tx => this.tx.run(tx, fn));
  }
  end() { return this.driver.end(); }
}

// Supabase through its transaction pooler (IPv4, serverless-friendly): no prepared statements in that mode.
export function pgDriver(url: string): Driver {
  const sql = postgres(url, {
    prepare: false, max: 5, idle_timeout: 20, connect_timeout: 10,
    ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true }, // verify the server certificate and host name (plain 'require' does not)
    types: { int8: { to: 20, from: [20], serialize: String, parse: Number } }, // counts and epoch ms fit a JS number
  });
  const wrap = (s: postgres.Sql | postgres.TransactionSql): Driver => ({
    async query(text, params) {
      const result = await s.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
      return { rows: [...result] as Row[], count: result.count };
    },
    begin: fn => s === sql ? sql.begin(tx => fn(wrap(tx))) as Promise<never> : fn(wrap(s)),
    end: () => sql.end(),
  });
  return wrap(sql);
}
