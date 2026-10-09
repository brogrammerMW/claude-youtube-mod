// Pure player logic: no engine calls, so it is testable on its own.
// Approach credit: refact0r/claude-surf (MIT), see ../NOTICE.md.

// The plugin runtime has these (ES2026 base64); older lib typings do not declare them.
declare global {
  interface Uint8Array { toBase64(): string }
  interface Uint8ArrayConstructor { fromBase64(text: string): Uint8Array }
}

export type PlayerMode = 'pixels' | 'blocks'
export type Override = PlayerMode | 'auto'
export type FrameSize = { width: number; height: number }
export type TermEnv = { termProgram?: string; term?: string; kittyWindow?: string }

const PIXEL_TERM_PROGRAMS = ['ghostty', 'wezterm']
const PIXEL_TERMS = ['xterm-kitty', 'xterm-ghostty']
const MAX_PIXEL_W = 960
const MAX_PIXEL_H = 4096
const MAX_BLOCK_COLS = 120
const MAX_BLOCK_ROWS = 40
const MAX_PIXEL_CELLS = 255
export const CHROME_ROWS = 3

// Guess from env: image-capable terminals get pixels, everything else (and any
// multiplexer, which swallows image escapes) gets quadrant-block cells.
export function pickMode(env: TermEnv, override: Override = 'auto'): PlayerMode {
  if (override !== 'auto') return override
  const term = (env.term ?? '').toLowerCase()
  const program = (env.termProgram ?? '').toLowerCase()
  if (program === 'tmux' || term.startsWith('tmux') || term.startsWith('screen')) return 'blocks'
  if (PIXEL_TERM_PROGRAMS.includes(program) || PIXEL_TERMS.includes(term) || env.kittyWindow) return 'pixels'
  return 'blocks'
}

export function nextOverride(now: Override): Override {
  return now === 'auto' ? 'pixels' : now === 'pixels' ? 'blocks' : 'auto'
}

// Cells the video box takes, from the pane body's size.
export function cellBox(mode: PlayerMode, bodyColumns: number, bodyRows: number): { cols: number; rows: number } {
  const rows = Math.max(2, Math.floor(bodyRows) - CHROME_ROWS)
  const cols = Math.max(2, Math.floor(bodyColumns))
  return mode === 'pixels'
    ? { cols: Math.min(cols, MAX_PIXEL_CELLS), rows: Math.min(rows, MAX_PIXEL_CELLS) }
    : { cols: Math.min(cols, MAX_BLOCK_COLS), rows: Math.min(rows, MAX_BLOCK_ROWS) }
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)

// ---- the pipeline: yt-dlp fetches (googlevideo refuses links ffmpeg opens itself), ffmpeg
// decodes once at a fixed size, ffplay plays the sound. Named pipes join them.

const FORMAT = 'bv*[height<=480]+ba/b[height<=480]/bv*+ba/b'
export const FPS = 15

// Online, once: save yt-dlp's details file (`${base}.info.json`) for the steps below.
export function lookupArgv(pageUrl: string, base: string): string[] {
  return ['yt-dlp', '--no-playlist', '--no-warnings', '--skip-download', '--write-info-json', '-o', base, pageUrl]
}

// Offline, from that file: the two format ids, then one JSON line of details.
export function detailsArgv(infoPath: string): string[] {
  return ['yt-dlp', '--no-warnings', '--load-info-json', infoPath, '-f', FORMAT,
    '--print', '%(requested_formats.0.format_id,format_id)s',
    '--print', '%(requested_formats.1.format_id,format_id)s',
    '--print', '%(.{width,height,channel,view_count,like_count,upload_date,duration,duration_string,description})j']
}

export type Formats = { video: string; audio: string; muxed: boolean }

// The first two non-JSON lines are the video and audio format ids ("NA" when one format has both).
export function parseFormats(stdout: string): Formats | undefined {
  const [video, audio] = stdout.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('{'))
  if (!video || video === 'NA') return undefined
  const muxed = !audio || audio === 'NA' || audio === video
  return { video, audio: muxed ? video : audio, muxed }
}

// yt-dlp's own downloader into a named pipe. `exec` makes the shell become yt-dlp, so killing the
// spawned process kills the download, with nothing left behind.
export function downloadArgv(infoPath: string, formatId: string, pipe: string): string[] {
  return ['/bin/sh', '-c', 'exec yt-dlp -q --no-warnings --no-part --load-info-json "$0" -f "$1" -o - > "$2"',
    infoPath, formatId, pipe]
}

// One decode size per video, in its own shape: about 270 px tall, at most 480 wide.
export function decodeSize(aspect: number): FrameSize {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9
  const width = Math.min(480, even(270 * a))
  return { width, height: even(width / a) }
}

// ffmpeg paces both inputs in real time (-re): frames go to one overwritten raw rgb24 file,
// sound goes as raw PCM into the pipe ffplay reads. One process, one clock.
// startAt > 0 starts there: ffmpeg reads and drops what comes before at full speed, unpaced.
// syncMs shifts the sound against the picture: later when positive, earlier when negative.
export function decoderArgv(videoPipe: string, audioPipe: string | undefined, size: FrameSize, framePath: string, pcmPipe: string, startAt = 0, syncMs = 0): string[] {
  const ss = startAt > 0 ? ['-ss', startAt.toFixed(1)] : []
  return ['ffmpeg', '-v', 'error', '-nostdin',
    ...ss, '-re', '-i', videoPipe, ...(audioPipe ? [...ss, '-re', '-i', audioPipe] : []),
    '-map', '0:v:0', '-vf', `fps=${FPS},scale=${size.width}:${size.height}:flags=area`,
    '-pix_fmt', 'rgb24', '-c:v', 'rawvideo', '-f', 'image2', '-update', '1', '-atomic_writing', '1', framePath,
    '-map', audioPipe ? '1:a:0' : '0:a:0', ...syncFilter(syncMs), '-ar', '48000', '-ac', '2', '-f', 's16le', '-y', pcmPipe]
}

// Later: pad silence in front. Earlier: drop the first bit, so every sample plays that much sooner.
export function syncFilter(ms: number): string[] {
  if (ms > 0) return ['-af', `adelay=${Math.round(ms)}:all=1`]
  if (ms < 0) return ['-af', `atrim=start=${(-ms / 1000).toFixed(3)},asetpts=PTS-STARTPTS`]
  return []
}

// ffplay plays the PCM with as little buffering as it allows; it ends when ffmpeg closes the pipe.
// (AudioToolbox straight from ffmpeg started 10-15 s late; ffplay starts at once.)
export function soundArgv(pcmPipe: string): string[] {
  return ['ffplay', '-nodisp', '-autoexit', '-nostats', '-loglevel', 'error',
    '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
    '-f', 's16le', '-ar', '48000', '-ch_layout', 'stereo', pcmPipe]
}

export type Meta = {
  width: number; height: number; channel: string; views?: number; likes?: number
  date: string; duration: string; description: string
  /** Length in seconds; undefined for live streams. */
  seconds?: number
}

// The JSON line yt-dlp prints after the stream URLs. Missing or broken → undefined.
export function parseMeta(stdout: string): Meta | undefined {
  const line = stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('{') && !l.includes('"User-Agent"')).pop()
  if (!line) return undefined
  try {
    const j = JSON.parse(line) as Record<string, unknown>
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    const d = str(j.upload_date)
    return {
      width: num(j.width) ?? 16, height: num(j.height) ?? 9, channel: str(j.channel),
      views: num(j.view_count), likes: num(j.like_count),
      date: /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : '',
      duration: str(j.duration_string), description: str(j.description), seconds: num(j.duration),
    }
  } catch {
    return undefined
  }
}

// Cells a video of this shape fills inside the space given, with no bars: a cell is about
// twice as tall as wide (8x16 px), so the box's real shape is (cols*8):(rows*16).
// ponytail: assumes an 8x16 cell; a terminal with a different cell shape stretches slightly.
export function fitBox(aspect: number, cols: number, rows: number): { cols: number; rows: number } {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9
  const byWidth = { cols, rows: Math.round((cols * 8) / a / 16) }
  const box = byWidth.rows <= rows ? byWidth : { cols: Math.round((rows * 16 * a) / 8), rows }
  return { cols: Math.max(2, box.cols), rows: Math.max(1, box.rows) }
}

// Every distinct http(s) link in a description, in order, trailing punctuation trimmed.
export function linksIn(text: string, max = 20): string[] {
  const found = (text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []).map(u => u.replace(/[.,;:!?]+$/, ''))
  return [...new Set(found)].slice(0, max)
}

// Where a skip of `delta` seconds lands: never before the start, and short of the end
// (a seek past the end would just finish the video).
export function seekTarget(at: number, delta: number, seconds?: number): number {
  const end = seconds !== undefined ? Math.max(0, seconds - 2) : Infinity
  return Math.max(0, Math.min(at + delta, end))
}

// 75 → "1:15", 3725 → "1:02:05"
export function clock(at: number): string {
  const t = Math.max(0, Math.floor(at))
  const [h, m, s] = [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60]
  const two = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}

// 1234 → "1.2K", 3400000 → "3.4M"
export function compact(n: number): string {
  for (const [div, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (n >= div) return `${(n / div).toFixed(n >= div * 10 ? 0 : 1).replace(/\.0$/, '')}${unit}`
  }
  return String(n)
}

// Quadrant blocks: each cell shows 2x2 pixels in two colors. Index = which of the four
// pixels take the foreground (bit 1 top-left, 2 top-right, 4 bottom-left, 8 bottom-right).
const QUADRANTS = [
  0x0020, 0x2598, 0x259d, 0x2580, 0x2596, 0x258c, 0x259e, 0x259b,
  0x2597, 0x259a, 0x2590, 0x259c, 0x2584, 0x2599, 0x259f, 0x2588,
]

// rgb is (cols*2) x (rows*2) pixels, 3 bytes each. For every cell, try each way of splitting its
// four pixels into two groups, color each group by its mean, and keep the split with the least error.
// ponytail: 8 splits x 4 pixels per cell; at 120x40 cells and 15 fps that is ~2.3M small steps a second.
const SPLITS = [15, 8, 9, 10, 11, 12, 13, 14]

export function quadrantWords(rgb: Uint8Array, cols: number, rows: number): Uint32Array {
  const words = new Uint32Array(cols * rows * 3)
  const w = cols * 2
  const px = new Int32Array(12)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const tl = ((y * 2) * w + x * 2) * 3
      const bl = tl + w * 3
      for (const [k, at] of [[0, tl], [3, tl + 3], [6, bl], [9, bl + 3]] as const) {
        px[k] = rgb[at] ?? 0; px[k + 1] = rgb[at + 1] ?? 0; px[k + 2] = rgb[at + 2] ?? 0
      }
      let best = 15, bestErr = Infinity, fg = 0, bg = 0
      // Masks 8..15 cover every split once (a split and its complement look the same);
      // 15 (one color) goes first so a flat cell stays a plain full block on ties.
      for (const mask of SPLITS) {
        const f = [0, 0, 0], b = [0, 0, 0]
        let nf = 0, nb = 0
        for (let i = 0; i < 4; i++) {
          const into = mask & (1 << i) ? f : b
          into[0] += px[i * 3]!; into[1] += px[i * 3 + 1]!; into[2] += px[i * 3 + 2]!
          if (mask & (1 << i)) nf++; else nb++
        }
        const fm = f.map(c => c / nf)
        const bm = nb ? b.map(c => c / nb) : fm
        let err = 0
        for (let i = 0; i < 4; i++) {
          const m = mask & (1 << i) ? fm : bm
          for (let c = 0; c < 3; c++) { const d = px[i * 3 + c]! - m[c]!; err += d * d }
        }
        if (err < bestErr) {
          bestErr = err; best = mask
          fg = (Math.round(fm[0]!) << 16) | (Math.round(fm[1]!) << 8) | Math.round(fm[2]!)
          bg = (Math.round(bm[0]!) << 16) | (Math.round(bm[1]!) << 8) | Math.round(bm[2]!)
        }
      }
      const o = (y * cols + x) * 3
      words[o] = QUADRANTS[best]!
      words[o + 1] = fg
      words[o + 2] = bg
    }
  }
  return words
}

// Averages a w x h rgb frame down (or up) to outW x outH: each output pixel is the mean of the
// source pixels under it, so small text and edges keep what detail the cells can hold.
export function resample(rgb: Uint8Array, w: number, h: number, outW: number, outH: number): Uint8Array {
  if (w === outW && h === outH) return rgb
  const out = new Uint8Array(outW * outH * 3)
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor((y * h) / outH), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / outH))
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor((x * w) / outW), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / outW))
      let r = 0, g = 0, b = 0, n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * w + sx) * 3
          r += rgb[i] ?? 0; g += rgb[i + 1] ?? 0; b += rgb[i + 2] ?? 0; n++
        }
      }
      const o = (y * outW + x) * 3
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n
    }
  }
  return out
}

// A w x h frame drawn into cols x rows quadrant cells.
export function rgbToBlocks(rgb: Uint8Array, w: number, h: number, cols: number, rows: number): string {
  return new Uint8Array(quadrantWords(resample(rgb, w, h, cols * 2, rows * 2), cols, rows).buffer).toBase64()
}

// A black frame for a Raster before the first blit.
export function blankCells(cols: number, rows: number): string {
  return rgbToBlocks(new Uint8Array(cols * rows * 12), cols * 2, rows * 2, cols, rows)
}

// The video id in a YouTube link: youtu.be/ID, watch?v=ID, /shorts/ID, /embed/ID, /live/ID.
// Plain text (a search) gives undefined; a bare 11-character word is a search, not an id.
export function videoIdFrom(text: string): string | undefined {
  let url: URL
  try { url = new URL(text.trim()) } catch { return undefined }
  const host = url.hostname.replace(/^(www|m|music)\./, '')
  const id = host === 'youtu.be'
    ? url.pathname.split('/')[1]
    : host === 'youtube.com' || host === 'youtube-nocookie.com'
      ? url.searchParams.get('v') ?? url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/)?.[1]
      : undefined
  return id && /^[\w-]{11}$/.test(id) ? id : undefined
}
