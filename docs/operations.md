# Actions and functions

You can call V4 actions and functions, bound (`People('x')/NS.ShareTrip`) and imported (`GetNearestAirport(lat=1,lon=2)`), and V2 function imports (`ApprovePurchaseOrder?PurchaseOrderId='1'`), in `$batch` too.

A mock doesn't know what an operation does, so the server:

- checks the method: `POST` for actions, `GET` for functions, `m:HttpMethod` for V2 function imports (`405` otherwise)
- reads the parameters: from the JSON body (V4 actions), the path (V4 functions) or the query string (V2). It logs the call with them: `action ShareTrip on /odata/v4/TripPin/People('x') {"userName":"bob","tripId":1}`
- checks a V4 action's body as it checks an entity's: a parameter the action doesn't have, or a value of the wrong JSON type, is a `400`
- applies the model's rule for it, if it has one (see [What an operation changes](#what-an-operation-changes))
- answers with what the return type allows:

| Return type                                         | Response                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| None                                                | `204`                                                                                                                 |
| The entity type it acts on                          | That entity: an Approve on an order returns the order                                                                 |
| An entity type whose key the parameters carry       | That entity (`404` if there is none)                                                                                  |
| Any other entity type, or a collection of one       | Rows of that type's entity set, with the query options applied                                                        |
| A primitive or complex type, or a collection of one | A neutral value: `""`, `0`, `false`, today's date, an all-zero GUID, an enum's first member, an object of those, `[]` |

Parameter aliases (`@p`) and path segments after an operation are rejected with `501`.

## On both protocols

Every operation is served on both protocols, whichever one the metadata was written for.

V2 has no bound operations. SAP Gateway writes an operation on an entity as a function import that takes the entity's key as parameters, and names the entity type in `sap:action-for`. The server maps one onto the other:

| V2                                                                       | V4                                                                                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Function import with `sap:action-for` and the entity's key as parameters | Action or function bound to that entity type (`EntitySetPath` set when it returns that entity, so UI5 updates the page with the result) |
| Any other function import                                                | Action or function import                                                                                                               |

Each V2 parameter says whether it's optional (`Nullable="true"`), as SAP Gateway writes it: Fiori Elements V2 takes a parameter without it as required, and won't call the function import without it.

An operation V2 can't express is left out of V2: one with complex or collection parameters, or bound to a type without an entity set. The startup log says so, in a `not in V2: ...` line.

To try it: [examples/PurchaseOrderSrv](../examples/PurchaseOrderSrv/) has a V2 function import, `ApprovePurchaseOrder`, served as a function import on V2 and as a bound action on V4. [examples/TripPin](../examples/TripPin/) has V4 operations of both kinds.

## What an operation changes

Without a rule, an operation changes no data. A model's optional `config.json` can make one set properties on the entity it acts on:

```json
{
  "operations": {
    "ApprovePurchaseOrder": { "set": { "Status": "Approved" } }
  }
}
```

The rule applies on both protocols. An operation or property the model doesn't have is an error at startup. Rules can also come from a shared file, see [extends](mock-data.md#sharing-rules-extends).

What a rule changes is a write like any other: rolled back when the request fails, and saved with [`--persist`](persistence.md), even when the operation is a function called with `GET`.
