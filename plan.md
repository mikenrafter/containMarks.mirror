# ContainMarks v1.2.0 — Fragment Encoding Hardening Plan

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

### 3. Bookmarklet attack vector

**Problem**: An attacker crafts `https://evil.com#cm:anything:0` and convinces the user to
bookmark it. On click, `onBeforeNavigate` detects the fragment and redirects to container 0.

**Action**: Only intercept URLs whose `#cm:` encoding matches a **known bookmark** in the
bookmark store (cross-reference against `bookmarks.search`). Reject unknown URLs so the
fragment becomes harmless text.

### 4. Back button loop with temporary containers

**Problem**: After a container redirect, the browser's back button navigates back to the
encoded URL — which triggers a second interception → redirect loop.

**Action**: Track recently-intercepted tab IDs with a short TTL. Skip re-interception for
tabs within the TTL window.

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

## Execution Order

| Phase | Items | Dependency |
|-------|-------|------------|
| A | #1 (double encode), #2 (fragment round-trip) | None — bug fixes |
| B | #3 (bookmarklet attack), #4 (back button loop) | None — security |
| C | #5 (sync cache), #6 (poll evaluation) | None — performance |
| D | #8 (urlCodec module extraction) | After A+B stabilize codecs |
| E | #7 (orphan migration UX) | After D stabilizes module boundaries |

Phases A–C are independent and can be parallelized. D depends on A+B. E depends on D.
