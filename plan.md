# ContainMarks v1.2.0 — Fragment Encoding Hardening Plan

## Checkpoint Status (2026-04-12)

This plan has advanced beyond the original baseline. Current verified state:

- Tests: 42/42 passing
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

### Additional completed scope (not in original phase table)

- Temporary Containers / Temporary Containers Plus integration
  - Detection for both extension IDs
  - "Temporary Container" assignment menu option
  - API-driven open flow (`createTabInTempContainer`)
  - Container assignment menu now filters ephemeral temp containers (graceful fallback if API is unavailable)

### Recommended next phase

- Phase D (#8): URL encoding extraction into a dedicated versioned codec module

### Still pending

- Phase E (#7): local/sync migration UX with orphan warning
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
| D | #8 (urlCodec module extraction) | After A+B stabilize codecs |
| E | #7 (orphan migration UX) | After D stabilizes module boundaries |
| F | #9 (back button loop) | After real-world testing with temp container addons |

Phases A–C are independent and can be parallelized. D depends on A+B. E depends on D.
F is deferred until design is finalized.
