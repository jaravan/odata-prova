# Actions and functions

V4 actions and functions, bound (`People('x')/NS.ShareTrip`) and imported (`GetNearestAirport(lat=1,lon=2)`), and V2 function imports (`ApprovePurchaseOrder?PurchaseOrderId='1'`) can be called, also inside `$batch`. A mock doesn't know what an operation does, so the server:

- checks the method: `POST` for actions, `GET` for functions, `m:HttpMethod` for V2 function imports (`405` otherwise)
- reads the parameters from the JSON body (V4 actions), the path (V4 functions) or the query string (V2), and logs the call with them: `action ShareTrip on /odata/v4/TripPin/People('x') {"userName":"bob","tripId":1}`
- applies the model's rule for it, if it has one (see [What an operation changes](#what-an-operation-changes))
- answers with what the return type allows:

| Return type                                         | Response                                                       |
| --------------------------------------------------- | -------------------------------------------------------------- |
| None                                                | `204`                                                          |
| The entity type it acts on                          | That entity: an Approve on an order returns the order          |
| An entity type whose key the parameters carry       | That entity (`404` if there is none)                           |
| Any other entity type, or a collection of one       | Rows of that type's entity set, with the query options applied |
| A primitive or complex type, or a collection of one | A neutral value: `""`, `0`, `false`, an object of those, `[]`  |

Parameter aliases (`@p`) and path segments after an operation are rejected with `501`.

## On both protocols

Every operation is served on both protocols, whichever one the metadata was written for. V2 has no bound operations: SAP Gateway writes an operation on an entity as a function import that takes the entity's key as parameters and names the entity type in `sap:action-for`. The server maps one onto the other:

| V2                                                                       | V4                                                                                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Function import with `sap:action-for` and the entity's key as parameters | Action or function bound to that entity type (`EntitySetPath` set when it returns that entity, so UI5 updates the page with the result) |
| Any other function import                                                | Action or function import                                                                                                               |

An operation V2 can't express (complex or collection parameters, or bound to a type without an entity set) is left out of V2, with a `not in V2: ...` line in the startup log. [examples/PurchaseOrderSrv](../examples/PurchaseOrderSrv/) has a V2 function import, `ApprovePurchaseOrder`, which is served as a function import on V2 and as a bound action on V4; [examples/TripPin](../examples/TripPin/) has V4 operations of both kinds.

## What an operation changes

Without a rule, an operation changes no data. A model's optional `config.json` can make one set properties on the entity it acts on:

```json
{
  "operations": {
    "ApprovePurchaseOrder": { "set": { "Status": "Approved" } }
  }
}
```

The rule applies on both protocols. An operation or property the model doesn't have is an error at startup.
