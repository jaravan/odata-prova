# Northwind (OData V4)

An example of a model written in OData V4. [PurchaseOrderSrv](../PurchaseOrderSrv/) is written
in V2. The server serves either one as both V2 and V4:

```sh
node server.ts examples/Northwind    # from the repo root; or: npx odata-prova examples/Northwind
curl 'http://localhost:3000/odata/v4/Northwind/Products?$expand=Category,Supplier'
curl 'http://localhost:3000/odata/v2/Northwind/Products?$expand=Category,Supplier'
```

`metadata.xml` is OData.org's Northwind service, unmodified
(https://services.odata.org/V4/Northwind/Northwind.svc/$metadata).

`data/` holds a few rows of Microsoft's Northwind sample database for `Categories`, `Suppliers`
and `Products`. The server generates mock data for the other entity sets.

`config.json` shapes some of the generated columns, see [Mock data](../../docs/mock-data.md#changing-a-column):

- `"CustomerID": "C####"` numbers the customers `C0001`, `C0002`, and so on, and the
  `CustomerID` columns of `Invoices` and `Orders_Qries` the same way, so they name customers
  that exist. They and `Employees.Extension` were the filler values `--explain` listed. An
  order's customer follows anyway: it's a foreign key.
- `Employees.Title` picks from a list, a sales representative the most likely.
- `Employees.HireDate`, `Freight` and `ShipVia` get realistic ranges: hired 2012 to 2024, a
  freight of 1 to 250, one of the three shippers.

Edit it while the server runs, and the generated rows follow.

The Northwind data is Copyright (c) Microsoft Corporation, published under the MIT License in
[microsoft/sql-server-samples](https://github.com/microsoft/sql-server-samples).
