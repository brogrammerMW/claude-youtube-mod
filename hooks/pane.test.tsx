import { test, expect, mock } from 'claude-code/testing'

// The pane draws its search box and status while nothing plays.
test('the youtube pane draws the idle list view', async ($, on) => {
  mock.clock(on)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>ENGINE-STUB</Text> })
  const ui = await $.ui.mount({
    plugin: 'youtube', surface: 'terminal', component: 'Pane', requestId: 'youtube',
    props: { title: 'YouTube', isFocused: false, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    viewport: { columns: 64, rows: 30 },
  })
  expect(await ui.find({ type: 'Text', text: /Type a search and press Enter/ })).toBeDefined()
  await ui.unmount()
})
