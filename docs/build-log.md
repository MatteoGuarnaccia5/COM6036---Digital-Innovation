# Development log

A record of what was built, in what order, and which decisions were taken along
the way. Each stage ends at a **commit boundary** with a suggested message, so
the git history can be reconstructed in small logical increments.

The build follows the nine-stage order set out in the specification.

---

## Stage 1 - Workspace, tooling, Docker Compose, CI

**Status:** complete. `npm run lint`, `npm run typecheck` and `npm test` all pass
(6 tests). The architecture test was checked against a deliberate violation -
adding `import { Pool } from 'pg'` to `packages/core/src/index.ts` fails the
suite with `packages/core/src/index.ts imports "pg"` - so the control is
demonstrated, not merely asserted.

### What was created

| Path | Purpose |
| --- | --- |
| `package.json` | npm workspaces root (`packages/*`, `apps/*`). No application code. |
| `tsconfig.base.json` | `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`. Every workspace is a composite project. |
| `tsconfig.json` | Root solution file referencing the four workspaces and the test project. |
| `packages/core` | Layer 2, business logic. `dependencies` is empty and stays empty. |
| `packages/data` | Layer 3, data access. Drizzle and `pg` live here and nowhere else. |
| `apps/web` | Layer 1, presentation. Express server plus (from stage 7) the React client. |
| `apps/scheduler` | The reminder worker process. |
| `tools/layer-rules.json` | The layer boundaries, written down once. |
| `eslint.config.js` | Reads `layer-rules.json` and turns each boundary into a lint error. |
| `tests/architecture.test.ts` | Reads the same file and asserts the boundaries at test time. |
| `docker-compose.yml` | `web`, `scheduler`, `db`. No `.env` needed. |
| `docker/*.Dockerfile` | Two images from one workspace, two independent lifecycles. |
| `.github/workflows/ci.yml` | Lint, typecheck, tests with coverage, Postgres service container. |

### Decisions taken

- **Three enforcement mechanisms, one rule.** The layer boundaries are declared
  in `tools/layer-rules.json` and enforced by (1) TypeScript project
  references, which make an upward import a compile error, (2) ESLint
  `no-restricted-imports`, and (3) `tests/architecture.test.ts`. The test parses
  each file with the TypeScript compiler API rather than a regular expression,
  so a module specifier inside a comment or a string cannot produce a false
  result either way.

- **`packages/data` references `packages/core`, which looks like an upward
  import and is not.** Data access imports the *port interfaces* that business
  logic declares, then implements them; the composition root injects the
  implementation. Runtime control still flows downward. This is the dependency
  inversion that lets `core` call a repository without knowing one exists, and
  it is why `core` can have an empty dependency list at all.

- **Migrations run in-process, guarded by a Postgres advisory lock**, rather
  than from an entrypoint shell script or a fourth "migrate" service. Both
  `web` and `scheduler` attempt them on start; the lock makes the race safe.
  This is what allows neither container to depend on the other's startup
  order, which is the independent-lifecycle requirement.

- **CI runs with `TZ=America/New_York`.** The recurrence rules are pure UTC
  arithmetic, so the suite must pass on a host in any zone. Pinning CI to a
  non-UTC zone with a DST transition turns that from an assumption into a test.

- **Debian slim base image, not Alpine**, so `bcrypt` installs a prebuilt glibc
  binary instead of needing a compiler toolchain in the image.

### Commit boundary

    chore: scaffold workspace, tooling, Docker Compose and CI

---

## Stage 2 - Schema, migrations, seed

**Status:** complete. 12 tests pass, including six new ones run against a real
PostgreSQL 17 server.

### What was created

| Path | Purpose |
| --- | --- |
| `packages/data/src/schema.ts` | The three application tables. |
| `packages/data/src/session-schema.ts` | The session store's table, kept separate on purpose. |
| `packages/data/src/client.ts` | Pool and drizzle handle. The only connection factory in the repository. |
| `packages/data/src/migrate.ts` | Advisory-locked migration runner. |
| `packages/data/src/seed.ts` | Idempotent demo data. |
| `packages/data/migrations/0000_initial_schema.sql` | Generated from the schema. |
| `packages/data/migrations/0001_session_store.sql` | Generated from the session schema. |
| `tests/support/database.ts` | Throwaway database helper for the suites that need one. |
| `tests/integration/schema.test.ts` | Asserts the migrated schema and the seed. |

### Decisions taken

- **`due_at` means two different things, so the TypeScript names differ.** The
  columns are named as the specification requires, but `tasks.due_at` maps to
  `Task.dueAt` (a deadline) and `reminders.due_at` maps to `Reminder.fireAt` (a
  firing time). Code holding both at once cannot now confuse them silently.

- **Three CHECK constraints beyond the stated model**, because the data model
  implies them and the database is the last place they can be guaranteed:
  `recurrence` must be null, one of the three keywords, or match
  `^every:[1-9][0-9]*d$`; `reminder_offset_minutes >= 0`; and `status = 'done'`
  exactly when `completed_at IS NOT NULL`.

- **A partial index on `reminders (due_at) WHERE sent_at IS NULL`.** The
  scheduler's claim query is the only hot path in the system, and this keeps it
  proportional to outstanding work rather than to the full delivery history.

- **The seed takes the password hash as a parameter** rather than importing
  bcrypt. Hashing is a policy decision owned by the composition root, and this
  keeps a native module out of the data access layer's dependency list.

- **Reminders whose firing time has already passed are seeded as delivered.**
  Otherwise a fresh `docker compose up` would dump a dozen historical reminders
  into the scheduler log on its first tick. Delivery is demonstrated on demand
  with the trigger script instead (stage 8).

- **Deferred:** `seed.ts` computes `fireAt = dueAt - offset` inline. Once
  `@tasks/core` owns that policy (stage 4) the seed should call the core helper
  instead, so the rule exists in one place.

### Commit boundary

    feat(data): schema, migrations and idempotent demo seed

---

## Stage 3 - Repository ports, implementations, in-memory fakes

**Status:** complete. 44 tests pass.

### What was created

| Path | Purpose |
| --- | --- |
| `packages/core/src/domain/types.ts` | The domain model in plain TypeScript. |
| `packages/core/src/domain/errors.ts` | Domain errors. No "forbidden" error exists, by design. |
| `packages/core/src/ports/repositories.ts` | The entire contract between business logic and storage. |
| `packages/core/src/ports/services.ts` | `Clock`, `PasswordHasher`, `ReminderNotifier`. |
| `packages/data/src/repositories/*.ts` | Drizzle implementations and row-to-domain mapping. |
| `tests/support/fakes/in-memory-repositories.ts` | The fakes the unit suite runs against. |
| `tests/contract/repository-contract.ts` | One suite, run against both implementations. |

### Decisions taken

- **The fakes are held to a contract.** Testing business logic against
  in-memory doubles is only sound if the doubles behave like the real thing, so
  the same 16-test suite runs against the fakes and against Drizzle on Postgres.
  Ordering, partial-update semantics and ownership scoping cannot drift apart
  without failing the build.

- **Ownership is a property of the query.** There is no `findById` on the task
  repository - only `findByIdForUser(taskId, userId)` - so a route cannot forget
  to scope a lookup, and "belongs to someone else" is indistinguishable from
  "does not exist" before the presentation layer ever sees it. The absence of an
  access-denied error in `errors.ts` is part of the same decision.

- **Transaction scope is a port, not a method.** `UnitOfWork.run()` hands
  business logic a set of repositories that happen to be transactional. Core can
  therefore compose atomic work - claim, deliver, stamp - without importing a
  database library or naming a transaction.

- **`FOR UPDATE OF r SKIP LOCKED`, not plain `FOR UPDATE`.** Restricting the
  lock to `reminders` means the joined `tasks` and `users` rows stay unlocked
  while an SMTP send is in flight, so delivering a reminder cannot block an
  unrelated edit to the same task.

- **The fakes cannot fake concurrency**, and the file says so. `SKIP LOCKED` has
  no meaning without a second connection, so locking behaviour is proven only
  against Postgres, in the scheduler suite at stage 8.

### Commit boundary

    feat(core): repository ports and domain model
    feat(data): Drizzle repository implementations
    test: repository contract suite run against fakes and Postgres

---

## Stage 4 - Business logic and unit tests

**Status:** complete. 99 tests pass; 55 of them are unit tests that touch
neither a database nor an HTTP server.

### What was created

| Path | Purpose |
| --- | --- |
| `packages/core/src/recurrence.ts` | FR4. Pure UTC instant arithmetic. |
| `packages/core/src/tasks/validation.ts` | Business rules about a well-formed task. |
| `packages/core/src/tasks/task-service.ts` | FR2 and FR3, each operation atomic. |
| `packages/core/src/reminders/policy.ts` | FR5 scheduling policy and reconciliation. |
| `packages/core/src/reminders/tick.ts` | One pass of the scheduler. |
| `tests/unit/*.test.ts` | 55 tests against in-memory fakes. |

### Decisions taken

- **Recurrence is pure UTC arithmetic, as agreed.** `daily` means exactly 24
  hours, not "the same wall-clock time tomorrow". The consequence at a DST
  boundary is that the instant is preserved and the user's local reading time
  shifts by an hour. This is pinned by test, and stated in a comment at the top
  of `recurrence.ts` so it reads as a decision rather than an oversight.

- **The DST tests guard against host-timezone contamination**, which is the
  failure this code actually suffers from in practice: it passes on a laptop in
  London and behaves differently on a CI runner in New York. `nextOccurrence` is
  run over four zones - including a half-hour offset - and asserted to give
  identical instants. The test first proves that changing `TZ` has any effect at
  all, so it cannot pass vacuously. CI runs the whole suite under
  `TZ=America/New_York` for the same reason.

- **Monthly clamps, and the clamp persists.** 31 January becomes 28 February
  (29 in a leap year), and the following month is computed from that, so a
  series starting on the 31st settles onto the 28th rather than springing back.
  Anchoring to the original day would need the root task's deadline to be
  carried through every occurrence. Documented and tested rather than hidden.

- **A recurring task must have a due date.** The specification leaves both
  columns independently nullable, but a recurrence rule with no deadline to
  advance would generate an endless series of undated clones. Rejected as a
  `ValidationError`. Flagged to the client.

- **Completing an already-completed task is a no-op.** Without that, a
  double-clicked button or a retried request generates a second occurrence.

- **Occurrences are anchored to the root task.** `parentTaskId` on the third
  occurrence points at the first, not the second, so a long-running series stays
  one hop deep and "all occurrences of this task" is a single query.

- **A failed delivery is caught and never rethrown.** Throwing would roll the
  tick's transaction back and discard the very `attempts` increment that stops a
  doomed reminder retrying for ever.

- **The exactly-once caveat is written down** at the top of `tick.ts`: delivery
  is an external side effect that cannot join the database transaction, so a
  crash between SMTP accepting a message and the commit would produce a
  duplicate. The real guarantee is at-least-once with single delivery on every
  non-crashing path.

- **Resolved from stage 2:** `seed.ts` now calls `computeReminderFireTime` from
  core instead of recomputing `dueAt - offset`, so fixtures cannot disagree with
  the rule the application applies.

### Commit boundary

    feat(core): recurrence arithmetic with DST and month-boundary tests
    feat(core): task operations, state transitions and reminder policy
    feat(core): reminder tick with exactly-once and retry handling
    refactor(data): seed uses the core reminder policy

---

## Stage 5 - Authentication, sessions, cross-user isolation

**Status:** complete. 135 tests pass.

### What was created

| Path | Purpose |
| --- | --- |
| `packages/core/src/auth/auth-service.ts` | FR1 rules. Names no crypto library. |
| `apps/web/src/server/adapters/bcrypt-password-hasher.ts` | The bcrypt adapter, cost factor 10. |
| `apps/web/src/server/presentation/timezone.ts` | The whole timezone boundary. |
| `apps/web/src/server/presentation/session.ts` | Cookie policy, session lifecycle, `requireAuthentication`. |
| `apps/web/src/server/presentation/errors.ts` | The only place an HTTP status is chosen. |
| `apps/web/src/server/presentation/serializers.ts` | Domain to JSON. Password hashes cannot leak. |
| `apps/web/src/server/routes/auth-routes.ts` | Register, login, logout, me. |
| `apps/web/src/server/app.ts`, `config.ts`, `index.ts` | The application and its composition root. |
| `tests/unit/auth-service.test.ts` | FR1 rules against fakes. |
| `tests/integration/auth.test.ts` | FR1 over HTTP, real bcrypt, real sessions. |
| `tests/integration/task-isolation.test.ts` | Cross-user isolation against real SQL. |

### Decisions taken

- **Upgraded `drizzle-orm` to 0.45.2 to clear GHSA-gpj5-g38j-94v9**, a
  high-severity SQL-injection advisory affecting improperly escaped identifiers
  in versions below 0.45.2. It was a runtime dependency of the data layer.
  `npm audit` now reports only four moderate advisories, all dev-only, inside
  the deprecated `@esbuild-kit` packages that `drizzle-kit` still depends on;
  they concern esbuild's dev server, which this project never runs, and no
  fixed `drizzle-kit` release exists.

- **A failed login for an unknown address still performs a bcrypt
  verification**, against a fixed hash of random bytes. Returning early would
  make response time an oracle for "is this person registered here?". Unknown
  address and wrong password produce byte-identical 401 responses, asserted by
  test.

- **The session id is regenerated on every sign-in**, so a cookie fixed by an
  attacker before the victim authenticates does not become a valid session
  afterwards.

- **Duplicate-email detection is part of the repository contract.** The unique
  index is the authority, not the earlier read, so two simultaneous
  registrations still produce a clean 409 rather than a 500. The contract suite
  immediately earned its keep here: it caught that Drizzle 0.45 wraps driver
  errors in a `DrizzleQueryError` and moves the Postgres error code onto
  `cause`, which the in-memory fake had no way of revealing. The detection now
  walks the cause chain rather than assuming a depth.

- **`session.expire` is `timestamptz`, not `connect-pg-simple`'s stock
  `timestamp(6)`.** Its queries compare that column against `to_timestamp($1)`,
  which yields a `timestamptz`; against a naive column that comparison silently
  depends on the connection's TimeZone setting. Verified by reading the
  library's SQL.

- **`SECURE_COOKIES` defaults to off, even in production.** A `Secure` cookie is
  never sent over plain HTTP, so defaulting it on would break the documented
  `docker compose up` on `http://localhost` - the browser would accept the login
  and then silently never return the cookie. Documented as the one flag to set
  behind HTTPS.

- **The API accepts a naive wall-clock deadline, `YYYY-MM-DDTHH:mm`**, and
  interprets it in the account's timezone. Accepting a pre-computed instant
  would have reduced the presentation layer to a pass-through and made the
  timezone boundary untestable. Conversion handles both awkward cases: a time in
  a spring-forward gap resolves to the instant after it, and an ambiguous time
  during autumn-back resolves to the first occurrence.

- **Isolation is tested against real SQL, not only the fakes.** The unit suite
  proves the service refuses another user's task, but against doubles written to
  behave that way. `task-isolation.test.ts` exercises the `WHERE user_id = $2`
  that actually enforces it, and asserts that another user's id is reported
  identically to an id that was never issued.

- **Scope note:** the HTTP-level cross-user 404 arrives with the task routes in
  stage 6. The mechanism it would exercise is already covered at the data,
  business and service layers here.

### Commit boundary

    fix(deps): upgrade drizzle-orm to 0.45.2 for GHSA-gpj5-g38j-94v9
    feat(core): registration and login rules with enumeration-resistant failure
    feat(web): timezone boundary, session handling and error mapping
    feat(web): authentication routes and composition root
    test: auth over HTTP, and cross-user isolation against real SQL

---

## Stage 6 - The JSON API

**Status:** complete. 158 tests pass.

### What was created

| Path | Purpose |
| --- | --- |
| `apps/web/src/server/routes/task-routes.ts` | FR2, FR3, FR4 and FR8 under `/api/v1/tasks`. |
| `tests/integration/tasks.test.ts` | 23 tests over HTTP, including the cross-user 404. |

### The surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/tasks` | List, by deadline, undated last. No filter or sort parameters - out of scope. |
| `POST` | `/api/v1/tasks` | Create. 201. |
| `GET` | `/api/v1/tasks/:id` | Read. |
| `PATCH` | `/api/v1/tasks/:id` | Partial update; `null` clears a field, absent leaves it. |
| `POST` | `/api/v1/tasks/:id/complete` | FR3. Returns the completed task and any generated occurrence. |
| `DELETE` | `/api/v1/tasks/:id` | Delete. 204. |

### Decisions taken

- **Completion is a sub-resource action, not `PATCH { status }`.** Completing a
  task drops its pending reminder and may generate the next occurrence - it is a
  state transition with consequences, not a field assignment. `status` is
  deliberately absent from the update schema, so exactly one code path can
  complete a task.

- **A malformed task id answers 404, not 400 or 500.** It also stops a non-UUID
  reaching Postgres, where it would raise a syntax error and surface as a server
  error. "No such task" is both true and consistent with how another user's id
  is treated.

- **Authentication is applied at the mount point**, not repeated per handler, so
  a route added later cannot forget it. A test asserts all six routes reject an
  anonymous caller.

- **No ownership check appears anywhere in the route layer**, and that is the
  point: the service takes the session's user id and the repository has no
  unscoped lookup, so isolation cannot be forgotten at this level. The HTTP
  tests confirm the surface does not undo it - every route answers 404, and
  another user's id returns a byte-identical body to an id that was never
  issued.

- **Every instant is published three ways**: `utc` (canonical ISO-8601),
  `local` (`YYYY-MM-DDTHH:mm` for form fields) and `display` (human-readable),
  all rendered in the account's zone. The timezone tests prove the boundary is
  real: the same wall-clock string from a London account and a New York account
  produces two different instants, and the same moment written in each zone
  produces one.

### Commit boundary

    feat(web): task JSON API under /api/v1
    test: task CRUD, recurrence and cross-user 404 over HTTP

---

## Stage 7 - The React client

**Status:** complete. 158 tests still pass; lint and typecheck clean. The built
client was rendered in headless Chrome and both screens were verified working
with no console errors.

### What was created

| Path | Purpose |
| --- | --- |
| `apps/web/src/shared/api-types.ts` | The wire format, imported by both halves. |
| `apps/web/src/client/api.ts` | Typed fetch client; one place handles failures. |
| `apps/web/src/client/App.tsx` | The shell. Two states, no router. |
| `apps/web/src/client/components/AuthPage.tsx` | FR1 screen, one form in two modes. |
| `apps/web/src/client/components/TaskListPage.tsx` | The list, with inline add and edit. |
| `apps/web/src/client/components/TaskForm.tsx` | Fields shared by add and edit. |
| `apps/web/src/client/components/TaskItem.tsx` | One task. |
| `apps/web/src/client/styles.css` | One stylesheet, contrast ratios documented. |
| `apps/web/vite.config.ts`, `tsconfig.client.json` | Build and typecheck for the client. |

### Decisions taken

- **No router.** The application has two states and they are determined by
  whether there is a session, not by a URL. Creating and editing happen inline
  on the list because a task must be creatable in at most two clicks from it - a
  separate route would make that impossible by construction. A router to express
  two states nobody can navigate between would be ceremony, not structure.

- **One click to add a task, not two.** The quick-add form is always on the
  page: type a title, press "Add task" or Enter. "More options" discloses
  deadline, priority, recurrence and reminder offset inline, which is the second
  click at most. Focus returns to the title field afterwards so several tasks
  can be added in a row without touching the mouse.

- **The wire format lives in `src/shared/api-types.ts`**, imported by the
  serialisers and by the client. A response shape the client has not caught up
  with is a compile error rather than a runtime surprise. It is the only thing
  the two halves share; neither imports the other's code.

- **The client never computes an instant.** It sends and receives naive local
  strings, exactly what `<input type="datetime-local">` produces. Conversion
  stays on the server, where the account's timezone is known - the browser's own
  zone is used for one thing only, guessing a default when registering.

- **Nothing is communicated by colour alone.** Overdue, completed and priority
  each carry a word as well as a style, and completed tasks are struck through
  rather than merely greyed. Every colour pair in the stylesheet is annotated
  with its contrast ratio; all exceed AA and most exceed AAA.

- **Buttons carry a visually hidden full label.** "Edit" is what a sighted user
  reads; "Edit &ldquo;Submit the literature review&rdquo;" is the accessible
  name, so a screen reader user moving through a list of buttons is not offered
  seventeen identical ones.

- **A native `window.confirm` guards deletion**, because the browser's own
  dialog is keyboard accessible and focus-managed, which a hand-rolled modal
  would have to reimplement correctly.

- **Same-origin by construction.** Express serves the built client itself, so
  the session cookie needs no CORS configuration, no `credentials: 'include'`
  and no SameSite relaxation. Verified: `/` and any deep path return the SPA
  shell, while an unknown `/api/` path still returns a JSON 404 rather than
  HTML.

### A flake found and fixed

The full suite failed once, in a test unrelated to anything being changed, then
passed on the next three runs. The cause was `connect-pg-simple` starting a
60-second prune timer per session store: `auth.test.ts` builds a second
application over the same pool to simulate a container restart, and the
discarded store's timer went on issuing queries after `afterAll` had closed the
pool - surfacing as a failure in whichever test happened to be running. The
prune interval is now a parameter, disabled in tests. A suite that fails once in
twenty is worse than one that fails every time, so this was worth chasing rather
than re-running.

### Commit boundary

    feat(web): shared API types for client and server
    feat(web): React client with inline task creation and editing
    feat(web): serve the built client from Express, same-origin
    fix(web): make the session prune interval configurable

---

## Stage 8 - The scheduler process

**Status:** complete. 177 tests pass. The process was also run for real against a
live database: a reminder was triggered and delivered, and the recovery property
was demonstrated by stopping the scheduler, letting a reminder come due, and
restarting it.

### What was created

| Path | Purpose |
| --- | --- |
| `apps/scheduler/src/index.ts` | The worker: timer, pool, transport, and nothing else. |
| `apps/scheduler/src/config.ts` | Environment. Note the absence of any web-app address. |
| `apps/scheduler/src/presentation/reminder-email.ts` | The second presentation edge - UTC to local, for email. |
| `apps/scheduler/src/adapters/reminder-notifier.ts` | nodemailer, or stdout when SMTP is unset. |
| `apps/scheduler/src/trigger-reminder.ts` | The demonstration script. |
| `packages/data/src/demo-tools.ts` | Its SQL, kept in the layer that owns SQL. |
| `tests/scheduler/reminder-delivery.test.ts` | 11 tests against real Postgres. |
| `tests/unit/reminder-email.test.ts` | 6 tests for the email presentation. |

### Decisions taken

- **Ticks are scheduled consecutively, not on a fixed interval.** With
  `setInterval`, a tick that outran its period would overlap the next. That
  would still be correct - `SKIP LOCKED` means overlapping ticks divide the work
  rather than duplicate it - but it would pile up connections exactly when the
  database is already struggling. The first tick runs immediately on start, so a
  scheduler that has been down delivers its backlog at once rather than a minute
  later.

- **The stdout notifier is a real implementation of the port, not a stub.** The
  claim, delivery and stamping path is identical either way; only the final step
  differs. That is what makes the credential-free demonstration honest.

- **The demo script only moves a firing time.** It does not send anything or
  mark anything delivered - the scheduler still claims, delivers and stamps
  through the ordinary path, so what the marker watches is the real mechanism.

- **Its SQL lives in `packages/data`, not in the script.** Adding
  `findNextPending` to `ReminderRepository` would have widened a domain contract
  that every implementation must satisfy, in order to serve a demo. It is
  exported as a clearly-labelled maintenance utility instead.

- **The transactional claim is asserted directly.** While one tick is blocked
  inside `notify`, a second connection observes that `sent_at` is still null -
  the stamp is uncommitted and invisible - and a concurrent tick claims nothing,
  because the row lock is held. Both become true only once the first
  transaction commits. That single test pins the lock, `SKIP LOCKED`, and
  "stamp within the claiming transaction" at once.

### A real defect, found by running it rather than by testing it

The first live run failed: `claimed 1, delivered 0, failed 1`, with
`last_error = "Invalid time value"`.

`claimDue` issues raw SQL through Drizzle's `execute()`. Drizzle configures
node-postgres to return timestamps as **strings** so that it can apply its own
column mapping in typed queries - but `execute()` bypasses that mapping. The
method was therefore returning `"2026-09-08 10:00:00+00"` where its type
promised a `Date`, and the assertion `execute<DueReminderRow>` made the compiler
believe it. Everything passed: the unit tests used fakes that return real Dates,
and the scheduler tests asserted titles rather than timestamps. It only surfaced
when the email renderer tried to format one.

Fixed by converting explicitly at the boundary, with a note that "tidying" the
Postgres string into ISO form first would *break* it - `2026-09-08T10:00:00+00`
is not valid ISO 8601, because ISO requires a two-part offset.

The lasting fix is the test: the repository contract now asserts that claimed
instants are `Date` instances with the right values, checked against both
implementations. Verified by reintroducing the defect and watching the contract
fail. The lesson worth recording is that a type assertion over a raw query is an
unchecked claim, and the contract suite was only as good as the fields it
bothered to assert.

### Commit boundary

    feat(scheduler): worker process with consecutive ticks and graceful shutdown
    feat(scheduler): email rendering and the SMTP/stdout notifier
    feat(scheduler): demo trigger script
    fix(data): convert raw-query timestamps to Date at the boundary
    test: scheduler exactly-once, recovery, locking and retry against Postgres

---

## Stage 9 - Accessibility, README, architecture documentation

**Status:** complete. 177 tests pass; lint, typecheck and build clean.

### What was created

| Path | Purpose |
| --- | --- |
| `README.md` | Written for a marker with ninety seconds. |
| `docs/architecture.md` | Layer rules, two Mermaid diagrams, the honest limits. |
| `tools/accessibility-audit.mjs` | axe-core against the running application. |

### Accessibility: audited, not asserted

`npm run audit:a11y` renders the running application in headless Chrome,
injects axe-core and checks WCAG 2.1 A and AA — including states a crawler
would never reach, because they only exist after an interaction.

    Sign in:                              no violations (17 checks passed)
    Create an account:                    no violations (20 checks passed)
    Task list:                            no violations (22 checks passed)
    Task list, add-task options expanded: no violations (23 checks passed)
    Task list, editing a task:            no violations (23 checks passed)

Automated tools cover roughly a third of the WCAG criteria; they are good at
contrast, labelling, roles and names, and cannot judge whether focus order makes
sense. The rest was checked by driving real key events over the Chrome
DevTools Protocol:

- **Heading structure** is `h1` → `h2` → `h3` with no skipped levels.
- **No positive `tabindex` anywhere**, so focus order is DOM order.
- **Twelve consecutive Tab presses** were recorded and follow the reading order:
  sign out, title field, add, more options, then each task's actions in turn.
- **The collapsed "More options" panel** uses `hidden`, so its five controls are
  genuinely out of the tab order rather than merely invisible.
- **The focus indicator** computes to `3px solid rgb(10, 84, 140)` at `2px`
  offset, and was confirmed visually.
- **Enter submits the quick-add form**, focus returns to the title field, and
  the live region announces `Added "…"` — so a task can be added without a
  mouse and the outcome is spoken.
- **Accessible names** were read from the browser's accessibility tree, not from
  `textContent`: buttons compute to `Edit "Write the requirements document"`
  rather than a list of seventeen identically-named "Edit" buttons. The
  `aria-hidden` on the visible label is doing its job.

The audit is not part of `npm test`: CI has no browser, and a test that silently
skips is worse than one that is run deliberately.

### Both Mermaid diagrams were rendered before being committed

A diagram that fails to parse is the first thing a marker sees. All three
Mermaid blocks across the README and the architecture document were parsed
*and* rendered to SVG in a real Mermaid runtime. Two message labels were
reworded first, because a bare `<` in a sequence-diagram message can be taken
for markup. Mermaid was installed for the check and removed afterwards; the
lockfile is unchanged and `npm ci` was verified to still resolve.

### Decisions taken

- **The README leads with running it.** What the application is, one command,
  the demo credentials, and how to see a reminder delivered — before any
  discussion of architecture.

- **The architecture document states its own limits.** The exactly-once
  guarantee is described precisely, including the crash window that makes it
  at-least-once in the strict sense, and `SKIP LOCKED` is presented as
  headroom for a second worker rather than as a present necessity. A marker who
  spots the gap should find it already acknowledged.

### Commit boundary

    docs: README and architecture documentation with layer diagrams
    feat(tools): accessibility audit with axe-core
    chore(lint): Node globals for plain-JavaScript tooling

---

## Stage 10 - Verifying `docker compose up`, and the bug it found

Docker was not available while the project was built, so the Compose setup was
authored carefully but never executed. The first real run failed. This records
what was wrong and how it was closed.

### The failure

`docker compose build` failed in both images at `RUN npm run build`, with fifty
type errors, all in the `tests` project:

    tests/support/database.ts(13,74): error TS2307:
      Cannot find module '@tasks/data' or its corresponding type declarations.

The same command succeeded on a clean checkout locally, which is what made it
interesting.

### Root cause: `.dockerignore` patterns are not recursive

    dist
    **/dist          <- nested build output correctly excluded
    *.tsbuildinfo    <- matches ONLY the context root

A `.dockerignore` pattern without `**/` matches at the top level only. So
`packages/core/dist` was excluded from the build context while
`packages/core/tsconfig.tsbuildinfo` was **copied into the image**.

`tsc --build` trusts `.tsbuildinfo`. It read those stale files, concluded that
`packages/core`, `packages/data`, `apps/web` and `apps/scheduler` were all
already up to date, and skipped emitting them — into `dist/` directories that
did not exist. The `tests` project then had no declaration files to resolve
`@tasks/*` against.

A probe build inside the container confirmed each step:

    tsbuildinfo present in context: ./packages/core/tsconfig.tsbuildinfo, …
    tsc --build --dry: Project '/app/packages/core/tsconfig.json' is up to date
    ls packages/core/dist: No such file or directory

The failure was loud but its message pointed at the wrong place: the errors
named the test files, while the fault was four projects upstream and in a file
that is not TypeScript at all.

### The fixes

1. **Every `.dockerignore` pattern now has its `**/` twin**, and the file says
   why in a comment, since this is the kind of mistake that reads as correct.

2. **The production image no longer compiles the test suite.** A new
   `tsconfig.build.json` references everything except `./tests`, and
   `npm run build` uses it. Compiling tests into a runtime image was wasted
   work, and it meant a type error in a test could break an image build.
   `npm run typecheck` still uses `tsconfig.json` and covers everything.

3. **CI now runs `docker compose up`.** Nothing in the previous pipeline could
   have caught this: every suite runs against the source tree, so none of them
   exercises the packaging. The new job builds both images, starts the stack,
   asserts the application is migrated and seeded, triggers a reminder and
   waits for the scheduler to deliver it. Each step was run locally first
   rather than written hopefully.

### Verified end to end

With the stack running from `docker compose up`:

- both images build from a clean context;
- `docker compose down -v` followed by `up` — a genuinely clean machine, with
  the volume destroyed — migrates, seeds 17 tasks and reports healthy;
- both processes apply migrations concurrently under the advisory lock;
- the demo account signs in and the API returns its tasks;
- `docker compose exec scheduler node apps/scheduler/dist/trigger-reminder.js`,
  exactly as the README gives it, produces a delivered reminder in the
  scheduler log within one tick, with the deadline rendered in the account's
  timezone;
- **`docker compose restart web` leaves the scheduler untouched** — its
  `StartedAt` is unchanged and its uptime continues — and the reverse holds
  too. The independent-lifecycle claim is now demonstrated rather than
  asserted;
- the session survives the web restart, because the store is Postgres;
- the accessibility audit passes against the containerised application, which
  also confirms the SPA is served correctly from the image.

### Commit boundary

    fix(docker): make .dockerignore patterns recursive
    build: exclude the test project from the production build
    ci: build and run the Compose stack, and assert a reminder is delivered
    docs: record the Docker packaging fault and its fix

---

## Stage 11 - Real SMTP: verified, and made configurable

Prompted by the question "does the email work with a real address?". The honest
answer at the time was that nobody knew: the stdout notifier was well covered,
but the **nodemailer path had never been executed**. A README that claims real
SMTP works should not be the only evidence that it does.

### Verifying the SMTP path

A throwaway SMTP server - about sixty lines of `node:net` speaking just enough
of RFC 5321 - was pointed at by the real scheduler, running against a real
database, delivering a real reminder. It received a well-formed message:

    envelope from: <tasks@example.com>
    envelope to  : <demo@example.com>
    Subject: Reminder: Pay rent
    Due: Wed, 16 Sept 2026, 15:00 (Europe/London)

Both delivery paths are therefore now demonstrated rather than assumed, and the
timezone conversion at the scheduler's presentation edge is confirmed on the
SMTP path as well as the stdout one.

### Making it configurable without editing tracked files

Previously the only way to enable SMTP under Compose was to edit
`docker-compose.yml`, which invites committing credentials. The scheduler's
environment now reads `${SMTP_HOST:-}` and friends, so settings go in a `.env`
file that `.gitignore` already covers.

### The defect that change exposed

Compose substitutes `${SMTP_USER:-}` as an **empty string**, not as an absent
variable. The old parsing only checked for `undefined`, so an unconfigured
stack would have passed `SMTP_HOST=""` and concluded a mail server *was*
configured, with blank credentials - attempting an SMTP AUTH with an empty
username against an empty host.

"Unset" and "set to nothing" now mean the same thing, and values are trimmed,
which also handles the whitespace a copied app password tends to carry.

`tests/unit/scheduler-config.test.ts` covers this: twelve tests over the mode
switch, credential handling, TLS selection and the documented defaults.
Reintroducing the defect fails three of them, so the guard is demonstrated.

### Commit boundary

    fix(scheduler): treat an empty SMTP variable as unset
    feat(docker): configure SMTP from a git-ignored .env file
    test: scheduler environment parsing
    docs: how to send to a real address, and the Gmail app-password caveat
