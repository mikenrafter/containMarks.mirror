# ContainMarks v1.2.0 — Fragment Encoding Hardening Plan

## Checkpoint Status (2026-04-12)

This plan has advanced beyond the original baseline. Current verified state:

- Tests: 105/105 passing
- Typecheck: clean
- Build: clean (`build:firefox:xpi` succeeds)

### Completed

- Phase A: done
  - Double-encode guard and fragment round-trip hardening shipped
- Phase B: done
  - Creation-time strip of orphaned `#cm:` encodings shipped
  - One-session bypass (`allowEncodedBookmarkImport`) with startup auto-revert shipped
- Phase C: done (implemented via event-coverage hardening instead of polling)
  - Hotswap recovery and late-edit handling hardened
  - New-tab/new-window interception hardened (`about:blank` race covered via webNavigation path)
  - Temp Containers race/orphan cleanup behavior hardened
- Phase D: done
  - URL encoding extracted into `src/urlCodec.ts` with versioned codec chain (beta/v1.0.0/v1.1.0/v1.2.0)
  - `parseBookmarkUrl` only handles v1.2.0 at runtime (security boundary)
  - `parseLegacyBookmarkUrl` added for startup migration paths only
  - Direct-to-current migration functions: `migrateFromBetaToCurrent`, `migrateFromV100ToCurrent`, `migrateFromV110ToCurrent`
  - Legacy storage helpers renamed and moved to urlCodec
  - `BookmarkTokenSource` moved to `models.ts`
- Phase E: done
  - Migration UX with orphan warning on sync toggle
  - Auto-trigger dialog when `enableBookmarkSync` checkbox changes
  - Three actions: Cancel and revert / Reset N bookmark(s) / Overwrite {target} mappings
  - `scanOrphanedBookmarks` and `resetOrphanedBookmarks` in `src/mappingMigration.ts`
  - Helpers extracted to testable module (no DOM dependency)

### Additional completed scope (not in original phase table)

- Temporary Containers / Temporary Containers Plus integration
  - Detection for both extension IDs
  - "Temporary Container" assignment menu option
  - API-driven open flow (`createTabInTempContainer`)
  - Container assignment menu now filters ephemeral temp containers (graceful fallback if API is unavailable)

### Still pending

- Phase F (#9): back-button loop mitigation (deferred design)

## Overview

The fragment-based URL encoding (`#cm:token:idx[#originalFragment]`) is functionally complete.
This plan addresses bugs, security vectors, interop concerns, architectural debt, and
migration UX surfaced during review.

---

## P0 — Bugs

### 1. Duplicate fragment encoding

**Problem**: If `ensureBookmarkContainerUrl` receives a URL that's already fragment-encoded
and `parseBookmarkUrl` somehow fails or returns the raw encoded URL, re-encoding would produce
`https://ex.com#cm:tok:0#cm:newtok:0` — a double encoding.

**Action**: Add a guard in `getNewUrl` that strips any existing `#cm:` encoding from the input
URL before re-encoding. Add a test for the double-encode path.

### 2. Fragment preservation round-trip

**Problem**: Verify that original fragments survive the full lifecycle: encode → decode
(hotswap) → re-encode (revert or user edit).

**Action**: Add end-to-end tests: encode URL with fragment → hotswap decode → user edits
(no URL change) → revert → verify original fragment preserved. Also test the user-edit path
where the user changes the URL AND the fragment.

---

## P1 — Security

### 3. Strip orphaned `#cm:` encodings on bookmark creation

**Problem**: A malicious page or shared link could embed `#cm:token:idx` in a URL. If the
user bookmarks that URL, the extension would treat it as a container-assigned bookmark on
next click — opening it in a container the attacker chose.

**Defense**: When a bookmark is **created** (`bookmarks.onCreated`), check whether its URL
contains `#cm:` encoding. If it does:
- Query `bookmarks.search` for all bookmarks with that **exact** full URL.
- If this is the **only** bookmark with that URL → the user bookmarked a link containing
  `#cm:` (likely malicious or accidental). Strip the `#cm:` encoding, leaving the clean URL.
- If there are **other** bookmarks with that exact URL → the user duplicated/copied an
  existing legit container bookmark. Leave the encoding intact.

**Temporary bypass setting**: Under the existing "I understand the risks" acknowledgment
checkbox, add an `allowEncodedBookmarkImport` setting. When enabled, the creation-time
strip is skipped (useful when importing or transferring bookmark collections). This setting
**auto-reverts to `false`** on every extension startup — it's a one-session escape hatch.

**Action**:
1. Add `onCreated` listener and strip logic in `backgroundApp.ts`.
2. Add `allowEncodedBookmarkImport` to settings schema with `acknowledgeRiskyTokenBehavior`
   gate and auto-revert in `startup()`.
3. Tests: imported bookmark with `#cm:` gets stripped; duplicated bookmark keeps encoding;
   bypass setting skips strip; setting reverts on restart.

---

## P2 — Interop & Performance

### 5. Synchronous in-memory mapping cache

**Problem**: `executeInterception` is async: cancel request → resolve settings → init mapping
store → look up mapping → `tabs.create` → `tabs.remove`. Each `await` adds latency.

**Action**: Maintain a synchronous in-memory cache of container index → cookieStoreId mappings
and settings. Populated on startup, updated on change events. This reduces the async chain
to just `tabs.create` + `tabs.remove`.

### 6. Polling fallback evaluation

**Problem**: Same-page fragment navigations may not fire `webNavigation.onBeforeNavigate` or
`webRequest.onBeforeRequest`. `handleTabUpdated` may miss some edge cases.

**Action**: Evaluate whether a lightweight poll (check active tab URL every N seconds) would
catch missed interceptions vs. extending `handleTabUpdated` event coverage.

---

## P3 — Migration UX

### 7. Local ↔ synced migration with orphan warning

**Problem**: When switching between local and synced mapping storage, bookmarks encoded with
one store's index may not resolve in the other. These become "orphaned".

**Action**: In the options UI transfer dialog, scan for orphaned bookmarks, warn the user,
and offer a checkbox to clear assignments for orphaned bookmarks.

---

## P4 — Architecture

### 8. URL encoding module — versioned codec chain

**Problem**: URL encoding has evolved across releases (Beta → 1.0.0 → 1.1.0 → 1.2.0).
Parsing/building logic sits in `containerMappings.ts` alongside unrelated mapping utilities.

**Action**: Extract URL encoding into `src/urlCodec.ts` with a versioned codec chain.
Each version defines `parse` and `build`. `parseBookmarkUrl` tries newest-first.
Migration functions become "upgrade from vN to vN+1".

| Version | Format |
|---------|--------|
| Beta | localStorage key → container name |
| 1.0.0 | `about:token:containerName:url` |
| 1.1.0 | `about:token:containerIndex:url` |
| 1.2.0 | `url#cm:token:containerIndex[#originalFragment]` |

---

## P5 — Deferred (needs more design)

### 9. Back button loop with temporary containers

**Problem**: After a container redirect, the browser's back button navigates back to the
encoded URL — which triggers a second interception → redirect loop. Interaction with
temporary-container addons adds complexity.

**Status**: Deferred. Needs analysis of Firefox back/forward cache behavior and testing
with Multi-Account Containers and Temporary Containers addons before designing a solution.
Candidate approach: track recently-intercepted tab IDs with a short TTL.

---

## Execution Order

| Phase | Items | Dependency |
|-------|-------|------------|
| A | #1 (double encode), #2 (fragment round-trip) | None — bug fixes | done |
| B | #3 (creation-time strip + bypass setting) | None — security | done |
| C | #5 (sync cache), #6 (poll evaluation) | None — performance | done via interception/event hardening |
| D | #8 (urlCodec module extraction) | After A+B stabilize codecs | done |
| E | #7 (orphan migration UX) | After D stabilizes module boundaries | done |
| F | #9 (back button loop) | After real-world testing with temp container addons |

Phases A–C are independent and can be parallelized. D depends on A+B. E depends on D.
F is deferred until design is finalized.

---

## Phase G: backgroundApp.ts Module Extraction

### Architecture
- **BookmarkAssignmentManager** (BAM): menu, assignment, hotswap lifecycle
- **NavigationPolicyEngine** (NPE): all redirect decisions → NavigationIntent
- **TabExecutionController** (TEC): tab/window side-effects, page action
- **ContainMarksRuntime** (CMR): wiring, startup, migration (replaces BackgroundApp)

Interface skeletons: `src/background/{bookmarkAssignmentManager,navigationPolicyEngine,tabExecutionController,containMarksRuntime}.ts`
Shared types added to `src/models.ts`: `NavigationIntent`, `HotswapRecord`, `PendingInterception`, `HotswapRedirectInfo`

### Extraction order (dependency-safe)

Each step: implement module class, move methods, update tests, typecheck+test.

#### Step 1: TabExecutionController (leaf — no other module depends on it)
| Method | Line | Notes |
|--------|------|-------|
| `openInContainer` | 660 | Core redirect primitive |
| `openInTempContainer` | 690 | TC extension delegation |
| `redirectHotswappedTab` | 720 | Resolve index → cookieStoreId, delegate to openInContainer |
| `cleanupOrphanedTabs` | 756 | Post-redirect about:blank cleanup |
| `syncPageActionVisibilityForTab` | 395 | Show/hide page action |
| `syncPageActionVisibilityForAllTabs` | 385 | Iterate all tabs |
| `handlePageActionClicked` | 1257 | Quick-bookmark + assign |
| New: `executeIntent` | — | Switch on NavigationIntent, dispatch to above methods |

#### Step 2: NavigationPolicyEngine (depends on TEC for nothing; depends on BAM.hotswapRedirectMap read-only)
| Method | Line | Notes |
|--------|------|-------|
| `handleBeforeNavigate` | 792 | Sync — populate pendingInterceptions |
| `handleBeforeRequest` | 825 | Sync blocking — cancel + fire async |
| `executeInterception` | 844 | Async — resolve mapping → return intent |
| New: `evaluateTabNavigation` | — | For handleTabUpdated path |
| New: `evaluateHotswapRedirect` | — | For handleTabCreated/handleWindowCreated path |

#### Step 3: BookmarkAssignmentManager (depends on nothing; exposes hotswapRedirectMap)
| Method | Line | Notes |
|--------|------|-------|
| `createMenuItems` | 444 | Build radio items for containers |
| `rebuildMenuItems` | 407 | Refresh menu for bookmark context |
| `getSelectedMenuContainerId` | 418 | Parse bookmark URL → current assignment |
| `getContainer` | 540 | Resolve cookieStoreId/backupName → ContextualIdentity |
| `updateBookmarkContainerUrl` | 571 | Core assignment: encode/decode URL |
| `applyContainer` | 637 | Batch-assign to bookmarks |
| `handleMenuClick` | 884 | Menu click → assign + hotswap |
| `handleMenuShown` | 905 | Menu shown → rebuild + hotswap decode |
| `handleMenuHidden` | 960 | Menu hidden → revert hotswap |
| `handleBookmarkChanged` | 987 | Detect user edit during hotswap |
| `handleBookmarkCreated` | 1039 | Strip orphaned encoding from new bookmarks |
| `detectTempContainersExtension` | 176 | Check for TC/TC+ addon |
| `persistHotswapRecords` | 313 | Persist hotswap state to storage |
| `recoverPendingHotswaps` | 325 | Crash recovery |
| `cancelHotswapTimer` | 352 | Cancel revert timer |
| `revertHotswap` | 364 | Execute revert |

#### Step 4: ContainMarksRuntime (wiring — last step, composes modules)
| Method | Line | Notes |
|--------|------|-------|
| `initialize` | 160 | Wire modules + register listeners |
| `startup` | 198 | Migration + recovery sequence |
| `migrateLegacyStorage` | 226 | One-time legacy migration |
| `migrateAboutBookmarks` | 263 | One-time about: URL migration |
| `refreshTokensOnStartup` | 286 | Token refresh sweep |
| `handleTabCreated` | 1079 | Route: evaluate hotswap → execute intent |
| `handleWindowCreated` | 1121 | Route: evaluate each tab → execute intent |
| `handleTabUpdated` | 1166 | Route: evaluate URL change → execute intent |
| `handleTabActivated` | 1240 | Route: sync page action |
| `registerListeners` | 1306 | Wire all browser listeners |
| `getMappingStore` | 380 | Select sync vs local store |
| `debug` | 147 | Conditional logging |

### Test update plan

- **Step 1** (TEC): New `tests/tabExecutionController.test.ts` — test openInContainer, cleanupOrphanedTabs, executeIntent. Mock browser.tabs.create/remove.
- **Step 2** (NPE): New `tests/navigationPolicyEngine.test.ts` — test intent output for each scenario (fragment URL, hotswap match, already-in-container, missing mapping). Mock only webNavigation/webRequest details.
- **Step 3** (BAM): New `tests/bookmarkAssignmentManager.test.ts` — test menu rebuild, hotswap encode/decode/revert, TC detection, bookmark event handling.
- **Step 4** (CMR): Adapt existing `tests/backgroundApp.test.ts` — verify wiring, startup sequence, event routing. Integration-level tests that exercise the full pipeline.

### Key constraint
After each step, `npm run typecheck && npm test` must remain green. BackgroundApp continues to exist and work throughout; methods are extracted one module at a time, with BackgroundApp delegating to the new module where extraction is complete.

### Step 1 progress: TabExecutionController — DONE
- `TabExecutionControllerImpl` implemented in `src/background/tabExecutionController.ts`
- 24 tests in `tests/tabExecutionController.test.ts` — all pass
- Added `isShown`, `setTitle` to `PageActionApi` in `models.ts`
- Added `isTempContainer` method (queries TC/TC+ API, graceful fallback)
- Page action visibility: `isShown` short-circuit prevents flicker
- `cleanupOrphanedTabs`: pre-delay snapshot excludes pre-existing tabs
- `handlePageActionClicked`: temp container tabs → `TEMP_CONTAINER_SENTINEL` assignment
- `syncPageActionVisibilityForAllTabs`: per-tab dynamic title ("Bookmark this page in ...")

#### HUMAN TODOs (require manual runtime testing)
1. **cleanupOrphanedTabs exclusion guard** — The pre-delay snapshot prevents removing pre-existing about:blank tabs. Trade-off: if TC creates the orphan before our snapshot (rare race), we miss it. Needs integration testing with TC installed.
2. **syncPageActionVisibilityForTab flicker** — The `isShown` short-circuit should prevent flicker, but needs visual confirmation in Firefox during rapid tab switching.
3. **handlePageActionClicked temp container** — When tab is in an ephemeral TC container, we assign to `TEMP_CONTAINER_SENTINEL` instead of the specific ephemeral cookieStoreId. Verify with TC installed that the bookmark opens correctly in a fresh temp container.

### Step 2 progress: NavigationPolicyEngine — DONE
- `NavigationPolicyEngineImpl` implemented in `src/background/navigationPolicyEngine.ts`
- 20 tests in `tests/navigationPolicyEngine.test.ts` — all pass
- `handleBeforeNavigate`: sync detection of fragment-encoded URLs + hotswap matches
- `handleBeforeRequest`: sync cancel + async intent resolution via `onIntentResolved` callback
- `resolveInterception`: maps interception → NavigationIntent (redirect/redirect-temp/reset-token/noop)
- `evaluateTabNavigation`: fallback path for fragment changes and legacy about: URLs
- `evaluateHotswapRedirect`: hotswap redirect evaluation for tab/window creation events
- Added `onIntentResolved` callback to deps for async-to-sync bridge
