const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { start, get, send } = require("./helpers");
const { parseMetadata } = require("../lib/metadata");

// A draft-enabled CAP service: Books (DraftRoot) composes Chapters (DraftNode), and
// associates Authors, which is not draft-enabled. The seed files have no draft columns.
const DRAFT_MODEL = path.join(__dirname, "fixtures", "DraftSrv");
const XML = fs.readFileSync(path.join(DRAFT_MODEL, "metadata.xml"), "utf8");
const BOOK = "b0000000-0000-4000-8000-000000000001";
const book = (active = true) => `Books(ID=${BOOK},IsActiveEntity=${active})`;

describe("draft: model", () => {
  it("reads DraftRoot and DraftNode, through the Common alias", () => {
    const model = parseMetadata(XML);
    assert.deepEqual(model.entitySets.Books.draft, {
      root: true,
      actions: {
        activate: "CatalogService.draftActivate",
        edit: "CatalogService.draftEdit",
        prepare: "CatalogService.draftPrepare",
        new: undefined,
      },
    });
    assert.equal(model.entitySets.Chapters.draft.root, false);
    assert.equal(model.entitySets.Authors.draft, undefined);
    assert.deepEqual(model.warnings, []);
  });

  it("reads the vocabulary's namespace and inline annotations on the entity set", () => {
    const inline = XML.replace(
      '<EntitySet Name="Authors" EntityType="CatalogService.Authors"/>',
      `<EntitySet Name="Authors" EntityType="CatalogService.Authors"/>
        <EntitySet Name="Drafts" EntityType="CatalogService.Books">
          <Annotation Term="com.sap.vocabularies.Common.v1.DraftRoot">
            <Record><PropertyValue Property="EditAction" String="CatalogService.draftEdit"/></Record>
          </Annotation>
        </EntitySet>`,
    );
    const model = parseMetadata(inline);
    assert.equal(model.entitySets.Drafts.draft.actions.edit, "CatalogService.draftEdit");
  });

  it("ignores a draft annotation on an entity set without an IsActiveEntity key", () => {
    const model = parseMetadata(
      XML.replace("CatalogService.EntityContainer/Chapters", "CatalogService.EntityContainer/Authors"),
    );
    assert.equal(model.entitySets.Authors.draft, undefined);
    assert.match(model.warnings.join("\n"), /draft ignored: Authors has no IsActiveEntity key property/);
  });

  it("joins the composition on IsActiveEntity too, the association to a plain set not", () => {
    const { entityTypes } = parseMetadata(XML);
    const books = entityTypes["CatalogService.Books"];
    assert.deepEqual(books.navigations.chapters.join, [["ID", "book_ID"], ["IsActiveEntity", "IsActiveEntity"]]);
    assert.deepEqual(entityTypes["CatalogService.Chapters"].navigations.book.join, [["book_ID", "ID"], ["IsActiveEntity", "IsActiveEntity"]]);
    assert.deepEqual(books.navigations.author.join, [["author_ID", "ID"]]);
    // The draft navigations stay out of what the emitters and the generator see
    assert.equal(books.navigations.SiblingEntity, undefined);
    assert.deepEqual(Object.keys(books.draftNavigations), ["DraftAdministrativeData", "SiblingEntity"]);
  });
});

describe("draft: reading active entities (V4)", () => {
  let s;
  before(async () => (s = await start(DRAFT_MODEL)));
  after(() => s.close());

  it("serves seeded rows as active entities without a draft", async () => {
    const r = await get(`${s.v4}/Books?$select=title,IsActiveEntity,HasActiveEntity,HasDraftEntity`);
    assert.equal(r.status, 200);
    assert.equal(r.body.value.length, 2);
    for (const row of r.body.value) {
      assert.equal(row.IsActiveEntity, true);
      assert.equal(row.HasActiveEntity, false);
      assert.equal(row.HasDraftEntity, false);
    }
  });

  it("answers the list report's request", async () => {
    const r = await get(
      `${s.v4}/Books?$count=true&$filter=(IsActiveEntity eq false or SiblingEntity/IsActiveEntity eq null)` +
        "&$select=ID,title,HasActiveEntity,HasDraftEntity,IsActiveEntity" +
        "&$expand=DraftAdministrativeData($select=DraftUUID,InProcessByUser,LastChangedByUser)",
    );
    assert.equal(r.status, 200);
    assert.equal(r.body["@odata.count"], 2);
    assert.equal(r.body.value[0].DraftAdministrativeData, null);
  });

  it("answers the object page's request", async () => {
    const r = await get(`${s.v4}/${book()}?$expand=chapters($select=title),author($select=name),SiblingEntity,DraftAdministrativeData`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.chapters.map((c) => c.title), ["Chapter I", "Chapter II"]);
    assert.equal(r.body.author.name, "Emily Brontë");
    assert.equal(r.body.SiblingEntity, null);
    assert.equal(r.body.DraftAdministrativeData, null);
  });

  it("an entity with no sibling or draft data: 204 on the navigation", async () => {
    assert.equal((await get(`${s.v4}/${book()}/SiblingEntity`)).status, 204);
    assert.equal((await get(`${s.v4}/${book()}/DraftAdministrativeData`)).status, 204);
    assert.equal((await get(`${s.v4}/${book(false)}`)).status, 404);
  });

  it("keeps a draft child out of the active parent's composition, and links the sibling", async () => {
    const draft = { ID: "c0000000-0000-4000-8000-000000000001", book_ID: BOOK, title: "Draft chapter", pages: 1, IsActiveEntity: false, HasActiveEntity: true, HasDraftEntity: false };
    s.store.insert("Chapters", draft);
    try {
      const r = await get(`${s.v4}/${book()}/chapters?$select=title`);
      assert.deepEqual(r.body.value.map((c) => c.title), ["Chapter I", "Chapter II"]);
      const active = await get(`${s.v4}/Chapters(ID=${draft.ID},IsActiveEntity=true)?$expand=SiblingEntity($select=title)`);
      assert.equal(active.body.SiblingEntity.title, "Draft chapter");
      const back = await get(`${s.v4}/Chapters(ID=${draft.ID},IsActiveEntity=false)/book?$select=title`);
      assert.equal(back.status, 204); // a draft chapter's book is the draft book, which doesn't exist
    } finally {
      s.store.remove("Chapters", s.model.entityTypes["CatalogService.Chapters"], { ID: draft.ID, IsActiveEntity: false });
    }
  });

  it("draft actions are not supported yet: 501", async () => {
    const r = await send("POST", `${s.v4}/${book()}/CatalogService.draftEdit`, { PreserveChanges: true });
    assert.equal(r.status, 501);
    assert.match(r.body.error.message, /draftEdit/);
  });

  it("V2 serves the same active entities", async () => {
    const r = await get(`${s.v2}/Books(ID=guid'${BOOK}',IsActiveEntity=true)?$expand=chapters`, { accept: "application/json" });
    assert.equal(r.status, 200);
    assert.equal(r.body.d.chapters.results.length, 2);
    assert.equal((await get(`${s.v2}/$metadata`)).status, 200);
  });
});

describe("draft: generated rows", () => {
  let s;
  before(async () => {
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "draft-"));
    fs.copyFileSync(path.join(DRAFT_MODEL, "metadata.xml"), path.join(dir, "metadata.xml"));
    s = await start(dir, { mockRows: 5 });
    s.dir = dir;
  });
  after(async () => {
    await s.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  });

  it("are active entities, and the compositions join", async () => {
    const r = await get(`${s.v4}/Books?$expand=chapters`);
    assert.equal(r.body.value.length, 5);
    for (const b of r.body.value) {
      assert.equal(b.IsActiveEntity, true);
      assert.equal(b.HasDraftEntity, false);
      for (const c of b.chapters) assert.equal(c.IsActiveEntity, true);
    }
    assert.ok(r.body.value.some((b) => b.chapters.length > 0));
  });
});
