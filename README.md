# odata-prova

[![tests](https://github.com/jaravan/odata-prova/actions/workflows/test.yml/badge.svg)](https://github.com/jaravan/odata-prova/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/odata-prova)](https://www.npmjs.com/package/odata-prova)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

![npx odata-prova starts on a folder that holds only a metadata.xml, generates data for its two entity sets and serves them as V2 and V4; a V4 request returns a purchase order with its items, and a V2 request returns the same order](img/hero.gif)

A mock OData V2 and V4 server generated from your service's `metadata.xml`. Point it at the file, and it serves the service as V2 and V4 at once, with mock data or your own CSV files. No project, no code and no SAP system needed.

> `prova (πρόβα)`: Greek for rehearsal

Not affiliated with or endorsed by SAP.

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

Needs Node.js 22 or later, or Docker. [examples/](examples/) has three services to try: [PurchaseOrderSrv](examples/PurchaseOrderSrv/) (V2, with a function import), [Northwind](examples/Northwind/) (V4) and [TripPin](examples/TripPin/) (V4, with actions and functions).

## Your service

```
MySrv/
  metadata.xml         # the service's $metadata, V2 or V4
  data/                # optional, one file per entity set (the others get mock data)
    MyEntitySet.csv    # header row, ; or , separated (JSON also works)
  config.json          # optional, what operations change (see Actions and functions)
```

The folder name becomes the service name: `/odata/v2/MySrv/` and `/odata/v4/MySrv/`. Whichever protocol the `metadata.xml` wasn't written for gets its metadata generated from the other. A data file is named after the entity set, its entity type, or `<namespace>-<EntityType>` (first match wins). Writes are kept in memory until a restart resets them.

A navigation the server can't join (for example a many-to-many link without a `ReferentialConstraint`) doesn't stop the service from starting. It is disabled with a `navigation disabled: ...` line in the startup log, and requests that use it get a `501` saying why.

### Mock data

Each entity set without a data file gets 20 generated rows, the same ones on every start ([lib/generate.js](lib/generate.js)). This is decided per entity set, so you can write files for some sets and let the rest be generated:

- Values fit the metadata: MaxLength, Precision and Scale, enums and complex types.
- Property names pick plausible values: a `Currency` holds EUR or USD, an `Email` an address, a `City` a city.
- Foreign keys point at real rows, so navigation and `$expand` work. When a foreign key is part of the key (an order's items), the rest of the key counts up per parent.

`MOCK_ROWS=50` changes the row count, and `MOCK_ROWS=0` turns generation off. A data file with only a header row keeps its entity set empty.

To edit the generated data, write it to files:

```sh
npx -p odata-prova odata-prova-mock-data ./MySrv    # writes MySrv/data/, 20 rows per set (add a number for more)
# edit the files: realistic names, the statuses you need to test, edge cases
npx odata-prova ./MySrv                             # serves your edited files
```

It writes the same rows the server generates, as CSV files (JSON for complex values), and only for entity sets without a data file; it never overwrites one. Delete a file to have that entity set generated again. With Docker: `docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/MySrv:/model" ghcr.io/jaravan/odata-prova node mock-data.js /model`.

Derived values aren't recalculated: deleting an item leaves its order's total as it was, since the server stores what it's sent and has no business logic. SAP's fe-mockserver behaves the same unless you write hooks for it.

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

For a complete setup, see [fiori-devstack](https://github.com/jaravan/fiori-devstack): a V2 and a V4 Fiori Elements app on this server, on Docker Compose or Kubernetes, with their OPA tests running in CI.

## Configuration

`odata-prova [modelDir]` serves the model in `modelDir`, or in the current directory. Everything else is set through environment variables, all optional:

| Variable       | Default                                        | Purpose                                                                               |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `PORT`         | `3000`                                         | HTTP port                                                                             |
| `MODEL_DIR`    | the current directory (`/models` in the image) | The model to serve when no `modelDir` is given, or a folder holding exactly one model |
| `SERVICE_NAME` | the model's folder name                        | Used to build the default service paths                                               |
| `V2_PATH`      | `/odata/v2/<SERVICE_NAME>`                     | V2 service root - set to `""` to disable V2                                           |
| `V4_PATH`      | `/odata/v4/<SERVICE_NAME>`                     | V4 service root - set to `""` to disable V4                                           |
| `MOCK_ROWS`    | `20`                                           | Rows generated for each entity set without a data file - `0` leaves it empty          |

The image contains no model. Mount one as `/models/<ServiceName>`, and the server finds it. To mount several, set `MODEL_DIR` to the one to serve, e.g. `-v "$PWD/examples:/models:ro" -e MODEL_DIR=/models/Northwind`.

> [!IMPORTANT]
> Run a single instance per service. Each instance keeps its own in-memory copy of the data, so with more than one replica, writes land on one and reads may come from another.

## Supported types

All primitive Edm types, plus:

- **Complex types**, nested and in collections. In V2 a complex value carries its type in `__metadata`, as SAP Gateway sends it.
- **Enum types** (V4). V2 has no enums, so there they are `Edm.String` holding the member name.
- **Collection-valued properties** (V4). V2 has none, so they are left out of the V2 service, with a `not in V2: ...` line in the startup log.
- **Inheritance** (`BaseType`). Each derived type gets its base's key, properties and navigations, so the generated `$metadata` needs no `BaseType`.

In a CSV data file, a complex or collection value goes in its cell as JSON. Filtering or sorting on a field inside a complex value is not supported.

The tests load Northwind (V2 and V4) and TripPin unmodified, see [test/fixtures/real](test/fixtures/real/).

## Supported query options

Reads and writes, `$filter`, `$orderby`, `$top`, `$skip`, `$select`, `$expand` (including nested V4 options like `$expand=Items($select=Material;$top=2)`), `$count`/`$inlinecount`, `$search`, and `$batch` (with atomic changesets) all work, on both protocols.

`$filter` includes the V4 lambda operators, which Fiori Elements V4 sends for filter fields on a to-many navigation: `Items/any(i:i/Material eq 'MAT-1001')`, `Items/all(i:i/Unit eq 'TO')` and `Items/any()`, over navigations and collection-valued properties (`Emails/any(e:endswith(e,'contoso.com'))`), nested, and with `$it` for the entity outside the lambda.

Not supported - rejected with `501 Not Implemented`: `$apply`, `$compute`, `$skiptoken`, `$deltatoken`, and any `$format` other than JSON. Not yet: drafts and ETags.

## Actions and functions

V4 actions and functions, bound (`People('x')/NS.ShareTrip`) and imported (`GetNearestAirport(lat=1,lon=2)`), and V2 function imports (`ApprovePurchaseOrder?PurchaseOrderId='1'`) can be called, also inside `$batch`. A mock doesn't know what an operation does, so the server:

- checks the method: `POST` for actions, `GET` for functions, `m:HttpMethod` for V2 function imports (`405` otherwise)
- reads the parameters from the JSON body (V4 actions), the path (V4 functions) or the query string (V2), and logs the call with them: `action ShareTrip on /odata/v4/TripPin/People('x') {"userName":"bob","tripId":1}`
- applies the model's rule for it, if it has one (see below)
- answers with what the return type allows:

| Return type                                         | Response                                                       |
| --------------------------------------------------- | -------------------------------------------------------------- |
| None                                                | `204`                                                          |
| The entity type it acts on                          | That entity: an Approve on an order returns the order          |
| An entity type whose key the parameters carry       | That entity (`404` if there is none)                           |
| Any other entity type, or a collection of one       | Rows of that type's entity set, with the query options applied |
| A primitive or complex type, or a collection of one | A neutral value: `""`, `0`, `false`, an object of those, `[]`  |

Parameter aliases (`@p`) and path segments after an operation are rejected with `501`.

### On both protocols

Every operation is served on both protocols, whichever one the metadata was written for. V2 has no bound operations: SAP Gateway writes an operation on an entity as a function import that takes the entity's key as parameters and names the entity type in `sap:action-for`. The server maps one onto the other:

| V2                                                                       | V4                                                                                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Function import with `sap:action-for` and the entity's key as parameters | Action or function bound to that entity type (`EntitySetPath` set when it returns that entity, so UI5 updates the page with the result) |
| Any other function import                                                | Action or function import                                                                                                               |

An operation V2 can't express (complex or collection parameters, or bound to a type without an entity set) is left out of V2, with a `not in V2: ...` line in the startup log. [examples/PurchaseOrderSrv](examples/PurchaseOrderSrv/) has a V2 function import, `ApprovePurchaseOrder`, which is served as a function import on V2 and as a bound action on V4; [examples/TripPin](examples/TripPin/) has V4 operations of both kinds.

### What an operation changes

Without a rule, an operation changes no data. A model's optional `config.json` can make one set properties on the entity it acts on:

```json
{
  "operations": {
    "ApprovePurchaseOrder": { "set": { "Status": "Approved" } }
  }
}
```

The rule applies on both protocols. An operation or property the model doesn't have is an error at startup.

## Why not the fe-mockserver or CAP?

- **[fe-mockserver](https://github.com/SAP/open-ux-odata)** runs as middleware inside `ui5 serve`, next to the app that hosts it. Its core can be mounted in your own Express server, but SAP documents it as not meant for direct use. odata-prova is a standalone server or container that any app, pipeline or test can share. fe-mockserver does support drafts, which odata-prova doesn't yet.
- **[CAP](https://cap.cloud.sap/)** can mock a service too: `cds import` converts its `metadata.xml` to CDS, and `cds watch` serves it with CSV data, but that needs a CAP project around it. odata-prova uses the file as is, with no project or code, and serves it as V2 and V4 at once.

For quick UI work inside a single app, the fe-mockserver is still simpler.

## Using it in code

The package exports the Express app, so you can start it from a test or mount it in your own server:

```js
const { createApp } = require("odata-prova");

const { app } = createApp({
  modelDir: "./MySrv",
  v2Path: "/odata/v2/MySrv", // a falsy path disables that protocol
  v4Path: "/odata/v4/MySrv",
  mockRows: 20, // default 0: only the data files
});
app.listen(3000);
```

## Architecture

```mermaid
flowchart LR
    subgraph Startup["Startup - runs once, at boot"]
        MX["metadata.xml"] --> PM["parseMetadata()"]
        PM --> MODEL[("model")]
        SEED["data/*.csv, *.json<br/>or generate.js"]
    end

    ST[("Store")]
    MODEL --> ST
    SEED --> ST

    subgraph Request["Per request - runs on every HTTP call"]
        direction LR
        REQ(["HTTP request"]) --> APP["app.js (Express)"]
        APP -- "POST .../$batch" --> BATCH["batch.js"] --> SVC
        APP -- "everything else" --> SVC["ODataService.dispatch()"]
        SVC -- "$filter, $orderby, $expand..." --> QF["query.js + filter.js"]
        SVC -- "parse/serialize" --> PROTO["protocol module<br/>(v2.js or v4.js)"]
        PROTO --> RES(["HTTP response"])
    end

    MODEL --> SVC
    SVC -- "read/write rows" --> ST
```

One model, parsed once at startup, backs a V2 service and a V4 service sharing the same in-memory `Store`. Each protocol module only knows how its own wire format looks (literals, JSON envelope, query option names); `service.js` does the actual URL/key parsing, navigation, and CRUD, protocol-agnostically.

## Possible future improvements

- **Draft handling** - no draft support, which most Fiori Elements V4 apps with edit flows depend on.
- **Optimistic concurrency** - no ETags and no `If-Match` checks, so concurrent updates are last-write-wins.
- **Richer operation rules** - rules can only set fixed values; conditions, computed values or creating entities would need more.
- **Broader query option support** - `$apply`, `$compute`, and server-driven paging via `$skiptoken`/`$deltatoken` are currently rejected with 501.
- **Persistent storage** - swap the in-memory `Store` for a real database.

## References

Specs and docs used for implementing the metadata parser, $filter, $expand, and $batch:

- [OData Version 2.0](https://www.odata.org/documentation/odata-version-2-0/) - odata.org docs (metadata, URI conventions, JSON format)
- [OData Version 4.01, Part 1: Protocol](https://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part1-protocol.html) - OASIS standard
- [OData CSDL XML Representation, Version 4.01](https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/os/odata-csdl-xml-v4.01-os.html) - the $metadata XML format for V4
- [SAP Annotations for OData Version 2.0](https://sap.github.io/odata-vocabularies/docs/v2-annotations.html) - `sap:` namespace attributes (label, display-format, content-version, etc.)

## Contributing

Issues and pull requests are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).
