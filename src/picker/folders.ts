import { SYNC_FOLDER_PARENT_ID, SYNC_FOLDER_TITLE } from '../mappings/containerMappings'
import type { BookmarkNode } from '../models'

export interface PickerFolder {
	id: string
	title: string
	/** 0 for top-level folders (Bookmarks Menu, Toolbar, …). */
	depth: number
}

/**
 * Bookmark folders in tree order, for the folder picker. Skips the invisible
 * root and ContainMarks' own mapping folder.
 */
export function listPickerFolders(tree: BookmarkNode[]): PickerFolder[] {
	const folders: PickerFolder[] = []
	const visit = (nodes: BookmarkNode[] | undefined, depth: number) => {
		for (const node of nodes ?? []) {
			if (node.type !== 'folder') continue
			if (node.parentId === SYNC_FOLDER_PARENT_ID && node.title?.trim() === SYNC_FOLDER_TITLE) continue
			folders.push({ id: node.id, title: node.title?.trim() || '(Untitled Folder)', depth })
			visit(node.children, depth + 1)
		}
	}
	// getTree() returns the untitled root; its children are the top-level folders.
	for (const root of tree) visit(root.children, 0)
	return folders
}
