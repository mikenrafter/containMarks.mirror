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
- All 25 tests pass, typecheck clean, build succeeds

## What still needs work (Phase A–E)

See `plan.md` for the phased hardening plan covering bugs (#1–2), security (#3–4), performance (#5–6), migration UX (#7), and architecture (#8).
