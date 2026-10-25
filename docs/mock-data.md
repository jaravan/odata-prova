# Mock data

Each entity set without a data file gets 20 generated rows, the same ones on every start ([lib/generate.ts](../lib/generate.ts)). It's decided per entity set: write files for some sets, and let the rest be generated.

The generated rows:

- **Fit the metadata:** MaxLength, Precision and Scale, enums and complex types.
- **Look plausible:** the property name picks the value, so a `Currency` holds EUR or USD, an `Email` an address, a `City` a city. Where the metadata says which property holds an amount's currency or a quantity's unit (`Measures.ISOCurrency`, `Measures.Unit`, `sap:unit`), that wins over the name.
- **Agree within a row:**
  - A row's city, postal code, region, country, currency, language and company code belong together: Walldorf, 69190, Germany, EUR, 1010.
  - Its material and unit come from one product, and a counted unit has a whole quantity: `5.000 PC`, but `41.650 L`. A price suits the product.
  - Its dates are in order: created or ordered first, then changed, shipped or due. An open validity ends on `9999-12-31`. Later rows have later dates, as document numbers do.
- **Agree with their header:** an order's items have its currency, and its total is the sum of theirs, when it's clear which properties those are. Items are numbered per order as SAP numbers them: `00010`, `00020`.
- **Link up:** foreign keys point at real rows, so navigation and `$expand` work.

`MOCK_ROWS=50` changes the row count. `MOCK_ROWS=0` turns generation off. A data file with only a header row keeps its entity set empty.

## Editing the generated data

To edit the generated data, write it to files:

```sh
npx odata-prova ./MySrv --write-data    # writes MySrv/data/, 20 rows per set (--mock-rows 50 for more)
# edit the files: realistic names, the statuses you need to test, edge cases
npx odata-prova ./MySrv                 # serves your edited files
```

It writes the rows the server would generate, as CSV files (JSON for complex values), and exits. It writes only for entity sets without a data file, and never overwrites one. Delete a file to have its entity set generated again.

With Docker:

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/MySrv:/models/MySrv" ghcr.io/jaravan/odata-prova node server.js --write-data
```

`odata-prova-mock-data ./MySrv`, and `node mock-data.js` in the image, do the same.

## Derived values

Derived values aren't recalculated. Deleting an item leaves its order's total as it was: the server stores what it's sent, and has no business logic. SAP's fe-mockserver behaves the same, unless you write hooks for it.
