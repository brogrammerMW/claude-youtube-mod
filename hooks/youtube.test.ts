import { test, expect } from 'claude-code/testing'
import { parseResults } from './register'

test('parses yt-dlp print lines', () => {
  const out = 'dQw4w9WgXcQ\tSong\tChan\t3:33\nbad line\nabcdefghijk\tLive\tNA\tNA\n'
  expect(parseResults(out)).toEqual([
    { id: 'dQw4w9WgXcQ', title: 'Song', channel: 'Chan', duration: '3:33' },
    { id: 'abcdefghijk', title: 'Live', channel: '', duration: 'live' },
  ])
})

import { sameVersion } from './register'

test('compares yt-dlp and Homebrew versions', () => {
  expect(sameVersion('2026.08.19', '2026.8.19')).toBe(true)
  expect(sameVersion('2026.07.04', '2026.8.19')).toBe(false)
})
