# Supported OData features

## Types

All primitive Edm types, plus:

- **Complex types**, nested and in collections. In V2 a complex value carries its type in `__metadata`, as SAP Gateway sends it.
- **Enum types** (V4). V2 has no enums, so there they are `Edm.String` holding the member name.
- **Collection-valued properties** (V4). V2 has none, so they are left out of the V2 service, with a `not in V2: ...` line in the startup log.
- **Inheritance** (`BaseType`). Each derived type gets its base's key, properties and navigations, so the generated `$metadata` needs no `BaseType`.

In a CSV data file, a complex or collection value goes in its cell as JSON. Filtering or sorting on a field inside a complex value is not supported.

Writes are checked against the metadata: a value that doesn't fit its type, or a `Nullable="false"` property that a create, `PUT` or `PATCH` leaves null, is a `400`. Properties the client may not set (`Core.Computed`, or `sap:creatable` or `sap:updatable` `"false"`) aren't required, and neither is anything in a draft, which may be incomplete until it is activated.

The tests load Northwind (V2 and V4) and TripPin unmodified, see [test/fixtures/real](../test/fixtures/real/).

## Query options

Reads and writes, `$filter`, `$orderby`, `$top`, `$skip`, `$select`, `$expand` (including nested V4 options like `$expand=Items($select=Material;$top=2)`), `$count`/`$inlinecount`, `$search`, and `$batch` (with atomic changesets) all work, on both protocols. A `$select` of something that is neither a property nor a navigation of the type is a `400`, like an unknown `$expand`.

`$filter` includes the V4 lambda operators, which Fiori Elements V4 sends for filter fields on a to-many navigation: `Items/any(i:i/Material eq 'MAT-1001')`, `Items/all(i:i/Unit eq 'TO')` and `Items/any()`, over navigations and collection-valued properties (`Emails/any(e:endswith(e,'contoso.com'))`), nested, and with `$it` for the entity outside the lambda.

## Drafts

An entity set annotated with `Common.DraftRoot` or `Common.DraftNode`, as CAP and RAP generate them, is served as draft-enabled (the startup log lists them as `draft-enabled: ...`):

- Seeded and generated rows are active entities: `IsActiveEntity` true, `HasActiveEntity` and `HasDraftEntity` false. Seed files don't need those columns, so CAP's work as they are.
- A composition (`Books` to `chapters` and back) also joins on `IsActiveEntity`, so an active entity reaches active children and a draft its drafts. Any other navigation into a draft-enabled set reaches its active entities.
- `SiblingEntity` and `DraftAdministrativeData` resolve, so the list report's `SiblingEntity/IsActiveEntity eq null` filter and the object page's `$expand=DraftAdministrativeData` work.

Creating and editing work the way Fiori Elements drives them, with the actions the `DraftRoot` annotation names:

| Request                                            | Effect                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST Books`                                       | A new entity, as a draft with no active entity yet. A missing `Edm.Guid` or integer key is generated (a string key too, when it can hold 36 characters), since Fiori Elements sends none. The annotation's `NewAction`, if any, does the same from its parameters. |
| `POST Books(ID=...,IsActiveEntity=true)/draftEdit` | Copies the entity and its compositions into a draft. With `PreserveChanges: true` and a draft already there: `409`; without, the old draft is replaced.                                                                                                            |
| `PATCH` / `PUT` on a draft                         | Changes the draft. `HasActiveEntity` and `HasDraftEntity` are left to the server.                                                                                                                                                                                  |
| `POST Books(...,IsActiveEntity=false)/chapters`    | A new draft child, its key generated the same way. A node can't be created on its own (`POST Chapters`).                                                                                                                                                           |
| `DELETE` on a draft child                          | Removes it from the draft (and from the active entity on activation).                                                                                                                                                                                              |
| `draftPrepare`                                     | Returns the draft: the mock has nothing to validate.                                                                                                                                                                                                               |
| `draftActivate`                                    | Writes the draft tree over the active one (creating it, for a new entity), deletes the children removed in the draft, and drops the draft.                                                                                                                         |
| `DELETE` on a draft root                           | Discards the draft.                                                                                                                                                                                                                                                |
| `DELETE` on an active root                         | Deletes it, with its draft and compositions.                                                                                                                                                                                                                       |

Active entities change only through a draft: a `PATCH` on one, a `POST` under one, or a `DELETE` of an active child is a `400`. Each of these requests is atomic, and inside a `$batch` changeset it rolls back with the rest. There is one user, `anonymous`, who owns every draft; `DraftAdministrativeData` says so, and is read-only.

**V2.** SAP Gateway and RAP put the same annotations in V2 metadata, with the actions as function import paths (`Srv.Srv_Entities/TravelEdit`); those are read too. Whichever version the metadata is, the V2 service calls the actions as function imports (`POST TravelEdit?TravelUUID=guid'...'&IsActiveEntity=true`) and the V4 service as bound actions.

Limits:

- A draft and its active entity share the key except `IsActiveEntity`, as in CAP and RAP. Older BOPF-based services that key drafts by a `DraftUUID` aren't supported.
- A `DraftAdministrativeData` entity set in the metadata (RAP's `I_DraftAdministrativeData`) keeps its own rows: the records are reachable through the navigation only.
- No validation, side effects, or locks between users.

## Not supported

Rejected with `501 Not Implemented`: `$apply`, `$compute`, `$skiptoken`, `$deltatoken`, and any `$format` other than JSON. Not yet: ETags.

A navigation without a `ReferentialConstraint` (on either side) is joined by naming: on the source's key names when the target has them (an item keyed by `SalesOrder` + `ItemNo` under a sales order keyed by `SalesOrder`), or on a foreign key named after the other side (`Item.OrderID`, `Item.Order_ID`, CAP's `author_ID`). Each such join is logged as `navigation joined by naming: ...`, since it's a guess. A match that would join two types' whole keys to each other (an order's `ID` to its items' `ID`) is only taken for a one-to-one link, never for one with a "many" side or from a type to itself.

A navigation the server can't join (for example a many-to-many link without a `ReferentialConstraint`) doesn't stop the service from starting. It is disabled with a `navigation disabled: ...` line in the startup log, and requests that use it get a `501` saying why.
