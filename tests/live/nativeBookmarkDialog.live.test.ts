/**
 * Issue #5 (choose the bookmark location each time): can ContainMarks hand the
 * user Firefox's own "Add bookmark" UI, with its Location picker, instead of
 * reimplementing a folder chooser?
 *
 * Findings, pinned here so a Firefox change that alters them fails loudly:
 * - A WebExtension cannot open the native dialog or the star panel. The
 *   dialog's chrome:// URL is refused by every tab/window API, and there is
 *   no bookmarks API that opens UI.
 * - The native star (or Ctrl+D) panel does work in container tabs, and only
 *   writes the bookmark when the user presses Save, already in the chosen
 *   folder. So `bookmarks.onCreated` sees the final location, which is the
 *   hook ContainMarks could use to tag star-made bookmarks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FirefoxSession } from 'firefox-addon-live'
import { startContainMarks } from './containMarks'

const PROPERTIES_DIALOG = 'chrome://browser/content/places/bookmarkProperties.xhtml'
const PAGE = 'http://mail.example/inbox'

let session: FirefoxSession
let work: number

const openWindows = () => session.chrome(
	'return [...Services.wm.getEnumerator(null)].map((window) => window.document.documentURI)',
) as Promise<string[]>

const bookmarksFor = (url: string) => session.chromeAsync(`
	const found = []
	await PlacesUtils.bookmarks.fetch({ url: new URL(args[0]) }, (bookmark) => found.push({
		url: bookmark.url.href, parent: bookmark.parentGuid, title: bookmark.title,
	}))
	return found`, [url]) as Promise<Array<{ url: string, parent: string, title: string }>>

const encodedBookmarks = () => session.chromeAsync(`
	const found = []
	const query = PlacesUtils.history.getNewQuery()
	query.searchTerms = 'mail.example'
	const options = PlacesUtils.history.getNewQueryOptions()
	options.queryType = options.QUERY_TYPE_BOOKMARKS
	const root = PlacesUtils.history.executeQuery(query, options).root
	root.containerOpen = true
	for (let i = 0; i < root.childCount; i++) found.push(root.getChild(i).uri)
	root.containerOpen = false
	return found`) as Promise<string[]>

beforeAll(async () => {
	session = await startContainMarks({ width: 900, height: 650 })
	work = await session.ensureContainer('Work', 'orange', 'briefcase')
}, 90_000)

afterAll(async () => {
	await session?.close()
})

describe('native bookmark dialog from the add-on', () => {
	it.each([
		['tabs.create', `await browser.tabs.create({ url: args[0] })`, /Illegal URL/],
		['windows.create', `await browser.windows.create({ url: args[0], type: 'popup' })`, /Illegal URL/],
		['tabs.update', `const [tab] = await browser.tabs.query({ active: true, currentWindow: true }); await browser.tabs.update(tab.id, { url: args[0] })`, /Illegal URL/],
		['window.open', `window.open(args[0])`, /denied/],
	])('%s refuses the bookmark properties dialog', async (_name, body, error) => {
		await expect(session.asExtension(body, [PROPERTIES_DIALOG])).rejects.toThrow(error)
		expect(await openWindows()).toEqual(['chrome://browser/content/browser.xhtml'])
	})

	it('has no API that opens bookmark UI', async () => {
		const bookmarkApi = await session.asExtension('return Object.keys(browser.bookmarks).sort()') as string[]
		expect(bookmarkApi.filter((name) => /open|show|edit|dialog|panel/i.test(name))).toEqual([])
	})
})

describe('native star panel in a container tab', () => {
	it('offers a location picker and saves only on Save, in the chosen folder', async () => {
		await session.openTab(PAGE, work)
		await session.realClick('star-button-box')
		await session.waitForPopup('editBookmarkPanel')

		expect(await session.chrome("return document.getElementById('editBMPanel_folderMenuList')?.hidden")).toBe(false)
		expect(await bookmarksFor(PAGE)).toEqual([])

		await session.chrome("document.getElementById('editBMPanel_folderMenuList').open = true; return true")
		// The menulist's popup has no id; wait for its items to lay out.
		await new Promise((done) => setTimeout(done, 500))
		await session.realClick('editBMPanel_unfiledRootItem')
		await session.realClick('editBookmarkPanelDoneButton')
		await session.waitForPopup('editBookmarkPanel', 'closed')

		await expect.poll(() => bookmarksFor(PAGE)).toEqual([
			expect.objectContaining({ url: PAGE, parent: 'unfiled_____' }),
		])
	})
})

describe('ContainMarks page action', () => {
	it('bookmarks the page with its container encoded into the URL', async () => {
		await session.openTab(`${PAGE}?page-action`, work)
		await session.waitForPopup('editBookmarkPanel', 'closed').catch(() => undefined)
		// The button shows once the page action syncs with the loaded tab.
		await session.waitForTarget('pageAction-urlbar-cont_bmarks')
		await session.realClick('pageAction-urlbar-cont_bmarks')

		await expect.poll(encodedBookmarks, { timeout: 5_000 })
			.toContainEqual(expect.stringMatching(/^http:\/\/mail\.example\/inbox\?page-action#cm:[^:]+:\d+$/))
	})
})
