# Mock data

Each entity set without a data file gets 20 generated rows, the same ones on every start ([lib/generate.js](../lib/generate.js)). This is decided per entity set, so you can write files for some sets and let the rest be generated:

- Values fit the metadata: MaxLength, Precision and Scale, enums and complex types.
- Property names pick plausible values: a `Currency` holds EUR or USD, an `Email` an address, a `City` a city.
- Foreign keys point at real rows, so navigation and `$expand` work. When a foreign key is part of the key (an order's items), the rest of the key counts up per parent.

`MOCK_ROWS=50` changes the row count, and `MOCK_ROWS=0` turns generation off. A data file with only a header row keeps its entity set empty.

## Editing the generated data

To edit the generated data, write it to files:

```sh
npx -p odata-prova odata-prova-mock-data ./MySrv    # writes MySrv/data/, 20 rows per set (add a number for more)
# edit the files: realistic names, the statuses you need to test, edge cases
npx odata-prova ./MySrv                             # serves your edited files
```

It writes the same rows the server generates, as CSV files (JSON for complex values), and only for entity sets without a data file; it never overwrites one. Delete a file to have that entity set generated again. With Docker: `docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/MySrv:/model" ghcr.io/jaravan/odata-prova node mock-data.js /model`.

## Derived values

Derived values aren't recalculated: deleting an item leaves its order's total as it was, since the server stores what it's sent and has no business logic. SAP's fe-mockserver behaves the same unless you write hooks for it.
