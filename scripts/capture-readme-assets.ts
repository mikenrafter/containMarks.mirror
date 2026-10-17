/**
 * Regenerates the README / product-page captures in product-page/ from a real
 * Firefox with ContainMarks loaded, on a private Xvfb display:
 *
 *   usage-omnibar  page-action click bookmarks the page + container
 *   usage-context  bookmark context menu → Assign Bookmark to container
 *   usage-edit     native Edit Bookmark dialog (the token stays hidden)
 *   usage-folder   folder context menu → Assign Bookmarks in Folder
 *   usage-picker   "Ask where to save each time": the folder picker popup
 *   usage-target   about:addons settings: pick the target folder and save (taller,
 *                  so the whole settings page shows)
 *
 * Each scene writes a 640px-wide GIF (real X pointer, recorded with ffmpeg) and
 * a PNG still. Pages are local fixtures served for *.example hosts. The harness
 * is firefox-addon-live (a flake input; see flake.nix).
 *
 * Usage (inside `nix develop`):
 *   npm run capture:readme                 # every scene
 *   npm run capture:readme -- context edit # only these scenes
 *   OUT_DIR=/tmp/shots npm run capture:readme
 */

import { resolve } from 'node:path'
import {
	GLIDE,
	dialogButton,
	dialogField,
	menuItem,
	openAddonPreferences,
	runCaptures,
	settle,
	signInPage,
	toolbarItem,
	type FirefoxSession,
} from 'firefox-addon-live'
import { EXTENSION_ID, EXTENSION_SOURCE } from '../tests/live/containMarks'

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const PAGE_ACTION = 'pageAction-urlbar-cont_bmarks'
const PICKER_PANEL = 'cont_bmarks-panel'
/** Window height for the settings capture: the about:addons card plus the whole options page. */
const TARGET_HEIGHT = 1100

await runCaptures({
	outDir: resolve(import.meta.dirname, '../product-page'),
	session: {
		addon: { source: EXTENSION_SOURCE, id: EXTENSION_ID },
		pages: {
			'mail.example': signInPage('Mail', '#6d4aff'),
			'drive.example': signInPage('Drive', '#8a6cff'),
			'git.example': signInPage('Git', '#24292f'),
			'shop.example': signInPage('Shop', '#e0672a'),
		},
	},
	setup: seedBookmarks,
	scenes: {
		omnibar: {
			async run(session, kit) {
				await session.openTab('http://mail.example/mail', await session.ensureContainer('Personal'))
				await settle(session)
				const stop = await kit.record('usage-omnibar')
				await sleep(600)
				await session.pointerTo(PAGE_ACTION, GLIDE)
				await sleep(500)
				await kit.still('usage-omnibar')
				await session.pointerClick()
				await sleep(1_500)
				await stop()
			},
		},

		context: {
			async run(session, kit) {
				await session.openTab('http://mail.example/mail', await session.ensureContainer('Work'))
				await settle(session)
				const stop = await kit.record('usage-context')
				await sleep(500)
				await session.realClick(toolbarItem('Mail'), { button: 3, glide: GLIDE })
				await session.waitForPopup('placesContext')
				await sleep(400)
				await session.pointerTo(menuItem('placesContext', 'Assign Bookmark to container'), GLIDE)
				await sleep(900)
				await session.pointerTo(menuItem('placesContext', 'Work'), GLIDE)
				await sleep(600)
				await kit.still('usage-context')
				await session.pointerClick()
				await sleep(1_200)
				await stop()
			},
		},

		edit: {
			// Edits the bookmark that `context` assigned.
			requires: ['context'],
			async run(session, kit) {
				await session.openTab('http://mail.example/mail', await session.ensureContainer('Work'))
				await settle(session)
				const stop = await kit.record('usage-edit')
				await sleep(500)
				await session.realClick(toolbarItem('Mail'), { button: 3, glide: GLIDE })
				await session.waitForPopup('placesContext')
				await sleep(400)
				await session.realClick('placesContext_show_bookmark:info', { glide: GLIDE })
				const field = dialogField('editBMPanel_locationField')
				await session.waitForTarget(field)
				await sleep(900)
				await session.pointerTo(field, GLIDE)
				await sleep(300)
				await session.pointerClick()
				await session.keys('End')
				await sleep(700)
				await kit.still('usage-edit')
				await sleep(800)
				await session.realClick(dialogButton('accept'), { glide: GLIDE })
				await sleep(1_200)
				await stop()
			},
		},

		folder: {
			async run(session, kit) {
				await session.openTab('http://drive.example/drive', await session.ensureContainer('Personal'))
				await settle(session)
				const stop = await kit.record('usage-folder')
				await sleep(500)
				await session.realClick(toolbarItem('shopping'), { button: 3, glide: GLIDE })
				await session.waitForPopup('placesContext')
				await sleep(400)
				await session.pointerTo(menuItem('placesContext', 'Assign Bookmarks in Folder'), GLIDE)
				await sleep(900)
				await session.pointerTo(menuItem('placesContext', 'Shopping'), GLIDE)
				await sleep(600)
				await kit.still('usage-folder')
				await session.pointerClick()
				await sleep(1_200)
				await stop()
			},
		},

		picker: {
			async run(session, kit) {
				await setAskForFolder(session, true)
				try {
					await session.openTab('http://mail.example/mail', await session.ensureContainer('Work'))
					await settle(session)
					const stop = await kit.record('usage-picker')
					await sleep(500)
					await session.realClick(PAGE_ACTION, { glide: GLIDE })
					await session.waitForPopup(PICKER_PANEL)
					// The remote popup page loads after the panel opens.
					await sleep(1_500)
					// First Tab enters the popup document, the second reaches the folder list.
					await session.keys('Tab')
					await sleep(200)
					await session.keys('Tab')
					await sleep(400)
					await session.type('shopping')
					await sleep(900)
					await kit.still('usage-picker')
					await session.keys('Return')
					await session.waitForPopup(PICKER_PANEL, 'closed')
					await sleep(1_200)
					await stop()
				} finally {
					await setAskForFolder(session, false)
				}
			},
		},

		target: {
			// Tall enough for the add-on card and the whole settings page, unscrolled.
			frame: { width: 800, height: TARGET_HEIGHT },
			async run(session, kit) {
				await openAddonPreferences(session)
				await settle(session)
				const stop = await kit.record('usage-target')
				await sleep(600)
				await session.pointerTo({ inlineOptions: '#target-folder' }, GLIDE)
				await sleep(500)
				await kit.still('usage-target')
				await session.pointerClick()
				await session.waitForPopup('ContentSelectDropdownPopup')
				await sleep(600)
				await session.realClick(menuItem('ContentSelectDropdownPopup', 'Bookmarks Toolbar / shopping'), { glide: GLIDE })
				await session.waitForPopup('ContentSelectDropdownPopup', 'closed')
				await sleep(500)
				await session.realClick({ inlineOptions: '#options-form-submit' }, { glide: GLIDE })
				await sleep(1_500)
				await stop()
			},
		},
	},
})

async function setAskForFolder(session: FirefoxSession, enabled: boolean): Promise<void> {
	await session.asExtension(`
		const key = 'containMarks.settings'
		const current = (await browser.storage.local.get(key))[key] ?? {}
		await browser.storage.local.set({ [key]: { ...current, askForFolderOnBookmark: args[0] } })
		return true`, [enabled])
}

async function seedBookmarks(session: FirefoxSession): Promise<void> {
	await session.chromeAsync(`
		const toolbar = PlacesUtils.bookmarks.toolbarGuid
		await PlacesUtils.bookmarks.insert({ parentGuid: toolbar, title: 'Mail', url: 'http://mail.example/mail' })
		await PlacesUtils.bookmarks.insert({ parentGuid: toolbar, title: 'Git', url: 'http://git.example/' })
		const folder = await PlacesUtils.bookmarks.insert({ parentGuid: toolbar, title: 'shopping', type: PlacesUtils.bookmarks.TYPE_FOLDER })
		await PlacesUtils.bookmarks.insert({ parentGuid: folder.guid, title: 'Shop', url: 'http://shop.example/' })
		await PlacesUtils.bookmarks.insert({ parentGuid: folder.guid, title: 'Shop deals', url: 'http://shop.example/deals' })
		return true`)
}
