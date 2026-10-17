import { describe, expect, it } from 'vitest'

import { listPickerFolders } from '../src/picker/folders'
import type { BookmarkNode } from '../src/models'

const folder = (id: string, title: string, parentId: string, children: BookmarkNode[] = []): BookmarkNode =>
	({ id, title, parentId, type: 'folder', children })
const bookmark = (id: string, parentId: string): BookmarkNode =>
	({ id, title: id, parentId, type: 'bookmark', url: `https://${id}.example/` })

describe('listPickerFolders', () => {
	it('lists folders in tree order with depth, skipping the root, bookmarks and the sync folder', () => {
		const tree = [folder('root________', '', '', [
			folder('menu________', 'Bookmarks Menu', 'root________', [
				folder('sync', 'ContainMarks Sync', 'menu________', [bookmark('mapping', 'sync')]),
				folder('mozilla', 'Mozilla Firefox', 'menu________', [bookmark('help', 'mozilla')]),
			]),
			folder('toolbar_____', 'Bookmarks Toolbar', 'root________', [
				bookmark('mail', 'toolbar_____'),
				folder('shop', 'shopping', 'toolbar_____', [folder('deals', '', 'shop')]),
			]),
			folder('unfiled_____', 'Other Bookmarks', 'root________'),
		])]

		expect(listPickerFolders(tree)).toEqual([
			{ id: 'menu________', title: 'Bookmarks Menu', depth: 0 },
			{ id: 'mozilla', title: 'Mozilla Firefox', depth: 1 },
			{ id: 'toolbar_____', title: 'Bookmarks Toolbar', depth: 0 },
			{ id: 'shop', title: 'shopping', depth: 1 },
			{ id: 'deals', title: '(Untitled Folder)', depth: 2 },
			{ id: 'unfiled_____', title: 'Other Bookmarks', depth: 0 },
		])
	})

	it('keeps a folder named like the sync folder outside the Bookmarks Menu', () => {
		const tree = [folder('root________', '', '', [
			folder('toolbar_____', 'Bookmarks Toolbar', 'root________', [folder('x', 'ContainMarks Sync', 'toolbar_____')]),
		])]

		expect(listPickerFolders(tree).map((entry) => entry.id)).toEqual(['toolbar_____', 'x'])
	})
})
