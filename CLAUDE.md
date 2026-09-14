# Pickarr

Pickarr reads RSS feeds, works out what each release is, collates versions of the same
thing into one pickable group, and shows the result for a human to browse. Nothing
downloads without a click. `README.md` has the operator's view.

## Layout

Two implementations live here side by side.

- **2.0** — `packages/host` (the host: boot, config, secrets, auth, jobs, the read and
  sync APIs), `packages/contract` (what a plugin is), `packages/openmetadata` (the
  lookup-service plugin base), `packages/plugin-tv`, `packages/plugin-movie`,
  and `packages/plugin-xxx`. This is where new work goes, and the specs are
  `docs/superpowers/specs/2026-09-*`.
- **`packages/web`** — currently 1.x's SPA, being rewritten against 2.0's sync API. The
  2.0 host does not serve it: the host answers JSON and artwork and nothing else.
- **1.x** — `packages/core` and `packages/plugin-scenes`. Frozen, and still the only
  thing `Dockerfile` builds. 2.0 is greenfield: it starts on an empty database and
  rebuilds from feeds, so nothing migrates and the two share no schema.

`docs/database-migrations.md` is required reading before you write a migration — a
migration that rebuilds a table silently stops that table replicating to every client.

## Testing hazards

These are not product defects. They are ways this repo's tests have been green while
proving less than they appeared to, each found by mutating the source and watching
nothing fail. Every one of them has already recurred at least once, which is why they
are written down here rather than left to be rediscovered.

**Handing a live DOM element to `node:assert` kills the web test run — now enforced,
not remembered.** `node:assert`'s equality helpers format *both* operands into the
failure message, and formatting a live element means deep-inspecting a DOM node. Inside
a `waitFor` that happens on every retry; even outside one it burns about 75 seconds and
takes the file with it. It presents as a bare SIGKILL, or a reasonless `'test failed'`
naming no test — which costs an hour to trace.

Two shapes have cost time here, and the second is why this is not scoped to the first:
`assert.equal(screen.queryByText(x), null)`, and `assert.equal(document.activeElement,
screen.getByRole(…))` — an identity comparison between two live nodes, with no `null`
and no `queryBy*` anywhere. One instance of that second shape sat in
`SecretField.test.tsx` and no pattern written for the first would have found it.

`scripts/check-test-hygiene.ts` fails `npm run check` on both, so this is a build error
rather than something to remember. It parses rather than pattern-matches, because this
very section *documents* the hazard by quoting it and a text match would flag the
documentation. Compare booleans instead: `assert.ok(!screen.queryByText(x), '…')`, or
the shared `gone()` helper in `packages/web/test/dom.ts`.

**`t.mock.timers` hangs the web test run, so a timing assertion there has to spy rather
than mock.** Enabling fake timers in a `@testing-library/react` test stalls before the
first assertion: React's own effect flush schedules through `setTimeout`, so replacing
it means the effect under test never runs and the test times out with nothing to point
at. This is not the hang above — it presents as a plain timeout, which reads like the
code being wrong rather than the harness. Assert on the *arguments* to the real
`setTimeout` instead: `packages/web/test/useGroupMetadata.test.tsx` pins an exact
backoff ladder and a clamped five-minute sleep that way, without waiting five real
minutes or replacing any timer behaviour. Server-side tests reach the same place by a
different route: `packages/core/test/abort-timeout.ts` replaces `AbortSignal.timeout`
itself with a signal the test aborts on demand, which needs no timer mocking at all and
asserts the production path more directly.

**A failing web test that skips its cleanup hangs the whole file, and the hang names no
test.** Three variants so far, all the same shape. A component that polls every three
seconds left its interval running when a test threw before its own `cleanup()`, and the
file sat for 180 seconds. A test that mocked `setInterval` and threw left the
*reverted* mock's timer running for real, about 70 seconds. The `queryByText` hang
above is the third. Use `afterEach(cleanup)`, which runs whether the test passed or
threw — every file in `packages/web/test` does. Per-test `cleanup()` calls only run on
the happy path, which is the path that did not need them.

**A test whose expected value is computed by the code under test cannot detect that
code changing.** `groupAnchor` was mutated to return a constant `group-x` — every card
claiming one DOM id, so a Downloads link scrolls to whichever card renders first — and
**all 70 web tests passed, the end-to-end one included.** Eight separate sites, across
three files, built their expectation by calling `groupAnchor(...)`. Nothing asserted
the literal string. An off-by-one variant is just as invisible, so "check it isn't a
constant" is not the lesson; spelling at least one end literally is.

Two things make this worth its own entry. It survived a reviewer who had *correctly
identified the same pattern* one level up, in `groupAnchorHref` — and then wrote the
shared `groupAnchor` the fix depended on without pinning it. And it has a subtler form:
**pinning a pure function does not pin that anyone calls it.** A migration's
duplicate-version guard had a passing test, and deleting the guard's *call site* broke
nothing, because the test exercised the function directly. Give the call site something
drivable.

**A test whose fixtures all come from the code under test cannot see that code's
history.** Every test of the manual-edit prefill seeded its rows from the *fixed*
parser, so none could observe a row written by the parser before the fix — and the
defect that survived into the final review lived exactly there. When behaviour changes
and stored data does not, hand-build a fixture in the old shape.

**A round-trip assertion cannot pin any property of a helper shared by both
directions.** `parse(name) → toManualValues → fromManualValues === parse(name)` looks
like a strong property, and it is — until the two directions are deduplicated onto one
function, which is otherwise the right thing to do. After that, changing the shared
helper moves both sides together and the assertion still holds: `.toSorted()` was
deleted from `sceneSlugFromParts` and the round-trip tests stayed green. Absolute-value
assertions on the key are what actually pin it. Deduplicate anyway — but replace the
redundancy you just removed.

**Mutation coverage flatters itself when every mutant targets contents and never the
wrapper.** `inTransaction` in `packages/core/src/manual/operations.ts` was surrounded by
22 mutants that all passed through it and none that attacked it; replacing its whole
`BEGIN`/`COMMIT`/`ROLLBACK` body with `return body()` left 302 tests green. A wrapper is
invisible on every happy path, so it needs a fault injected deliberately — for that one,
a `BEFORE DELETE` trigger raising `ABORT`, which fails the statement and leaves the
transaction to the caller the way a real constraint failure does. `RAISE(ROLLBACK)`
unwinds first and tests SQLite instead of you.

**A mutant that crashes proves nothing.** Four mutants that copied a column from a merge
loser to its survivor were first written to read the row *after* the delete, which raised
`NOT NULL` and failed every test in the file. That looks like overwhelming evidence and
is none: a mutant must change one behaviour, not break the code. Rewritten to copy before
the delete, each produced a single targeted failure. The same trap appears in SQL — a
narrowing mutant put `WHERE id = media_groups.id` inside a subquery already correlated on
`media_groups`, so the inner name shadowed the outer and the query was broken rather than
narrowed. When a mutant fails everything, suspect the mutant.

**`getByRole` and `getByText` cannot see whether a component is legible.** Both read the
accessibility tree, and the accessibility tree is satisfied by attributes a sighted user
never receives. `IdentityChangeConfirm` shipped with `role="dialog"`, an
`aria-label="Confirm identity change"`, no visible heading, and — as it turned out — no
`.confirm` rule in the stylesheet at all, so it rendered as an unstyled block of text
inline, directly beneath each page's own error banner. Eight unit tests and two
Playwright specs asserted `getByRole('dialog', { name: 'Confirm identity change' })` and
passed throughout, because that name came from the `aria-label`. The first person to use
it read it as an error, did not press Confirm, and reported the merge as silently broken;
the merge had been working the whole time and was waiting for a click.

The lesson is not "add a screenshot test". It is that `role` and `aria-*` are assertions
about the *announced* interface, and asserting them proves nothing about the rendered
one: a query that would still pass if every stylesheet were deleted is not evidence that
anyone can use the thing. Where a component's whole job is to be understood — a
confirmation, an error, a warning — assert the visible affordance too: a real heading via
`getByRole('heading')`, with the accessible name sourced from that heading through
`aria-labelledby` rather than duplicated in an `aria-label`, so the announced string and
the visible one cannot drift apart. Playwright's `toBeVisible()` does not close this gap
either: an unstyled `<div>` full of text is genuinely visible.

**Before accepting a coverage loss, enumerate what does still differ.** `MediaCard`'s
scene panel was a `section.metadata`, and a test could assert its presence to prove a
group's answer was `confirmed` even when the answer carried no poster, no synopsis and no
cast. The poster-led card moved the panel's children into the identity column and deleted
the wrapper, so a confirmed answer with nothing in it renders nothing of its own — and
the assertion that used to pin that state had nothing left to query. Re-adding the
wrapper for the test's benefit was refused.

What makes it worth recording is the reasoning error made while assessing it. The first
reading was "nothing in the DOM distinguishes this card from a group that was never asked
at all", and that was false: `settled` is `(confirmed || none) && a requery handler`, both
routes pass one, so a Requery button renders for a confirmed-but-empty card and not for an
`absent` one. The real loss is `confirmed`-with-nothing versus `none` — the two states
`settled` deliberately treats alike — which is a much narrower thing to be blind to. A
component with several independent conditions usually leaves more than one mark.
