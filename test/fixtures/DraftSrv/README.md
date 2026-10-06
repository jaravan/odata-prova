# DraftSrv

A draft-enabled CAP service, for `test/draft.test.js`: `Books` (draft root) composes
`Chapters` (draft node) and associates `Authors`, which is not draft-enabled.

`metadata.xml` is CAP's output, unmodified, for the model in `cds/`. To regenerate it:

```sh
npx -p @sap/cds-dk cds compile test/fixtures/DraftSrv/cds --to edmx > test/fixtures/DraftSrv/metadata.xml
```

Generated with @sap/cds-dk 10.1.0 (@sap/cds-compiler 7.1.0). The seed files in `data/` have no
draft columns, like CAP's.
