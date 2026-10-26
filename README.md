# odata-prova

[![tests](https://github.com/jaravan/odata-prova/actions/workflows/test.yml/badge.svg)](https://github.com/jaravan/odata-prova/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/odata-prova)](https://www.npmjs.com/package/odata-prova)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

![In a terminal, npx odata-prova starts on a folder holding only a metadata.xml, generates rows for its two entity sets and prints the V2 and V4 URLs. In VS Code, the SAP Fiori generator connects to the V4 URL and generates a List Report app on PurchaseOrderSet. The app then runs in the browser, showing the generated purchase orders and the object page of one with its items, whose prices add up to its total](img/hero.gif)

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

The image is built for amd64 and arm64, and tagged by version (e.g. `0.21.0` or `0.21`) and `latest`.

[examples/](examples/) has three services to try: [PurchaseOrderSrv](examples/PurchaseOrderSrv/) (V2, all generated, with mock rules and a function import), [Northwind](examples/Northwind/) (V4, data files and mock rules) and [TripPin](examples/TripPin/) (V4, with actions and functions).

> [!TIP]
> **See it in a full project:** [fiori-devstack](https://github.com/jaravan/fiori-devstack) runs V2 and V4 Fiori Elements apps on odata-prova, with Docker Compose or Kubernetes, and OPA tests in CI.

## Your service

```
MySrv/
  metadata.xml         # the service's $metadata, V2 or V4
  data/                # optional, one file per entity set (the others get mock data)
    MyEntitySet.csv    # header row, ; or , separated, quoted as spreadsheets write it (JSON also works)
  config.json          # optional, mock data rules and what operations change (see docs/mock-data.md, docs/operations.md)
```

The folder name becomes the service name: `/odata/v2/MySrv/` and `/odata/v4/MySrv/`.

Your `metadata.xml` can be V2 or V4. The server generates the other version, annotations included: `sap:` attributes become [V4 annotations](docs/odata-support.md#sap-annotations-in-the-generated-v4-metadata), and V4 annotations are [written for UI5's V2 model](docs/odata-support.md#v4-annotations-in-the-generated-v2-metadata).

A data file is named after its entity set (or its entity type, or `<namespace>-<EntityType>`). An entity set without one gets 20 generated rows that fit the metadata and agree with each other: a row's city, country and currency, an order's items and its total. Their foreign keys point at real rows, so navigation and `$expand` work. Something off? `npx odata-prova ./MySrv --explain` tells you what to add to `config.json`, and `--write-data` writes the rows to files to edit, see [Mock data](docs/mock-data.md).

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

| Option            | Variable        | Default            | Purpose                                                                                                                    |
| ----------------- | --------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `-p`, `--port`    | `PORT`          | `3000`             | HTTP port                                                                                                                  |
| `modelDir`        | `MODEL_DIR`     | current directory  | The model, or a folder holding one                                                                                         |
| `--service-name`  | `SERVICE_NAME`  | the model's folder | The name in the default paths                                                                                              |
| `--v2-path`       | `V2_PATH`       | `/odata/v2/<name>` | V2 root, `""` turns V2 off                                                                                                 |
| `--v4-path`       | `V4_PATH`       | `/odata/v4/<name>` | V4 root, `""` turns V4 off                                                                                                 |
| `--mock-rows`     | `MOCK_ROWS`     | `20`               | Rows generated per set without a data file                                                                                 |
| `--etags`         | `ETAGS`         | `lenient`          | How [`If-Match`](docs/odata-support.md#etags) is checked: `lenient`, `strict` or `off`                                     |
| `--joins`         | `JOINS`         | `guess`            | [Navigations without a constraint](docs/odata-support.md#navigations-without-a-referentialconstraint): `guess` or `strict` |
| `--page-size`     | `PAGE_SIZE`     | `0`: every row     | Rows per response, with a [next link](docs/odata-support.md#server-driven-paging)                                          |
| `--persist`       | `PERSIST`       | none: in memory    | A SQLite file or `postgres://` URL, see [Keeping the data](docs/persistence.md)                                            |
| `--persist-reset` | `PERSIST_RESET` | off                | Start over from the data files (`PERSIST_RESET=1`)                                                                         |
| `--explain`       |                 |                    | Show [filler values](docs/mock-data.md#changing-a-column) and what to add to `config.json`, then exit                      |
| `--write-data`    |                 |                    | Write the generated rows to [`data/`](docs/mock-data.md#editing-the-generated-data), then exit                             |

The image contains no model. Mount one as `/models/<ServiceName>`, and the server finds it. To mount several, set `MODEL_DIR` to the one to serve, e.g. `-v "$PWD/examples:/models:ro" -e MODEL_DIR=/models/Northwind`.

## Keeping the data

By default, every start begins fresh from your data files and mock rows, which is what CI wants. To keep what your app writes across restarts, give the server a SQLite file, or a PostgreSQL database that several replicas can share:

```sh
npx odata-prova ./MySrv --persist ./MySrv.db
npx odata-prova ./MySrv --persist postgres://user:password@db:5432/mocks
```

`--persist-reset` starts over from your data files. How writes are saved, what happens when `metadata.xml` or the mock rules change, Docker volumes and replicas: [Keeping the data](docs/persistence.md).

## What's supported

- **Reads and writes**, with deep insert, links (`@odata.bind`, `$ref`, V2's `$links`) and `$batch` changesets.
- **Query options**: `$filter`, `$orderby`, `$top`, `$skip`, `$select`, `$expand`, `$count`, `$search`, `$compute`, and V4's `$apply` for grouped and aggregated tables.
- **Types**: every primitive Edm type, complex and enum types, collections and inheritance.
- **Actions and functions**, bound and imported, on both protocols.
- **What Fiori Elements needs**: drafts (CAP or RAP), ETags, delta links and server-driven paging.

Northwind (V2 and V4) and TripPin load unmodified, every navigation working. The details, and what's rejected: [Supported OData features](docs/odata-support.md).

## Why not the fe-mockserver or CAP?

- **[fe-mockserver](https://github.com/SAP/open-ux-odata)** runs as middleware inside `ui5 serve`, next to the app that hosts it. Its core can be mounted in your own Express server, but SAP documents it as not meant for direct use. odata-prova is a standalone server or container that any app, pipeline or test can share.
- **[CAP](https://cap.cloud.sap/)** can mock a service too: `cds import` converts its `metadata.xml` to CDS, and `cds watch` serves it with CSV data, but that needs a CAP project around it. odata-prova uses the file as is, with no project or code, and serves it as V2 and V4 at once.

For quick UI work inside a single app, the fe-mockserver is still simpler.

## Documentation

- [Mock data](docs/mock-data.md): how rows are generated, changing a column with `config.json`, and editing rows as files
- [Supported OData features](docs/odata-support.md): types, query options, and what's rejected
- [Keeping the data](docs/persistence.md): a SQLite file or PostgreSQL, Docker volumes, replicas
- [Actions and functions](docs/operations.md): how operations answer, the V2/V4 mapping, and `config.json` rules
- [Architecture](docs/architecture.md): how it's built, using it in code, planned improvements, and the specs it follows

## Contributing

Issues and pull requests are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).
