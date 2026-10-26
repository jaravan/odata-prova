# Mock data

Each entity set without a data file gets 20 generated rows, the same ones on every start ([lib/generate.ts](../lib/generate.ts)). It's decided per entity set: write files for some sets, and let the rest be generated.

The generated rows:

- **Fit the metadata:** MaxLength, Precision and Scale, enums and complex types.
- **Look plausible:** the property name picks the value, so a `Currency` holds EUR or USD, an `Email` an address, a `City` a city. Where the metadata says which property holds an amount's currency or a quantity's unit (`Measures.ISOCurrency`, `Measures.Unit`, `sap:unit`), that wins over the name.
- **Number SAP's documents as SAP does:** a purchase order is `4500000001`, a supplier ID `17300001`, by SAP's field names (`PurchaseOrder`, `Ebeln`, `Lifnr`, ...), see [SAP's field names](#saps-field-names).
- **Agree within a row:**
  - A row's city, postal code, region, country, currency, language and company code belong together: Walldorf, 69190, Germany, EUR, 1010.
  - Its material and unit come from one product, and a counted unit has a whole quantity: `5.000 PC`, but `41.650 L`. A price suits the product.
  - Its dates are in order: created or ordered first, then changed, shipped or due. An open validity ends on `9999-12-31`. Later rows have later dates, as document numbers do.
- **Agree with their header:** an order's items have its currency, company code and plant, and its total is the sum of theirs, when it's clear which properties those are. Items are numbered per order as SAP numbers them: `00010`, `00020`.
- **Link up:** foreign keys point at real rows, so navigation and `$expand` work.

`MOCK_ROWS=50` changes the row count. `MOCK_ROWS=0` turns generation off. A data file with only a header row keeps its entity set empty.

## Changing a column

When some generated values are only a stand-in, the startup says so in one line:

```
  2 properties use filler values: add --explain to see them, and what to put in config.json
```

`--explain` lists them, with the label your app shows and a sample, and a block to paste into the model's `config.json`:

```
$ npx odata-prova ./MySrv --explain
2 properties use filler values:

  PurchaseOrderSet.Incoterms   "Incoterms"   Incoterms 1
  PurchaseOrderSet.ZzProject   "Project"     38150427

To change them, add to config.json:

  "mock": {
    "PurchaseOrderSet.Incoterms": ["...", "..."],
    "PurchaseOrderSet.ZzProject": "ZZ######"
  }

Everything else looks fine. To see how every property is generated: --explain all
```

Paste it into `MySrv/config.json`, inside `{ }`, and edit the values:

```json
{
  "mock": {
    "PurchaseOrderSet.Incoterms": ["EXW", "FOB", "FOB", "CIF"],
    "PurchaseOrderSet.ZzProject": "PRJ-####"
  }
}
```

Save it, and refresh the app: every generated order has one of those Incoterms, FOB the most, and a project numbered `PRJ-0001`, `PRJ-0002`, and so on. Any property can have a rule, not only the ones `--explain` lists. `--explain all` shows how every property is generated, and what decides it.

## Editing the generated data

Rules describe columns. For particular rows ("order 4500000003 is cancelled"), write the data to files and edit them:

```sh
npx odata-prova ./MySrv --write-data    # writes MySrv/data/, 20 rows per set (--mock-rows 50 for more)
# edit the files: realistic names, the statuses you need to test, edge cases
npx odata-prova ./MySrv                 # serves your edited files
```

It writes the rows the server would generate, rules included, as CSV files (JSON for complex values), and exits. It writes only for entity sets without a data file, and never overwrites one. Delete a file to have its entity set generated again.

With Docker:

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/MySrv:/models/MySrv" ghcr.io/jaravan/odata-prova node server.js --write-data
```

`odata-prova-mock-data ./MySrv`, and `node mock-data.js` in the image, do the same.

## Derived values

Derived values aren't recalculated. Deleting an item leaves its order's total as it was: the server stores what it's sent, and has no business logic. SAP's fe-mockserver behaves the same, unless you write hooks for it.

## More

### Rule values

A rule's value is one of these:

| You write                  | Each generated row gets                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `"45########"`             | A running number in the `#`s, zero-padded to their count, the rest as written: `4500000001`, `4500000002`   |
| `"####0"`                  | The same, so an item counts by 10: `00010`, `00020`. A key part under a parent starts over for each parent. |
| `"100..50000"`             | A number in that range, with the property's decimals (on a text property, the decimals written)             |
| `"2025-01-01..2025-06-30"` | A date in that range                                                                                        |
| `"EUR"`, `5`, `true`       | Always that value                                                                                           |
| `["Open", "Approved"]`     | One of those. Repeat a value to make it more likely: `["Open", "Open", "Approved"]`                         |

A list is never read for `#` or `..`: to always write `A#1`, write `["A#1"]`.

A key only takes a running number, so every row's key is different. A foreign key always holds the key of the row it points at, so it takes no rule.

### Rule keys

- `"Set.Property"`: that entity set's property.
- `"Property"`: that property in every entity set that has it.
- `"Set.Address/City"` or `"Address/City"`: a member of a complex property.
- A collection of values (`"Tags"`) gets two values, each by the rule; a collection of complex values takes rules for its members.

Names match whatever their case. A rule sets its property only: with `"Currency": "EUR"`, the rows' cities and countries still vary, and an item still takes its order's company code.

### Sharing rules: extends

Several services can share rules, and operations, from other `config.json` files:

```json
{
  "extends": "../shared/sap-fields.json",
  "mock": { "PurchaseOrderSet.Status": ["Open", "Approved"] }
}
```

`extends` is a path, relative to the file that names it, or a list of them. Those files can extend others in turn. With Docker, mount the shared folder too: `-v "$PWD/shared:/models/shared:ro"`.

### Which rule wins

- A `"Set.Property"` rule over a `"Property"` rule.
- The model's own `config.json` over a file it extends, and a later file of an `extends` list over an earlier one.
- Any rule over [SAP's field names](#saps-field-names).

### SAP's field names

Properties named as SAP names them, in its APIs or by their DDIC names, get numbers in SAP's standard ranges with no rule, from [lib/sap-fields.ts](../lib/sap-fields.ts):

| Field                | Names                                       | Numbered     |
| -------------------- | ------------------------------------------- | ------------ |
| Purchase order       | `PurchaseOrder`, `PurchaseOrderId`, `Ebeln` | `45########` |
| Purchase order item  | `PurchaseOrderItem`, `Ebelp`                | `####0`      |
| Purchase requisition | `PurchaseRequisition`, `Banfn`              | `001#######` |
| Sales order          | `SalesOrder`, `SalesOrderId`, `Vbeln`       | `000#######` |
| Sales order item     | `SalesOrderItem`, `Posnr`                   | `#####0`     |
| Outbound delivery    | `OutboundDelivery`, `DeliveryDocument`      | `008#######` |
| Billing document     | `BillingDocument`                           | `009#######` |
| Material document    | `MaterialDocument`, `Mblnr`                 | `49########` |
| Supplier             | `Supplier`, `SupplierId`, `Lifnr`           | `173#####`   |
| Customer             | `Customer`, `CustomerId`, `Kunnr`           | `171#####`   |
| Material             | `Material`, `MaterialId`, `Matnr`           | `TG##`       |

A key named `ID`, `Id`, `Number` or `Key` goes by its entity type's name: `A_PurchaseRequisitionType.ID` is a purchase requisition's. They apply only where they fit: a number, or a text of at most 12 characters. A `Supplier` of 80 is a name, and gets one.

### Mistakes

A rule that doesn't fit the model stops the start, every mistake listed with how to fix it:

```
MySrv/config.json: 2 mock rules that don't fit the model:
  mock "PurchaseOrderSet.Staus": PurchaseOrderSet has no property Staus. Did you mean "Status"?
  mock "PurchaseOrderSet.Currency": "EURO" is 4 long, MaxLength is 3
```

A rule from a shared file that names a set or property this model doesn't have is skipped instead: `--explain all` lists it as unused.

While the server runs, a mistake doesn't stop it: the log shows the same message, and the rows stay as they were until the rules are fixed.

### Changing rules while the server runs

The server watches `config.json`, and the files it extends. When the mock rules change, the generated sets are generated again, and the log says which:

```
MySrv/config.json: mock rules changed
  PurchaseOrderSet: regenerated
  PurchaseOrderItemSet: has your changes, kept (restart to regenerate it)
```

- **Your writes are kept.** A set changed by a write since the start keeps its rows. So does a set whose rows other kept rows point at, when the new rules change its keys: `PurchaseOrderSet: kept, PurchaseOrderItemSet refers to it and has your changes`.
- **Only the sets that come out different** are replaced. Their delta links answer `410 Gone`, as after a restart.
- **Not with `--persist`:** there the rules apply at the next start, see below.
- **Only the mock rules.** A change to `operations`, `metadata.xml` or a data file needs a restart.

### With --persist

With `--persist`, the generated rows are saved at the first start, and loaded from then on. At each start after, the generated sets are generated again, by the rules as they are then, and the ones that come out different replace what was saved:

```
Saved state: loaded from MySrv.db (the rows above are not used)
The mock rules or the generator changed since the state was saved:
  PurchaseOrderSet: regenerated
  PurchaseOrderItemSet: has your changes, kept (--persist-reset to regenerate it)
```

That's a change to the mock rules, to `--mock-rows`, or a new version of odata-prova that generates rows differently. A set with your writes is kept, as is a set whose keys would change under rows with writes that point at them. `--persist-reset` starts over from the data files and generated rows, your writes dropped. With replicas on PostgreSQL, the first server that starts does it, and the others load what it saved.

A state saved by version 0.20.0 or before doesn't record which sets are as generated: its sets are all kept. Start once with `--persist-reset` for the rules to apply from then on.
