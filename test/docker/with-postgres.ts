// Runs the persistence tests against a PostgreSQL in a container: `yarn test:postgres`. Needs
// Docker. CI points POSTGRES_URL at a service container instead, and `yarn test` runs them with
// the rest.
import { spawnSync } from "node:child_process";
import { GenericContainer, Wait } from "testcontainers";

const container = await new GenericContainer("postgres:17-alpine")
  .withEnvironment({ POSTGRES_PASSWORD: "test" })
  .withExposedPorts(5432)
  // The image starts the server, stops it once initialized, then starts it for good
  .withWaitStrategy(
    Wait.forLogMessage(/database system is ready to accept connections/, 2),
  )
  .start();

let status: number | null;
try {
  const url = `postgres://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/postgres`;
  ({ status } = spawnSync(
    process.execPath,
    ["--test", "test/persistence-flows.test.ts", "test/postgres.test.ts"],
    { stdio: "inherit", env: { ...process.env, POSTGRES_URL: url } },
  ));
} finally {
  await container.stop();
}
process.exit(status ?? 1);
