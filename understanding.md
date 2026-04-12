# Understanding

## What was asked

Switch the bookmark URL encoding from `about:token:idx:realUrl` to a **fragment-based** scheme where the real URL is visible and the encoding lives in the `#` fragment. This was implemented as `realUrl#cm:token:containerIndex[#originalFragment]`.

Three supporting mechanisms were requested:

1. **`webNavigation.onBeforeNavigate` + `webRequest.onBeforeRequest` interception**: Detect fragment encoding in `onBeforeNavigate` (which has access to the fragment), then synchronously cancel the HTTP request in `onBeforeRequest` (blocking, `main_frame` only). This prevents network leakage to the wrong container. Iframes and XHR are never intercepted.

2. **Hotswap for bookmark editing**: When the user right-clicks a bookmark, temporarily decode the URL (remove `#cm:...`) so the native Properties dialog shows the clean URL. Track the hotswap state in memory and persist to storage for crash recovery. Restore encoding after a timeout or on user edit.

3. **Pre-existing fragment preservation**: URLs like `https://example.com/page#section` must not lose the `#section` fragment. The encoding goes *before* the original fragment, separated by a second `#` inside the fragment content (valid per RFC 3986). Format: `https://example.com/page#cm:token:0#section`.

## What was delivered (Phase 0)

- Fragment codec: `parseFragmentEncoding`, `parseLegacyEncoding`, `isFragmentEncodedUrl`, `isLegacyEncodedUrl`, `decodeToRealUrl` in `containerMappings.ts`
- `getNewUrl` now produces fragment format; `parseBookmarkUrl` tries fragment-first, falls back to legacy `about:`, then returns a clean default for unencoded URLs
- `handleBeforeNavigate` (synchronous) + `handleBeforeRequest` (synchronous cancel + async fire-and-forget)
- Hotswap state machine: `handleMenuShown` → decode, `handleMenuHidden` → start revert timer, `handleBookmarkChanged` → re-encode on user edit
- Crash recovery: hotswap records persisted to `containMarks.hotswaps` key, recovered on startup
- Auto-migration: `migrateAboutBookmarks` converts legacy `about:token:idx:url` bookmarks to fragment format on startup
- Manifest permissions: `webNavigation`, `webRequest`, `webRequestBlocking`, `<all_urls>`
- All 42 tests pass, typecheck clean, build succeeds

## What was delivered after Phase 0

- Security hardening:
	- Creation-time stripping of orphaned `#cm:` bookmark encodings
	- One-session import bypass (`allowEncodedBookmarkImport`) with startup auto-revert
- Hotswap and interception hardening:
	- Late-edit safety paths and self-update guards
	- New-tab/new-window interception reliability improvements
	- `about:blank` timing/race mitigation via webNavigation interception path
	- Temporary-container orphan-tab cleanup
- Temporary Containers ecosystem integration:
	- Detection and support for both Temporary Containers variants
	- "Temporary Container" assignment menu path using extension API
	- Filtering of ephemeral temp containers from assignable permanent-container list (with graceful fallback)

## What still needs work

Primary next phase: URL codec extraction and versioned module boundary cleanup (see `plan.md`, Phase D).

After that: migration UX improvements (Phase E) and deferred back-button loop design (Phase F).
