# Recipes

Commands for common tasks. Every option and its environment variable: [Configuration](../README.md#configuration).

## Try a service with curl

On the example, from the repo root: `npx odata-prova examples/PurchaseOrderSrv`.

```sh
S=http://localhost:3000/odata

curl "$S/v4/PurchaseOrderSrv/\$metadata"                                  # V2: $S/v2/...
curl "$S/v4/PurchaseOrderSrv/PurchaseOrderSet?\$top=2"
curl "$S/v2/PurchaseOrderSrv/PurchaseOrderSet?\$top=2"                    # the same rows, as V2
curl "$S/v4/PurchaseOrderSrv/PurchaseOrderSet?\$top=2&\$expand=Items"
curl -G "$S/v4/PurchaseOrderSrv/PurchaseOrderSet" \
  --data-urlencode "\$filter=Status eq 'Open'" --data-urlencode '$count=true'

# Writes need no CSRF token
curl -X PATCH -H "Content-Type: application/json" -d '{"Supplier":"Acme"}' \
  "$S/v4/PurchaseOrderSrv/PurchaseOrderSet('4500000001')"
curl -X POST -H "Content-Type: application/json" -d '{}' \
  "$S/v4/PurchaseOrderSrv/PurchaseOrderSet('4500000002')/com.example.po.ApprovePurchaseOrder"
curl -X POST "$S/v2/PurchaseOrderSrv/ApprovePurchaseOrder?PurchaseOrderId='4500000003'"
```

## npx

```sh
npx odata-prova ./MySrv                          # the latest version
npx odata-prova@0.21.0 ./MySrv --port 4004       # a pinned one, another port
MOCK_ROWS=50 PAGE_SIZE=100 npx odata-prova ./MySrv   # settings as variables

npx odata-prova ./MySrv --explain                # filler values, and what to add to config.json
npx odata-prova ./MySrv --explain all            # how every property is generated
npx odata-prova ./MySrv --write-data             # the generated rows into MySrv/data/, to edit
npx odata-prova ./MySrv --persist ./MySrv.db     # keep the writes across restarts

# Several services: one process each, on its own port
npx odata-prova ./MySrv --port 3000 & npx odata-prova ./OtherSrv --port 3001
```

## Docker

```sh
# A pinned version, settings as variables
docker run -p 3000:3000 -v "$PWD/MySrv:/models/MySrv:ro" \
  -e MOCK_ROWS=50 -e PAGE_SIZE=100 ghcr.io/jaravan/odata-prova:0.21

# Another port on your side
docker run -p 4004:3000 -v "$PWD/MySrv:/models/MySrv:ro" ghcr.io/jaravan/odata-prova

# One model out of a folder of them
docker run -p 3000:3000 -v "$PWD/examples:/models:ro" -e MODEL_DIR=/models/Northwind ghcr.io/jaravan/odata-prova
```

Several services: one container each, on its own port. Keeping the data across restarts: [Keeping the data](persistence.md).

### --explain and --write-data with Docker

The image runs `node server.js`; add the flag after it:

```sh
docker run --rm -v "$PWD/MySrv:/models/MySrv:ro" ghcr.io/jaravan/odata-prova node server.js --explain

docker run --rm -v "$PWD/MySrv:/models/MySrv:ro" ghcr.io/jaravan/odata-prova node server.js --explain all
```

Paste what it proposes into `MySrv/config.json` on your side. A running container picks the change up through the mount, and regenerates the rows: no restart, see [Changing a column](mock-data.md#changing-a-column).

`--write-data` writes the generated rows to `MySrv/data/`, to edit them. It needs the folder writable (no `:ro`), and `--user` makes the files yours, not the container's:

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/MySrv:/models/MySrv" ghcr.io/jaravan/odata-prova node server.js --write-data
```

## Docker Compose

```yaml
services:
  odata:
    image: ghcr.io/jaravan/odata-prova:0.21
    ports: ["3000:3000"]
    volumes: ["./MySrv:/models/MySrv:ro"]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/healthz"]
      interval: 2s
```

`docker compose up -d --wait` returns once it answers. An app in the same file reaches it at `http://odata:3000`.

## In CI

A GitHub Actions job, before the app's tests:

```yaml
steps:
  - uses: actions/checkout@v4
  - run: docker run -d -p 3000:3000 -v "$PWD/MySrv:/models/MySrv:ro" ghcr.io/jaravan/odata-prova:0.21
  - run: for i in $(seq 30); do curl -sf http://localhost:3000/healthz && break; sleep 1; done
  - run: npm test
```

Without Docker, start it with `npx odata-prova ./MySrv &` instead. The rows are the same on every run.

A full project, with Fiori apps and OPA tests in CI: [fiori-devstack](https://github.com/jaravan/fiori-devstack).
