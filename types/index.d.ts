export type Video = { id: string; title: string; channel: string; duration: string }

declare module 'claude-code' {
  interface PluginState {
    youtube: {
      results: Video[]
      status: string
      /** Title of the video playing in the pane, '' when the list shows. */
      playing: string
      /** The mode the player draws in. */
      mode: 'pixels' | 'blocks'
      /** User choice for the mode: auto picks from the terminal. */
      override: 'auto' | 'pixels' | 'blocks'
      /** True while the player's search bar holds text: the s/m/v hotkeys are off then. */
      hasDraft: boolean
      /** Bumped on each player search submit, so the bar redraws empty. */
      submits: number
    }
  }
}
