# claude-youtube-mod

Claude Code mod: `/youtube <search or link>` plays YouTube inside a pane. Pure logic in `hooks/player.ts` (tested), engine wiring and drawing in `hooks/register.tsx`. Check with `claude plugin validate .` and `claude plugin test .`.

## Recent Changes

### feat: in-pane YouTube player with synced sound - 2026-10-07
- Branch: `minor/1-in-pane-player`
- PR: https://github.com/brogrammerMW/claude-youtube-mod/pull/2
- Summary: yt-dlp downloads video and audio into named pipes (googlevideo 403s links ffmpeg opens directly); one ffmpeg decodes both in real time, frames to a file the pane draws and PCM through a pipe to ffplay, so picture and sound start together. Quadrant blocks or real pixels, fixed decode size so resizing restarts nothing, search bar and links in the player, details and links under the video, s/m/v hotkeys only while the search bar is empty, no automatic mpv fallback.
