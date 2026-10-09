# Contributing

Issues and pull requests are welcome. For a bug, a feature, or a `metadata.xml` the server can't handle, [open an issue](https://github.com/jaravan/odata-prova/issues/new/choose) first.

## Set up

You need Node.js 22.18 or later with Corepack (`corepack enable`, for the pinned Yarn 4), and Docker to build the image. 22.18 is the first Node 22 release that runs TypeScript files directly, which the tests and `yarn dev` rely on; the published package needs only Node 22.

```sh
yarn install
yarn dev        # serves examples/PurchaseOrderSrv on port 3000, restarting on changes
node server.js examples/TripPin   # any other model
```

## Test

```sh
yarn test
yarn typecheck
yarn format:check   # yarn format fixes it
```

CI runs all three on every push and pull request.

## Changes

- One change per commit, with a [Conventional Commits](https://www.conventionalcommits.org/) message, e.g. `fix(filter): ...`, `feat(v4): ...`, `docs(readme): ...`. Say in the body why, not only what.
- A fix comes with a test that fails without it. For a metadata problem, add the smallest `metadata.xml` that shows it under `test/fixtures/`.
- Tests use the fixtures, not `examples/`: the example data there may change. Only `test/models.test.js` loads the examples, to check that each one still works.
- Only add third-party files, such as sample metadata or data, if their license allows it, and credit them in [NOTICE](NOTICE).
