import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsOverlay from './SettingsOverlay'
import { fetchJsonResponse } from './test/fixtures'
import type { ConfigProp, LogRecord } from './types'

function makeConfigProp(overrides: Partial<ConfigProp> = {}): ConfigProp {
  return {
    key: 'server.port',
    label: 'Port',
    section: 'Server',
    description: 'The port to listen on.',
    tooltip: null,
    type: 'int',
    value: 4343,
    default: 4343,
    min: 1,
    max: 65535,
    choices: null,
    restart_required: true,
    ...overrides,
  }
}

function makeLogRecord(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    timestamp: '2026-01-01 12:00:00',
    level: 'info',
    logger: 'app',
    message: 'started',
    ...overrides,
  }
}

function makeFetchRouter() {
  const state = {
    configProps: [] as ConfigProp[],
    logs: [] as LogRecord[] | { error: string },
    saveResponse: { restart_required: [] as string[] } as { restart_required?: string[]; error?: string },
    saveStatus: 200,
    rescanResponse: null as ConfigProp[] | null,
  }
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/config' && method === 'GET') return Promise.resolve(fetchJsonResponse(state.configProps))
    if (url === '/api/config' && method === 'PATCH') return Promise.resolve(fetchJsonResponse(state.saveResponse, state.saveStatus))
    if (url === '/api/probes/rescan' && method === 'POST') return Promise.resolve(fetchJsonResponse(state.rescanResponse ?? state.configProps))
    if (url.startsWith('/api/logs')) return Promise.resolve(fetchJsonResponse(state.logs))
    return Promise.resolve(fetchJsonResponse({}))
  })
  return { fn, state }
}

let router: ReturnType<typeof makeFetchRouter>

beforeEach(() => {
  router = makeFetchRouter()
  vi.stubGlobal('fetch', router.fn)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('SettingsOverlay shell', () => {
  it('shows the Config tab by default', async () => {
    render(<SettingsOverlay onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Config' })).toHaveClass('active')
  })

  it('switches to Logs and About tabs', async () => {
    render(<SettingsOverlay onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'About' }))
    expect(screen.getByText('drivecheck')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Logs' }))
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith(expect.stringContaining('/api/logs')))
  })

  it('calls onClose when the close button is clicked', async () => {
    const onClose = vi.fn()
    render(<SettingsOverlay onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: '' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose on Escape', () => {
    const onClose = vi.fn()
    render(<SettingsOverlay onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when clicking the scrim but not the panel', async () => {
    const onClose = vi.fn()
    render(<SettingsOverlay onClose={onClose} />)
    await userEvent.click(document.querySelector('.so-panel')!)
    expect(onClose).not.toHaveBeenCalled()

    await userEvent.click(document.querySelector('.so-scrim')!)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('confirms before closing with unsaved Config changes, and Cancel keeps them', async () => {
    const onClose = vi.fn()
    router.state.configProps = [makeConfigProp({ key: 'server.port', value: 4343 })]
    render(<SettingsOverlay onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '9000' } })
    await userEvent.click(screen.getByRole('button', { name: '' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('Discard unsaved config changes?')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('spinbutton')).toHaveValue(9000)
  })

  it('closes and discards unsaved Config changes when confirmed', async () => {
    const onClose = vi.fn()
    router.state.configProps = [makeConfigProp({ key: 'server.port', value: 4343 })]
    render(<SettingsOverlay onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '9000' } })
    await userEvent.click(screen.getByRole('button', { name: '' }))
    await userEvent.click(screen.getByRole('button', { name: 'Discard & Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('collapses the nav, hiding tab labels', async () => {
    render(<SettingsOverlay onClose={vi.fn()} />)
    expect(screen.getByText('Config')).toBeInTheDocument()
    await userEvent.click(screen.getByTitle('Collapse categories'))
    expect(screen.queryByText('Config')).not.toBeInTheDocument()
    expect(screen.getByTitle('Config')).toBeInTheDocument()
  })
})

describe('ConfigTab', () => {
  it('fetches and renders props grouped by section', async () => {
    router.state.configProps = [
      makeConfigProp({ key: 'server.port', label: 'Port', section: 'Server' }),
      makeConfigProp({ key: 'server.host', label: 'Host', section: 'Server', type: 'str', value: '127.0.0.1' }),
    ]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Server')).toBeInTheDocument())
    expect(screen.getByText('Port')).toBeInTheDocument()
    expect(screen.getByText('Host')).toBeInTheDocument()
  })

  it('disables Save with "No Changes" until something is edited', async () => {
    router.state.configProps = [makeConfigProp()]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'No Changes' })).toBeDisabled()
  })

  it('marks a prop dirty and enables Save when its value changes', async () => {
    router.state.configProps = [makeConfigProp({ key: 'server.port', value: 4343 })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '9000' } })
    expect(screen.getByRole('button', { name: 'Save (1 change)' })).toBeEnabled()
    expect(document.querySelector('.cfg-prop-row')).toHaveClass('dirty')
  })

  it('keeps a pending Config edit after switching tabs and back', async () => {
    router.state.configProps = [makeConfigProp({ key: 'server.port', value: 4343 })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '9000' } })
    expect(screen.getByRole('button', { name: 'Save (1 change)' })).toBeEnabled()

    await userEvent.click(screen.getByRole('button', { name: 'About' }))
    await userEvent.click(screen.getByRole('button', { name: 'Config' }))

    expect(screen.getByRole('spinbutton')).toHaveValue(9000)
    expect(screen.getByRole('button', { name: 'Save (1 change)' })).toBeEnabled()
  })

  it('un-marks dirty when the value is changed back to the original', async () => {
    router.state.configProps = [makeConfigProp({ key: 'server.port', value: 4343 })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '9000' } })
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '4343' } })
    expect(screen.getByRole('button', { name: 'No Changes' })).toBeDisabled()
  })

  it('discards pending changes after a confirm click', async () => {
    router.state.configProps = [makeConfigProp({ key: 'server.port', value: 4343 })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '9000' } })
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByRole('spinbutton')).toHaveValue(9000)

    await userEvent.click(screen.getByRole('button', { name: 'Confirm?' }))
    expect(screen.getByRole('button', { name: 'No Changes' })).toBeDisabled()
    expect(screen.getByRole('spinbutton')).toHaveValue(4343)
  })

  it('saves successfully, applies the new value, and shows a restart banner', async () => {
    router.state.configProps = [makeConfigProp({ key: 'server.port', value: 4343, restart_required: true })]
    router.state.saveResponse = { restart_required: ['server.port'] }
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '9000' } })
    await userEvent.click(screen.getByRole('button', { name: /Save/ }))

    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/config', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ 'server.port': 9000 }),
    })))
    await waitFor(() => expect(screen.getByText(/Restart required to apply: server.port/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'No Changes' })).toBeDisabled()
  })

  it('shows the server-provided error message when saving fails', async () => {
    router.state.configProps = [makeConfigProp({ key: 'server.port', value: 4343 })]
    router.state.saveResponse = { error: 'Port already in use' }
    router.state.saveStatus = 400
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '9000' } })
    await userEvent.click(screen.getByRole('button', { name: /Save/ }))

    await waitFor(() => expect(screen.getByText('Port already in use')).toBeInTheDocument())
    // A failed save keeps the pending change (so Save still reflects 1 change, not reverted).
    expect(screen.getByRole('button', { name: 'Save (1 change)' })).toBeInTheDocument()
  })

  it('shows a network-error message when the save request throws', async () => {
    router.state.configProps = [makeConfigProp({ key: 'server.port', value: 4343 })]
    router.fn.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/config' && init?.method === 'PATCH') return Promise.reject(new Error('boom'))
      return Promise.resolve(fetchJsonResponse(router.state.configProps))
    })
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '9000' } })
    await userEvent.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(screen.getByText('Network error')).toBeInTheDocument())
  })

  it('renders an enum control with its choices', async () => {
    router.state.configProps = [makeConfigProp({
      key: 'logging.level', label: 'Log level', type: 'enum', value: 'info', choices: ['debug', 'info', 'warning'],
    })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Log level')).toBeInTheDocument())
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select).toHaveValue('info')
    expect(Array.from(select.options).map(o => o.value)).toEqual(['debug', 'info', 'warning'])
  })

  it('renders a bool control as a checkbox', async () => {
    router.state.configProps = [makeConfigProp({ key: 'server.debug', label: 'Debug', type: 'bool', value: false })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Debug')).toBeInTheDocument())
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    await userEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Save (1 change)' })).toBeInTheDocument()
  })

  it('renders a str control as a text input', async () => {
    router.state.configProps = [makeConfigProp({ key: 'server.host', label: 'Host', type: 'str', value: '127.0.0.1' })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Host')).toBeInTheDocument())
    expect(screen.getByRole('textbox')).toHaveValue('127.0.0.1')
  })

  it('renders a list control as a textarea, one item per line', async () => {
    router.state.configProps = [makeConfigProp({
      key: 'collector.vitals_probes', label: 'Vitals probes', type: 'list',
      value: ['a.b.c', 'd.e.f'], default: ['a.b.c', 'd.e.f'],
    })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Vitals probes')).toBeInTheDocument())
    expect(screen.getByRole('textbox')).toHaveValue('a.b.c\nd.e.f')

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a.b.c\nd.e.f\ng.h.i' } })
    expect(screen.getByRole('button', { name: 'Save (1 change)' })).toBeInTheDocument()
  })

  it('renders a module_list control as a reorderable item list with an add dropdown', async () => {
    router.state.configProps = [makeConfigProp({
      key: 'collector.vitals_probes', label: 'Vitals probes', type: 'module_list',
      value: ['drives.collector.probes.vitals.hwmon_temp', 'drives.collector.probes.vitals.sysfs_io'],
      default: ['drives.collector.probes.vitals.hwmon_temp', 'drives.collector.probes.vitals.sysfs_io'],
      choices: ['drives.collector.probes.vitals.hwmon_temp', 'drives.collector.probes.vitals.sysfs_io', 'drives.collector.probes.vitals.mount_status'],
    })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Vitals probes')).toBeInTheDocument())

    // Shown shortened — just the module name plus a native/custom tag, not
    // the full dotted path (too long for mobile). The full path is still
    // reachable via HoverReveal (tested elsewhere for that mechanism) for
    // list items, and via a plain title attribute for dropdown options.
    expect(screen.getByText('hwmon_temp (native)')).toBeInTheDocument()
    expect(screen.getByText('sysfs_io (native)')).toBeInTheDocument()
    // Already-listed items aren't offered again in the add dropdown. Values
    // (what actually gets stored) stay full dotted paths even though the
    // visible option text is shortened.
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(Array.from(select.options).map(o => o.value)).toEqual(['', 'drives.collector.probes.vitals.mount_status', '__custom__'])
    expect(screen.getByText('mount_status (native)')).toBeInTheDocument()
    expect(screen.getByTitle('drives.collector.probes.vitals.mount_status')).toBeInTheDocument()
  })

  it('tags a discovered custom probe as "(custom)" and leaves an unrecognized path untagged', async () => {
    router.state.configProps = [makeConfigProp({
      key: 'collector.vitals_probes', label: 'Vitals probes', type: 'module_list',
      value: ['vitals.example_custom_vitals', 'totally.unrelated.path'],
      default: ['vitals.example_custom_vitals', 'totally.unrelated.path'],
      choices: [],
    })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Vitals probes')).toBeInTheDocument())

    expect(screen.getByText('example_custom_vitals (custom)')).toBeInTheDocument()
    // Doesn't match this category's native or custom path shape (e.g. a
    // hand-typed path with no recognizable convention) — shown in full
    // rather than guessing at a tag.
    expect(screen.getByText('totally.unrelated.path')).toBeInTheDocument()
  })

  it('removes a module_list item and stages the change', async () => {
    router.state.configProps = [makeConfigProp({
      key: 'collector.vitals_probes', label: 'Vitals probes', type: 'module_list',
      value: ['a.b', 'c.d'], default: ['a.b', 'c.d'], choices: [],
    })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('a.b')).toBeInTheDocument())

    await userEvent.click(screen.getAllByTitle('Remove')[0])
    expect(screen.queryByText('a.b')).not.toBeInTheDocument()
    expect(screen.getByText('c.d')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save (1 change)' })).toBeInTheDocument()
  })

  it('reorders module_list items with the move-down button', async () => {
    router.state.configProps = [makeConfigProp({
      key: 'collector.vitals_probes', label: 'Vitals probes', type: 'module_list',
      value: ['a.b', 'c.d'], default: ['a.b', 'c.d'], choices: [],
    })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('a.b')).toBeInTheDocument())

    const items = () => Array.from(document.querySelectorAll('.ml-item-path')).map(el => el.textContent)
    expect(items()).toEqual(['a.b', 'c.d'])

    await userEvent.click(document.querySelector('.ml-item .ml-move-btn[title="Move down"]')!)
    expect(items()).toEqual(['c.d', 'a.b'])
    expect(screen.getByRole('button', { name: 'Save (1 change)' })).toBeInTheDocument()
  })

  it('adds a module_list item from the choices dropdown', async () => {
    router.state.configProps = [makeConfigProp({
      key: 'collector.vitals_probes', label: 'Vitals probes', type: 'module_list',
      value: ['a.b'], default: ['a.b'], choices: ['a.b', 'e.f'],
    })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('a.b')).toBeInTheDocument())

    await userEvent.selectOptions(screen.getByRole('combobox'), 'e.f')
    expect(screen.getByText('e.f')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save (1 change)' })).toBeInTheDocument()
  })

  it('adds a module_list item via the custom-path fallback', async () => {
    router.state.configProps = [makeConfigProp({
      key: 'collector.vitals_probes', label: 'Vitals probes', type: 'module_list',
      value: [], default: [], choices: [],
    })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Vitals probes')).toBeInTheDocument())

    await userEvent.selectOptions(screen.getByRole('combobox'), '__custom__')
    await userEvent.type(screen.getByPlaceholderText('dotted.module.path'), 'my.custom.probe')
    await userEvent.click(screen.getByTitle('Add'))

    expect(screen.getByText('my.custom.probe')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save (1 change)' })).toBeInTheDocument()
  })

  it('cancels the custom-path fallback without adding anything', async () => {
    router.state.configProps = [makeConfigProp({
      key: 'collector.vitals_probes', label: 'Vitals probes', type: 'module_list',
      value: [], default: [], choices: [],
    })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Vitals probes')).toBeInTheDocument())

    await userEvent.selectOptions(screen.getByRole('combobox'), '__custom__')
    await userEvent.type(screen.getByPlaceholderText('dotted.module.path'), 'my.custom.probe')
    await userEvent.click(screen.getByTitle('Cancel'))

    expect(screen.queryByPlaceholderText('dotted.module.path')).not.toBeInTheDocument()
    expect(screen.queryByText('my.custom.probe')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'No Changes' })).toBeDisabled()
  })

  it('rescans probe directories and refreshes choices when the rescan button is clicked', async () => {
    router.state.configProps = [makeConfigProp({
      key: 'collector.vitals_probes', label: 'Vitals probes', section: 'Collector', type: 'module_list',
      value: ['a.b'], default: ['a.b'], choices: ['a.b'],
    })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Vitals probes')).toBeInTheDocument())

    router.state.rescanResponse = [makeConfigProp({
      key: 'collector.vitals_probes', label: 'Vitals probes', section: 'Collector', type: 'module_list',
      value: ['a.b'], default: ['a.b'], choices: ['a.b', 'new.found.probe'],
    })]
    await userEvent.click(screen.getByTitle('Rescan native + custom probe directories for newly added probes'))

    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/probes/rescan', expect.objectContaining({ method: 'POST' })))
    await waitFor(() => expect(Array.from((screen.getByRole('combobox') as HTMLSelectElement).options).map(o => o.value))
      .toContain('new.found.probe'))
  })

  it('ignores non-numeric input on a numeric control', async () => {
    router.state.configProps = [makeConfigProp({ key: 'server.port', value: 4343 })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())
    await userEvent.type(screen.getByRole('spinbutton'), 'x')
    expect(screen.getByRole('button', { name: 'No Changes' })).toBeDisabled()
  })

  it('shows a restart hint at rest, and a stronger badge once the row is dirty', async () => {
    router.state.configProps = [makeConfigProp({ key: 'server.port', value: 4343, restart_required: true })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    expect(screen.queryByText('Requires Restart')).not.toBeInTheDocument()
    const icon = document.querySelector('.cfg-restart-icon')!.closest('.cfg-tooltip-anchor')!
    fireEvent.pointerEnter(icon, { pointerType: 'mouse' })
    expect(screen.getByText('Requires an app restart to take effect')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '9000' } })
    expect(screen.getByText('Requires Restart')).toBeInTheDocument()
  })

  it('shows a reset-to-default button only when the saved value differs from default, and hides it while dirty', async () => {
    router.state.configProps = [makeConfigProp({ key: 'server.port', value: 9000, default: 4343 })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    expect(document.querySelector('.cfg-reset-btn')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1234' } })
    expect(document.querySelector('.cfg-reset-btn')).not.toBeInTheDocument()
  })

  it('hides the reset-to-default button once the value already matches the default', async () => {
    router.state.configProps = [makeConfigProp({ key: 'server.port', value: 4343, default: 4343 })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    expect(document.querySelector('.cfg-reset-btn')).not.toBeInTheDocument()
  })

  it('clicking reset-to-default stages the default value as a pending change', async () => {
    router.state.configProps = [makeConfigProp({ key: 'server.port', value: 9000, default: 4343 })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    await userEvent.click(document.querySelector('.cfg-reset-btn')!)
    expect(screen.getByRole('spinbutton')).toHaveValue(4343)
    expect(screen.getByRole('button', { name: 'Save (1 change)' })).toBeInTheDocument()
  })
})

describe('HoverReveal tooltips', () => {
  it('shows the tooltip text on mouse hover and hides it on mouse leave', async () => {
    router.state.configProps = [makeConfigProp({ tooltip: 'Extended explanation here' })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    const icon = document.querySelector('.cfg-tooltip-icon')!.closest('.cfg-tooltip-anchor')!
    fireEvent.pointerEnter(icon, { pointerType: 'mouse' })
    expect(screen.getByText('Extended explanation here')).toBeInTheDocument()

    fireEvent.pointerLeave(icon, { pointerType: 'mouse' })
    expect(screen.queryByText('Extended explanation here')).not.toBeInTheDocument()
  })

  it('ignores touch pointer hover', async () => {
    router.state.configProps = [makeConfigProp({ tooltip: 'Extended explanation here' })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    const icon = document.querySelector('.cfg-tooltip-icon')!.closest('.cfg-tooltip-anchor')!
    fireEvent.pointerEnter(icon, { pointerType: 'touch' })
    expect(screen.queryByText('Extended explanation here')).not.toBeInTheDocument()
  })

  it('reveals the raw config key on click and dismisses on an outside click', async () => {
    router.state.configProps = [makeConfigProp({ key: 'server.port', label: 'Port' })]
    render(<SettingsOverlay onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Port')).toBeInTheDocument())

    await userEvent.click(screen.getByText('Port'))
    expect(screen.getByText('server.port')).toBeInTheDocument()

    await userEvent.click(document.body)
    await waitFor(() => expect(screen.queryByText('server.port')).not.toBeInTheDocument())
  })
})

describe('LogsTab', () => {
  async function openLogsTab() {
    render(<SettingsOverlay onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Logs' }))
  }

  it('fetches with the default limit and level, then renders rows', async () => {
    router.state.logs = [makeLogRecord({ message: 'hello world' })]
    await openLogsTab()
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/logs?n=500&level=all'))
    expect(screen.getByText('hello world')).toBeInTheDocument()
    expect(screen.getByText('1 entries')).toBeInTheDocument()
  })

  it('shows a server-provided error message', async () => {
    router.state.logs = { error: 'log file not found' }
    await openLogsTab()
    await waitFor(() => expect(screen.getByText('log file not found')).toBeInTheDocument())
  })

  it('shows a network-error message on fetch failure', async () => {
    router.fn.mockImplementation((url: string) =>
      url.startsWith('/api/logs') ? Promise.reject(new Error('boom')) : Promise.resolve(fetchJsonResponse([])),
    )
    await openLogsTab()
    await waitFor(() => expect(screen.getByText('Network error')).toBeInTheDocument())
  })

  it('toggles line numbers', async () => {
    router.state.logs = [makeLogRecord()]
    await openLogsTab()
    await waitFor(() => expect(screen.getByText('started')).toBeInTheDocument())
    expect(screen.queryByText('1')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTitle('Line numbers'))
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('refetches with the chosen severity when the filter is changed', async () => {
    router.state.logs = []
    await openLogsTab()
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/logs?n=500&level=all'))

    await userEvent.click(screen.getByTitle('Filter'))
    await userEvent.selectOptions(screen.getByTitle('Minimum severity to show'), 'error')
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/logs?n=500&level=error'))
  })

  it('refetches with the chosen entry limit when changed', async () => {
    router.state.logs = []
    await openLogsTab()
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/logs?n=500&level=all'))

    await userEvent.click(screen.getByTitle('Filter'))
    await userEvent.selectOptions(screen.getByTitle('Entries to fetch'), '1000')
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/logs?n=1000&level=all'))
  })

  it('reloads on refresh click with the same params', async () => {
    router.state.logs = []
    await openLogsTab()
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/logs?n=500&level=all'))
    const callsBefore = router.fn.mock.calls.filter(c => c[0] === '/api/logs?n=500&level=all').length

    await userEvent.click(screen.getByTitle('Refresh logs'))
    await waitFor(() => {
      const callsAfter = router.fn.mock.calls.filter(c => c[0] === '/api/logs?n=500&level=all').length
      expect(callsAfter).toBeGreaterThan(callsBefore)
    })
  })

  it('exports logs with the current severity filter and chosen format', async () => {
    let capturedHref = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      capturedHref = this.href
    })
    router.state.logs = []
    await openLogsTab()
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/logs?n=500&level=all'))

    const exportSelect = screen.getByTitle('Export the full matching log history').querySelector('select')!
    await userEvent.selectOptions(exportSelect, 'csv')
    expect(capturedHref).toContain('/api/logs/export?')
    expect(capturedHref).toContain('format=csv')
    expect(capturedHref).toContain('level=all')
  })
})

describe('AboutTab', () => {
  it('renders the application name and version', async () => {
    render(<SettingsOverlay onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'About' }))
    expect(screen.getByText('drivecheck')).toBeInTheDocument()
    expect(screen.getByText('dev')).toBeInTheDocument()
  })
})
