const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { start, get, send, batch, batchResponses } = require("./helpers");
const { parseMetadata } = require("../lib/metadata");

// A draft-enabled CAP service, metadata as cds compiles it (see the fixture's README): Books
// (DraftRoot) composes Chapters (DraftNode), and associates Authors, which is not
// draft-enabled. The seed files have no draft columns.
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
    // CAP's DraftMessages is a collection, which V2 has no place for
    assert.ok(
      model.warnings.every((w) =>
        /^not in V2: .*is a collection-valued property$/.test(w)
      ),
      model.warnings.join("\n")
    );
  });

  it("reads the vocabulary's namespace and inline annotations on the entity set", () => {
    const inline = XML.replace(
      '<EntitySet Name="Authors" EntityType="CatalogService.Authors"/>',
      `<EntitySet Name="Authors" EntityType="CatalogService.Authors"/>
        <EntitySet Name="Drafts" EntityType="CatalogService.Books">
          <Annotation Term="com.sap.vocabularies.Common.v1.DraftRoot">
            <Record><PropertyValue Property="EditAction" String="CatalogService.draftEdit"/></Record>
          </Annotation>
        </EntitySet>`
    );
    const model = parseMetadata(inline);
    assert.equal(
      model.entitySets.Drafts.draft.actions.edit,
      "CatalogService.draftEdit"
    );
  });

  it("ignores a draft annotation on an entity set without an IsActiveEntity key", () => {
    const model = parseMetadata(
      XML.replace(
        "CatalogService.EntityContainer/Chapters",
        "CatalogService.EntityContainer/Authors"
      )
    );
    assert.equal(model.entitySets.Authors.draft, undefined);
    assert.match(
      model.warnings.join("\n"),
      /draft ignored: Authors has no IsActiveEntity key property/
    );
  });

  it("joins the composition on IsActiveEntity too, the association to a plain set not", () => {
    const { entityTypes } = parseMetadata(XML);
    const books = entityTypes["CatalogService.Books"];
    assert.deepEqual(books.navigations.chapters.join, [
      ["ID", "book_ID"],
      ["IsActiveEntity", "IsActiveEntity"],
    ]);
    assert.deepEqual(
      entityTypes["CatalogService.Chapters"].navigations.book.join,
      [
        ["book_ID", "ID"],
        ["IsActiveEntity", "IsActiveEntity"],
      ]
    );
    assert.deepEqual(books.navigations.author.join, [["author_ID", "ID"]]);
    // The draft navigations stay out of what the emitters and the generator see
    assert.equal(books.navigations.SiblingEntity, undefined);
    assert.deepEqual(Object.keys(books.draftNavigations), [
      "DraftAdministrativeData",
      "SiblingEntity",
    ]);
  });
});

describe("draft: reading active entities (V4)", () => {
  let s;
  before(async () => (s = await start(DRAFT_MODEL)));
  after(() => s.close());

  it("serves seeded rows as active entities without a draft", async () => {
    const r = await get(
      `${s.v4}/Books?$select=title,IsActiveEntity,HasActiveEntity,HasDraftEntity,DraftMessages`
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.value.length, 2);
    for (const row of r.body.value) {
      assert.equal(row.IsActiveEntity, true);
      assert.equal(row.HasActiveEntity, false);
      assert.equal(row.HasDraftEntity, false);
      assert.deepEqual(row.DraftMessages, []); // a collection is never null
    }
  });

  it("answers the list report's request", async () => {
    const r = await get(
      `${s.v4}/Books?$count=true&$filter=(IsActiveEntity eq false or SiblingEntity/IsActiveEntity eq null)` +
        "&$select=ID,title,HasActiveEntity,HasDraftEntity,IsActiveEntity" +
        "&$expand=DraftAdministrativeData($select=DraftUUID,InProcessByUser,LastChangedByUser)"
    );
    assert.equal(r.status, 200);
    assert.equal(r.body["@odata.count"], 2);
    assert.equal(r.body.value[0].DraftAdministrativeData, null);
  });

  it("answers the object page's request", async () => {
    const r = await get(
      `${
        s.v4
      }/${book()}?$expand=chapters($select=title),author($select=name),SiblingEntity,DraftAdministrativeData`
    );
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.chapters.map((c) => c.title),
      ["Chapter I", "Chapter II"]
    );
    assert.equal(r.body.author.name, "Emily Brontë");
    assert.equal(r.body.SiblingEntity, null);
    assert.equal(r.body.DraftAdministrativeData, null);
  });

  it("an entity with no sibling or draft data: 204 on the navigation", async () => {
    assert.equal((await get(`${s.v4}/${book()}/SiblingEntity`)).status, 204);
    assert.equal(
      (await get(`${s.v4}/${book()}/DraftAdministrativeData`)).status,
      204
    );
    assert.equal((await get(`${s.v4}/${book(false)}`)).status, 404);
  });

  it("keeps a draft child out of the active parent's composition, and links the sibling", async () => {
    const draft = {
      ID: "c0000000-0000-4000-8000-000000000001",
      book_ID: BOOK,
      title: "Draft chapter",
      pages: 1,
      IsActiveEntity: false,
      HasActiveEntity: true,
      HasDraftEntity: false,
    };
    s.store.insert("Chapters", draft);
    try {
      const r = await get(`${s.v4}/${book()}/chapters?$select=title`);
      assert.deepEqual(
        r.body.value.map((c) => c.title),
        ["Chapter I", "Chapter II"]
      );
      const active = await get(
        `${s.v4}/Chapters(ID=${draft.ID},IsActiveEntity=true)?$expand=SiblingEntity($select=title)`
      );
      assert.equal(active.body.SiblingEntity.title, "Draft chapter");
      const back = await get(
        `${s.v4}/Chapters(ID=${draft.ID},IsActiveEntity=false)/book?$select=title`
      );
      assert.equal(back.status, 204); // a draft chapter's book is the draft book, which doesn't exist
    } finally {
      s.store.remove(
        "Chapters",
        s.model.entityTypes["CatalogService.Chapters"],
        { ID: draft.ID, IsActiveEntity: false }
      );
    }
  });

  it("V2 serves the same active entities", async () => {
    const r = await get(
      `${s.v2}/Books(ID=guid'${BOOK}',IsActiveEntity=true)?$expand=chapters`,
      { accept: "application/json" }
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.d.chapters.results.length, 2);
    assert.equal((await get(`${s.v2}/$metadata`)).status, 200);
  });
});

describe("draft: generated rows", () => {
  let s;
  before(async () => {
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "draft-"));
    fs.copyFileSync(
      path.join(DRAFT_MODEL, "metadata.xml"),
      path.join(dir, "metadata.xml")
    );
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

// The requests Fiori Elements V4 sends for Edit, changes, Save and Discard
const ACTION = (name) => `CatalogService.${name}`;
const LIST_FILTER =
  "$filter=(IsActiveEntity eq false or SiblingEntity/IsActiveEntity eq null)";

describe("draft: edit, change and activate (V4)", () => {
  let s, newChapter;
  before(async () => (s = await start(DRAFT_MODEL)));
  after(() => s.close());

  it("draftEdit copies the entity and its compositions into a draft", async () => {
    const r = await send(
      "POST",
      `${s.v4}/${book()}/${ACTION(
        "draftEdit"
      )}?$select=title,IsActiveEntity,HasActiveEntity,HasDraftEntity`,
      { PreserveChanges: true }
    );
    assert.equal(r.status, 200);
    assert.match(r.body["@odata.context"], /#Books\/\$entity$/);
    assert.deepEqual(
      {
        title: r.body.title,
        IsActiveEntity: r.body.IsActiveEntity,
        HasActiveEntity: r.body.HasActiveEntity,
        HasDraftEntity: r.body.HasDraftEntity,
      },
      {
        title: "Wuthering Heights",
        IsActiveEntity: false,
        HasActiveEntity: true,
        HasDraftEntity: false,
      }
    );
    const chapters = await get(
      `${s.v4}/${book(
        false
      )}/chapters?$select=title,IsActiveEntity,HasActiveEntity`
    );
    assert.deepEqual(
      chapters.body.value.map((c) => [
        c.title,
        c.IsActiveEntity,
        c.HasActiveEntity,
      ]),
      [
        ["Chapter I", false, true],
        ["Chapter II", false, true],
      ]
    );
  });

  it("the active entity knows it has a draft, and the list shows the draft in its place", async () => {
    const active = await get(
      `${
        s.v4
      }/${book()}?$select=HasDraftEntity&$expand=SiblingEntity($select=IsActiveEntity),DraftAdministrativeData`
    );
    assert.equal(active.body.HasDraftEntity, true);
    assert.equal(active.body.SiblingEntity.IsActiveEntity, false);
    assert.equal(
      active.body.DraftAdministrativeData.InProcessByUser,
      "anonymous"
    );
    assert.equal(active.body.DraftAdministrativeData.DraftIsCreatedByMe, true);

    const list = await get(
      `${s.v4}/Books?${LIST_FILTER}&$select=title,IsActiveEntity&$orderby=title`
    );
    assert.deepEqual(
      list.body.value.map((b) => [b.title, b.IsActiveEntity]),
      [
        ["Jane Eyre", true],
        ["Wuthering Heights", false],
      ]
    );
  });

  it("a second draftEdit preserving changes is a 409; the active entity can't be changed", async () => {
    const again = await send(
      "POST",
      `${s.v4}/${book()}/${ACTION("draftEdit")}`,
      { PreserveChanges: true }
    );
    assert.equal(again.status, 409);
    assert.equal(
      (await send("PATCH", `${s.v4}/${book()}`, { title: "x" })).status,
      400
    );
    assert.equal(
      (await send("POST", `${s.v4}/${book()}/chapters`, { title: "x" })).status,
      400
    );
    assert.equal(
      (await send("POST", `${s.v4}/${book(false)}/${ACTION("draftEdit")}`, {}))
        .status,
      400
    );
  });

  it("PATCH changes the draft only, and the draft columns stay the server's", async () => {
    const r = await send("PATCH", `${s.v4}/${book(false)}`, {
      title: "Wuthering Heights (2nd ed.)",
      HasActiveEntity: false,
    });
    assert.equal(r.status, 204);
    const draft = (await get(`${s.v4}/${book(false)}`)).body;
    assert.equal(draft.title, "Wuthering Heights (2nd ed.)");
    assert.equal(draft.HasActiveEntity, true);
    assert.equal(
      (await get(`${s.v4}/${book()}`)).body.title,
      "Wuthering Heights"
    );
  });

  it("POST to a draft's composition creates a new draft child, with a generated key", async () => {
    const r = await send("POST", `${s.v4}/${book(false)}/chapters`, {
      title: "Chapter III",
      pages: 5,
    });
    assert.equal(r.status, 201);
    assert.match(r.body.ID, /^[0-9a-f-]{36}$/);
    assert.equal(r.body.book_ID, BOOK);
    assert.equal(r.body.IsActiveEntity, false);
    assert.equal(r.body.HasActiveEntity, false);
    newChapter = r.body.ID;
  });

  it("DELETE on a draft child removes it from the draft", async () => {
    const r = await send(
      "DELETE",
      `${s.v4}/Chapters(ID=c0000000-0000-4000-8000-000000000002,IsActiveEntity=false)`
    );
    assert.equal(r.status, 204);
    const chapters = await get(
      `${s.v4}/${book(false)}/chapters?$select=title&$orderby=title`
    );
    assert.deepEqual(
      chapters.body.value.map((c) => c.title),
      ["Chapter I", "Chapter III"]
    );
  });

  it("draftPrepare returns the draft", async () => {
    const r = await send(
      "POST",
      `${s.v4}/${book(false)}/${ACTION("draftPrepare")}`,
      { SideEffectsQualifier: "" }
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.IsActiveEntity, false);
  });

  it("draftActivate writes the draft over the active entity and removes the draft", async () => {
    const r = await send(
      "POST",
      `${s.v4}/${book(false)}/${ACTION(
        "draftActivate"
      )}?$expand=chapters($select=ID,title;$orderby=title)`,
      {}
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.IsActiveEntity, true);
    assert.equal(r.body.HasDraftEntity, false);
    assert.equal(r.body.title, "Wuthering Heights (2nd ed.)");
    assert.deepEqual(
      r.body.chapters.map((c) => c.title),
      ["Chapter I", "Chapter III"]
    );
    assert.equal(r.body.chapters[1].ID, newChapter);

    assert.equal((await get(`${s.v4}/${book(false)}`)).status, 404);
    assert.equal(
      (await get(`${s.v4}/Chapters?$filter=IsActiveEntity eq false`)).body.value
        .length,
      0
    );
    assert.equal(
      (
        await get(
          `${s.v4}/Chapters(ID=c0000000-0000-4000-8000-000000000002,IsActiveEntity=true)`
        )
      ).status,
      404
    );
    const active = await get(
      `${
        s.v4
      }/${book()}?$expand=DraftAdministrativeData,chapters($select=HasDraftEntity)`
    );
    assert.equal(active.body.DraftAdministrativeData, null);
    assert.ok(active.body.chapters.every((c) => c.HasDraftEntity === false));
    assert.equal(
      (await send("POST", `${s.v4}/${book()}/${ACTION("draftActivate")}`, {}))
        .status,
      400
    );
  });
});

describe("draft: discard and delete (V4)", () => {
  let s;
  before(async () => (s = await start(DRAFT_MODEL)));
  after(() => s.close());

  const edit = (preserve = true) =>
    send("POST", `${s.v4}/${book()}/${ACTION("draftEdit")}`, {
      PreserveChanges: preserve,
    });

  it("DELETE on the draft discards it, children included; the active entity is as it was", async () => {
    await edit();
    await send("PATCH", `${s.v4}/${book(false)}`, { title: "changed" });
    await send("POST", `${s.v4}/${book(false)}/chapters`, {
      title: "Draft only",
    });
    assert.equal((await send("DELETE", `${s.v4}/${book(false)}`)).status, 204);

    assert.equal((await get(`${s.v4}/${book(false)}`)).status, 404);
    assert.equal(
      (await get(`${s.v4}/Chapters?$filter=IsActiveEntity eq false`)).body.value
        .length,
      0
    );
    const active = (await get(`${s.v4}/${book()}?$expand=chapters`)).body;
    assert.equal(active.title, "Wuthering Heights");
    assert.equal(active.HasDraftEntity, false);
    assert.equal(active.chapters.length, 2);
  });

  it("draftEdit without PreserveChanges replaces an existing draft", async () => {
    await edit();
    await send("PATCH", `${s.v4}/${book(false)}`, { title: "lost" });
    const r = await edit(false);
    assert.equal(r.status, 200);
    assert.equal(r.body.title, "Wuthering Heights");
    assert.equal(
      (await get(`${s.v4}/Books?$filter=IsActiveEntity eq false`)).body.value
        .length,
      1
    );
  });

  it("DELETE on an active root deletes it with its draft and compositions", async () => {
    assert.equal((await send("DELETE", `${s.v4}/${book()}`)).status, 204);
    assert.equal((await get(`${s.v4}/Books`)).body.value.length, 1);
    assert.equal(
      (await get(`${s.v4}/Chapters?$filter=book_ID eq ${BOOK}`)).body.value
        .length,
      0
    );
  });

  it("an active child can't be deleted on its own", async () => {
    const r = await send(
      "DELETE",
      `${s.v4}/Chapters(ID=c0000000-0000-4000-8000-000000000003,IsActiveEntity=true)`
    );
    assert.equal(r.status, 400);
  });
});

describe("draft: through $batch and V2", () => {
  let s;
  before(async () => (s = await start(DRAFT_MODEL)));
  after(() => s.close());

  it("a failed changeset rolls back the draft it created", async () => {
    const r = await batch(s.v4, [
      [
        {
          method: "POST",
          url: `${book()}/${ACTION("draftEdit")}`,
          body: { PreserveChanges: true },
        },
        {
          method: "PATCH",
          url: `${book(false)}`,
          body: { stock: "not a number" },
        },
      ],
    ]);
    assert.ok(batchResponses(r.text).some((p) => p.status >= 400));
    assert.equal(
      (await get(`${s.v4}/Books?$filter=IsActiveEntity eq false`)).body.value
        .length,
      0
    );
    assert.equal((await get(`${s.v4}/${book()}`)).body.HasDraftEntity, false);
  });

  it("V2 calls the same actions as function imports", async () => {
    const r = await send(
      "POST",
      `${s.v2}/draftEdit?ID=guid'${BOOK}'&IsActiveEntity=true&PreserveChanges=true`,
      undefined,
      { accept: "application/json" }
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.d.IsActiveEntity, false);
    const activated = await send(
      "POST",
      `${s.v2}/draftActivate?ID=guid'${BOOK}'&IsActiveEntity=false`,
      undefined,
      { accept: "application/json" }
    );
    assert.equal(activated.status, 200);
    assert.equal(activated.body.d.IsActiveEntity, true);
  });
});

describe("draft: creating a new entity (V4)", () => {
  let s, id;
  before(async () => (s = await start(DRAFT_MODEL)));
  after(() => s.close());

  it("POST on the root collection creates a draft with a generated key", async () => {
    const r = await send("POST", `${s.v4}/Books`, { title: "Villette" });
    assert.equal(r.status, 201);
    assert.match(r.body.ID, /^[0-9a-f-]{36}$/);
    assert.equal(r.body.IsActiveEntity, false);
    assert.equal(r.body.HasActiveEntity, false);
    id = r.body.ID;
    assert.ok(
      r.headers.get("location").endsWith(`Books(ID=${id},IsActiveEntity=false)`)
    );
    const admin = await get(
      `${s.v4}/Books(ID=${id},IsActiveEntity=false)/DraftAdministrativeData`
    );
    assert.equal(admin.body.InProcessByUser, "anonymous");
    assert.match(
      admin.body["@odata.context"],
      /#Books\/DraftAdministrativeData\/\$entity$/
    );
    const write = await send(
      "PATCH",
      `${s.v4}/Books(ID=${id},IsActiveEntity=false)/DraftAdministrativeData`,
      {}
    );
    assert.equal(write.status, 405);
  });

  it("the new draft gets children, is in the list, and has no sibling", async () => {
    const draft = `Books(ID=${id},IsActiveEntity=false)`;
    assert.equal(
      (await send("POST", `${s.v4}/${draft}/chapters`, { title: "Chapter I" }))
        .status,
      201
    );
    const r = await get(
      `${s.v4}/${draft}?$expand=SiblingEntity,chapters($select=IsActiveEntity)`
    );
    assert.equal(r.body.SiblingEntity, null);
    assert.deepEqual(r.body.chapters, [{ IsActiveEntity: false }]);
    const list = await get(`${s.v4}/Books?${LIST_FILTER}&$select=title`);
    assert.equal(list.body.value.length, 3);
  });

  it("draftActivate creates the active entity and its children", async () => {
    const r = await send(
      "POST",
      `${s.v4}/Books(ID=${id},IsActiveEntity=false)/${ACTION(
        "draftActivate"
      )}?$expand=chapters`,
      {}
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.IsActiveEntity, true);
    assert.equal(r.body.title, "Villette");
    assert.equal(r.body.chapters.length, 1);
    assert.equal(
      (await get(`${s.v4}/Books?$filter=IsActiveEntity eq false`)).body.value
        .length,
      0
    );
  });

  it("a new draft discarded leaves nothing behind", async () => {
    const r = await send("POST", `${s.v4}/Books`, { title: "Shirley" });
    await send(
      "POST",
      `${s.v4}/Books(ID=${r.body.ID},IsActiveEntity=false)/chapters`,
      {}
    );
    assert.equal(
      (
        await send(
          "DELETE",
          `${s.v4}/Books(ID=${r.body.ID},IsActiveEntity=false)`
        )
      ).status,
      204
    );
    assert.equal(
      (await get(`${s.v4}/Books?$filter=title eq 'Shirley'`)).body.value.length,
      0
    );
    assert.equal(
      (await get(`${s.v4}/Chapters?$filter=IsActiveEntity eq false`)).body.value
        .length,
      0
    );
  });

  it("a node is created under its parent's draft only", async () => {
    const r = await send("POST", `${s.v4}/Chapters`, { title: "orphan" });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /under its parent's draft/);
  });
});

describe("draft: NewAction (V4)", () => {
  let s, dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "draft-new-"));
    fs.writeFileSync(
      path.join(dir, "metadata.xml"),
      XML.replace(
        '<PropertyValue Property="EditAction" String="CatalogService.draftEdit"/>',
        '<PropertyValue Property="EditAction" String="CatalogService.draftEdit"/>\n            <PropertyValue Property="NewAction" String="CatalogService.draftNew"/>'
      ).replace(
        '<Action Name="draftEdit"',
        `<Action Name="draftNew" IsBound="true" EntitySetPath="in">
        <Parameter Name="in" Type="Collection(CatalogService.Books)"/>
        <Parameter Name="title" Type="Edm.String"/>
        <ReturnType Type="CatalogService.Books"/>
      </Action>
      <Action Name="draftEdit"`
      )
    );
    s = await start(dir);
  });
  after(async () => {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates a draft from the action's parameters", async () => {
    const r = await send("POST", `${s.v4}/Books/${ACTION("draftNew")}`, {
      title: "Agnes Grey",
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.title, "Agnes Grey");
    assert.equal(r.body.IsActiveEntity, false);
    assert.equal(r.body.HasActiveEntity, false);
  });
});

// A RAP-style V2 service: the draft annotations are V4 ones inside the V2 document, the
// actions are function imports named by path, and the associations join on IsActiveEntity
const DRAFT_V2_MODEL = path.join(__dirname, "fixtures", "DraftSrvV2");
const TRAVEL = "a0000000-0000-4000-8000-000000000001";
const travel = (active = true) =>
  `Travel(TravelUUID=guid'${TRAVEL}',IsActiveEntity=${active})`;
const JSON_ACCEPT = { accept: "application/json" };

describe("draft: V2 metadata (RAP)", () => {
  let s;
  before(async () => (s = await start(DRAFT_V2_MODEL)));
  after(() => s.close());

  it("reads the draft annotations and resolves the draft navigations", () => {
    assert.equal(s.model.entitySets.Travel.draft.root, true);
    assert.equal(s.model.entitySets.Booking.draft.root, false);
    assert.deepEqual(s.model.warnings, []);
  });

  it("serves seeded rows as active entities, with SiblingEntity and DraftAdministrativeData", async () => {
    const r = await get(
      `${
        s.v2
      }/${travel()}?$expand=to_Booking,SiblingEntity,DraftAdministrativeData`,
      JSON_ACCEPT
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.d.HasDraftEntity, false);
    assert.equal(r.body.d.to_Booking.results.length, 2);
    assert.equal(r.body.d.SiblingEntity, null);
    assert.equal(r.body.d.DraftAdministrativeData, null);
  });

  it("edits, changes and activates through the function imports", async () => {
    const edit = await send(
      "POST",
      `${s.v2}/TravelEdit?TravelUUID=guid'${TRAVEL}'&IsActiveEntity=true&PreserveChanges=true`,
      undefined,
      JSON_ACCEPT
    );
    assert.equal(edit.status, 200);
    assert.equal(edit.body.d.IsActiveEntity, false);

    assert.equal(
      (
        await send("MERGE", `${s.v2}/${travel(false)}`, {
          Description: "Trip to Walldorf and Berlin",
        })
      ).status,
      204
    );
    const booking = await send(
      "POST",
      `${s.v2}/${travel(false)}/to_Booking`,
      { BookingID: "0003", FlightPrice: "99.000" },
      JSON_ACCEPT
    );
    assert.equal(booking.status, 201);
    assert.equal(booking.body.d.IsActiveEntity, false);
    const draftBooking = `Booking(BookingUUID=guid'${booking.body.d.BookingUUID}',IsActiveEntity=false)`;
    const back = await get(`${s.v2}/${draftBooking}/to_Travel`, JSON_ACCEPT);
    assert.equal(back.body.d.IsActiveEntity, false); // a draft booking's travel is the draft
    const prepare = await send(
      "POST",
      `${s.v2}/BookingPrepare?BookingUUID=guid'${booking.body.d.BookingUUID}'&IsActiveEntity=false`,
      undefined,
      JSON_ACCEPT
    );
    assert.equal(prepare.status, 200);

    const activate = await send(
      "POST",
      `${s.v2}/TravelActivate?TravelUUID=guid'${TRAVEL}'&IsActiveEntity=false`,
      undefined,
      JSON_ACCEPT
    );
    assert.equal(activate.status, 200);
    assert.equal(activate.body.d.IsActiveEntity, true);
    const active = await get(
      `${s.v2}/${travel()}?$expand=to_Booking`,
      JSON_ACCEPT
    );
    assert.equal(active.body.d.Description, "Trip to Walldorf and Berlin");
    assert.equal(active.body.d.to_Booking.results.length, 3);
    assert.equal(
      (await get(`${s.v2}/${travel(false)}`, JSON_ACCEPT)).status,
      404
    );
  });

  it("creates a new travel as a draft, and the V4 service of the model edits it", async () => {
    const r = await send(
      "POST",
      `${s.v2}/Travel`,
      { Description: "New trip" },
      JSON_ACCEPT
    );
    assert.equal(r.status, 201);
    assert.equal(r.body.d.IsActiveEntity, false);
    const id = r.body.d.TravelUUID;
    const activated = await send(
      "POST",
      `${s.v4}/Travel(TravelUUID=${id},IsActiveEntity=false)/TravelService.TravelActivate`,
      {}
    );
    assert.equal(activated.status, 200);
    assert.equal(activated.body.IsActiveEntity, true);
  });
});
