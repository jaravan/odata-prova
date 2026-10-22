// Persistence in a PostgreSQL database, through pg (imported on the first load, so a server
// without it never loads it), which several servers can share: replicas of one service,
// behind a load balancer. The rows' layout is the SQLite file's (see sqlite.ts), with the
// service's name on every row, so several services can keep their data in one database too:
// the tables odata_prova_meta, odata_prova_sets, odata_prova_rows and odata_prova_log, in the
// connection's search_path (another schema: ?options=-c%20search_path%3Dmyschema in the URL).
//
// Each server keeps the whole state in memory, and catches up with the others before every
// request (see sharedTurn in persistence.ts):
// - The log holds every commit, numbered, with an id: each server knows the latest it has, and
//   reads the ones after it. When the one it has isn't there any more, as it applied it, the
//   state isn't the one it has: further behind than the log goes back, replaced (a reset, an
//   adapted metadata.xml), emptied and seeded anew, restored from a backup. It loads it all
//   again. With the tables gone, it can't: it has to restart (see LostError).
// - A commit is saved under the service's lock, and only if no other server saved since this
//   one's latest: otherwise it's refused (StaleError), and the request runs again, caught up.
// - A turn that may write takes the same lock first, and keeps it to its end.
// No server owns the service, so a connection that's lost is simply opened again.
//
// Nothing waits without end: a write waits LOCK_TIMEOUT for the others' at most, then answers
// 503; a connection CONNECT_TIMEOUT, so a database out of reach is a 503 at once; a query
// QUERY_TIMEOUT. A server that vanishes without closing its connection (its node
// or network gone) holds a turn's lock until PostgreSQL notices, which keepalives make about
// half a minute, rather than the operating system's two hours.

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Row } from "./model.ts";
import { HttpError } from "./query.ts";
import {
  toJson,
  fromJson,
  LostError,
  StaleError,
  type News,
  type Persistence,
  type Saved,
  type SetChanges,
  type Shape,
} from "./persistence.ts";

// The layout of the tables; a service saved in another one isn't read
const FORMAT = "1";

// The advisory locks' key: odata-prova's, then the service's
const LOCK = "odata-prova";

// Rows per statement, in a write or a delete: a first state can hold a lot of them
const CHUNK = 5000;

// How many of the latest commits the log keeps
const KEEP = 1000;

// How long a write waits for the service's lock, in ms: other servers' writes hold it a few
// ms each
const LOCK_TIMEOUT = 5000;

// How long getting a connection may take, in ms
const CONNECT_TIMEOUT = 5000;

// How long a query may take, in ms, on the database and waiting for its answer
const QUERY_TIMEOUT = 30_000;

// What a connection that can't be had, or was lost, fails with: the database is out of reach
const UNREACHABLE = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

// How soon a connection that's gone quiet is checked, then how often, and how many checks it
// fails before it's closed, on both ends (in s): a minute at most
const KEEPALIVE = { idle: 10, interval: 5, count: 3 };

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK)
    out.push(items.slice(i, i + CHUNK));
  return out;
}

const isPostgresUrl = (text: string) => /^postgres(ql)?:\/\//i.test(text);

// The URL without its password and parameters, which can hold secrets: for the log and errors
function redact(url: string): string {
  try {
    const u = new URL(url);
    u.password = "";
    u.search = "";
    return u.toString();
  } catch {
    return "the database";
  }
}

// Clients with an error listener: without one, a connection lost while checked out would end
// the process
const listened = new WeakSet<PoolClient>();

class PostgresPersistence implements Persistence {
  url: string;
  service: string;
  name: string;
  private pool: Pool | undefined;
  // The connection holding the service's lock, from lock() to unlock(): the turn's queries go
  // through it
  private locked: PoolClient | undefined;
  // The latest commit this server has: loaded, caught up with, or its own; and its id
  private version = 0;
  private id = "";
  private keep: number;
  private lockTimeout: number;
  private connectTimeout: number;

  // service: whose rows these are, in a database other services may keep theirs in too.
  // keep: how many of the latest commits the log keeps; lockTimeout and connectTimeout: see
  // LOCK_TIMEOUT and CONNECT_TIMEOUT
  constructor(
    url: string,
    service: string,
    {
      keep = KEEP,
      lockTimeout = LOCK_TIMEOUT,
      connectTimeout = CONNECT_TIMEOUT,
    } = {},
  ) {
    this.url = url;
    this.service = service;
    this.name = `${redact(url)} (as ${service})`;
    this.keep = keep;
    this.lockTimeout = lockTimeout;
    this.connectTimeout = connectTimeout;
  }

  // Connects, creates the tables if there are none, and reads what the service saved
  async load(): Promise<Saved | undefined> {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: this.url,
      connectionTimeoutMillis: this.connectTimeout,
      lock_timeout: this.lockTimeout,
      statement_timeout: QUERY_TIMEOUT,
      query_timeout: QUERY_TIMEOUT,
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE.idle * 1000,
    });
    // A connection lost while idle is replaced at the next query; without a listener, its
    // error would end the process
    pool.on("error", () => {});
    // PostgreSQL's end of each connection checks the server too: else a turn's lock outlives
    // a server gone without a word for hours. Sent before the connection's first query.
    pool.on("connect", (client) => {
      client
        .query(
          `SET tcp_keepalives_idle = ${KEEPALIVE.idle};
           SET tcp_keepalives_interval = ${KEEPALIVE.interval};
           SET tcp_keepalives_count = ${KEEPALIVE.count}`,
        )
        .catch(() => {});
    });
    this.pool = pool;
    try {
      await this.transaction(async (client) => {
        // Servers starting at once would each create the tables, and all but one fail
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          LOCK,
        ]);
        await client.query(`
          CREATE TABLE IF NOT EXISTS odata_prova_meta (
            service TEXT NOT NULL,
            name TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (service, name)
          );
          CREATE TABLE IF NOT EXISTS odata_prova_rows (
            service TEXT NOT NULL,
            set_name TEXT NOT NULL,
            key TEXT NOT NULL,
            seq BIGINT NOT NULL,
            data JSON NOT NULL,
            PRIMARY KEY (service, set_name, key)
          );
          CREATE INDEX IF NOT EXISTS odata_prova_rows_order
            ON odata_prova_rows (service, set_name, seq);
          CREATE TABLE IF NOT EXISTS odata_prova_sets (
            service TEXT NOT NULL,
            set_name TEXT NOT NULL,
            PRIMARY KEY (service, set_name)
          );
          CREATE TABLE IF NOT EXISTS odata_prova_log (
            service TEXT NOT NULL,
            version BIGINT NOT NULL,
            id TEXT NOT NULL,
            changes TEXT,
            PRIMARY KEY (service, version)
          );
        `);
      });
    } catch (e) {
      await this.close();
      throw new Error(
        `cannot connect to ${redact(this.url)}: ${(e as Error).message}`,
        { cause: e },
      );
    }
    try {
      return await this.snapshot();
    } catch (e) {
      await this.close();
      throw e;
    }
  }

  // What the other servers saved since this one's latest commit
  async since(): Promise<News> {
    try {
      // This server's latest commit, and the ones after it
      const { rows } = await this.query<{
        version: string;
        id: string;
        changes: string | null;
      }>(
        `SELECT version, id, changes FROM odata_prova_log
         WHERE service = $1 AND version >= $2 ORDER BY version`,
        [this.service, this.version],
      );
      const mine = this.version ? rows.shift() : undefined;
      // Not the state this server has any more (see the top), further behind than the log
      // goes back, or one replaced: all of it again
      if (
        (this.version &&
          (Number(mine?.version) !== this.version || mine?.id !== this.id)) ||
        (rows.length && Number(rows[0].version) !== this.version + 1) ||
        rows.some((r) => r.changes === null)
      ) {
        const state = await this.snapshot();
        if (!state) throw new LostError(`${this.name} has none any more`);
        return { state };
      }
      if (rows.length) {
        this.version = Number(rows.at(-1)!.version);
        this.id = rows.at(-1)!.id;
      }
      return { changes: rows.map((r) => fromJson<SetChanges[]>(r.changes!)) };
    } catch (e) {
      throw this.failure(e);
    }
  }

  // One database transaction: a commit's deletes, then its writes
  commit(changes: SetChanges[]): Promise<void> {
    return this.save(changes);
  }

  // One database transaction too: all the service had saved goes, these rows and shape come.
  // The other servers load it all again.
  replace(changes: SetChanges[], shape: Shape): Promise<void> {
    return this.save(changes, shape);
  }

  async lock(): Promise<void> {
    const client = await this.connect().catch((e: unknown) => {
      throw this.failure(e);
    });
    try {
      await client.query(
        "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
        [LOCK, this.service],
      );
    } catch (e) {
      client.release(e as Error);
      throw this.failure(e);
    }
    this.locked = client;
  }

  async unlock(): Promise<void> {
    const client = this.locked;
    this.locked = undefined;
    if (!client) return;
    try {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
        [LOCK, this.service],
      );
      client.release();
    } catch (e) {
      // Its connection ends, and the lock with it
      client.release(e as Error);
    }
  }

  async close(): Promise<void> {
    await this.unlock();
    const pool = this.pool;
    this.pool = undefined;
    await pool?.end();
  }

  // Every set's rows as the database holds them, in their order: for tests, and an export
  state(): Promise<Record<string, Row[]>> {
    return this.withClient((client) => this.rows(client));
  }

  private async save(changes: SetChanges[], shape?: Shape): Promise<void> {
    const service = this.service;
    const id = randomUUID();
    const version = await this.transaction(async (client) => {
      // Re-entrant: a turn that may write holds it already
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [LOCK, service],
      );
      // The latest commit has to be this server's: else another saved since, or the state
      // isn't the one this server has any more (see since)
      const { rows } = await client.query<{ version: string; id: string }>(
        `SELECT version, id FROM odata_prova_log WHERE service = $1
         ORDER BY version DESC LIMIT 1`,
        [service],
      );
      const [latest] = rows;
      if (
        latest
          ? Number(latest.version) !== this.version || latest.id !== this.id
          : this.version !== 0
      )
        throw new StaleError();
      if (shape) {
        await client.query("DELETE FROM odata_prova_rows WHERE service = $1", [
          service,
        ]);
        await client.query("DELETE FROM odata_prova_sets WHERE service = $1", [
          service,
        ]);
        await client.query(
          `INSERT INTO odata_prova_meta (service, name, value) VALUES ($1, 'shape', $2)
           ON CONFLICT (service, name) DO UPDATE SET value = excluded.value`,
          [service, JSON.stringify(shape)],
        );
      }
      // A set with no rows leaves no trace in rows, yet its being empty is state: without it,
      // a set whose rows were all deleted would get its seeded rows back on a restart
      if (changes.length)
        await client.query(
          `INSERT INTO odata_prova_sets (service, set_name)
           SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
          [service, changes.map(({ set }) => set)],
        );
      for (const { set, deleted } of changes)
        for (const keys of chunks(deleted))
          await client.query(
            `DELETE FROM odata_prova_rows
             WHERE service = $1 AND set_name = $2 AND key = ANY($3::text[])`,
            [service, set, keys],
          );
      // A new row goes after the set's others, in the order written; an existing one keeps its
      // seq, as it keeps its place in memory
      for (const { set, written } of changes)
        for (const part of chunks(written))
          await client.query(
            `INSERT INTO odata_prova_rows (service, set_name, key, seq, data)
             SELECT $1, $2, w.key,
               (SELECT coalesce(max(seq), 0) FROM odata_prova_rows
                WHERE service = $1 AND set_name = $2) + w.n,
               w.data::json
             FROM unnest($3::text[], $4::text[]) WITH ORDINALITY AS w(key, data, n)
             ON CONFLICT (service, set_name, key) DO UPDATE SET data = excluded.data`,
            [
              service,
              set,
              part.map(({ key }) => key),
              part.map(({ row }) => toJson(row)),
            ],
          );
      await client.query(
        `INSERT INTO odata_prova_meta (service, name, value) VALUES ($1, 'format', $2)
         ON CONFLICT DO NOTHING`,
        [service, FORMAT],
      );
      // A replaced state has no changes to catch up with: the others load it all (see since)
      const next = this.version + 1;
      await client.query(
        "INSERT INTO odata_prova_log (service, version, id, changes) VALUES ($1, $2, $3, $4)",
        [service, next, id, shape ? null : toJson(changes)],
      );
      await client.query(
        "DELETE FROM odata_prova_log WHERE service = $1 AND version <= $2",
        [service, next - this.keep],
      );
      return next;
    }).catch((e: unknown) => {
      throw this.failure(e);
    });
    this.version = version;
    this.id = id;
  }

  // What a failed query answers, other than a 500:
  // - a lock not had within lockTimeout (lock_not_available): the other servers' writes held
  //   it, or one gone without a word does, until PostgreSQL notices: a 503, to send again
  // - a connection that can't be had, or was lost: a 503 too, until the database is back
  // - tables that are gone (undefined_table): the state is lost (see LostError)
  private failure(e: unknown): unknown {
    const { code = "", message = "" } = e as {
      code?: string;
      message?: string;
    };
    if (code === "55P03")
      return new HttpError(
        503,
        `The other servers' writes held the saved state for more than ${this.lockTimeout / 1000}s: send the request again`,
      );
    if (code === "42P01")
      return new LostError(`${this.name} has no tables any more`);
    if (
      /^(08|57P0)/.test(code) ||
      UNREACHABLE.has(code) ||
      /connection terminated|timeout exceeded when trying to connect|query read timeout/i.test(
        message,
      )
    )
      return new HttpError(
        503,
        `The database can't be reached: ${message || code}`,
      );
    return e;
  }

  // What the service saved, as one moment saw it, and the latest commit that includes;
  // undefined when it saved nothing yet
  private snapshot(): Promise<Saved | undefined> {
    return this.withClient(async (client) => {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        const meta = await client.query<{ name: string; value: string }>(
          "SELECT name, value FROM odata_prova_meta WHERE service = $1",
          [this.service],
        );
        const values = new Map(meta.rows.map((r) => [r.name, r.value]));
        const { rows } = await client.query<{ version: string; id: string }>(
          `SELECT version, id FROM odata_prova_log WHERE service = $1
           ORDER BY version DESC LIMIT 1`,
          [this.service],
        );
        this.version = rows[0] ? Number(rows[0].version) : 0;
        this.id = rows[0]?.id ?? "";
        const format = values.get("format");
        // No state saved yet: the first commit saves one
        if (format === undefined) return undefined;
        if (format !== FORMAT)
          throw new Error(
            `${this.name} has format ${format}, this version reads ${FORMAT}`,
          );
        const shape = values.get("shape");
        return {
          state: await this.rows(client),
          shape: shape === undefined ? undefined : (JSON.parse(shape) as Shape),
        };
      } finally {
        await client.query("COMMIT");
      }
    });
  }

  private async rows(client: PoolClient): Promise<Record<string, Row[]>> {
    const sets = await client.query<{ set_name: string }>(
      "SELECT set_name FROM odata_prova_sets WHERE service = $1",
      [this.service],
    );
    const state: Record<string, Row[]> = Object.fromEntries(
      sets.rows.map(({ set_name }) => [set_name, []]),
    );
    // As text: pg would parse JSON itself, without fromJson's INF and NaN
    const rows = await client.query<{ set_name: string; data: string }>(
      `SELECT set_name, data::text AS data FROM odata_prova_rows
       WHERE service = $1 ORDER BY set_name, seq`,
      [this.service],
    );
    for (const { set_name, data } of rows.rows)
      state[set_name].push(fromJson(data));
    return state;
  }

  // fn in a database transaction: committed when it returns, rolled back when it throws
  private transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      }
    });
  }

  private query<R extends object>(text: string, values: unknown[]) {
    return this.withClient((client) => client.query<R>(text, values));
  }

  // fn on the connection holding the lock, or one of the pool's for its while
  private async withClient<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (this.locked) return fn(this.locked);
    const client = await this.connect();
    try {
      const result = await fn(client);
      client.release();
      return result;
    } catch (e) {
      // A connection that failed isn't given out again
      client.release(e instanceof StaleError ? undefined : (e as Error));
      throw e;
    }
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool) throw new Error(`${this.name} is not open`);
    const client = await this.pool.connect();
    if (!listened.has(client)) {
      client.on("error", () => {});
      listened.add(client);
    }
    return client;
  }
}

export { PostgresPersistence, isPostgresUrl, redact };
