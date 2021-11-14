// dev config
// I couldn't be bothered to type 'true' and 'false' every time I wanted to
// change it
let enable_debug = !!0


// constants

// maximum container name length: 25, therefore, null = 26
const noContainer = '-'.repeat(26)
// used in user-facing error/security messages
const one = "sed an expired/invalid token"
const two = "ttempted to break"

// basic config

// look into other prefixes -- needs to work on container drag+drop, invalid
// urls don't work
const prefix = "about"
const delim = ":"


// debugging
function debug(...args) {
	if (enable_debug) console.log(...args)
}
// always log
const log = console.log

// startup
async function startup() {
	const nodes = await browser.bookmarks.search({})
	// clean unused keys
	for (key in localStorage) {
		try {
			const reference = localStorage[key]
			const node = (_=>{try{
				// parse, if invalid, return null
				return typeof reference === "string" ? JSON.parse(reference) : null
				} catch (e) {return null}
			})()
			if (node === null) continue

			const bookmark = await browser.bookmarks.get(node.id).then(x=>x[0])
			if (bookmark.id) {
				if (bookmark.type == "folder" ||
					!node.container) continue

				const attempt = await lookup(bookmark.url)
				log(key, node, attempt)

				if (key === attempt.token) {
					await refresh({...bookmark, ...node})
					continue
				}
			}
		} catch (e) {log(e)}
		log("deleted unused key:", key)
		delete localStorage[key]
	}
}

try {
	const real_debug = enable_debug
	enable_debug = false
	startup().then(_=>enable_debug = real_debug)
}
catch (e) {debug(e)}

// menu
{
	createMenuItems()

	// Update bookmark url on menu item selection
	browser.menus.onClicked.addListener(async (info) => {
		await browser.bookmarks.get(info.bookmarkId).then(debug)
		await apply(await browser.bookmarks.get(info.bookmarkId), info.menuItemId)
	})
	
	// Creates menu items when called
	function createMenuItems(bookmark={type:"",id:""}) {
		let main_message = ["Assign",
			bookmark.type === "folder"
				? ("Bookmarks in " + (bookmark.id === "toolbar_____" ? "Toolbar" : "Folder"))
				: "Bookmark",
			"to container"]
		// Main menu items
		browser.menus.create({
			id: "assign_container",
			title: main_message.join(' '),
			contexts: ["bookmark"],
		})
		// Submenu items for assign_container
		browser.menus.create({
			id: noContainer,
			title: "No Container",
			contexts: ["bookmark"],
			parentId: "assign_container"
		})
		browser.menus.create({
			type: "separator",
			contexts: ["bookmark"],
			parentId: "assign_container"
		})
		browser.contextualIdentities.query({}).then(function (containers) {
			for (index in containers) {
				const container = containers[index]
				browser.menus.create({
					id: container.name,
					title: container.name,
					icons: {
						16: `icons/${container.icon}.svg#${container.color}`
					},
					contexts: ["bookmark"],
					parentId: "assign_container"
				})
			}
			browser.menus.refresh()
		})
	}
	
	// Remove menu if shown from toolbar
	browser.menus.onShown.addListener(async (info) => {
		try {
			if (itemsExist) {
				browser.menus.removeAll()
				itemsExist = false
			}
			if (info.contexts.includes("bookmark")) {
				const bookmark = await browser.bookmarks.get(info.bookmarkId)
				if (bookmark[0].type == "separator") {
					browser.menus.refresh()
					return
				}
				createMenuItems(bookmark[0])
				itemsExist = true
			}
		} catch (e) {debug(e)}
	})
}
let itemsExist = true


/*
 * bookmark setup and generation
 */


function generateKey(num=undefined) {
	let key = "";
	// loop until unique
	while (true) {
		// 0.123456789 -> 0... -> 3uddqdppcdfg
		key = (num || Math.random()).toString(32).substr(2)
		// debug(key)
		// if unique, return
		if (localStorage[key] === undefined)
			return key;
	}
}

function parse(url) {
	// assign initial values, and make a new token
	let value = {url: url, token: "", old_token: ""}
	// split string into sub-parts
	let parts = url.split(delim)
	// if there are 3+ parts (prefix:token:etc), and the first one is a token
	if (parts.length >= 3 && parts[0] === prefix) {
		// remember the old token
		value.token     = parts[1]
		value.old_token = parts[1]
		// forget the prefix + token
		parts = parts.slice(2)
	}
	value.url = parts.join(delim)
	debug(`parse: ${url} ->`, value)
	return value
}

// given a url, assign a token
function assign(value, container=null) {
	// if there's a container, don't assign an ID
	value.token = container ||
		(value.container === noContainer ? "" : generateKey())
	// url -> prefix:token:url
	if (value.token) value.url = [prefix, value.token, value.url].join(delim)
	return value
}

// arg:retain - retain current token, or use new one
async function lookup(url, id=0) {
	let value = {id: id, container: null, ...parse(url)}

	try {
		// if isn't builtin name (potential exploits to be found here)
		if (localStorage.hasOwnProperty(value.old_token)) {
			const info = JSON.parse(localStorage[value.old_token])
			value = {...value, ...info}
		}
	} catch (e) {debug(e)}

	debug(`lookup ${url} -> ${value.container}`)
	return value;
}

async function refresh(bookmark) {
	try {
		const reference = await lookup(bookmark.url, bookmark.id)
		const container = bookmark.container || reference.container
		const bmark = assign({...reference, container})
		debug('refresh:', bookmark, reference, bmark)
		
		// update DB
		if (bmark.token)
			localStorage[bmark.token] = JSON.stringify({id: bmark.id, container})
		delete localStorage[bookmark.old_token || bmark.old_token]

		// update bookmark
		await browser.bookmarks.update(bmark.id, {url: bmark.url})
		return bmark
	} catch(e) {debug(e)}
}

// Update bookmark url with selected container
async function update(bookmark, container) {
	debug('update:', bookmark, container)
	return refresh({...bookmark, container})
}


async function apply(bookmarks, item) {
	debug('apply', bookmarks, item)
	for (index in bookmarks) {
		if (bookmarks[index].id == "separator") continue
		try {
			if (bookmarks[index].type == "folder")
				await apply(await browser.bookmarks.getChildren(bookmarks[index].id), item)
			else
				await update(bookmarks[index], item)
		} catch (e) {debug(e)}
	}
	// debug('updated:', bookmarks)
}

/*
 * containers, and opening functionality
 */


async function getContainer(name) {
	debug('getContainer', name)
	if (name == noContainer || name == undefined || typeof name != "string")
		return null

	const containers = await browser.contextualIdentities.query({name}).then(x=>x)

	// debug(containers)
	if (containers.length >= 1) {
		// debug(name, true)
		return containers[0]
	}
	// debug(name, false)

	return null
}

async function validateContainer(name) {
	return await getContainer(name) == null ? null : name
}

async function open(bmark, tab) {
	debug('open', bmark, tab)
	try {
		const container = await getContainer(bmark.container)
		// debug(container)
		let newTab = {
			cookieStoreId: container.cookieStoreId,
			url: bmark.url,
			index: tab.index + 1
		}

		// debug(bmark)
		await browser.tabs.create(newTab)
		await browser.tabs.remove(tab.id)
	} catch (e) {debug(e)}
}

browser.tabs.onUpdated.addListener( async (id, change, tab) => {
	//log(id, change)
	if (change.status === "complete" &&
		change.url.startsWith(prefix) &&
		id !== browser.tabs.TAB_ID_NONE
	) {
		// debug(change, id)
		let incoming = await lookup(tab.url)
		if (!incoming.token) return
		let bookmark = {}
		// validate that keys match
		if (incoming.id !== 0) {
			bookmark = await browser.bookmarks.get(incoming.id).then(x=>x[0])
			debug('incoming:', incoming, bookmark)
			if (tab.url == bookmark.url) {
				await open(incoming, tab)
				debug('new token:', await refresh(incoming))
				return
			}
		}
		debug("invalid")
		try {
			await browser.notifications.create({
				type: "basic",
				title: tab.url,
				message: incoming.container ?
					`A${two} into ${incoming.container},\nOr u${one}.` :
					`U${one},\nOr a${two} out of its container.`
			})
			await browser.tabs.highlight({populate: false, tabs: [tab.index]})
			// revoke the "notty" key
			if (incoming.container) await refresh({...incoming, ...bookmark})
		} catch (e) {log(e)}
	}
});



browser.bookmarks.onRemoved.addListener( async (id, info) => {
	const item = await lookup(info.node.url)
	// debug('removed', info.node, item)
	delete localStorage[item.token]
});


browser.pageAction.onClicked.addListener( async (tab, info) => {
	try {
		const container = await browser.contextualIdentities.get(tab.cookieStoreId)
		const title = tab.title.substr(0,10)
		const bookmark = await browser.bookmarks.create({
			parentId: "toolbar_____", index: 0,
			title, url: tab.url
		})
		log(await refresh({...bookmark, container: container.name}))
		await browser.notifications.create({
			type: "basic",
			title: "Bookmark Created",
			message: `${title} in ${container.name}\n(1st item on your bookmarks bar)`
		})
	} catch (e) {log(e)}
});
