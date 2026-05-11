# ContainMarks Navigation Architecture — Reorganization Spec

> Status: **DRAFT** — pending review before implementation.

## Problem statement

The current 4-module structure (BAM, NPE, TEC, BackgroundApp) distributes hotswap
state across 3 module boundaries. Data flows through long DI chains with timing
constraints that are impossible to reason about locally:

- `hotswapRedirectMap` is written by BAM, consumed by NPE, read by TEC
- `preHotswapTabIds` is captured in BAM, travels through TEC deps
- `handleMenuHidden` has an async gap where consumed entries get re-added
- The `NavigationIntent` abstraction adds indirection without solving timing
- Revert timer (200ms) conflicts with async redirect chain (>200ms)

## Proposed architecture

```
ContainMarksRuntime
  ├── HotswapHandler        (class with DI, not a mixin)
  ├── TempContainerLayer    (class with DI, wraps redirects)
  └── StandardHandler       (class with DI)
```

### Module boundaries

No `NavigationIntent` objects. No `TabExecutionController`. No `BookmarkAssignmentManager`.
No `NavigationPolicyEngine`. Each handler directly executes tab/window side-effects.

### Pipeline (per navigation event)

Every `webNavigation.onBeforeNavigate` and `tabs.onUpdated` invocation runs through:

```
1. [sync]  hotswap.detect(url, tab)       → 'claim' | 'locked' | 'pass'
2. [sync]  standard.detect(url, tab)      → 'claim' | 'pass'  (skipped if hotswap claimed)
3. [sync]  return { cancel: true }          (if any handler claimed)
4. [async] tc.cleanup(windowId, preTabIds)  (always if TC present)
5. [async] IF hotswap locked              → done (only TC cleanup ran)
   ELIF hotswap claimed                   → tc.wrapRedirect(hotswap.activate)
   ELIF standard claimed                  → tc.wrapRedirect(standard.activate)
   ELSE                                   → done
```

## Module specifications

---

### HotswapHandler

**Purpose:** Owns the entire hotswap decode → redirect → revert lifecycle.

**State:**

| Field | Type | Purpose |
|-------|------|---------|
| `redirectMap` | `Map<url, { containerIndex, bookmarkId }>` | Decoded URLs awaiting navigation interception |
| `hotswapRecords` | `Map<bookmarkId, HotswapRecord>` | Active decode sessions |
| `revertTimers` | `Map<bookmarkId, timeoutId>` | Scheduled reverts |
| `lockedUrls` | `Set<url>` | URLs consumed by a navigation but not yet reverted |
| `preHotswapTabIds` | `Set<tabId> \| null` | Tab snapshot captured at menuHidden, before TC acts |
| `selfUpdateBookmarkIds` | `Set<bookmarkId>` | Self-edit suppression |
| `pendingEditBookmark` | `{ id, containerIndex } \| null` | Bookmark being edited in Properties dialog |

**Event handlers:**

| Event | Handler | Behavior |
|-------|---------|----------|
| `menus.onShown` | `handleMenuShown` | Clear locks from previous cycle. If bookmark has encoded URL: decode it, add to `redirectMap`, register hotswap record, persist for crash recovery. |
| `menus.onHidden` | `handleMenuHidden` | Capture `preHotswapTabIds` snapshot. For each hotswap record without a revert timer: ensure it's in `redirectMap` (do not re-add if already consumed), schedule revert. |
| `bookmarks.onChanged` | `handleBookmarkChanged` | If self-edit → skip. If hotswap record for this bookmark exists → re-encode with user's new URL. If `pendingEditBookmark` matches → re-encode. |
| `bookmarks.onCreated` | `handleBookmarkCreated` | Anti-injection: strip orphaned fragment encoding from new bookmarks unless `allowEncodedBookmarkImport`. |

**Pipeline methods:**

| Method | Sync? | Returns | Behavior |
|--------|-------|---------|----------|
| `detect(url, tab)` | **sync** | `'claim' \| 'locked' \| 'pass'` | Check `redirectMap` for url match. If match: consume entry, add url to `lockedUrls`, return `'claim'`. If url in `lockedUrls`: return `'locked'`. Otherwise: `'pass'`. |
| `activate(url, tab)` | async | void | Lookup containerIndex from consumed info. Resolve mapping → get cookieStoreId. Open tab in container, remove source tab. Delay revert timer by consumed navigation. After tab redirect completes, schedule deferred revert (extended delay). |
| `getContainerIndex(url)` | sync | `number \| null` | Returns the container index for a consumed hotswap URL. Called by `activate()`. |

**Revert lifecycle:**

```
menuShown:  add to redirectMap + hotswapRecords, cancel any preexisting revert timers
menuHidden: snapshot tabs, cancel any preexisting revert timers, schedule revert timer (200ms)
navigation: consume() → add to lockedUrls, pause/extend revert timer
  ↳ activate: open in container, remove source tab
  ↳ after activate: reschedule revert timer
revert:     update bookmark URL back to encoded form, remove from lockedUrls
menuShown:  clear lockedUrls (new cycle starts fresh)
```

**Critical invariant:** Once a URL is in `lockedUrls`, no handler (standard, hotswap, or
TC redirect) will fire for that URL. Only TC cleanup runs. The lock is released when the
revert timer finally fires.

---

### TempContainerLayer

**Purpose:** Wraps redirect execution with TC-specific behavior. Not a handler — a
decorator/layer that enhances redirects.

**State:**

| Field | Type | Purpose |
|-------|------|---------|
| `extensionId` | `string \| null` | Detected TC/TC+ extension ID |

**Methods:**

| Method | Behavior |
|--------|----------|
| `initialize()` | Probe for TC/TC+ extensions via `management.get()`. Store `extensionId`. |
| `isPresent()` | Returns `extensionId !== null`. |
| `cleanup(windowId, preTabIds)` | After delay (150ms × N iterations): query window tabs. For each tab not in `preTabIds` and not in the target container: ask TC via `isTempContainer()`. If ephemeral → remove. |
| `wrapRedirect(redirectFn)` | Call `redirectFn()` to perform the tab create+remove. If source tab removal fails (TC replaced it), still run cleanup. |
| `openInTempContainer(url, tab)` | Call TC API `createTabInTempContainer`. Remove source tab. Fallback to default container on failure. |
| `isTempContainer(cookieStoreId)` | Proxy to TC API. Returns false if no TC installed. |

**TC-aware redirect flow:**

```
wrapRedirect(redirectFn):
  1. Take pre-redirect tab snapshot (or use preHotswapTabIds if available)
  2. Call redirectFn(url, cookieStoreId, tab)
     → redirectFn creates tab in container, tries to remove source
  3. If source removal failed → TC likely replaced it
  4. Run cleanup(windowId, preRedirectSnapshot)
```

---

### StandardHandler

**Purpose:** Handles fragment-encoded bookmark URLs (non-hotswap) via the
navigation interception pipeline.

**State:**

| Field | Type | Purpose |
|-------|------|---------|
| (none) | — | StandardHandler is stateless. Pipeline state (`pendingInterceptions`, `claimedTabIds`) lives in the runtime. |

**Pipeline methods:**

| Method | Sync? | Returns | Behavior |
|--------|-------|---------|----------|
| `detect(url, tab)` | **sync** | `'claim' \| 'pass'` | Parse URL: if fragment-encoded → return `'claim'`. Otherwise `'pass'`. |
| `activate(url, tab)` | async | void | Resolve containerIndex → mapping → cookieStoreId. Open tab in container, remove source. If `regenerateTokenOnEveryUse` → update bookmark token. |

**No `handleBeforeRequest`** — the webRequest cancel scope lives in the runtime's
navigation pipeline so that ALL handlers can participate in cancellation. See the
runtime's `handleBeforeRequest` below.

**Fallback for non-HTTP URLs:**

When `webRequest.onBeforeRequest` doesn't fire (same-page fragment change, `about:blank` URL (simple new tab mechanism),
etc.), `tabs.onUpdated` triggers re-evaluation in the runtime. The runtime checks pipeline
state (`pendingCancellations` not consumed, `claimedTabIds` doesn't have the tab) and
calls `standard.activate()` directly as a fallback.

---

### ContainMarksRuntime

**Purpose:** Module instantiation, wiring, listener registration, startup sequence.
Contains NO business logic beyond routing.

**Owns:**

| Concern | Detail |
|---------|--------|
| Mapping stores | `syncMappingStore`, `localMappingStore` |
| Settings | `loadSettings()` accessor |
| Listener registration | All `browser.*` event listeners delegated to handlers |
| Startup | Init stores, recover hotswaps, migrate legacy bookmarks, refresh tokens |

**Listener routing:**

```typescript
// --- Pipeline state (owned by runtime, shared across handlers) ---
const pendingCancellations = new Map<number, 'hotswap' | 'standard'>()
const claimedTabIds = new Set<number>()

// --- Navigation pipeline: detection + cancel ---
browser.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return
  
  const hotswapResult = hotswap.detect(details.url, { id: details.tabId })
  const standardResult = hotswapResult === 'pass'
    ? standard.detect(details.url, { id: details.tabId })
    : 'pass'
  
  // Track which tabs need their HTTP request cancelled
  if (hotswapResult === 'claim') {
    pendingCancellations.set(details.tabId, 'hotswap')
  } else if (standardResult === 'claim') {
    pendingCancellations.set(details.tabId, 'standard')
  }
  
  // Fire and forget the async activation chain
  if (hotswapResult !== 'pass' || standardResult !== 'pass') {
    void activateNavigation(details, hotswapResult, standardResult)
  }
})

// --- HTTP request cancellation (shared scope for all handlers) ---
browser.webRequest.onBeforeRequest.addListener((details) => {
  if (details.type !== 'main_frame') return
  
  const pending = pendingCancellations.get(details.tabId)
  if (!pending) return
  
  // Claim this tab so tabs.onUpdated yields no-op for the same navigation
  claimedTabIds.add(details.tabId)
  pendingCancellations.delete(details.tabId)
  
  // The async activation chain is already running (fired in onBeforeNavigate)
  // — we just need to cancel the HTTP request.
  setTimeout(() => claimedTabIds.delete(details.tabId), 0)
  return { cancel: true }
}, { urls: ['<all_urls>'], types: ['main_frame'] }, ['blocking'])

// --- tabs.onUpdated fallback (for when webRequest doesn't fire) ---
browser.tabs.onUpdated.addListener((id, change, tab) => {
  void handleTabUpdated(id, change, tab)
})

// Menu events → HotswapHandler
browser.menus.onShown.addListener(hotswap.handleMenuShown)
browser.menus.onHidden.addListener(hotswap.handleMenuHidden)
browser.menus.onClicked.addListener(hotswap.handleMenuClick)

// Bookmark events → HotswapHandler
browser.bookmarks.onChanged.addListener(hotswap.handleBookmarkChanged)
browser.bookmarks.onCreated.addListener(hotswap.handleBookmarkCreated)
```

**Shared utilities (not in any handler):**

- `getContainer(query)` — resolves container by cookieStoreId or backupName
- `updateBookmarkContainerUrl(bookmark, cookieStoreId?)` — encode/refresh bookmark URL
- `applyContainer(bookmarks, cookieStoreId)` — recursive container assignment
- Context menu building — `createMenuItems()` (can stay in HotswapHandler or be extracted)

---

## Page action

Page action (show/hide icon + click handler) stays in the runtime or in a small
`PageActionHandler` class. It's orthogonal to navigation and doesn't need to be
in any of the 3 handlers.

---

## Migration path

1. **Extract HotswapHandler** from BAM — move all hotswap state, menu events, bookmark events
2. **Extract TempContainerLayer** from TEC — move TC detection, cleanup, TC API calls
3. **Extract StandardHandler** from NPE + TEC — combine interception logic with tab execution
4. **Wire in ContainMarksRuntime** — replace BackgroundApp's routing with new pipeline
5. **Delete old modules** — BAM, NPE, TEC become empty → remove
6. **Move shared utils** — `getContainer`, `updateBookmarkContainerUrl`, etc. to shared service or runtime

Each step is independently testable. No big-bang rewrite.

---

## Open questions

1. **Context menu building** — stays in HotswapHandler or extracted to its own class?
2. **Mapping store access** — each handler gets `mappingStore` via DI, or a shared service?
3. **Page action** — own class or stays in runtime?
4. **Bookmark codec** (`getNewUrl`, `parseBookmarkUrl`, `decodeToRealUrl`) — stays as pure functions in `urlCodec.ts`, shared by all handlers?
