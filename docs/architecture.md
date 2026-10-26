# Architecture

```mermaid
flowchart LR
    subgraph Startup["Startup - runs once, at boot"]
        MX["metadata.xml"] --> PM["parseMetadata()"]
        PM --> MODEL[("model")]
        SEED["data/*.csv, *.json<br/>or generate.ts"]
    end

    ST[("Store")]
    MODEL --> ST
    SEED --> ST

    subgraph Request["Per request - runs on every HTTP call"]
        direction LR
        REQ(["HTTP request"]) --> APP["app.ts (Express)"]
        APP -- "POST .../$batch" --> BATCH["batch.ts"] --> SVC
        APP -- "everything else" --> SVC["ODataService.dispatch()<br/>+ dispatch.ts"]
        SVC -- "$filter, $orderby, $expand..." --> QF["query.ts, filter.ts<br/>+ apply-query.ts"]
        SVC -- "create, update, delete, links" --> WR["writes.ts<br/>+ references.ts"]
        SVC -- "actions, functions" --> OPS["operations.ts"]
        SVC -- "parse/serialize" --> PROTO["protocol module<br/>(v2.ts or v4.ts)"]
        PROTO --> RES(["HTTP response"])
    end

    MODEL --> SVC
    SVC -- "read/write rows" --> ST
```

One model, parsed once at startup, backs a V2 service and a V4 service. Both share the same in-memory `Store`.

- **Each protocol module** only knows how its own wire format looks: literals, JSON envelope, query option names.
- **`dispatch.ts`** walks the resource path and follows navigations, whatever the protocol, and hands each part of the work to its own module.
- **`service.ts`** keeps what they all share: the model's lookups, navigations, and a collection's response.

| Module                                                                           | What it does                                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `app.ts`, `batch.ts`                                                             | the Express app: routes, CORS, `$batch`, errors outside the service                  |
| `service.ts`, `dispatch.ts`                                                      | a request from its path to its answer                                                |
| `protocol.ts`, `protocols/v2.ts`, `protocols/v4.ts`                              | each protocol's literals, query options and responses                                |
| `metadata.ts`, `navigations.ts`, `operation-views.ts`                            | reading `metadata.xml` into the model                                                |
| `emit.ts`, `emit-v2.ts`, `emit-v4.ts`, `annotations-v2.ts`, `sap-annotations.ts` | the `$metadata` of the protocol the document wasn't written in                       |
| `resource-path.ts`, `query.ts`                                                   | the path and its keys, the query options                                             |
| `filter.ts`, `apply-query.ts`, `compute.ts`                                      | `$filter`, `$orderby`, `$search`, `$top`, `$skip`; `$compute`                        |
| `apply-parse.ts`, `aggregation.ts`, `aggregates.ts`, `hierarchy.ts`              | `$apply`: parsing, running, aggregate values, hierarchies                            |
| `paging.ts`, `delta.ts`                                                          | server-driven paging, delta links                                                    |
| `writes.ts`, `references.ts`, `links.ts`                                         | creates, updates, deletes; links between entities; link sets                         |
| `operations.ts`, `draft.ts`, `etag.ts`                                           | actions and functions, drafts, ETags                                                 |
| `store.ts`, `generate.ts`, `mock-data.ts`                                        | the rows and their transactions; data files, generated mock data                     |
| `config.ts`, `mock-rules.ts`, `sap-fields.ts`, `explain.ts`, `live-rules.ts`     | `config.json` and its mock rules, SAP's field names, `--explain`, rules changed live |
| `queue.ts`, `persistence.ts`, `sqlite.ts`, `postgres.ts`                         | requests one at a time; saving the data, in a SQLite file or PostgreSQL              |
| `types.ts`, `model.ts`                                                           | Edm values, the model's types                                                        |

The sources are TypeScript, in `lib/`, and `model.ts` describes the model they all share. `yarn build` compiles them to `dist/`, which is what the npm package and the Docker image run. The tests run on the sources directly (Node 22.18 or later strips the types).

## Writes and transactions

The `Store` is the only thing that changes rows. Every change goes through `store.insert`, `store.update` or `store.remove`.

The rows are private to it. `rows()` and `lookup()` hand them out as read-only arrays, so a `push` or `splice` from outside is a compile error.

Rows change in place: a module keeps the row object it found, and sees what the store writes into it.

Each change made inside a transaction is logged with what it takes to undo it, and a rollback replays the log backwards:

```ts
const mark = store.begin();
try {
  // ... changes through the store
  store.commit(mark);
} catch (e) {
  store.rollback(mark);
  throw e;
}
```

- **Every request is a transaction.** `ODataService.execute()` begins one. It commits it when the request succeeds, and rolls it back when the request throws or its response is a status of 400 or more. So a request that fails leaves the data as it found it, whatever it had changed before failing. A handler that changes rows and then answers with an error loses those changes, by design.
- **Transactions nest.**
  - A `$batch` changeset is one, and each of its requests one inside it, so a failing request rolls back the whole changeset.
  - A draft action (`draft.ts` `atomic()`) and a deep insert (`writes.ts` `create`) are one inside their request's.
  - An inner rollback undoes only its own changes. An inner commit keeps them for the outer transaction to keep or undo.
- **Only the logged changes are undone.** Nothing is copied: the log holds the rows and the old values of the fields that changed, so a transaction costs what it touches, not what the store holds.
- **Navigations use an index.** `store.lookup()` finds the rows of a set whose columns hold given values, for `related()` and `$expand`. Its index is built on first use. The store drops it whenever a change could make it wrong. It can tell, because every change goes through it.

**A change that bypasses the store** (`row.X = ...` on a row of the store) compiles, but escapes rollback and persistence. The tests catch it: `test/helpers.ts` turns on `store.audit`. At the end of every transaction, it checks that undoing the log gives back the data as the transaction found it.

New code that changes a row uses `store.update(setName, row, changes)`.

## Persistence

With `--persist` (or `persist` in code), the data is saved to a SQLite file, or a PostgreSQL database, so writes survive a restart.

The store in memory still answers every request. The file or database only keeps its state: loaded whole at startup, and written after every change. Queries never read from it.

### Why the data is in memory

- **No database is the main case.** `npx odata-prova ./MySrv`, CI and demos need only a `metadata.xml` and data files. The store was in memory first; persistence keeps it across restarts, and doesn't replace it.
- **The schema is the metadata's.** Any `metadata.xml` brings its own entity types, keys, complex and enum types, collections and inheritance, and may change at any time. Rows in memory take any shape. In a database they'd need tables generated from the metadata, and a migration whenever it changes: that's why the database keeps rows as JSON documents, which it can't query as the store does.
- **Queries would be written twice.** `$filter` (with `any` and `all`), `$expand` with nested options, `$apply` and hierarchies, `$search`, `$compute`, drafts and delta links all run in JavaScript over the rows. In SQL they'd have to be translated for SQLite and PostgreSQL, and still give the same results as without a database, despite the differences in null ordering, collation, decimals and dates. Every later feature would be written twice too.
- **Rollback is an undo log.** A failed request, `$batch` changeset or draft action undoes what it changed in memory, synchronously (see [Writes and transactions](#writes-and-transactions)).
- **A mock's data fits.** Hundreds to thousands of rows per set: a query over them takes well under a millisecond, and loading them at startup is cheap.

**What it costs.** Memory and startup grow with the data: 50,000 rows in one set and 200,000 in another take about 370 MB, and a start loads all of them. With replicas (see [The database, and replicas](#the-database-and-replicas)), each server holds all the data: the memory is paid once per server, and a new one loads everything before it answers.

**When to revisit.** If services of 100,000 rows or more, served by several replicas each, become common, or a service has to be read from a database's own tables, the database should answer the queries. That would replace the store, the persistence backends and the replicas' catching up. The OData parsing, the V2 and V4 metadata, and the protocols' output stay.

### How a write is saved

- **The net change per row.** The outermost transaction's log (see above) is reduced to what the file needs: each row written once, as it ends up, and the rows deleted. A row inserted and removed again in one transaction is nothing. That's `netChanges()` in `persistence.ts`.
- **Rows by identity.** An entity's keys, with a contained entity's parent's keys too; a link's columns; a draft's `DraftUUID`.
- **Saved before it's answered.** `persistence.commit()` writes the changes in one database transaction. Until it succeeds, the store holds them (`store.commit()`, then `store.settle()`). If it fails, they're undone with the same log, and the request answers `500`. Memory and the file never disagree.
- **One request at a time.** Saving is async. While one request's changes are being saved, another must not see them, since they may yet be undone. So `queue.ts` runs the requests of every service on a store one at a time, each after the one before it has been saved.
- **Reads wait too,** because a GET can write: a function with a `config.json` rule. They wait only while a save runs, about a millisecond with SQLite.
- **A `$batch`** takes one turn for all its parts. A changeset is saved once, at its end.

### Startup and shutdown

- **`ready`.** `createApp()` stays synchronous, and returns `ready` with the app. The queue starts behind it, so a request that arrives early waits.
- **The first start** saves the seeded state to the file. **Later starts** replace the seeded state with the saved one.
- **A state that can't be loaded** makes `ready` reject, and every request answers `503`. `server.ts` exits instead of listening.
- **A changed `metadata.xml`.** The file keeps the shape of the rows it holds, next to them: per set, its identity columns and each property's type. When that shape differs from the model's, the saved rows are adapted (a removed property dropped, a new one empty, a changed type converted), the change logged, and the adapted state saved. Changed identity columns would make the rows other rows, so the start is refused, pointing at `--persist-reset`.
- **Changed mock rules.** With the shape, the file keeps a fingerprint (a hash) of each generated set's rows, while no write has changed them, and the mock rules. A later start generates those sets again on the saved state (`Store.regenerate`), and replaces the ones that come out different, so a change to the rules, to `--mock-rows` or to the generator shows. A set whose rows no longer match their fingerprint has writes, and is kept. A fingerprint rather than a flag cleared on a set's first commit: nothing on the commit path changes, and replicas need nothing new.
- **`close()`** waits for the requests in the queue, their saves included, then closes the file. `server.ts` calls it on SIGTERM.
- **`SHUTDOWN_DELAY`** (ms): how long `server.ts` keeps answering after SIGTERM, before it stops taking connections. Meanwhile each response has `Connection: close`, so clients reconnect elsewhere. A load balancer takes a few seconds to stop sending requests to a server that's stopping, and those would otherwise fail. 5000 in Kubernetes (`KUBERNETES_SERVICE_HOST` is set), 0 elsewhere.

### The file

`sqlite.ts` uses `node:sqlite`, which is built into Node, and imports it only when `--persist` is used.

- One table holds every set's rows, by set and identity. Each row is the JSON of the row as memory holds it, with a sequence number that keeps the order across a restart.
- Rows are documents rather than typed columns, so a `metadata.xml` that changes all the time isn't a schema migration each time.
- `INF`, `-INF` and `NaN`, which JSON can't hold, are written `{"$float": "INF"}`.
- The file is locked while a server has it open: one server per file.

### The database, and replicas

`postgres.ts` keeps the same layout in PostgreSQL, through `pg`, imported only when `--persist` is a `postgres://` URL. Several servers can share it: replicas of one service. Each still answers from the store in memory, so queries don't change.

- **The log.** `odata_prova_log` holds every commit of a service, numbered, as the net changes it saved. A server knows the latest it has.
- **Catching up.** Before every request, `sharedTurn()` in `persistence.ts` asks for the commits after that one. It applies them to the store through `store.insert`, `update` and `removeRow`, in a transaction of their own, settled at once. Each commit has an id too, and a server checks that its latest is still there, as it applied it. When it isn't, the saved state is no longer the one the server has. It may be further behind than the log goes back (it keeps the latest 1000), replaced (a reset, an adapted `metadata.xml`), emptied and seeded anew, or restored from a backup, even one that's as many commits ahead. The server then loads the whole state again.
- **A commit is saved only if it's caught up.** Under the service's advisory lock, it checks that the log's latest is the server's own. Otherwise it's refused with `StaleError`, and the store's changes are undone as for any failed save.
- **A turn that may write takes the lock first**, and keeps it to its end. The other servers' commits wait, so its own can't be refused, and a `$batch`'s changesets are saved as they run. That's every request but a `GET`.
- **A `GET` doesn't take it.** If one writes after all (a function with a rule) and is refused, it runs again, caught up, up to three times. Running a request again is safe: it changes nothing but the store, and that was undone.
- **Starting.** Servers starting at once on nothing saved each seed the store, and try to save it: the first wins, and the others load its state. The same when they adapt a state, or regenerate its generated sets, at once. A server whose `metadata.xml` isn't the one the state was saved from answers `503`, until it restarts and adapts the state to its own.
- **The pool.** No server owns the service, so a lost connection is replaced at the next query. A turn's queries go through the connection holding its lock.
- **The state lost.** With the tables gone, there's nothing to load. Requests answer `503` (`LostError`), and `/healthz` fails from then on, so a liveness probe restarts the server, which seeds the state anew. A state saved from another `metadata.xml` doesn't fail `/healthz`: a restarted old server would adapt the state back to its own, and the new ones would then adapt it to theirs.
- **Nothing waits without end.** A wait for the lock gives up after 5 seconds (`lock_timeout`), a wait for a connection after 5 (a database out of reach), and a query after 30. All answer `503`. Keepalives on both ends of each connection make PostgreSQL notice a server gone without closing it (its node or network down) in about half a minute, and free the lock it held. `queue.ts` also answers `503`, without running it, to a request that waited over 30 seconds for its turn. Under more load than the servers can take, they shed requests rather than fall further behind.
- Rows are `json`, not `jsonb`, which would reorder their fields, and are read back as text, for `INF` and `NaN`.

A backend has `load()`, `commit(changes)`, `replace(changes, shape)` and `close()`. One that replicas share also has `since()`, `lock()` and `unlock()`: see `Persistence` in `persistence.ts`. `test/shared.test.ts` runs replicas on a shared database in memory. The tests run every kind of write against SQLite and an in-memory backend, and check after each request that what's saved is what the store holds. With `POSTGRES_URL` set, against PostgreSQL too: CI has one, and `yarn test:postgres` starts one in Docker.

## Using it in code

The package exports the Express app, with its TypeScript types, so you can start it from a test or mount it in your own server:

```js
import { createApp } from "odata-prova";

const { app } = createApp({
  modelDir: "./MySrv",
  v2Path: "/odata/v2/MySrv", // a falsy path disables that protocol
  v4Path: "/odata/v4/MySrv",
  mockRows: 20, // default 0: only the data files
  etags: "strict", // default "lenient", see docs/odata-support.md#etags
  joins: "strict", // default "guess", see docs/odata-support.md#navigations-without-a-referentialconstraint
  pageSize: 100, // default 0: every row, see docs/odata-support.md#server-driven-paging
});
app.listen(3000);
```

To keep the data in a file or a database, as `--persist` does, pass `persist`.

- Wait for `ready` before serving. It settles once the saved state is loaded, or the first one saved, and rejects when it can't be.
- `close()` waits for the requests being answered, and their saves, then closes the file.

```js
const { app, ready, close } = createApp({
  modelDir: "./MySrv",
  v4Path: "/odata/v4/MySrv",
  persist: "./MySrv.db", // a SQLite file, created if there's none
  persistReset: false, // true: start over from the data files and mock rows
  // persist: "postgres://user:password@db/mocks", // or a database
  // serviceName: "MySrv", // whose rows they are there, default the model folder's
});
await ready;
const server = app.listen(3000);
process.once("SIGTERM", () => server.close(() => void close()));
```

That is the package's whole API: `odata-prova` exports `createApp`, `findModelDir`, `ETAG_MODES` and `JOIN_MODES`, and their types (`AppOptions`, `ETagMode`, `JoinMode`).

Its other files are internal, and may change in any release. So `package.json`'s `exports` doesn't let them be imported: `import ... from "odata-prova/dist/lib/metadata.js"` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## Possible future improvements

- **Draft validation** - drafts are activated as they are: no validation messages, side effects, or locks between users.
- **Richer operation rules** - rules can only set fixed values; conditions, computed values or creating entities would need more.
- **Exporting the saved data** - write what a `--persist` file holds as data files, to keep as the next test fixture.
- **Seeding only when there's nothing saved** - the data files are read at every start, even when the saved state replaces them, so one that no longer fits a changed `metadata.xml` stops the start.

## References

Specs and docs used for implementing the metadata parser, $filter, $expand, and $batch:

- [OData Version 2.0](https://www.odata.org/documentation/odata-version-2-0/) - odata.org docs (metadata, URI conventions, JSON format)
- [OData Version 4.01, Part 1: Protocol](https://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part1-protocol.html) - OASIS standard
- [OData CSDL XML Representation, Version 4.01](https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/os/odata-csdl-xml-v4.01-os.html) - the $metadata XML format for V4
- [SAP Annotations for OData Version 2.0](https://sap.github.io/odata-vocabularies/docs/v2-annotations.html) - `sap:` namespace attributes (label, display-format, content-version, etc.)
