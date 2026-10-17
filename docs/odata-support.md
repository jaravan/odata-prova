# Supported OData features

## Types

All primitive Edm types, plus:

- **Complex types**, nested and in collections. In V2 a complex value carries its type in `__metadata`, as SAP Gateway sends it.
- **Enum types** (V4). V2 has no enums, so there they are `Edm.String` holding the member name.
- **Collection-valued properties** (V4). V2 has none, so they are left out of the V2 service, with a `not in V2: ...` line in the startup log.
- **Inheritance** (`BaseType`). Each derived type gets its base's key, properties and navigations, so the generated `$metadata` needs no `BaseType`.

In a CSV data file, a complex or collection value goes in its cell as JSON. Filtering or sorting on a field inside a complex value is not supported.

Writes are checked against the metadata: a value that doesn't fit its type, or a `Nullable="false"` property that a create, `PUT` or `PATCH` leaves null, is a `400`. Properties the client may not set (`Core.Computed`, or `sap:creatable` or `sap:updatable` `"false"`) aren't required, and neither is anything in a draft, which may be incomplete until it is activated.

The tests load Northwind (V2 and V4) and TripPin unmodified, with every navigation working, see [test/fixtures/real](../test/fixtures/real/).

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

Arithmetic in `$filter` follows the spec's numeric promotion: `div` of two integers rounds towards zero (`Quantity div 2`), `divby` doesn't, and an operation with a null is null, which no comparison matches. A minus negates: `-Price lt -100`, `-(Price sub Discount)`.

### Computed properties (`$compute`)

V4's `$compute` adds properties to each entity, from an expression written as in `$filter`, under an alias:

```
GET /odata/v4/MySrv/PurchaseOrderItemSet?$compute=Quantity mul NetPrice as LineTotal&$filter=LineTotal gt 5000&$orderby=LineTotal desc
```

A computed property is in the response, and `$filter`, `$orderby` and `$select` use it like one of the entity's own. The expression can use the entity's properties, paths through single-valued navigations (`PurchaseOrder/Status`), arithmetic and the `$filter` functions, and its type follows from them: `Quantity mul NetPrice` of two decimals is an `Edm.Decimal`, `year(OrderDate)` an `Edm.Int32`. It works on a collection, a single entity, `/$count`, and in an `$expand` (`Items($compute=...;$select=LineTotal)`).

A mistake in it (an unknown property, an alias that is already a property, arithmetic on text) is a `400`. It isn't supported together with `$apply`, nor in V2, which has no `$compute`: both are a `501`.

### Server-driven paging

With `PAGE_SIZE` set (`createApp`'s `pageSize` option), a collection's response holds at most that many rows, and a link to the next page: `@odata.nextLink` in V4, `d.__next` in V2. Following the links gives every row the query asks for, `$skip` and `$top` included. The count from `$count=true` or `$inlinecount=allpages` stays the total on every page. That's how SAP Gateway and CAP answer a large collection, so an app can be tried against a backend that pages.

```
GET /odata/v4/MySrv/PurchaseOrderSet?$orderby=OrderDate      (PAGE_SIZE=2)

{ "value": [ ...2 orders... ],
  "@odata.nextLink": "/odata/v4/MySrv/PurchaseOrderSet?$orderby=OrderDate&$skiptoken=2" }
```

The link is the request with a `$skiptoken`: where the next page starts among the rows the query options leave. A client sends it back as it is; a `$skiptoken` also works without paging. UI5's V2 and V4 models don't follow the link: they take it as a sign that there are more rows, and read the next ones with `$skip` and `$top`, which works as before.

A V4 client can ask for smaller pages with `Prefer: odata.maxpagesize=N`, which works without `PAGE_SIZE` too, and is confirmed in `Preference-Applied`. A larger one than `PAGE_SIZE` is not. Paging applies to an entity set, a navigation's collection, a function's result and an `$apply` result, not to collections in an `$expand`. It's off by default, as a client that ignores the links would see only the first page.

### Delta links

A V4 client can track the changes to an entity set: it reads the set with `Prefer: odata.track-changes`, and gets an `@odata.deltaLink` with the last page. Reading that link later answers what has changed since, with the next delta link:

```
GET /odata/v4/MySrv/PurchaseOrderSet?$filter=Status eq 'Open'&$deltatoken=m1x2k3-1

{ "@odata.context": "/odata/v4/MySrv/$metadata#PurchaseOrderSet/$delta",
  "value": [
    { "PurchaseOrderId": "4500000003", "Status": "Open", ... },
    { "@odata.context": "/odata/v4/MySrv/$metadata#PurchaseOrderSet/$deletedEntity",
      "id": "/odata/v4/MySrv/PurchaseOrderSet('4500000001')", "reason": "changed" } ],
  "@odata.deltaLink": "/odata/v4/MySrv/PurchaseOrderSet?$filter=Status eq 'Open'&$deltatoken=m1x2k3-2" }
```

The delta has the entities added or changed that match the link's `$filter` and `$search`, with its `$select` and `$expand`. Each entity that matched before and is deleted, or no longer matches, gets a `$deletedEntity` entry, with `"reason": "deleted"` or `"changed"`. Changes come from any write: a create, update or delete, a draft activated, or an operation's `config.json` rule.

A delta link is for an entity set, read without `$apply`, `$compute`, `$skip` or `$top`; for other reads the preference isn't applied, and `Preference-Applied` says so. The server keeps the latest 100 delta links, and none across a restart: an older one is a `410 Gone`, and the client reads the set again. A change inside an expanded navigation isn't a change of the entity. V2 has no delta links: `$deltatoken` there is a `501`.

### Aggregation (`$apply`)

V4's `$apply` groups and aggregates, as UI5's V4 model asks for grouped tables and totals: `$apply=filter(Status ne 'Cancelled')/groupby((Currency),aggregate(TotalAmount with sum as Total,$count as Count))`. Transformations are separated by `/` and run in order, before the other query options, which then work on the result, its aliases included (`&$filter=Total gt 10000&$orderby=Total desc`).

- `filter(...)`, `search(...)`, `orderby(...)`, `skip(n)` and `top(n)`: as the query options of the same names. `identity` leaves the rows as they are.
- `compute(Amount mul 2 as Double,...)`: a property for each row, as [`$compute`](#computed-properties-compute) adds it, which the transformations after it use: `compute(month(OrderDate) as Month)/groupby((Month),aggregate($count as Count))`. Its rows are copies, written as the result's rows, not entities to expand.
- `topcount(n,P)` and `bottomcount(n,P)`: the `n` rows with the highest or lowest values of `P`, a property, an alias, a path or an expression (`TotalAmount mul Quantity`, `length(Name)`), in that order. `P` can be any value with an order: text goes alphabetically, dates by time. `topsum(s,P)` and `bottomsum(s,P)`: the fewest of them, from the highest or the lowest, whose values add up to at least `s`. `toppercent(p,P)` and `bottompercent(p,P)`: the same, up to `p` percent of the total, where `P` is a number. Rows whose value is null are left out.
- `groupby((A,B))`: one row per distinct combination of `A` and `B`, with an `aggregate(...)` after the properties to aggregate each group. Any other sequence after them runs on each group's rows, one group after the other: `groupby((Currency),topcount(1,TotalAmount))` gives the highest order of each currency, still entities. Rows the sequence makes, such as an aggregate's, get the group's values: `groupby((Currency),aggregate(TotalAmount with sum as Total)/filter(Total gt 10000))`.
- Paths through single-valued navigations, to group or aggregate by a related entity's property, as UI5 groups by a text it reaches through a navigation: on order items, `groupby((PurchaseOrder/Status),aggregate(NetPrice with sum as Total))`. The response nests the path, `{"PurchaseOrder":{"Status":"Open"},"Total":"38.20"}`, and the other query options use it as it is: `$orderby=PurchaseOrder/Status`. A navigation that leads nowhere gives `null`.
- Paths through a collection navigation. Grouping by one copies each row for each entity the navigation leads to, and the other paths through it read that entity: on orders, `groupby((Items/Currency),aggregate(Items/NetPrice with sum as Total,$count as Count))` sums and counts the items of each currency. The response nests the path as a list, `{"Items":[{"Currency":"EUR"}],"Total":"7438.70","Count":"5"}`. Aggregating one without grouping by it takes the values of all the related entities: `aggregate(Items/NetPrice with sum as Total)` sums the items of all the orders.
- `groupby((A,B),filter(...))`: the rows of each group that pass the filter, in which `$these/aggregate(...)` is an aggregate over the group's rows (in any filter of a groupby's sequence). That's how UI5 filters groups on their totals (`$$filterOnAggregate`): `groupby((Country),filter($these/aggregate(Amount) gt 1000))/groupby((Country),aggregate(Amount))` gives the countries whose amounts add up to more than 1000. `$these/aggregate` takes a custom aggregate (`Amount`), `Amount with sum` (or any other method), or `$count`.
- `aggregate(...)`: one row for all of them, with `P with sum as Alias`, `min`, `max`, `average` and `countdistinct`, and `$count as Alias`. Nulls are left out. Counts, and the sum or average of anything but a `Double` or `Single`, are `Edm.Decimal` (a string with `IEEE754Compatible=true`), and decimals add up exactly. So does their average, rounded when it doesn't end: 16 digits more than the values have.
- Custom aggregates, which UI5 asks for with no `with` when the metadata declares them (`Aggregation.CustomAggregate`, on the entity type or set): `aggregate(Amount,Currency)`, or `aggregate(Amount as Total)`. The metadata says what type the result is but not how it is computed, so the server aggregates the property of the same name: a number is summed, and anything else, such as a currency or a unit, is the value all the rows share, or `null` when they differ, which is how UI5 shows amounts in mixed currencies.
- `concat(A,B,...)`: runs each sequence on the same rows and puts their results one after the other. UI5 uses it for the rows it needs besides the ones it shows: `concat(aggregate(Amount with min as UI5min__Amount,$count as UI5__count),skip(0)/top(20))` answers with the minimum and the count in a first row, then a page of rows. Each row has only the properties of its own sequence.

The result rows have no key, so no ETag, and the context lists their properties: `$metadata#PurchaseOrderSet(Currency,Total,Count)`. `$select` picks among them, as UI5 sends it with `identity`. A row that is still one of the entities, which `identity`, `filter`, `search`, `orderby`, `skip`, `top`, the ranks, `traverse` and a groupby's sequence of those pass on, is written as an entity, with its ETag, and `$expand` expands it: `$apply=concat(aggregate($count as UI5__count),identity)&$expand=Items($select=Material)`. `$expand` on a result with no entities left, after an `aggregate`, `groupby` or `compute`, is a `400`. `$apply` works on an operation's result too, when it's a collection of entities: `GetOpenOrders()?$apply=groupby((Status),aggregate(Amount with sum as Total))`. On any other result it's a `400`, checked before an action runs. A mistake in `$apply` (an unknown property, a sum of a string, an alias that is already a property, a custom aggregate the metadata doesn't declare) is a `400`.

`501`, never ignored: a custom aggregation method (`Amount with Custom.median`) or a custom aggregate with no property of its name, which the metadata doesn't say how to compute, a path through more than one collection navigation, and `$apply` in V2, which has none. Ranking by a path through a collection navigation, which has no single value for a row, is a `400`.

### Hierarchies

A recursive hierarchy, as UI5's tree tables show one, is declared on an entity type by two annotations with the same qualifier, which CAP writes for `@hierarchy`: `Aggregation.RecursiveHierarchy`, with the node property and the navigation to a node's parent, and `Hierarchy.RecursiveHierarchy`, with the properties the server fills in for each node it answers with: `DrillState`, `DistanceFromRoot`, `LimitedDescendantCount` and `LimitedRank`.

UI5 asks for the first levels with `TopLevels`: `$apply=com.sap.vocabularies.Hierarchy.v1.TopLevels(HierarchyNodes=$root/Genres,HierarchyQualifier='GenresHierarchy',NodeProperty='ID',Levels=2)`. The answer is the nodes with fewer ancestors than `Levels` (all of them without it) in preorder, siblings in the order of the rows before it (`orderby(name)/TopLevels(...)`). `ExpandLevels=[{"NodeID":"4","Levels":1}]` shows more levels below a node, all of them with `"Levels":null`, or collapses it with `0`. Each node's `DrillState` is `expanded` when its children are in the answer, `collapsed` when it has some that aren't, and `leaf` when it has none. The nodes are still entities, with their key, ETag and `$expand`.

To expand a node, UI5 asks for its children with `descendants`, and to search or filter, for the matching nodes and their ancestors with `ancestors`, followed by `TopLevels`:

- `descendants($root/Genres,GenresHierarchy,ID,filter(ID eq 4),1)`: the rows below the nodes the transformations (here `filter(ID eq 4)`) give, down to the distance (`1`: the children), or all of them without one.
- `ancestors($root/Genres,GenresHierarchy,ID,search(Epic),keep start)`: the rows above them, up to the distance or the roots. Then `TopLevels` shows the matches expanded down to them.

`keep start` keeps the nodes the transformations give, and the rows keep their order.

`Show=["5","8"]` in `TopLevels` shows those nodes: every ancestor of each is expanded, even one `ExpandLevels` collapses. A node ID that isn't among the rows is left alone.

`traverse($root/Genres,GenresHierarchy,ID,preorder)` puts the rows in the hierarchy's order, each parent before its children, or after them with `postorder`. Expressions after the order sort the roots and siblings: `traverse(...,preorder,name desc)`. The order is the whole hierarchy's, so a row keeps its place when its parent isn't among the rows (`filter(ID ne 4)/traverse(...)`). Unlike `TopLevels`, nothing is filled in, and the rows stay entities. Parents come from the whole hierarchy (`$root/Genres`), and the properties are filled in relative to the answer: `DistanceFromRoot` is the depth from the real root.

A node whose parent isn't among the rows is a root. Parents that go round in a cycle, as generated rows can have them, are broken at the first node in the rows' order, so every node shows once. Hierarchy nodes other than an entity set (`$root/Genres`) are a `501`.

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

## Errors

An error answers in the protocol's shape: `{"error":{"code":...,"message":...}}` in V4, and the same with `"message":{"lang":"en","value":...}` in V2. Its `code` is one a client can branch on. Where it can act on the error, the code says how:

| `code`             | Status | When                                                                  |
| ------------------ | ------ | --------------------------------------------------------------------- |
| `RequiredProperty` | `400`  | a create or update leaves a `Nullable="false"` property or a key null |
| `InvalidValue`     | `400`  | a value doesn't fit its property's type                               |
| `DuplicateKey`     | `409`  | a create's key is already taken                                       |
| `DraftExists`      | `409`  | an edit draft of the entity already exists                            |
| `ETagMismatch`     | `412`  | the `If-Match` ETag has gone stale: read the entity again             |
| `ETagRequired`     | `428`  | `ETAGS=strict`, and an update or delete sends no `If-Match`           |
| `DeltaLinkExpired` | `410`  | a delta link no longer kept: read the entity set again                |

Any other error's code is its status's: `BadRequest` (`400`), `NotFound` (`404`), `MethodNotAllowed` (`405`), `Conflict` (`409`), `PayloadTooLarge` (`413`), `NotImplemented` (`501`) or `InternalError` (`500`).

## Not supported

Rejected with `501 Not Implemented`: `$apply` and `$compute` in V2, `$compute` with `$apply`, `$deltatoken` in V2, the parts of `$apply` listed under [Aggregation](#aggregation-apply), and any `$format` other than JSON. `If-None-Match` is ignored: a read always answers with the entity.

## Navigations without a ReferentialConstraint

A navigation without a `ReferentialConstraint` (on either side) is joined by naming: on the source's key names when the target has them (an item keyed by `SalesOrder` + `ItemNo` under a sales order keyed by `SalesOrder`), or on a foreign key named after the other side (`Item.OrderID`, `Item.Order_ID`, CAP's `author_ID`). Each such join is logged as `navigation joined by naming: ...`, since it's a guess. A match that would join two types' whole keys to each other (an order's `ID` to its items' `ID`) is only taken for a one-to-one link, never for one with a "many" side or from a type to itself.

A navigation with nothing to join on, such as TripPin's `Person.Photo`, gets a key of its own: a hidden column for each of the target's keys, named `<Navigation>_<Key>` (`Photo_Id`), the name a guess would have looked for. A data file fills it like any other column, and generated rows point it at real ones:

```
data/People.csv
UserName;FirstName;Photo_Id
russellwhyte;Russell;1
```

Its partner, a collection (an order's `Lines`, for a line's `Order`), joins back on the same column. The column is the server's, not the service's: no response or `$metadata` shows it, and the generated `$metadata` has no constraint for the navigation. Each one is logged as `navigation with a key of its own: ...`. For now it's filled from data files only: a write doesn't change it.

A collection with nothing to join on, a many-to-many link such as TripPin's `Person.Friends` or Northwind's `Customer.CustomerDemographics`, gets links of its own: a link set of key pairs, named after the source's entity set and the navigation. A navigation and its partner share one. A data file fills it, and generated data links each row to up to three others:

```
data/People-Friends.csv
UserName;Friends_UserName
russellwhyte;scottketchum
russellwhyte;ronaldmundy
```

Each one is logged as `navigation with links of its own: Person.Friends in People-Friends`, which names its file. Creating an entity through the navigation (`POST People('russellwhyte')/Friends`, or a deep insert) links it, deleting an entity removes its links, and a failed `$batch` changeset takes them back.

A containment navigation (`ContainsTarget`) whose target no entity set holds, such as TripPin's `Person.Trips`, gets an entity set of its own, named after the parent's set and the navigation (`People-Trips`, and `People-Trips-PlanItems` below it). It's in no service document or `$metadata`, and is reached only through its parent: `People('russellwhyte')/Trips(1001)/PlanItems`. A contained entity's key is unique only under its parent, so its rows keep their parent's keys in hidden columns, named after the parent's type (`Person_UserName`, then `Trip_TripId`), which a data file fills:

```
data/People-Trips.csv
Person_UserName;TripId;Name
russellwhyte;1001;Trip in US
scottketchum;1001;Trip in Beijing
```

Creating one through the navigation puts it under that parent, at the parent's URL (`Location: .../People('russellwhyte')/Trips(1002)`), and deleting the parent deletes everything it contains. V2 has no containment, so these navigations aren't in the V2 service. Each one is logged as `navigation with an entity set of its own: ...`.

A guess can be wrong, and then the navigation shows other entities' rows, which look just as real. `JOINS=strict` (`createApp`'s `joins` option) guesses none: such a navigation gets a key of its own instead, which links nothing until a data file fills it, or is disabled as below when it can't have one. A constraint on one side only, as CAP writes them, is not a guess: the other side takes it from its partner in either mode.

A navigation the server can't join (one to an entity type no entity set holds, outside containment) doesn't stop the service from starting. It is disabled with a `navigation disabled: ...` line in the startup log, and requests that use it get a `501` saying why.
