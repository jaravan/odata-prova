# Northwind (OData V4)

An example of a model written in OData V4; [PurchaseOrderSrv](../PurchaseOrderSrv/) is written
in V2. The server serves either one as both V2 and V4:

```sh
node server.js examples/Northwind    # from the repo root; or: npx odata-prova examples/Northwind
curl 'http://localhost:3000/odata/v4/Northwind/Products?$expand=Category,Supplier'
curl 'http://localhost:3000/odata/v2/Northwind/Products?$expand=Category,Supplier'
```

`metadata.xml` is OData.org's Northwind service, unmodified
(https://services.odata.org/V4/Northwind/Northwind.svc/$metadata). `data/` holds a few rows of
Microsoft's Northwind sample database for `Categories`, `Suppliers` and `Products`; the server
generates mock data for the other entity sets. The Northwind data is Copyright (c) Microsoft Corporation, published
under the MIT License in [microsoft/sql-server-samples](https://github.com/microsoft/sql-server-samples).
