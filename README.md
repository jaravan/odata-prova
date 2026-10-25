# odata-prova

[![tests](https://github.com/jaravan/odata-prova/actions/workflows/test.yml/badge.svg)](https://github.com/jaravan/odata-prova/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/odata-prova)](https://www.npmjs.com/package/odata-prova)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

![In a terminal, npx odata-prova starts on a folder holding a metadata.xml and a CSV file for each of its two entity sets, loads their rows and prints the V2 and V4 URLs. In VS Code, the SAP Fiori generator connects to the V4 URL and generates a List Report app on PurchaseOrderSet. The app then runs in the browser, showing the purchase orders and the object page of one with its items](img/hero.gif)

A mock OData V2 and V4 server generated from your service's `metadata.xml`. Point it at the file, and it serves the service as V2 and V4 at once, with mock data or your own CSV files. No project, no code and no SAP system needed.

> `prova (πρόβα)`: Greek for rehearsal

Not affiliated with or endorsed by SAP.

## Who is it for?

Anyone whose work depends on an SAP OData service they can't always reach: Fiori and UI5 developers, UX designers, web, mobile and integration developers, test and DevOps engineers, and consultants giving demos.

Where it helps:

- **Before the backend exists:** the service's `metadata.xml` is enough.
- **Without the SAP system:** no VPN, missing authorizations or a system that's down. The app keeps its paths through the `fiori-tools-proxy` (see [Your app](#your-app)).
- **In CI:** a Docker image with the same data on every run, for OPA5 and other browser tests.
- **Moving from V2 to V4:** one `metadata.xml` serves both, side by side on the same data.
- **In demos:** data you choose, for people without access to the system.

It's not a backend: there's no business logic beyond required values and `config.json` rules. Writes last until a restart, unless you [keep them in a file](#keeping-the-data).

## Requirements

- [Node.js](https://nodejs.org/) 22.13+ or [Docker](https://www.docker.com/)

## Quick start

A folder with your service's `metadata.xml` is all it needs:

```sh
npx odata-prova ./MySrv
```

```
odata-prova listening on port 3000
  V2: http://localhost:3000/odata/v2/MySrv/
  V4: http://localhost:3000/odata/v4/MySrv/
```

> If port 3000 is already in use, pick another with `--port`, e.g. `npx odata-prova ./MySrv --port 4004`

Or with Docker, mounting the folder as `/models/<ServiceName>`:

```sh
docker run -p 3000:3000 -v "$PWD/MySrv:/models/MySrv:ro" ghcr.io/jaravan/odata-prova
```

The image is built for amd64 and arm64, and tagged by version (e.g. `0.19.0` or `0.19`) and `latest`.

[examples/](examples/) has three services to try: [PurchaseOrderSrv](examples/PurchaseOrderSrv/) (V2, with a function import), [Northwind](examples/Northwind/) (V4) and [TripPin](examples/TripPin/) (V4, with actions and functions).

> [!TIP]
> **See it in a full project:** [fiori-devstack](https://github.com/jaravan/fiori-devstack) runs V2 and V4 Fiori Elements apps on odata-prova, with Docker Compose or Kubernetes, and OPA tests in CI.

## Your service

```
MySrv/
  metadata.xml         # the service's $metadata, V2 or V4
  data/                # optional, one file per entity set (the others get mock data)
    MyEntitySet.csv    # header row, ; or , separated, quoted as spreadsheets write it (JSON also works)
  config.json          # optional, what operations change (see docs/operations.md)
```

The folder name becomes the service name: `/odata/v2/MySrv/` and `/odata/v4/MySrv/`.

Your `metadata.xml` can be V2 or V4. The server generates the other version, annotations included: `sap:` attributes become [V4 annotations](docs/odata-support.md#sap-annotations-in-the-generated-v4-metadata), and V4 annotations are [written for UI5's V2 model](docs/odata-support.md#v4-annotations-in-the-generated-v2-metadata).

A data file is named after its entity set (or its entity type, or `<namespace>-<EntityType>`). An entity set without one gets 20 generated rows that fit the metadata and agree with each other: a row's city, country and currency, an order's items and its total. Their foreign keys point at real rows, so navigation and `$expand` work. To edit them, `odata-prova-mock-data` writes them to files, see [Mock data](docs/mock-data.md).

## Your app

Point your app's backend at the server. In a Fiori tools app, that's the `fiori-tools-proxy` backend in `ui5.yaml`. Its `pathReplace` maps the path your app requests to the server's, so the app itself doesn't change:

```yaml
backend:
  - path: /sap/opu/odata/sap/MySrv
    pathReplace: /odata/v2/MySrv
    url: http://localhost:3000
```

Use `/odata/v4/MySrv` for a V4 app. The server also sends CORS headers, so apps can call it directly.

The server serves only the service and its `$metadata`. Annotations your app loads from the system's catalog service (an `IWFND/CATALOGSERVICE` data source in `manifest.json`) aren't available; annotation files in the app work as usual.

## Configuration

`odata-prova [modelDir] [options]` serves the model in `modelDir`, or in the current directory.

Every setting is optional, and can be given as an option or an environment variable. Options work in any shell; variables suit Docker and Kubernetes. When both are set, the option wins. `odata-prova --help` lists them all.

```sh
npx odata-prova ./MySrv --port 4004 --mock-rows 50 --etags strict
```

| Option            | Variable        | Default                                        | Purpose                                                                                                                                                                                                                                                     |
| ----------------- | --------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p`, `--port`    | `PORT`          | `3000`                                         | HTTP port                                                                                                                                                                                                                                                   |
| `modelDir`        | `MODEL_DIR`     | the current directory (`/models` in the image) | The model to serve, or a folder holding exactly one model                                                                                                                                                                                                   |
| `--service-name`  | `SERVICE_NAME`  | the model's folder name                        | Used to build the default service paths                                                                                                                                                                                                                     |
| `--v2-path`       | `V2_PATH`       | `/odata/v2/<SERVICE_NAME>`                     | V2 service root - set to `""` to disable V2                                                                                                                                                                                                                 |
| `--v4-path`       | `V4_PATH`       | `/odata/v4/<SERVICE_NAME>`                     | V4 service root - set to `""` to disable V4                                                                                                                                                                                                                 |
| `--mock-rows`     | `MOCK_ROWS`     | `20`                                           | Rows generated for each entity set without a data file - `0` leaves it empty                                                                                                                                                                                |
| `--etags`         | `ETAGS`         | `lenient`                                      | How strictly `If-Match` is checked: `lenient`, `strict` or `off`, see [ETags](docs/odata-support.md#etags)                                                                                                                                                  |
| `--joins`         | `JOINS`         | `guess`                                        | A navigation without a `ReferentialConstraint`: `guess` its join from property names, or `strict` to give it a key of its own instead, see [Navigations without a ReferentialConstraint](docs/odata-support.md#navigations-without-a-referentialconstraint) |
| `--page-size`     | `PAGE_SIZE`     | `0`                                            | The most rows a collection's response holds, with a next link to the rest - `0` sends every row, see [Server-driven paging](docs/odata-support.md#server-driven-paging)                                                                                     |
| `--persist`       | `PERSIST`       | none: in memory only                           | A SQLite file, or a PostgreSQL database (`postgres://...`, which replicas can share), that keeps the data, so writes survive a restart - no value keeps it in memory, see [Keeping the data](#keeping-the-data)                                             |
| `--persist-reset` | `PERSIST_RESET` | off                                            | With `--persist`: start over from the data files and mock rows, replacing what was saved (`PERSIST_RESET=1`)                                                                                                                                                |

The image contains no model. Mount one as `/models/<ServiceName>`, and the server finds it. To mount several, set `MODEL_DIR` to the one to serve, e.g. `-v "$PWD/examples:/models:ro" -e MODEL_DIR=/models/Northwind`.

> [!IMPORTANT]
> Run one server per service, unless the data is in PostgreSQL. Each server keeps its own copy of the data in memory, so with several replicas, a write lands on one and a read may come from another. With `--persist postgres://...`, replicas catch up with each other: see [In PostgreSQL, with replicas](#in-postgresql-with-replicas).

## Keeping the data

By default, every start begins fresh from your data files and mock rows. That's what CI wants.

To keep what your app writes, give the server a file:

```sh
npx odata-prova ./MySrv --persist ./MySrv.db
```

The first start creates the file and saves the data to it. Every start after that loads the file, so your writes are still there.

- **Every write is saved before it's answered.** If it can't be saved, the request fails with `500` and nothing changes.
- **The file replaces your data files.** Edited a CSV? Start once with `--persist-reset` to go back to them.
- **Changed `metadata.xml`?** The next start adapts the saved rows to it, and the log lists what changed. Changed keys can't be adapted: the server stops and asks for `--persist-reset`.
- **One server per file.** A second one is refused while the first runs.

With Docker, keep the file in a volume at `/state`:

```sh
docker run -p 3000:3000 -v "$PWD/MySrv:/models/MySrv:ro" \
  -v mysrv-data:/state -e PERSIST=/state/MySrv.db ghcr.io/jaravan/odata-prova
```

A folder of your own works too, if the image's `node` user (uid 1000) can write to it. Or run the container as yourself, with `--user "$(id -u)"`.

### In PostgreSQL, with replicas

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

## What's supported

- **Reads and writes**, including deep insert, links to existing entities (`@odata.bind`, `$ref`, V2's `$links`), and `$batch` with atomic changesets.
- **Query options**: `$filter` (with V4's `any` and `all`), `$orderby`, `$top`, `$skip`, `$select`, `$expand` (with nested V4 options, and `*`), `$count`/`$inlinecount`, `$search` and V4's `$compute`. Server-driven paging with `$skiptoken` is opt-in, see [`PAGE_SIZE`](docs/odata-support.md#server-driven-paging).
- **Aggregation**: V4's `$apply`, for UI5's grouped and aggregated tables, totals included. What it doesn't cover is rejected with `501`, see [Aggregation](docs/odata-support.md#aggregation-apply).
- **Types**: all primitive Edm types, complex and enum types, collections and inheritance.
- **Actions and functions**, bound and imported, served on both protocols: a V2 function import with `sap:action-for` becomes a V4 bound action. A `config.json` rule can make one change data, e.g. set `Status` to `Approved`.
- **Drafts** (`Common.DraftRoot`, from CAP or RAP, V4 or V2): the Fiori Elements create and edit flows - create, edit, change, save or discard an entity and its compositions in a draft. See [Drafts](docs/odata-support.md#drafts).
- **ETags** (`Core.OptimisticConcurrency`, or V2's `ConcurrencyMode="Fixed"`): a change sent with an ETag that's gone stale is a `412`. `ETAGS=strict` also requires one, and `ETAGS=off` ignores it. See [ETags](docs/odata-support.md#etags).
- **Delta links**: read an entity set with `Prefer: odata.track-changes`, and its delta link later answers what was added, changed or deleted since: `@odata.deltaLink` in V4, SAP Gateway's `__delta` with `!deltatoken` in V2. See [Delta links](docs/odata-support.md#delta-links).

The tests load Northwind (V2 and V4) and TripPin unmodified, with every navigation working, including those with no foreign key in the metadata ([Navigations without a ReferentialConstraint](docs/odata-support.md#navigations-without-a-referentialconstraint)).

## Why not the fe-mockserver or CAP?

- **[fe-mockserver](https://github.com/SAP/open-ux-odata)** runs as middleware inside `ui5 serve`, next to the app that hosts it. Its core can be mounted in your own Express server, but SAP documents it as not meant for direct use. odata-prova is a standalone server or container that any app, pipeline or test can share.
- **[CAP](https://cap.cloud.sap/)** can mock a service too: `cds import` converts its `metadata.xml` to CDS, and `cds watch` serves it with CSV data, but that needs a CAP project around it. odata-prova uses the file as is, with no project or code, and serves it as V2 and V4 at once.

For quick UI work inside a single app, the fe-mockserver is still simpler.

## Documentation

- [Mock data](docs/mock-data.md): how rows are generated, and editing them as files
- [Supported OData features](docs/odata-support.md): types, query options, and what's rejected
- [Actions and functions](docs/operations.md): how operations answer, the V2/V4 mapping, and `config.json` rules
- [Architecture](docs/architecture.md): how it's built, using it in code, planned improvements, and the specs it follows

## Contributing

Issues and pull requests are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).
