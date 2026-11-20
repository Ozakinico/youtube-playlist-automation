import { expect, it, vi } from 'vitest'
import { loadQueue, runQueue, type Queue } from './queue'
import { ApiError } from './youtube'

const first = 'aaaaaaaaaaa'
const second = 'bbbbbbbbbbb'
function makeQueue(...ids: string[]): Queue {
  return { version: 1, target: 'PLtarget', title: '追加先', jobs: ids.map(id => ({ id, title: id, status: 'pending' })) }
}
const signal = () => new AbortController().signal
const delay = async () => {}

it('recovers a saved snapshot and skips existing and ambiguous jobs after reload', async () => {
  const queue = makeQueue(first, second)
  queue.jobs[0].status = 'sending'
  const recovered = loadQueue({ getItem: () => JSON.stringify(queue) })
  const api = { items: vi.fn(async () => [first]), insert: vi.fn(async () => {}) }
  const save = vi.fn()
  await runQueue(recovered!, api, save, signal(), delay)
  expect(api.insert).toHaveBeenCalledExactlyOnceWith(queue.target, second)
  expect(save.mock.lastCall?.[0].jobs.map((job: Queue['jobs'][number]) => job.status)).toEqual(['skipped', 'added'])
})

it('rechecks before retrying a transient write error', async () => {
  const api = {
    items: vi.fn(async () => []),
    insert: vi.fn(async () => {}).mockRejectedValueOnce(new ApiError(503, '', 'Temporary failure')),
  }
  const save = vi.fn()
  await runQueue(makeQueue(first), api, save, signal(), delay)
  expect(api.items).toHaveBeenCalledTimes(2)
  expect(api.insert).toHaveBeenCalledTimes(2)
  expect(save.mock.lastCall?.[0].jobs[0].status).toBe('added')
})

it('does not repeat a committed write whose response was lost', async () => {
  const api = {
    items: vi.fn(async () => [first]).mockResolvedValueOnce([]),
    insert: vi.fn().mockRejectedValue(new ApiError(0, 'network', 'Lost response')),
  }
  const save = vi.fn()
  await runQueue(makeQueue(first), api, save, signal(), delay)
  expect(api.insert).toHaveBeenCalledTimes(1)
  expect(save.mock.lastCall?.[0].jobs[0].status).toBe('skipped')
})

it.each([new ApiError(401, 'authError', 'Expired'), new ApiError(403, 'quotaExceeded', 'Quota')])(
  'stops on %s and preserves remaining jobs', async error => {
    const api = { items: vi.fn(async () => []), insert: vi.fn().mockRejectedValue(error) }
    const save = vi.fn()
    await expect(runQueue(makeQueue(first, second), api, save, signal(), delay)).rejects.toBe(error)
    expect(api.insert).toHaveBeenCalledTimes(1)
    expect(save.mock.lastCall?.[0].jobs.map((job: Queue['jobs'][number]) => job.status)).toEqual(['pending', 'pending'])
  },
)

it('finishes an in-flight write on stop and preserves later work', async () => {
  const abort = new AbortController()
  const api = { items: vi.fn(async () => []), insert: vi.fn(async () => abort.abort()) }
  const save = vi.fn()
  await runQueue(makeQueue(first, second), api, save, abort.signal, delay)
  expect(api.insert).toHaveBeenCalledTimes(1)
  expect(save.mock.lastCall?.[0].jobs.map((job: Queue['jobs'][number]) => job.status)).toEqual(['added', 'pending'])
})

it('records a permanent error and continues with later jobs', async () => {
  const api = {
    items: vi.fn(async () => []),
    insert: vi.fn(async () => {}).mockRejectedValueOnce(new ApiError(404, 'videoNotFound', 'Not found')),
  }
  const save = vi.fn()
  await runQueue(makeQueue(first, second), api, save, signal(), delay)
  expect(api.insert).toHaveBeenCalledTimes(2)
  expect(save.mock.lastCall?.[0].jobs[0]).toMatchObject({ status: 'failed', detail: 'videoNotFound · Not found' })
  expect(save.mock.lastCall?.[0].jobs[1].status).toBe('added')
})

it('pauses the remaining queue after a destination permission error', async () => {
  const error = new ApiError(403, 'playlistItemsNotAccessible', 'Forbidden')
  const api = { items: vi.fn(async () => []), insert: vi.fn().mockRejectedValue(error) }
  const save = vi.fn()
  await expect(runQueue(makeQueue(first, second), api, save, signal(), delay)).rejects.toBe(error)
  expect(api.insert).toHaveBeenCalledExactlyOnceWith('PLtarget', first)
  expect(save.mock.lastCall?.[0].jobs).toMatchObject([
    { status: 'pending', detail: expect.stringContaining('所有する通常の再生リスト') },
    { status: 'pending' },
  ])
})
