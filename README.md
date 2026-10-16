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

It's not a backend: no business logic beyond required values and `config.json` rules, and writes last until a restart.

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

Or with Docker, mounting the folder as `/models/<ServiceName>`:

```sh
docker run -p 3000:3000 -v "$PWD/MySrv:/models/MySrv:ro" ghcr.io/jaravan/odata-prova
```

The image is built for amd64 and arm64 and tagged by version (`<major>.<minor>.<patch>` and `<major>.<minor>`) and `latest`.

Needs Node.js 22 or later, or Docker. [examples/](examples/) has three services to try: [PurchaseOrderSrv](examples/PurchaseOrderSrv/) (V2, with a function import), [Northwind](examples/Northwind/) (V4) and [TripPin](examples/TripPin/) (V4, with actions and functions).

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

The folder name becomes the service name: `/odata/v2/MySrv/` and `/odata/v4/MySrv/`. Whichever protocol the `metadata.xml` wasn't written for gets its metadata generated from the other, with its annotations: a V2 document's `sap:` attributes become [V4 annotations](docs/odata-support.md#sap-annotations-in-the-generated-v4-metadata), and a V4 document's annotations are [written for UI5's V2 model](docs/odata-support.md#v4-annotations-in-the-generated-v2-metadata). A data file is named after the entity set, its entity type, or `<namespace>-<EntityType>` (first match wins). Writes are kept in memory until a restart resets them.

Each entity set without a data file gets 20 generated rows that fit the metadata, with foreign keys pointing at real rows so navigation and `$expand` work. `odata-prova-mock-data` writes them to files for you to edit, see [Mock data](docs/mock-data.md).

## Your app

Point your app's backend at the server. In a Fiori tools app, that's the `fiori-tools-proxy` backend in `ui5.yaml`, where `pathReplace` maps the path your app requests to the server's, so the app itself doesn't change:

```yaml
backend:
  - path: /sap/opu/odata/sap/MySrv
    pathReplace: /odata/v2/MySrv
    url: http://localhost:3000
```

Use `/odata/v4/MySrv` for a V4 app. The server also sends CORS headers, so apps can call it directly.

The server serves only the service and its `$metadata`. Annotations your app loads from the system's catalog service (an `IWFND/CATALOGSERVICE` data source in `manifest.json`) aren't available; annotation files in the app work as usual.

## Configuration

`odata-prova [modelDir]` serves the model in `modelDir`, or in the current directory. Everything else is set through environment variables, all optional:

| Variable       | Default                                        | Purpose                                                                                                                                                                                                                               |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`         | `3000`                                         | HTTP port                                                                                                                                                                                                                             |
| `MODEL_DIR`    | the current directory (`/models` in the image) | The model to serve when no `modelDir` is given, or a folder holding exactly one model                                                                                                                                                 |
| `SERVICE_NAME` | the model's folder name                        | Used to build the default service paths                                                                                                                                                                                               |
| `V2_PATH`      | `/odata/v2/<SERVICE_NAME>`                     | V2 service root - set to `""` to disable V2                                                                                                                                                                                           |
| `V4_PATH`      | `/odata/v4/<SERVICE_NAME>`                     | V4 service root - set to `""` to disable V4                                                                                                                                                                                           |
| `MOCK_ROWS`    | `20`                                           | Rows generated for each entity set without a data file - `0` leaves it empty                                                                                                                                                          |
| `ETAGS`        | `lenient`                                      | How strictly `If-Match` is checked: `lenient`, `strict` or `off`, see [ETags](docs/odata-support.md#etags)                                                                                                                            |
| `JOINS`        | `guess`                                        | A navigation without a `ReferentialConstraint`: `guess` its join from property names, or `strict` to disable it, see [Navigations without a ReferentialConstraint](docs/odata-support.md#navigations-without-a-referentialconstraint) |
| `PAGE_SIZE`    | `0`                                            | The most rows a collection's response holds, with a next link to the rest - `0` sends every row, see [Server-driven paging](docs/odata-support.md#server-driven-paging)                                                               |

The image contains no model. Mount one as `/models/<ServiceName>`, and the server finds it. To mount several, set `MODEL_DIR` to the one to serve, e.g. `-v "$PWD/examples:/models:ro" -e MODEL_DIR=/models/Northwind`.

> [!IMPORTANT]
> Run a single instance per service. Each instance keeps its own in-memory copy of the data, so with more than one replica, writes land on one and reads may come from another.

## What's supported

- **Reads and writes**, including deep insert, and `$batch` with atomic changesets.
- **Query options**: `$filter` (with the V4 lambda operators `any` and `all`), `$orderby`, `$top`, `$skip`, `$select`, `$expand` (with nested V4 options), `$count`/`$inlinecount`, `$search`, server-driven paging with `$skiptoken` ([`PAGE_SIZE`](docs/odata-support.md#server-driven-paging)), and V4's `$apply` for UI5's grouped and aggregated tables, totals included ([Aggregation](docs/odata-support.md#aggregation-apply)).
- **Types**: all primitive Edm types, complex and enum types, collections and inheritance.
- **Actions and functions**, bound and imported, served on both protocols: a V2 function import with `sap:action-for` becomes a V4 bound action. A `config.json` rule can make one change data, e.g. set `Status` to `Approved`.
- **Drafts** (`Common.DraftRoot`, from CAP or RAP, V4 or V2): the Fiori Elements create and edit flows - create, edit, change, save or discard an entity and its compositions in a draft. See [Drafts](docs/odata-support.md#drafts).
- **ETags** (`Core.OptimisticConcurrency`, or V2's `ConcurrencyMode="Fixed"`): a change sent with an ETag that's gone stale is a `412`. `ETAGS=strict` also requires one, and `ETAGS=off` ignores it. See [ETags](docs/odata-support.md#etags).

`$compute`, `$deltatoken` and the rest of `$apply` are rejected with `501`.

The tests load Northwind (V2 and V4) and TripPin unmodified.

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
