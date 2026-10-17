/**
 * Issue #5: with "Ask where to save each time" on, the page action opens the
 * folder picker popup; saving from it bookmarks the page, container-encoded,
 * in the picked folder. With it off, a click saves straight to the target.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FirefoxSession } from 'firefox-addon-live'
import { startContainMarks } from './containMarks'

const PANEL = 'cont_bmarks-panel'
const BUTTON = 'pageAction-urlbar-cont_bmarks'
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
// The panel reports "open" before the remote popup page has loaded and focused
// its name field, and that page isn't reachable from Marionette; give it time.
const pickerReady = () => sleep(1_500)

let session: FirefoxSession
let work: number

const setAskForFolder = (enabled: boolean) => session.asExtension(`
	const key = 'containMarks.settings'
	const current = (await browser.storage.local.get(key))[key] ?? {}
	await browser.storage.local.set({ [key]: { ...current, askForFolderOnBookmark: args[0] } })
	return true`, [enabled])

const folderContents = (guid: string) => session.chromeAsync(`
	const tree = await PlacesUtils.promiseBookmarksTree(args[0])
	return (tree.children ?? []).map((child) => ({ title: child.title, url: child.uri }))`, [guid]) as Promise<Array<{ title: string, url: string }>>

beforeAll(async () => {
	session = await startContainMarks({
		width: 800,
		height: 562,
		pages: { 'mail.example': { title: 'Mail: Sign-in' } },
	})
	work = await session.ensureContainer('Work')
}, 90_000)

afterAll(async () => {
	await session?.close()
})

describe('folder picker popup', () => {
	it('saves to the folder picked in the popup, with the container encoded', async () => {
		await setAskForFolder(true)
		await session.openTab('http://mail.example/picked', work)
		await session.waitForTarget(BUTTON)
		await session.realClick(BUTTON)
		await session.waitForPopup(PANEL)
		await expect.poll(() => session.chrome(
			`return document.getElementById(arguments[0]).querySelector('browser')?.currentURI.spec`, [PANEL],
		)).toMatch(/\/picker\/picker\.html$/)

		// Name field starts focused. The first Tab only moves focus into the
		// popup document; the second reaches the folder list, where typing selects.
		await pickerReady()
		await session.keys('Tab')
		await sleep(200)
		await session.keys('Tab')
		await session.type('Other')
		await session.keys('Return')
		await session.waitForPopup(PANEL, 'closed')

		await expect.poll(() => folderContents('unfiled_____')).toEqual([{
			title: 'Mail: Sign-in',
			url: expect.stringMatching(/^http:\/\/mail\.example\/picked#cm:[^:]+:\d+$/),
		}])
	})

	it('Cancel closes the popup without bookmarking', async () => {
		await session.openTab('http://mail.example/cancelled', work)
		await session.waitForTarget(BUTTON)
		await session.realClick(BUTTON)
		await session.waitForPopup(PANEL)
		await pickerReady()
		await session.keys('Escape')
		await session.waitForPopup(PANEL, 'closed')

		const everywhere = [...await folderContents('toolbar_____'), ...await folderContents('unfiled_____')]
		expect(everywhere.filter((bookmark) => bookmark.url.includes('/cancelled'))).toEqual([])
	})

	it('goes back to saving straight to the target folder when turned off', async () => {
		await setAskForFolder(false)
		await session.openTab('http://mail.example/direct', work)
		await session.waitForTarget(BUTTON)
		await session.realClick(BUTTON)

		await expect.poll(() => folderContents('toolbar_____')).toContainEqual({
			title: 'Mail: Sign',
			url: expect.stringMatching(/^http:\/\/mail\.example\/direct#cm:[^:]+:\d+$/),
		})
		expect(await session.popupState(PANEL)).not.toBe('open')
	})
})
