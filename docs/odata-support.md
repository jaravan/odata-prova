# Supported OData features

## Types

All primitive Edm types, plus:

- **Complex types**, nested and in collections. In V2 a complex value carries its type in `__metadata`, as SAP Gateway sends it.
- **Enum types** (V4). V2 has no enums, so there they are `Edm.String` holding the member name.
- **Collection-valued properties** (V4). V2 has none, so they are left out of the V2 service, with a `not in V2: ...` line in the startup log.
- **Inheritance** (`BaseType`). Each derived type gets its base's key, properties and navigations, so the generated `$metadata` needs no `BaseType`.

In a CSV data file, a complex or collection value goes in its cell as JSON. Filtering or sorting on a field inside a complex value is not supported.

The tests load Northwind (V2 and V4) and TripPin unmodified, see [test/fixtures/real](../test/fixtures/real/).

## Query options

Reads and writes, `$filter`, `$orderby`, `$top`, `$skip`, `$select`, `$expand` (including nested V4 options like `$expand=Items($select=Material;$top=2)`), `$count`/`$inlinecount`, `$search`, and `$batch` (with atomic changesets) all work, on both protocols.

`$filter` includes the V4 lambda operators, which Fiori Elements V4 sends for filter fields on a to-many navigation: `Items/any(i:i/Material eq 'MAT-1001')`, `Items/all(i:i/Unit eq 'TO')` and `Items/any()`, over navigations and collection-valued properties (`Emails/any(e:endswith(e,'contoso.com'))`), nested, and with `$it` for the entity outside the lambda.

## Drafts

A V4 entity set annotated with `Common.DraftRoot` or `Common.DraftNode`, as CAP and RAP generate them, is served as draft-enabled (the startup log lists them as `draft-enabled: ...`):

- Seeded and generated rows are active entities: `IsActiveEntity` true, `HasActiveEntity` and `HasDraftEntity` false. Seed files don't need those columns, so CAP's work as they are.
- A composition (`Books` to `chapters` and back) also joins on `IsActiveEntity`, so an active entity reaches active children and a draft its drafts. Any other navigation into a draft-enabled set reaches its active entities.
- `SiblingEntity` and `DraftAdministrativeData` resolve, so the list report's `SiblingEntity/IsActiveEntity eq null` filter and the object page's `$expand=DraftAdministrativeData` work.

Editing works the way Fiori Elements V4 drives it, with the actions the `DraftRoot` annotation names:

| Request                                            | Effect                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST Books(ID=...,IsActiveEntity=true)/draftEdit` | Copies the entity and its compositions into a draft. With `PreserveChanges: true` and a draft already there: `409`; without, the old draft is replaced. |
| `PATCH` / `PUT` on a draft                         | Changes the draft. `HasActiveEntity` and `HasDraftEntity` are left to the server.                                                                       |
| `POST Books(...,IsActiveEntity=false)/chapters`    | A new draft child. A missing `Edm.Guid` or integer key is generated, since Fiori Elements sends none.                                                   |
| `DELETE` on a draft child                          | Removes it from the draft (and from the active entity on activation).                                                                                   |
| `draftPrepare`                                     | Returns the draft: the mock has nothing to validate.                                                                                                    |
| `draftActivate`                                    | Writes the draft tree over the active one, deletes the children removed in the draft, and drops the draft.                                              |
| `DELETE` on a draft root                           | Discards the draft.                                                                                                                                     |
| `DELETE` on an active root                         | Deletes it, with its draft and compositions.                                                                                                            |

Active entities change only through a draft: a `PATCH` on one, a `POST` under one, or a `DELETE` of an active child is a `400`. Each of these requests is atomic, and inside a `$batch` changeset it rolls back with the rest. There is one user, `anonymous`, who owns every draft; `DraftAdministrativeData` says so. The V2 service of the same model calls the actions as function imports (`POST draftEdit?ID=guid'...'&IsActiveEntity=true`).

Not yet: creating a new entity as a draft (`POST Books`), and draft annotations in V2 metadata.

## Not supported

Rejected with `501 Not Implemented`: `$apply`, `$compute`, `$skiptoken`, `$deltatoken`, and any `$format` other than JSON. Not yet: creating new entities as drafts (see [Drafts](#drafts)) and ETags.

A navigation the server can't join (for example a many-to-many link without a `ReferentialConstraint`) doesn't stop the service from starting. It is disabled with a `navigation disabled: ...` line in the startup log, and requests that use it get a `501` saying why.
