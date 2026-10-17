/**
 * Folder picker popup, shown by the page action when "Ask where to save each
 * time" is on. Saving sends BOOKMARK_TAB_MESSAGE to the background, which
 * creates and container-encodes the bookmark exactly like a direct click.
 */

import { BOOKMARK_TAB_MESSAGE, type BookmarkTabMessage } from '../background/pageActionHandler'
import { NO_CONTAINER } from '../constants'
import { loadSettings } from '../preferences/settings'
import type { BrowserApi } from '../models'
import { listPickerFolders } from './folders'

declare global {
	var browser: BrowserApi
}

function element<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id)
	if (!found) throw new Error(`Missing #${id}`)
	return found as T
}

async function init(): Promise<void> {
	const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
	if (tab?.id === undefined) {
		window.close()
		return
	}
	const tabId = tab.id
	const [settings, tree] = await Promise.all([loadSettings(browser), browser.bookmarks.getTree()])

	const name = element<HTMLInputElement>('name')
	// Full title here (the direct click truncates); a blank name falls back to the short default.
	name.value = tab.title ?? tab.url ?? ''

	const folders = element<HTMLSelectElement>('folders')
	for (const folder of listPickerFolders(tree)) {
		const option = new Option(folder.title, folder.id)
		option.style.paddingInlineStart = `${8 + folder.depth * 14}px`
		folders.add(option)
	}
	folders.value = settings.targetFolderId
	if (folders.selectedIndex < 0) folders.selectedIndex = 0
	folders.selectedOptions[0]?.scrollIntoView({ block: 'nearest' })

	if (tab.cookieStoreId && tab.cookieStoreId !== NO_CONTAINER) {
		const identity = await browser.contextualIdentities.get(tab.cookieStoreId).catch(() => null)
		const pill = element<HTMLSpanElement>('container')
		pill.textContent = identity?.name ?? 'this container'
		if (identity?.colorCode) pill.style.setProperty('--pill', identity.colorCode)
	}

	const form = element<HTMLFormElement>('picker')
	let saving = false
	const save = async () => {
		if (saving || !folders.value) return
		saving = true
		element<HTMLButtonElement>('save').disabled = true
		try {
			const message: BookmarkTabMessage = { type: BOOKMARK_TAB_MESSAGE, tabId, parentId: folders.value, title: name.value }
			await browser.runtime.sendMessage({ ...message })
			window.close()
		} catch (error) {
			element<HTMLParagraphElement>('error').textContent = `Couldn't save: ${String((error as Error)?.message ?? error)}`
			element<HTMLButtonElement>('save').disabled = false
			saving = false
		}
	}

	form.addEventListener('submit', (event) => {
		event.preventDefault()
		void save()
	})
	// A listbox swallows Enter; treat Enter and double-click on a folder as Save.
	folders.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault()
			void save()
		}
	})
	folders.addEventListener('dblclick', () => void save())
	element<HTMLButtonElement>('cancel').addEventListener('click', () => window.close())

	name.focus()
	name.select()
}

void init()
