import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RunTaskTab from './RunTaskTab'
import { fetchJsonResponse, makeDrive, routeFetch } from './test/fixtures'
import type { BatchPreview, BatchPreviewDrive, BatchPreviewStep, RecipeInfo } from './types'

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals() })

const SCAN: RecipeInfo = {
  key: 'initial_scan', name: 'Initial Scan', description: 'Short, Conveyance and Long.',
  destructive: false, stop_on_failure: true,
  params: [{ name: 'fail_on_new_remaps', label: 'Fail on new remaps', type: 'boolean', default: false, min: null, max: null }],
}
const STRESS: RecipeInfo = {
  key: 'stress', name: 'Stress Test', description: 'Erases the drive.', destructive: true, stop_on_failure: true,
  params: [{ name: 'passes', label: 'Passes', type: 'number', default: 1, min: 1, max: 4 }],
}

const step = (name: string, extra: Partial<BatchPreviewStep> = {}): BatchPreviewStep => ({
  operation: name.toLowerCase(), operation_name: name, destructive: false, supported: true, settings: [], check: null, ...extra,
})

type Plans = Record<string, Omit<BatchPreviewDrive, 'guid'>>
const included = (steps: BatchPreviewStep[], locked = false) => ({ excluded: null, locked, steps })

// Answers /api/batches/preview with `plans` per guid, echoing the request's
// params like the server; records each request body.
function mockApi(recipe: RecipeInfo, plans: Plans) {
  const previews: Record<string, unknown>[] = []
  vi.mocked(fetch).mockImplementation(routeFetch({
    '/api/operations': [],
    '/api/recipes': [recipe],
    '/api/batches/preview': (init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      previews.push(body)
      const preview: BatchPreview = {
        recipe, params: body.params, stop_on_failure: body.stop_on_failure,
        drives: body.guids.map((guid: string) => ({ guid, ...plans[guid] })),
      }
      return preview
    },
  }))
  return previews
}

function renderTab(guids: string[], onRunRecipe = vi.fn().mockResolvedValue(null), drives = guids.map(guid => makeDrive({ guid, model: `Model ${guid}` }))) {
  render(<RunTaskTab drives={drives} selected={guids} onRun={vi.fn()} onRunRecipe={onRunRecipe} />)
  return onRunRecipe
}

const plan = () => screen.getByRole('region', { name: 'Plan' })
const planReady = () => waitFor(() => expect(plan()).toHaveAttribute('aria-busy', 'false'))

describe('Run Task recipes', () => {
  it('lists recipes under Recipes and opens one with its description', async () => {
    mockApi(SCAN, { d1: included([step('Short')]) })
    renderTab(['d1'])
    expect(await screen.findByText('Recipes')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Initial Scan' })).toBeInTheDocument()
    expect(screen.getByText('Short, Conveyance and Long.')).toBeInTheDocument()
  })

  it('shows drives with the same plan together, with each step and its settings', async () => {
    mockApi(SCAN, {
      d1: included([step('Short'), step('Badblocks', { settings: [{ name: 'block_size', label: 'Block size', value: 8192 }] })]),
      d2: included([step('Short'), step('Badblocks', { settings: [{ name: 'block_size', label: 'Block size', value: 8192 }] })]),
      d3: included([step('Short'), step('Conveyance', { supported: false })]),
    })
    renderTab(['d1', 'd2', 'd3'])
    await planReady()
    const groups = within(plan()).getAllByLabelText('Drives').map(list => list.parentElement!)
    expect(groups).toHaveLength(2)
    expect(within(groups[0]).getByText('Model d1')).toBeInTheDocument()
    expect(within(groups[0]).getByText('Model d2')).toBeInTheDocument()
    const setting = within(groups[0]).getByText('Block size')
    expect(setting.tagName).toBe('DT')
    expect(setting.nextElementSibling).toHaveTextContent('8,192')
    expect(within(groups[1]).getByText('Skipped: not supported on this drive')).toBeInTheDocument()
  })

  it('says why a drive is left out, and runs on the rest', async () => {
    mockApi(SCAN, {
      d1: included([step('Short')]),
      d2: { excluded: "Can't run step 2", locked: false, steps: null },
    })
    const onRunRecipe = renderTab(['d1', 'd2'])
    await planReady()
    expect(within(plan()).getByText("Left out: Can't run step 2")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run on 1 of 2 drives' }))
    expect(onRunRecipe).toHaveBeenCalledWith(['d1'], 'initial_scan', { fail_on_new_remaps: false }, true)
  })

  it("can't run when every drive is left out", async () => {
    mockApi(SCAN, { d1: { excluded: 'Nope', locked: false, steps: null } })
    renderTab(['d1'])
    await planReady()
    expect(screen.getByText('None of the selected drives can run Initial Scan.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled()
  })

  it('replans as options change and runs with them', async () => {
    const previews = mockApi(SCAN, { d1: included([step('Short')]) })
    const onRunRecipe = renderTab(['d1'])
    await planReady()
    fireEvent.click(screen.getByRole('checkbox', { name: /Stop if a step fails/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Fail on new remaps/ }))
    expect(plan()).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled()  // until the plan catches up
    await planReady()
    expect(previews.at(-1)).toMatchObject({ stop_on_failure: false, params: { fail_on_new_remaps: true } })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(onRunRecipe).toHaveBeenCalledWith(['d1'], 'initial_scan', { fail_on_new_remaps: true }, false)
  })

  it('confirms a destructive recipe before starting it', async () => {
    mockApi(STRESS, { d1: included([step('Badblocks', { destructive: true })]) })
    const onRunRecipe = renderTab(['d1'])
    await planReady()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(onRunRecipe).not.toHaveBeenCalled()
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText(/Stress Test destroys all data on this drive/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run Stress Test' }))
    expect(onRunRecipe).toHaveBeenCalledWith(['d1'], 'stress', { passes: 1 }, true)
  })

  it('blocks a destructive recipe while a drive it would run on is locked', async () => {
    mockApi(STRESS, { d1: included([step('Badblocks')], true) })
    renderTab(['d1'])
    await planReady()
    expect(screen.getByText(/1 drive is locked/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled()
  })

  it("shows the server's reason when it can't plan", async () => {
    vi.mocked(fetch).mockImplementation(routeFetch({
      '/api/operations': [],
      '/api/recipes': [SCAN],
      '/api/batches/preview': fetchJsonResponse({ error: "the recipe's plan is invalid: boom" }, 500),
    }))
    renderTab(['d1'])
    expect(await screen.findByRole('alert')).toHaveTextContent("the recipe's plan is invalid: boom")
  })

  it('shows a refusal from starting the recipe', async () => {
    mockApi(SCAN, { d1: included([step('Short')]) })
    renderTab(['d1'], vi.fn().mockResolvedValue('one or more drives are locked'))
    await planReady()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('one or more drives are locked')
  })
})
