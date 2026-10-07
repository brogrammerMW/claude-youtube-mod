import { test, expect } from 'claude-code/testing'
import {
  blankCells, cellBox, compact, decodeSize, decoderArgv, detailsArgv, downloadArgv, fitBox, linksIn, lookupArgv,
  nextOverride, parseFormats, parseMeta, pickMode, quadrantWords, resample, rgbToBlocks, soundArgv, videoIdFrom,
} from './player'

test('pickMode: image terminals get pixels, the rest blocks, override wins', () => {
  expect(pickMode({ termProgram: 'ghostty' })).toBe('pixels')
  expect(pickMode({ termProgram: 'WezTerm' })).toBe('pixels')
  expect(pickMode({ term: 'xterm-kitty' })).toBe('pixels')
  expect(pickMode({ term: 'xterm-ghostty' })).toBe('pixels')
  expect(pickMode({ kittyWindow: '3' })).toBe('pixels')
  expect(pickMode({ termProgram: 'Apple_Terminal', term: 'xterm-256color' })).toBe('blocks')
  expect(pickMode({ termProgram: 'iTerm.app' })).toBe('blocks')
  expect(pickMode({ term: 'tmux-256color', kittyWindow: '3' })).toBe('blocks')
  expect(pickMode({})).toBe('blocks')
  expect(pickMode({ termProgram: 'Apple_Terminal' }, 'pixels')).toBe('pixels')
  expect(pickMode({ termProgram: 'ghostty' }, 'blocks')).toBe('blocks')
  expect(pickMode({ termProgram: 'ghostty' }, 'auto')).toBe('pixels')
})

test('nextOverride cycles auto, pixels, blocks', () => {
  expect(nextOverride('auto')).toBe('pixels')
  expect(nextOverride('pixels')).toBe('blocks')
  expect(nextOverride('blocks')).toBe('auto')
})

test('cellBox leaves room for the chrome and caps by mode', () => {
  expect(cellBox('pixels', 64, 36)).toEqual({ cols: 64, rows: 33 })
  expect(cellBox('pixels', 400, 400)).toEqual({ cols: 255, rows: 255 })
  expect(cellBox('blocks', 200, 100)).toEqual({ cols: 120, rows: 40 })
  expect(cellBox('blocks', 1, 1)).toEqual({ cols: 2, rows: 2 })
})

test('blankCells is a black cell per box position', () => {
  const words = new Uint32Array(Uint8Array.fromBase64(blankCells(3, 2)).buffer)
  expect(words.length).toBe(3 * 2 * 3)
  expect(words[0]).toBe(0x2588)
  expect(words[1]).toBe(0)
  expect(words[2]).toBe(0)
})

test('videoIdFrom reads YouTube links and ignores searches', () => {
  expect(videoIdFrom('https://youtu.be/Rn4nmFRPe0s?si=4TB-7QJqgZHhRrKZ')).toBe('Rn4nmFRPe0s')
  expect(videoIdFrom('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42')).toBe('dQw4w9WgXcQ')
  expect(videoIdFrom('https://m.youtube.com/shorts/abcdefghijk')).toBe('abcdefghijk')
  expect(videoIdFrom('https://www.youtube.com/embed/abcdefghijk?autoplay=1')).toBe('abcdefghijk')
  expect(videoIdFrom('https://music.youtube.com/watch?v=abcdefghijk')).toBe('abcdefghijk')
  expect(videoIdFrom('claude code mods')).toBe(undefined)
  expect(videoIdFrom('lofihiphops')).toBe(undefined)
  expect(videoIdFrom('https://vimeo.com/123456789')).toBe(undefined)
  expect(videoIdFrom('https://youtu.be/short')).toBe(undefined)
})

// One cell = 2x2 pixels; returns the cell's [codePoint, fg, bg].
const cell = (pixels: number[][]) => {
  const rgb = new Uint8Array(12)
  pixels.forEach((p, i) => rgb.set(p, i * 3))
  return Array.from(quadrantWords(rgb, 1, 1))
}

test('quadrantWords picks the pattern and two colors that fit the 2x2 pixels', () => {
  const R = [255, 0, 0], B = [0, 0, 255]
  // order: top-left, top-right, bottom-left, bottom-right
  expect(cell([R, R, B, B])).toEqual([0x2584, 0x0000ff, 0xff0000]) // ▄ blue bottom, red top
  expect(cell([R, B, R, B])).toEqual([0x2590, 0x0000ff, 0xff0000]) // ▐ blue right
  expect(cell([R, B, B, R])).toEqual([0x259a, 0xff0000, 0x0000ff]) // ▚ diagonal
  expect(cell([B, R, R, R])).toEqual([0x259f, 0xff0000, 0x0000ff]) // ▟ three red
  expect(cell([R, R, R, R])[0]).toBe(0x2588)                       // █ one color
})

test('rgbToBlocks and blankCells encode cols*rows triplets', () => {
  const bytes = Uint8Array.fromBase64(blankCells(4, 3))
  expect(bytes.length).toBe(4 * 3 * 3 * 4)
  // a black 480x270 frame drawn into 4x3 cells is the blank frame
  expect(rgbToBlocks(new Uint8Array(480 * 270 * 3), 480, 270, 4, 3)).toBe(blankCells(4, 3))
})

test('resample averages the source pixels under each output pixel', () => {
  // 4x2 frame: left half red, right half blue → 2x1 is one red and one blue pixel
  const R = [255, 0, 0], B = [0, 0, 255]
  const src = new Uint8Array([...R, ...R, ...B, ...B, ...R, ...R, ...B, ...B])
  expect(Array.from(resample(src, 4, 2, 2, 1))).toEqual([255, 0, 0, 0, 0, 255])
  // 2x1 → 1x1 averages red and blue
  expect(Array.from(resample(new Uint8Array([...R, ...B]), 2, 1, 1, 1))).toEqual([127, 0, 127])
  expect(resample(src, 4, 2, 4, 2)).toBe(src) // same size: untouched
})

test('fitBox fills width or height with no bars', () => {
  expect(fitBox(16 / 9, 80, 40)).toEqual({ cols: 80, rows: 23 })  // wide video: full width
  expect(fitBox(9 / 16, 80, 40)).toEqual({ cols: 45, rows: 40 })  // vertical short: full height
  expect(fitBox(NaN, 80, 40)).toEqual(fitBox(16 / 9, 80, 40))
})

test('parseMeta reads the details JSON line', () => {
  const out = '397\n251-20\n{"width":854,"height":480,"channel":"Chase AI","view_count":123456,"upload_date":"20260930","duration_string":"9:11","description":"see https://a.b/c."}'
  const m = parseMeta(out)!
  expect([m.width, m.height, m.channel, m.views, m.date, m.duration]).toEqual([854, 480, 'Chase AI', 123456, '2026-09-30', '9:11'])
  expect(parseMeta('397')).toBe(undefined)
  expect(parseMeta('{broken')).toBe(undefined)
})

test('linksIn and compact', () => {
  expect(linksIn('a https://x.io/a. b https://x.io/a, c (https://y.io/b) http://z.io')).toEqual(['https://x.io/a', 'https://y.io/b', 'http://z.io'])
  expect([compact(950), compact(1234), compact(3_400_000), compact(12_000_000)]).toEqual(['950', '1.2K', '3.4M', '12M'])
})

test('lookup goes online once and saves the details file; details read it offline', () => {
  const look = lookupArgv('https://www.youtube.com/watch?v=abc', '/t/info')
  expect(look).toContain('--write-info-json')
  expect(look).toContain('--skip-download')
  expect(look.slice(-3)).toEqual(['-o', '/t/info', 'https://www.youtube.com/watch?v=abc'])
  const det = detailsArgv('/t/info.info.json')
  expect(det[det.indexOf('--load-info-json') + 1]).toBe('/t/info.info.json')
  expect(det.filter(a => a === '--print')).toHaveLength(3)
  expect(det.some(a => a.startsWith('http'))).toBe(false) // no page URL: offline
})

test('parseFormats: separate video and audio, or one format with both', () => {
  expect(parseFormats('397\n251-20\n{"width":854}')).toEqual({ video: '397', audio: '251-20', muxed: false })
  expect(parseFormats('18\nNA\n{"width":640}')).toEqual({ video: '18', audio: '18', muxed: true })
  expect(parseFormats('{"width":1}')).toBe(undefined)
  expect(parseFormats('NA\nNA')).toBe(undefined)
})

test('downloads exec yt-dlp into a pipe, so killing the child kills the download', () => {
  const argv = downloadArgv('/t/i.json', '251-20', '/t/audio.pipe')
  expect(argv[0]).toBe('/bin/sh')
  expect(argv[2]!.startsWith('exec yt-dlp ')).toBe(true)
  expect(argv[2]).toContain('-o - > "$2"')
  expect(argv.slice(3)).toEqual(['/t/i.json', '251-20', '/t/audio.pipe'])
})

test('decodeSize keeps the video shape, ~270 tall, at most 480 wide, even', () => {
  expect(decodeSize(16 / 9)).toEqual({ width: 480, height: 270 })
  expect(decodeSize(854 / 480)).toEqual({ width: 480, height: 268 })
  expect(decodeSize(9 / 16)).toEqual({ width: 150, height: 266 })
  expect(decodeSize(NaN)).toEqual(decodeSize(16 / 9))
})

test('decoder: both pipes paced in real time, frames to one file, PCM to the sound pipe', () => {
  const size = { width: 480, height: 270 }
  const split = decoderArgv('/t/v.pipe', '/t/a.pipe', size, '/t/frame.rgb', '/t/pcm.pipe')
  expect(split.filter(a => a === '-re')).toHaveLength(2)
  expect(split[split.lastIndexOf('-map') + 1]).toBe('1:a:0')
  expect(split.slice(-6)).toEqual(['-ar', '48000', '-ac', '2', '-f', 's16le', '-y', '/t/pcm.pipe'].slice(-6))
  expect(split).toContain('fps=15,scale=480:270:flags=area')
  expect(split.some(a => a.startsWith('http'))).toBe(false) // yt-dlp fetches; ffmpeg never opens a link
  const muxed = decoderArgv('/t/v.pipe', undefined, size, '/t/frame.rgb', '/t/pcm.pipe')
  expect(muxed.filter(a => a === '-i')).toHaveLength(1)
  expect(muxed[muxed.lastIndexOf('-map') + 1]).toBe('0:a:0')
})

test('sound: ffplay reads raw PCM from the pipe with minimal buffering', () => {
  const argv = soundArgv('/t/pcm.pipe')
  expect(argv[0]).toBe('ffplay')
  expect(argv).not.toContain('-nostdin') // ffplay rejects it
  expect(argv).toContain('nobuffer')
  expect(argv.slice(-7)).toEqual(['-f', 's16le', '-ar', '48000', '-ch_layout', 'stereo', '/t/pcm.pipe'])
})
