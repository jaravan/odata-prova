# Keeping the data

By default, every start begins fresh from your data files and mock rows. That's what CI wants. `--persist` (or `PERSIST`) keeps what your app writes across restarts: in a SQLite file for one server, or in PostgreSQL for several.

## In a file

To keep what your app writes, give the server a file:

```sh
npx odata-prova ./MySrv --persist ./MySrv.db
```

The first start creates the file and saves the data to it. Every start after that loads the file, so your writes are still there.

- **Every write is saved before it's answered.** If it can't be saved, the request fails with `500` and nothing changes.
- **The file replaces your data files.** Edited a CSV? Start once with `--persist-reset` to go back to them.
- **Changed the mock rules?** The next start generates the generated sets again, and saves them. A set with your writes is kept, and the log says so. The same happens when `--mock-rows` changes, or a new version generates rows differently. See [Mock data](mock-data.md#with---persist).
- **Changed `metadata.xml`?** The next start adapts the saved rows to it, and the log lists what changed. Changed keys can't be adapted: the server stops and asks for `--persist-reset`.
- **One server per file.** A second one is refused while the first runs.

## With Docker

Keep the file in a volume at `/state`:

```sh
docker run -p 3000:3000 -v "$PWD/MySrv:/models/MySrv:ro" \
  -v mysrv-data:/state -e PERSIST=/state/MySrv.db ghcr.io/jaravan/odata-prova
```

A folder of your own works too, if the image's `node` user (uid 1000) can write to it. Or run the container as yourself, with `--user "$(id -u)"`.

## In PostgreSQL, with replicas

> [!IMPORTANT]
> Run one server per service, unless the data is in PostgreSQL. Each server keeps its own copy of the data in memory, so with several replicas, a write lands on one and a read may come from another. With PostgreSQL, replicas catch up with each other.

To keep the data out of the container, in a database you already run, give the server a `postgres://` URL instead of a file:

```sh
docker run -p 3000:3000 -v "$PWD/MySrv:/models/MySrv:ro" \
  -e PERSIST=postgres://user:password@db:5432/mocks ghcr.io/jaravan/odata-prova
```

The container keeps nothing: replace it, and the next one starts from what was saved. And several servers can serve the same service on one database: replicas behind a load balancer, scaled up and down, and updated one at a time.

- **Every server answers alike.** Each holds all the data in memory, so size its memory for that. Before every request, it catches up with what the others saved. A write on one is there for the next request, on any of them, so Fiori's drafts and save-then-read work across replicas.
- **Reads scale, writes don't.** Each request costs one small query, about a millisecond. Writes are saved one at a time across all the servers of a service: a few hundred a second, however many servers. Under more load, a write that waits over 5 seconds answers `503`, and so does any request that waits over 30 seconds for its turn.
- **The database is needed to answer.** While it can't be reached, requests fail with `503` at once, and work again when it's back. If it's restored from a backup, or emptied and seeded anew by a new server, the servers load it again. If its tables are gone, `/healthz` fails, and the restarted servers seed it anew.
- **Several services can share a database.** The server creates four tables, `odata_prova_meta`, `odata_prova_sets`, `odata_prova_rows` and `odata_prova_log`, and keeps each service's rows under its name (`--service-name`, by default the model folder's). For another schema than the default, add `?options=-c%20search_path%3Dmyschema` to the URL. The database user needs to be allowed to create tables at the first start.
- **Don't leave `PERSIST_RESET=1` set for all the servers.** Every server that starts resets the data, the ones added to scale up too. Reset once, with one server.
- **A changed `metadata.xml` in a rolling update:** the first new server adapts the saved rows to it, and from then on, the old ones answer `503` until they're replaced.
- **Delta links are each server's own.** One handed out by another server is a `410 Gone`, and the client reads the set again.

The user and password can stay out of the URL: the standard `PGUSER` and `PGPASSWORD` variables work too (and the other `PG*` ones, e.g. `PGSSLMODE=require`).
