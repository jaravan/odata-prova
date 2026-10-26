# PurchaseOrderSrv (OData V2)

An SAP Gateway style purchase order service, written in OData V2, with its items and a function
import. [Northwind](../Northwind/) is written in V4. The server serves either one as both V2 and
V4:

```sh
node server.ts examples/PurchaseOrderSrv    # from the repo root; or: npx odata-prova examples/PurchaseOrderSrv
curl 'http://localhost:3000/odata/v2/PurchaseOrderSrv/PurchaseOrderSet?$expand=Items'
curl 'http://localhost:3000/odata/v4/PurchaseOrderSrv/PurchaseOrderSet?$expand=Items'
```

There's no `data/`: every row is generated, the way an SAP system would have them. Orders are
numbered in SAP's range, `4500000001` and on, their items `00010`, `00020`. An item has its
order's currency, and its material's unit and price; an order's total is the sum of its items.

`config.json` holds the rest, see [Mock data](../../docs/mock-data.md#changing-a-column):

- `PurchaseOrderSet.Status` picks from a list, most orders `Open`: an item repeated is more
  likely.
- `PurchaseOrderItemSet.Description` picks from a list too, and `Quantity` is a range, whole for
  materials counted in pieces.
- `operations` makes the function import `ApprovePurchaseOrder` set the order's `Status` to
  `Approved` (see [Actions and functions](../../docs/operations.md)):

```sh
curl -X POST "http://localhost:3000/odata/v2/PurchaseOrderSrv/ApprovePurchaseOrder?PurchaseOrderId='4500000002'"
```

Edit `config.json` while the server runs, and the generated rows follow. `--write-data` writes
them to `data/`, to edit row by row.
