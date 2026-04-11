# Original Request

> WAIT! I just realized that a fragment + hotswap + onBeforeRequest (ensuring that this only applies to top-level sites, not iframes or XHR) setup would work perfectly! The user wouldn't even see the fragment when editing! The extension would need to keep track of which bookmarks are hotswapped or are being hotswap-polled... So that a crash wouldn't unset a bookmark. The next restart would resolve any pending hotswaps. Make sure not to clobber preexisting fragments ... ie - add our text before the preexisting fragment text & add a special suffix to our encoding that ensures the other fragment is correctly restored when loading & editing. Does our current delimiter work for the fragment approach? If not, switch it.
>
> Get started!

## Follow-up concerns (post-implementation review):

1. Back button voodoo from advanced temp containers
2. Bookmarklet attack vector
3. Temp containers interop — async delay between open and load
4. Duplicate fragment encoding bug (re-encoding already-encoded URLs)
5. Polling fallback for edge cases where events don't fire
6. Handle migration from local ↔ sync — warn about orphaned bookmarks
7. Legacy vs current link format — organize by version, extract to dedicated module
