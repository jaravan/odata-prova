# Mock data

Each entity set without a data file gets 20 generated rows, the same ones on every start ([lib/generate.ts](../lib/generate.ts)). It's decided per entity set: write files for some sets, and let the rest be generated.

The generated rows:

- **Fit the metadata:** MaxLength, Precision and Scale, enums and complex types.
- **Look plausible:** the property name picks the value, so a `Currency` holds EUR or USD, an `Email` an address, a `City` a city.
- **Link up:** foreign keys point at real rows, so navigation and `$expand` work. When a foreign key is part of the key (an order's items), the rest of the key counts up per parent.

`MOCK_ROWS=50` changes the row count. `MOCK_ROWS=0` turns generation off. A data file with only a header row keeps its entity set empty.

## Editing the generated data

To edit the generated data, write it to files:

```sh
npx -p odata-prova odata-prova-mock-data ./MySrv    # writes MySrv/data/, 20 rows per set (add a number for more)
# edit the files: realistic names, the statuses you need to test, edge cases
npx odata-prova ./MySrv                             # serves your edited files
```

It writes the rows the server would generate, as CSV files (JSON for complex values). It writes only for entity sets without a data file, and never overwrites one. Delete a file to have its entity set generated again.

With Docker:

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/MySrv:/model" ghcr.io/jaravan/odata-prova node mock-data.js /model
```

## Derived values

Derived values aren't recalculated. Deleting an item leaves its order's total as it was: the server stores what it's sent, and has no business logic. SAP's fe-mockserver behaves the same, unless you write hooks for it.
