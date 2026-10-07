import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Video } from '../types'
import {
  blankCells, cellBox, compact, decodeSize, decoderArgv, detailsArgv, downloadArgv, fitBox, FPS, linksIn,
  lookupArgv, nextOverride, parseFormats, parseMeta, pickMode, rgbToBlocks, soundArgv, videoIdFrom,
} from './player'
import type { FrameSize, Meta, Override, PlayerMode, TermEnv } from './player'

const PANE = 'youtube'
// Theme color names, so the pane follows the person's light, dark or color-blind theme.
// Red is the one accent: YouTube's own mark for "this is playing".
const C = { accent: 'error', text: 'text', dim: 'inactive', faint: 'subtle', link: 'suggestion', ok: 'success' }
const DETAIL_ROWS = 4 // title, meta strip, controls, one spacer stay visible under the video
const FRAME_ROWS = 4 // the centered heading and the search bar above, plus the screen border's top and bottom
const FRAME_COLS = 2 // the screen border's left and right
const MAX_DESCRIPTION = 4000
const results = atom({ plugin: 'youtube', key: 'results' } as const, [])
const status = atom({ plugin: 'youtube', key: 'status' } as const, 'Type a search and press Enter.')
const playing = atom({ plugin: 'youtube', key: 'playing' } as const, '')
const mode = atom({ plugin: 'youtube', key: 'mode' } as const, 'blocks' as PlayerMode)
const hasDraft = atom({ plugin: 'youtube', key: 'hasDraft' } as const, false)
const submits = atom({ plugin: 'youtube', key: 'submits' } as const, 0)
const override = atom({ plugin: 'youtube', key: 'override' } as const, 'auto' as Override)

export function parseResults(stdout: string): Video[] {
  return stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter(cols => cols.length >= 2 && /^[\w-]{11}$/.test(cols[0] ?? ''))
    .map(([id = '', title = '', channel = '', duration = '']) => ({
      id,
      title,
      channel: channel === 'NA' ? '' : channel,
      duration: duration === 'NA' ? 'live' : duration,
    }))
}

async function search($: Engine, query: string) {
  const q = query.trim()
  if (!q) return
  await update($, status, () => `Searching "${q}"…`)
  try {
    const { exitCode, stdout, stderr } = await $.process.run(
      ['yt-dlp', `ytsearch10:${q}`, '--flat-playlist', '--no-warnings',
       '--print', '%(id)s\t%(title)s\t%(channel)s\t%(duration_string)s'],
      { timeoutMs: 45_000 },
    )
    const found = parseResults(stdout)
    await update($, results, () => found)
    await update($, status, () =>
      exitCode !== 0 ? `yt-dlp failed: ${stderr.trim().split('\n').pop()}`
        : found.length === 0 ? 'No results.'
        : `${found.length} results for "${q}". Pick one to play.`)
  } catch (err) {
    await update($, status, () => `Search failed: ${String(err)} (is yt-dlp installed? brew install yt-dlp)`)
  }
}

async function playMpv($: Engine, v: Video) {
  const url = `https://www.youtube.com/watch?v=${v.id}`
  await update($, status, () => `Playing: ${v.title}`)
  // The child lives as long as this loop; mpv closing ends it.
  void (async () => {
    let failure = ''
    try {
      const player = $.process.spawn({
        argv: ['mpv', '--force-window=immediate', '--ontop', '--autofit=640x360',
               '--geometry=100%:0%', `--title=${v.title}`, url],
      })
      let stderr = ''
      for (let step = await player.next(); ; step = await player.next()) {
        if (step.done) {
          if (step.value.code !== 0) failure = stderr.trim().split('\n').pop() || `mpv exited ${step.value.code}`
          break
        }
        if (step.value.stream === 'stderr') stderr = (stderr + step.value.text).slice(-2000)
      }
    } catch (err) {
      failure = `mpv did not start: ${String(err)}`
    }
    if (failure) {
      // mpv failed (missing, or YouTube refused the stream): use YouTube's own player in the browser.
      await update($, status, () => `mpv failed (${failure.slice(0, 120)}); opened in browser instead.`)
      await $.process.run(['open', url])
    }
  })()
}

// ---- In-pane player (approach: refact0r/claude-surf, see NOTICE.md) ----

type Handle = ReturnType<Engine['process']['spawn']>
type Run = {
  id: number
  video: Video
  pageUrl: string
  dir: string
  mode: PlayerMode
  meta?: Meta
  /** The fixed size ffmpeg decodes at: the pane scales it, so resizing restarts nothing. */
  size?: FrameSize
  framePath: string
  /** Downloads, decoder and sound player: every child this run started, all ended on stop. */
  children: Handle[]
  /** Last error lines per child, for the message when playback fails. */
  errors: Record<string, string>
  ticker?: { cancel: () => void }
  decoderAt: number
  gotFrame: boolean
  lastMtime: number
  generation: number
  denies: number
  busy: boolean
}

const FIRST_FRAME_MS = 20_000
const POLL_MS = 15
const DENY_LIMIT = 6 // ponytail: a deny also means "not mounted yet" during a redraw; 6 frames (~0.4s) is past that race
const BLACK_PIXEL = { rgba: 'AAAA/w==', width: 1, height: 1 }

let run: Run | undefined
let runCounter = 0
let envCache: TermEnv | undefined
// What the last render drew: the only size a blit may name.
let shown: { mode: PlayerMode; cols: number; rows: number } | undefined

async function readEnv($: Engine): Promise<TermEnv> {
  return {
    termProgram: await $.env.get('TERM_PROGRAM'),
    term: await $.env.get('TERM'),
    kittyWindow: await $.env.get('KITTY_WINDOW_ID'),
  }
}

// Drains a child's pieces; resolves with its exit code (null when killed). Rejects if it cannot start.
async function pump(child: Handle, onPiece: (stream: 'stdout' | 'stderr', text: string) => void): Promise<number | null> {
  for (let step = await child.next(); ; step = await child.next()) {
    if (step.done) return step.value.code
    onPiece(step.value.stream, step.value.text)
  }
}

const lastLine = (text: string) => text.trim().split('\n').pop() ?? ''

// Starts one child for this run and keeps its stderr tail; resolves with its exit code.
async function child($: Engine, r: Run, name: string, argv: string[]): Promise<number | null> {
  const h = $.process.spawn({ argv })
  r.children.push(h)
  let stderr = ''
  try {
    return await pump(h, (stream, text) => { if (stream === 'stderr') stderr = (stderr + text).slice(-1000) })
  } catch (err) {
    stderr = String(err)
    return -1
  } finally {
    if (stderr.trim()) r.errors[name] = lastLine(stderr)
  }
}

// The player's search bar: hotkeys stay armed only while it is empty.
async function draftChanged($: Engine, value: string) {
  const has = value.length > 0
  if ((await read($, hasDraft)) !== has) await update($, hasDraft, () => has)
}

async function submitFromPlayer($: Engine, value: string) {
  await update($, hasDraft, () => false)
  await update($, submits, n => n + 1) // a new key redraws the bar empty
  return submitQuery($, value)
}

// The search bars: a YouTube link plays that video, anything else searches.
async function submitQuery($: Engine, value: string) {
  const id = videoIdFrom(value)
  return id ? playLink($, id) : search($, value)
}

// A pasted link plays that video directly: look up its title, list it, start the player.
async function playLink($: Engine, id: string) {
  await update($, status, () => 'Opening the linked video…')
  let video: Video = { id, title: `youtu.be/${id}`, channel: '', duration: '' }
  try {
    const { stdout } = await $.process.run(
      ['yt-dlp', `https://www.youtube.com/watch?v=${id}`, '--no-warnings', '--skip-download',
       '--print', '%(id)s\t%(title)s\t%(channel)s\t%(duration_string)s'],
      { timeoutMs: 30_000 },
    )
    video = parseResults(stdout)[0] ?? video
  } catch (err) {
    $.ui.log(`youtube: title lookup failed: ${String(err)}`, { to: 'debug' })
  }
  await update($, results, () => [video])
  await startPlayback($, video)
}

async function startPlayback($: Engine, v: Video) {
  await stopPlayback($)
  envCache ??= await readEnv($)
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  const m = pickMode(envCache, await read($, override))
  const id = ++runCounter
  const dir = `${tmp}/yt-pane-${Date.now().toString(36)}`
  const r: Run = {
    id, video: v, pageUrl: `https://www.youtube.com/watch?v=${v.id}`, mode: m, dir,
    framePath: `${dir}/frame.rgb`, children: [], errors: {}, decoderAt: Date.now(),
    gotFrame: false, lastMtime: 0, generation: 0, denies: 0, busy: false,
  }
  run = r
  const alive = () => run?.id === id
  await update($, mode, () => m)
  await update($, playing, () => v.title)
  await update($, status, () => `Looking up "${v.title}"…`)
  try {
    await $.fs.write(`${dir}/.keep`, '')
  } catch (err) {
    return failInPane($, r, `no temp folder: ${String(err)}`)
  }

  // 1. Online, once: yt-dlp saves the video's details file. 2. Offline: formats and details from it.
  const info = `${dir}/info.info.json`
  try {
    const looked = await $.process.run(lookupArgv(r.pageUrl, `${dir}/info`), { timeoutMs: 45_000 })
    if (!alive()) return
    if (looked.exitCode !== 0) return failInPane($, r, lastLine(looked.stderr) || 'yt-dlp could not look the video up')
    const details = await $.process.run(detailsArgv(info), { timeoutMs: 20_000 })
    if (!alive()) return
    const formats = details.exitCode === 0 ? parseFormats(details.stdout) : undefined
    if (!formats) return failInPane($, r, lastLine(details.stderr) || 'no playable format')
    r.meta = parseMeta(details.stdout)
    r.size = decodeSize(r.meta ? r.meta.width / r.meta.height : 16 / 9)

    // 3. Named pipes: yt-dlp → video / audio → ffmpeg → frames + PCM → ffplay.
    const pipes = { video: `${dir}/video.pipe`, audio: `${dir}/audio.pipe`, pcm: `${dir}/pcm.pipe` }
    const made = await $.process.run(['mkfifo', pipes.video, pipes.pcm, ...(formats.muxed ? [] : [pipes.audio])])
    if (!alive()) return
    if (made.exitCode !== 0) return failInPane($, r, lastLine(made.stderr) || 'could not make the pipes')

    await update($, status, () => `${m === 'pixels' ? 'pixels' : 'blocks'} · ${FPS} fps`)
    void child($, r, 'sound', soundArgv(pipes.pcm))
    void child($, r, 'video download', downloadArgv(info, formats.video, pipes.video))
    if (!formats.muxed) void child($, r, 'audio download', downloadArgv(info, formats.audio, pipes.audio))
    r.decoderAt = Date.now()
    void watchDecoder($, r, decoderArgv(pipes.video, formats.muxed ? undefined : pipes.audio, r.size, r.framePath, pipes.pcm))
  } catch (err) {
    return failInPane($, r, String(err))
  }
  // Poll well above the frame rate: polling at the frame rate beats against ffmpeg's writes,
  // showing a frame late and skipping the next every second or so. tick redraws only on a new frame.
  r.ticker = $.clock.every(POLL_MS, () => void tick($, r))
}

// The decoder's end is the run's end: finished, or failed with the most telling error line.
async function watchDecoder($: Engine, r: Run, argv: string[]) {
  const code = await child($, r, 'decoder', argv)
  if (run?.id !== r.id) return // stopped by us: not a failure
  if (code === 0) return stopPlayback($, `Finished: ${r.video.title}`)
  const why = r.errors['video download'] ?? r.errors['audio download'] ?? r.errors.decoder ?? `ffmpeg exited ${code}`
  return failInPane($, r, why)
}

async function tick($: Engine, r: Run) {
  if (run?.id !== r.id || r.busy || !r.size) return
  r.busy = true
  try {
    const stat = await $.fs.stat(r.framePath).catch(() => undefined)
    if (run?.id !== r.id) return
    if (!stat) {
      if (!r.gotFrame && Date.now() - r.decoderAt > FIRST_FRAME_MS) await failInPane($, r, 'no picture after 20 s')
      return
    }
    const box = shown
    if (!box || box.mode !== r.mode || stat.mtimeMs === r.lastMtime) return
    r.lastMtime = stat.mtimeMs
    r.gotFrame = true
    const { width, height } = r.size
    let result
    if (r.mode === 'pixels') {
      // The terminal reads the file and scales it into the box itself.
      result = await $.ui.blit({
        requestId: PANE, key: 'video', columns: box.cols, rows: box.rows,
        source: { file: r.framePath, format: 'rgb', width, height, generation: ++r.generation },
      })
    } else {
      const { base64 } = await $.fs.read(r.framePath, { as: 'bytes' })
      const rgb = Uint8Array.fromBase64(base64)
      if (rgb.length !== width * height * 3) return
      result = await $.ui.blit({
        requestId: PANE, key: 'video', columns: box.cols, rows: box.rows,
        cells: rgbToBlocks(rgb, width, height, box.cols, box.rows),
      })
    }
    if (!result.deny) r.denies = 0
    else if (r.mode === 'pixels' && ++r.denies >= DENY_LIMIT) {
      // This terminal shows no images: blocks now, and start in blocks next time too.
      await update($, override, () => 'auto')
      await switchMode($, r, 'blocks', 'Blocks: this terminal can\'t show images (v switches view)')
    }
  } catch (err) {
    $.ui.log(`youtube: frame draw failed: ${String(err)}`, { to: 'debug' })
  } finally {
    r.busy = false
  }
}

// Switching view only changes how the same frames are drawn: nothing restarts.
async function switchMode($: Engine, r: Run, m: PlayerMode, why?: string) {
  if (run?.id !== r.id) return
  r.mode = m
  r.denies = 0
  r.lastMtime = 0
  await update($, mode, () => m)
  if (why) await update($, status, () => why)
}

async function cycleMode($: Engine) {
  const r = run
  if (!r || !envCache) return
  const next = nextOverride(await read($, override))
  await update($, override, () => next)
  await switchMode($, r, pickMode(envCache, next), `view: ${next}`)
}

async function stopPlayback($: Engine, message?: string) {
  const r = run
  run = undefined
  shown = undefined
  await update($, playing, () => '')
  if (message) await update($, status, () => message)
  if (!r) return
  r.ticker?.cancel()
  // A silent child never wakes a read loop, so each handle is closed explicitly.
  for (const h of r.children) void h.return({ code: null, signal: null }).catch(() => undefined)
  r.children = []
  if (r.dir.includes('/yt-pane-')) void $.process.run(['rm', '-rf', r.dir]).catch(() => undefined)
}

// In-pane playback failed: stop, say why in the pane and the transcript, and leave mpv to the
// person (the window button). Nothing opens on its own.
async function failInPane($: Engine, r: Run, why: string) {
  if (run?.id !== r.id) return
  await stopPlayback($)
  $.ui.log(`youtube: couldn't play "${r.video.title}" in the pane: ${why}`)
  await update($, status, () => `Couldn't play here: ${why.slice(0, 160)} · [window] opens it in mpv`)
}

async function fallbackToMpv($: Engine, r: Run, why: string) {
  if (run?.id !== r.id) return
  await stopPlayback($)
  await update($, status, () => `in-pane failed (${why.slice(0, 100)}); opening mpv`)
  await playMpv($, r.video)
}

let isUpdating = false

// "2026.08.19" (yt-dlp) and "2026.8.19" (Homebrew) are the same version.
export function sameVersion(a: string, b: string): boolean {
  const norm = (v: string) => v.trim().split('.').map(n => String(Number(n))).join('.')
  return norm(a) === norm(b)
}

async function updateYtDlp($: Engine) {
  if (isUpdating) return
  isUpdating = true
  try {
    const version = async () => (await $.process.run(['yt-dlp', '--version'])).stdout.trim()
    const before = await version()
    const api = await $.process.run(['curl', '-fsS', 'https://formulae.brew.sh/api/formula/yt-dlp.json'])
    const latest: string = JSON.parse(api.stdout).versions.stable
    if (sameVersion(before, latest)) return
    $.ui.toast(`Updating yt-dlp ${before} → ${latest}…`)
    // Exit code is unreliable (brew can fail on an unrelated dependency); the version tells.
    const { stderr } = await $.process.run(['brew', 'upgrade', 'yt-dlp'], { timeoutMs: 300_000 })
    const after = await version()
    $.ui.toast(after !== before ? `yt-dlp updated to ${after}`
      : `yt-dlp update failed: ${stderr.trim().split('\n').pop()}`)
  } catch (err) {
    $.ui.log(`youtube: yt-dlp update check failed: ${String(err)}`, { to: 'debug' })
  } finally {
    isUpdating = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'youtube', description: 'Search YouTube and play a video' })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stopPlayback($).catch(() => undefined)
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await stopPlayback($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'youtube' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'YouTube', focus: true })
    void updateYtDlp($)
    const id = videoIdFrom(e.args)
    if (id) void playLink($, id)
    else if (e.args.trim()) void search($, e.args)
    return { text: 'YouTube pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // The mobile app draws no Input yet, and only the terminal has Image and Raster.
    const Input = 'Input' in els ? els.Input : null
    const Image = 'Image' in els ? els.Image : null
    const Raster = 'Raster' in els ? els.Raster : null
    const canPlay = e.surface === 'terminal' && Image !== null && Raster !== null
    const title = await read($, playing)

    // After a hot reload the atom survives but the child does not: show the list.
    if (title && run && canPlay) {
      const m = await read($, mode)
      const meta = run.meta
      const room = cellBox(m, e.props.bodyColumns - FRAME_COLS, e.props.scroll.bodyRows - DETAIL_ROWS - FRAME_ROWS)
      const box = fitBox(meta ? meta.width / meta.height : 16 / 9, room.cols, room.rows)
      shown = { mode: m, ...box }
      run.lastMtime = 0 // a redraw reset the picture: blit the current frame again
      const Link = 'Link' in els ? els.Link : null
      const facts = [
        meta?.channel || run.video.channel,
        meta?.views !== undefined ? `${compact(meta.views)} views` : '',
        meta?.date ?? '',
        meta?.duration || run.video.duration,
        meta?.likes !== undefined ? `▲ ${compact(meta.likes)}` : '',
      ].filter(Boolean)
      const description = (meta?.description ?? '').trim().slice(0, MAX_DESCRIPTION)
      const links = linksIn(description)
      const width = Math.max(20, e.props.bodyColumns - 2)
      // Hotkeys only while the search bar is empty, so typing "stop" never stops the video.
      const keys = !(await read($, hasDraft))
      const bar = await read($, submits)
      const others = (await read($, results)).filter(v => v.id !== run!.video.id).slice(0, 8)
      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text><Text color={C.accent} bold>▶ </Text><Text color={C.dim}>NOW PLAYING</Text></Text>
            <Text color={C.faint}>{await read($, status)}</Text>
          </Box>
          <Box justifyContent="center"><Text color={C.accent} bold>YouTube Video Mod</Text></Box>
          {Input && <Input key={`q-${bar}`} label="search  " placeholder="search YouTube or paste a link" submitLabel="go"
            onInput={(value: string) => void draftChanged($, value)}
            onSubmit={(value: string) => void submitFromPlayer($, value)} />}
          <Box borderStyle="round" borderColor={C.accent} alignSelf="center">
            {m === 'pixels'
              ? <Image key="video" source={BLACK_PIXEL} columns={box.cols} rows={box.rows} alt=" " />
              : <Raster key="video" columns={box.cols} rows={box.rows} cells={blankCells(box.cols, box.rows)} />}
          </Box>
          <Text bold wrap="truncate-end">{title}</Text>
          <Text color={C.dim} wrap="truncate-end">{facts.join('  ·  ')}</Text>
          <Box gap={2}>
            <Button key="stop" plain label="stop" {...(keys ? { hotkey: 's' } : {})} onPress={() => void stopPlayback($, 'Stopped.')} />
            <Button key="window" plain label="window" {...(keys ? { hotkey: 'm' } : {})}
              onPress={() => { const r = run; if (r) void fallbackToMpv($, r, 'window requested') }} />
            <Button key="view" plain label="view" {...(keys ? { hotkey: 'v' } : {})} onPress={() => void cycleMode($)} />
            <Text color={C.faint}>{keys ? 'tab to move · ↑↓ scroll' : 'keys off while typing'}</Text>
          </Box>
          {others.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={C.dim} bold>RESULTS</Text>
              {others.map((v, i) => (
                <Box key={`next-${v.id}`} gap={1}>
                  <Box width={3} flexShrink={0}><Text color={C.faint}>{String(i + 1).padStart(2)}</Text></Box>
                  <Button key={`next-play-${v.id}`} plain label={v.title.length > width - 18 ? `${v.title.slice(0, width - 19)}…` : v.title}
                    onPress={() => void startPlayback($, v)} />
                  <Text color={C.dim}>{v.duration}</Text>
                </Box>
              ))}
            </Box>
          )}
          {description && (
            <Box flexDirection="column" borderStyle="round" borderColor={C.faint} paddingX={1} marginTop={1} width={width}>
              <Text color={C.dim} bold>DESCRIPTION</Text>
              <Text color={C.text}>{description}</Text>
            </Box>
          )}
          {links.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={C.dim} bold>LINKS</Text>
              {links.map((url, i) => (
                <Box key={`link-${i}`}>
                  <Text color={C.accent}>↗ </Text>
                  {Link ? <Link href={url} label={url} /> : <Text color={C.link}>{url}</Text>}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    const list = await read($, results)
    const cols = e.viewport?.columns ?? 80
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 5)
    const titleW = Math.max(16, cols - (canPlay ? 34 : 24))
    const pick = (v: Video) => void (canPlay ? startPlayback($, v) : playMpv($, v))

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text><Text color={C.accent} bold>▶ YouTube</Text></Text>
          <Text color={C.faint}>{canPlay ? 'plays here · [window] opens mpv' : 'plays in the mpv window'}</Text>
        </Box>
        {Input && <Input key="q" label="search  " placeholder="lofi beats, rust tutorial, or paste a link" submitLabel="search"
          autoFocus onSubmit={(value: string) => void submitQuery($, value)} />}
        <Text color={C.dim}>{await read($, status)}</Text>
        {list.slice(0, room).map((v, i) => (
          <Box key={`row-${v.id}`} gap={1}>
            <Box width={3} flexShrink={0}><Text color={C.faint}>{String(i + 1).padStart(2)}</Text></Box>
            <Box width={titleW} flexShrink={0}>
              <Button key={`play-${v.id}`} plain label={v.title.length > titleW ? `${v.title.slice(0, titleW - 1)}…` : v.title}
                onPress={() => pick(v)} />
            </Box>
            <Box width={8} flexShrink={0}><Text color={C.dim}>{v.duration.padStart(7)}</Text></Box>
            <Text color={C.faint} wrap="truncate-end">{v.channel}</Text>
            {canPlay && <Button key={`win-${v.id}`} plain label="[window]" onPress={() => void playMpv($, v)} />}
          </Box>
        ))}
      </Box>
    )
  })
}
