# claude-youtube-mod

Claude Code mod: `/youtube <search or link>` plays YouTube inside a pane. Pure logic in `hooks/player.ts` (tested), engine wiring and drawing in `hooks/register.tsx`. Check with `claude plugin validate .` and `claude plugin test .`.

## Recent Changes

### feat: pause, rewind and fast forward - 2026-10-09
- Branch: `minor/3-pause-seek`
- Summary: Playback runs in legs: pause ends the current leg's children and remembers the position; play and ±10 s skips start a new leg with `-ss` on each ffmpeg input (ffmpeg 9 drops pre-seek data unpaced). Per-leg pipe and frame names, a leg counter so a killed decoder is not a failure, position = offset + time since the leg's first frame. Keys j/k/l (YouTube's), only while the search bar is empty.

### feat: in-pane YouTube player with synced sound - 2026-10-07
- Branch: `minor/1-in-pane-player`
- PR: https://github.com/brogrammerMW/claude-youtube-mod/pull/2
- Summary: yt-dlp downloads video and audio into named pipes (googlevideo 403s links ffmpeg opens directly); one ffmpeg decodes both in real time, frames to a file the pane draws and PCM through a pipe to ffplay, so picture and sound start together. Quadrant blocks or real pixels, fixed decode size so resizing restarts nothing, search bar and links in the player, details and links under the video, s/m/v hotkeys only while the search bar is empty, no automatic mpv fallback.
