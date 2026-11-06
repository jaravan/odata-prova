import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start, send, type TestServer } from "./helpers.ts";

// What fuzzing the server found, each the smallest request that shows it

const fixture = (name: string) =>
  path.join(import.meta.dirname, "fixtures", name);

const BOOK = "b0000000-0000-4000-8000-000000000001";
const book = (active: boolean) => `Books(ID=${BOOK},IsActiveEntity=${active})`;

describe("a link is held to what a PATCH is, in a draft", () => {
  let s: TestServer;
  const authorOf = (active: boolean) =>
    (s.store.rows("Books") as Record<string, unknown>[]).find(
      (b) => b.ID === BOOK && b.IsActiveEntity === active,
    )?.author_ID;

  before(async () => {
    s = await start(fixture("DraftSrv"));
  });
  after(() => s.close());

  it("PUT and DELETE $ref on an active entity -> 400, it changes through its draft", async () => {
    const author = (s.store.rows("Authors") as { ID: string }[]).at(-1)!.ID;
    const before = authorOf(true);
    const put = await send("PUT", `${s.v4}/${book(true)}/author/$ref`, {
      "@odata.id": `Authors(${author})`,
    });
    assert.equal(put.status, 400);
    assert.match(put.body.error.message, /change its draft/);
    const del = await send("DELETE", `${s.v4}/${book(true)}/author/$ref`);
    assert.equal(del.status, 400);
    assert.equal(authorOf(true), before);
  });

  it("$ref on a draft sets the draft's link, and leaves the active entity's", async () => {
    const edit = await send(
      "POST",
      `${s.v4}/${book(true)}/CatalogService.draftEdit`,
      { PreserveChanges: false },
    );
    assert.equal(edit.status, 200);
    const author = (s.store.rows("Authors") as { ID: string }[]).at(-1)!.ID;
    const active = authorOf(true);
    const put = await send("PUT", `${s.v4}/${book(false)}/author/$ref`, {
      "@odata.id": `Authors(${author})`,
    });
    assert.equal(put.status, 204);
    assert.equal(authorOf(false), author);
    assert.equal(authorOf(true), active);
  });

  it("a draft's children can't be linked to or away from it", async () => {
    const created = await send("POST", `${s.v4}/Books`, {});
    assert.equal(created.status, 201);
    const url = `${s.v4}/Books(ID=${created.body.ID},IsActiveEntity=false)`;
    const kid = await send("POST", `${url}/chapters`, {});
    assert.equal(kid.status, 201);
    const key = `(ID=${kid.body.ID},IsActiveEntity=false)`;
    const away = await send("DELETE", `${url}/chapters${key}/$ref`);
    assert.equal(away.status, 400);
    assert.match(away.body.error.message, /stays in the draft/);
    const other = await send("POST", `${s.v4}/Books`, {});
    const added = await send(
      "POST",
      `${s.v4}/Books(ID=${other.body.ID},IsActiveEntity=false)/chapters/$ref`,
      { "@odata.id": `Chapters${key}` },
    );
    assert.equal(added.status, 400);
    assert.match(added.body.error.message, /stays in the draft/);
  });

  it("a draft child can't be linked out of its draft", async () => {
    const chapter = (
      s.store.rows("Chapters") as Record<string, unknown>[]
    ).find((c) => c.book_ID === BOOK && c.IsActiveEntity === false)!;
    const other = "New";
    const created = await send("POST", `${s.v4}/Books`, { title: other });
    assert.equal(created.status, 201);
    const target = `Books(ID=${created.body.ID},IsActiveEntity=false)`;
    const url = `${s.v4}/Chapters(ID=${String(chapter.ID)},IsActiveEntity=false)`;
    const ref = await send("PUT", `${url}/book/$ref`, {
      "@odata.id": target,
    });
    assert.equal(ref.status, 400);
    assert.match(ref.body.error.message, /stays in the draft/);
    const bind = await send("PATCH", url, { "book@odata.bind": target });
    assert.equal(bind.status, 400);
    assert.equal(chapter.book_ID, BOOK);
  });
});
