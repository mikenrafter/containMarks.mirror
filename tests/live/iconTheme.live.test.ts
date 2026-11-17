/** MR !5: page-action artwork must remain visible after Firefox removes its dark-mode filter. */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startContainMarks } from './containMarks'

for (const dark of [false, true]) {
 describe(`page-action icon with ${dark ? 'dark' : 'light'} browser chrome`, () => {
  it('contrasts with the address bar without the legacy SVG filter', async () => {
   // WHY: Firefox <=151 hid black-only SVG defects with an implicit filter.
   // A real chrome capture checks the rendered paint, not merely SVG source text.
   const dir = await mkdtemp(join(tmpdir(), 'containmarks-icon-'))
   const session = await startContainMarks({ dark, width: 800, height: 562,
    prefs: { 'extensions.webextensions.pageActionIconDarkModeFilter.enabled': false },
    pages: { 'icon.example': { title: 'Icon contrast' } },
   })
   try {
    await session.openTab('http://icon.example/')
    await session.waitForTarget('pageAction-urlbar-cont_bmarks')
    const rect = await session.screenRect('#pageAction-urlbar-cont_bmarks .urlbar-icon')
    const file = join(dir, 'icon.png')
    await session.screenshot(file, rect)
    const pixels = execFileSync('convert', [file, '-alpha', 'off', '-depth', '8', 'rgb:-'])
    const lum = []
    for (let i = 0; i < pixels.length; i += 3) lum.push((pixels.readUInt8(i) + pixels.readUInt8(i + 1) + pixels.readUInt8(i + 2)) / 3)
    // Icon strokes must be bright against dark chrome, dark against light chrome.
    // Requiring multiple pixels excludes isolated raster noise.
    const foreground = lum.filter(v => dark ? v > 180 : v < 75).length
    expect(foreground).toBeGreaterThan(12)
   } finally {
    await session.close()
    await rm(dir, { recursive: true, force: true })
   }
  }, 90_000)
 })
}
