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

## SAP annotations in the generated V4 metadata

For a V2 `metadata.xml`, the V4 service's `$metadata` carries its `sap:` attributes as the V4 annotations SAP names for them in [SAP Annotations for OData Version 2.0](https://sap.github.io/odata-vocabularies/docs/v2-annotations.html), so a Fiori Elements V4 app gets the same texts, units and restrictions as a V2 app:

| V2                                                                                                                | V4                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `sap:label`, `sap:heading`, `sap:quickinfo`                                                                       | `Common.Label`, `Common.Heading`, `Common.QuickInfo` (`sap:label` on an entity type too)              |
| `sap:text`                                                                                                        | `Common.Text`                                                                                         |
| `sap:unit`                                                                                                        | `Measures.ISOCurrency` when it names a `sap:semantics="currency-code"` property, else `Measures.Unit` |
| `sap:semantics` `currency-code`, `unit-of-measure`                                                                | `Common.IsCurrency`, `Common.IsUnit`                                                                  |
| `sap:display-format="UpperCase"`                                                                                  | `Common.IsUpperCase`                                                                                  |
| `sap:field-control`                                                                                               | `Common.FieldControl`                                                                                 |
| `sap:value-list="fixed-values"`                                                                                   | `Common.ValueListWithFixedValues`                                                                     |
| `sap:visible="false"`                                                                                             | `UI.Hidden`                                                                                           |
| `sap:creatable` and `sap:updatable` `"false"` on a property                                                       | `Core.Computed` (both) or `Core.Immutable` (`sap:updatable` only)                                     |
| `sap:creatable`, `sap:updatable`, `sap:deletable` (or `-path`) on an entity set                                   | `Capabilities.InsertRestrictions`, `UpdateRestrictions`, `DeleteRestrictions`                         |
| `sap:searchable`                                                                                                  | `Capabilities.SearchRestrictions`                                                                     |
| `sap:pageable`, `sap:countable`, `sap:addressable` `"false"`                                                      | `Capabilities.TopSupported` and `SkipSupported`, `CountRestrictions`, `IndexableByKey`                |
| `sap:requires-filter`, and `sap:filterable`, `sap:required-in-filter`, `sap:filter-restriction` on its properties | `Capabilities.FilterRestrictions`                                                                     |
| `sap:sortable` on its properties                                                                                  | `Capabilities.SortRestrictions`                                                                       |

As in SAP Gateway, an entity set with `sap:` attributes but no `sap:searchable="true"` is not searchable, so a Fiori Elements V4 app shows no search field for it. A term the document's own `<Annotations>` blocks already set on the same target is left out, and the terms use the document's alias for a vocabulary it references.

These annotations only describe the service: the server itself still accepts a `$search`, a filter on a non-filterable property or a create in a non-creatable entity set.

## V4 annotations in the generated V2 metadata

For a V4 `metadata.xml`, the V2 service's `$metadata` carries all of its annotations, which UI5's V2 model reads and puts before anything it derives from `sap:` attributes. They are written the way UI5 reads them:

- Every `<Annotations>` block is in the V4 namespace (`xmlns="http://docs.oasis-open.org/odata/ns/edm"`): UI5 skips blocks in any other.
- Every `<edmx:Reference>` declares V4's edmx namespace, as SAP Gateway writes them: UI5 resolves a term's alias (`UI.Hidden` to `com.sap.vocabularies.UI.v1.Hidden`) only from references in it.
- An annotation written inline on an element, such as a property, an entity set or an action, moves into a block targeting that element, since V2 elements can't carry one.
- Targets use namespaces, not the schema's alias (`SAP__self.Orders` is written `com.example.Orders`): UI5 resolves only the aliases of `<edmx:Reference>`.
- An action or function is targeted as the function import V2 serves it as (see [Actions and functions](operations.md)): `Ns.Approve(Ns.Order)` becomes `Ns.Container/Approve`, and `Ns.Approve` without a binding becomes every function import of `Approve`. An action import's target becomes its function import's too.

Two `sap:` attributes are written as well, where UI5 reads an attribute and not an annotation:

- `sap:searchable="true"` on every entity set, unless its annotations say `Capabilities.SearchRestrictions/Searchable` false. Without it, UI5 takes an entity set as not searchable, while V4 takes it as searchable.
- `sap:applicable-path` on a function import whose action has `Core.OperationAvailable` with a path (`_it/CanApprove` becomes `CanApprove`), which enables the action's button in Fiori Elements V2.

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
| `draftPrepare`                                     | Returns the draft: required values are checked on activation.                                                                                                                                                                                                      |
| `draftActivate`                                    | Checks the draft tree's required values (`400` if one is missing, and the draft stays), then writes it over the active one (creating it, for a new entity), deletes the children removed in the draft, and drops the draft.                                        |
| `DELETE` on a draft root                           | Discards the draft.                                                                                                                                                                                                                                                |
| `DELETE` on an active root                         | Deletes it, with its draft and compositions.                                                                                                                                                                                                                       |

Active entities change only through a draft: a `PATCH` on one, a `POST` under one, or a `DELETE` of an active child is a `400`. Each of these requests is atomic, and inside a `$batch` changeset it rolls back with the rest. There is one user, `anonymous`, who owns every draft; `DraftAdministrativeData` says so, and is read-only.

**V2.** SAP Gateway and RAP put the same annotations in V2 metadata, with the actions as function import paths (`Srv.Srv_Entities/TravelEdit`); those are read too. Whichever version the metadata is, the V2 service calls the actions as function imports (`POST TravelEdit?TravelUUID=guid'...'&IsActiveEntity=true`) and the V4 service as bound actions. The V4 service's `$metadata` names them as bound actions too (`EditAction="Srv.TravelEdit"`), since Fiori Elements V4 calls them by that name, and an annotation on a function import targets its bound action (`Srv.TravelEdit(Srv.TravelType)`).

Limits:

- A draft and its active entity share the key except `IsActiveEntity`, as in CAP and RAP. Older BOPF-based services that key drafts by a `DraftUUID` aren't supported.
- A `DraftAdministrativeData` entity set in the metadata (RAP's `I_DraftAdministrativeData`) keeps its own rows: the records are reachable through the navigation only.
- No validation besides required values on activation, no side effects, and no locks between users.

## ETags

An entity set has ETags when the metadata names the properties they're made of: `Core.OptimisticConcurrency` on the set (V4, as CAP writes it for `@odata.etag`), or `ConcurrencyMode="Fixed"` on properties of its type (V2, as SAP Gateway writes it). The other protocol's `$metadata` says the same in its own terms.

- **Reading.** An entity's ETag is in the `ETag` header of a single-entity response, and in the payload as `@odata.etag` (V4) or `__metadata.etag` (V2), expanded entities included. It is those properties' values, e.g. `W/"2026-01-01T10:00:00.000Z"`.
- **Writing.** A `PUT`, `PATCH`, `MERGE` or `DELETE`, or an action on the entity, sent with an `If-Match` that holds neither the entity's current ETag nor `*` is a `412`: the entity has changed since it was read, and nothing changes. A successful update answers with the new ETag.
- **New values.** The server sets the ETag's properties on every create and change, as CAP does for a managed `modifiedAt` and RAP for its last-changed timestamp, so another client's ETag goes stale: a timestamp moves to now, a number counts up (an integer at the top of its type's range starts again at the bottom), a GUID or string is new. A boolean or a time of day has no next value and keeps its own. A value the client sends for one is replaced.

`ETAGS` sets how strict the checks are:

| `ETAGS`             | Without `If-Match`              | With a stale one |
| ------------------- | ------------------------------- | ---------------- |
| `lenient` (default) | the change goes through         | `412`            |
| `strict`            | `428` for an update or a delete | `412`            |
| `off`               | the change goes through         | ignored          |

`strict` is what the OData spec asks of a service with ETags; an action still runs without `If-Match`, which the spec leaves to the service, and so does a change to a draft. `off` still sends the ETags, so a client that reads them works as before. In code, it's `createApp`'s `etags` option.

UI5 sends the ETag it read on its own, so a Fiori app needs nothing more. To try a `412` by hand, read an entity, change it from another client (`If-Match: *`), and then change it with the first ETag.

## Not supported

Rejected with `501 Not Implemented`: `$apply`, `$compute`, `$skiptoken`, `$deltatoken`, and any `$format` other than JSON. `If-None-Match` is ignored: a read always answers with the entity.

## Navigations without a ReferentialConstraint

A navigation without a `ReferentialConstraint` (on either side) is joined by naming: on the source's key names when the target has them (an item keyed by `SalesOrder` + `ItemNo` under a sales order keyed by `SalesOrder`), or on a foreign key named after the other side (`Item.OrderID`, `Item.Order_ID`, CAP's `author_ID`). Each such join is logged as `navigation joined by naming: ...`, since it's a guess. A match that would join two types' whole keys to each other (an order's `ID` to its items' `ID`) is only taken for a one-to-one link, never for one with a "many" side or from a type to itself.

A guess can be wrong, and then the navigation shows other entities' rows, which look just as real. `JOINS=strict` (`createApp`'s `joins` option) guesses none: such a navigation is disabled instead, as below, with `add one to metadata.xml` as the reason. A constraint on one side only, as CAP writes them, is not a guess: the other side takes it from its partner in either mode.

A navigation the server can't join (for example a many-to-many link without a `ReferentialConstraint`) doesn't stop the service from starting. It is disabled with a `navigation disabled: ...` line in the startup log, and requests that use it get a `501` saying why.
