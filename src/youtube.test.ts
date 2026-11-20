import { expect, it, vi } from 'vitest'
import { compare, createYouTube } from './youtube'

it('loads all playlist pages and batches only difference IDs in groups of 50', async () => {
  const ids = Array.from({ length: 63 }, (_, index) => 'video' + index)
  const fetchedBatches: string[][] = []
  const calls = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/playlists')) {
      return Response.json({ items: [
        { id: 'source', snippet: { title: 'コピー元' } }, { id: 'target', snippet: { title: '追加先' } },
      ] })
    }
    if (url.pathname.endsWith('/playlistItems')) {
      expect(url.searchParams.get('maxResults')).toBe('50')
      const target = url.searchParams.get('playlistId') === 'target'
      const second = url.searchParams.get('pageToken') === '2'
      return Response.json({
        items: (target ? [ids[4]] : second ? ids.slice(50) : ids.slice(0, 50)).map(videoId => ({ contentDetails: { videoId } })),
        nextPageToken: !target && !second ? '2' : undefined,
      })
    }
    const batch = url.searchParams.get('id')!.split(',')
    fetchedBatches.push(batch)
    expect(url.searchParams.get('part')).toBe('snippet,statistics,contentDetails')
    return Response.json({ items: batch.slice(1).map(id => ({
      id, snippet: { title: id, publishedAt: '2026-01-01' }, statistics: { viewCount: '1000000' },
    })) })
  })
  const count = vi.fn()
  const api = createYouTube('mock', count, calls)
  const progress = vi.fn()
  const data = await compare(api, 'source', 'target', new AbortController().signal, progress)
  expect(data.videos).toHaveLength(62)
  expect(data.videos[0].issue).toBeTruthy()
  expect(fetchedBatches.map(batch => batch.length)).toEqual([50, 12])
  expect(fetchedBatches.flat()).not.toContain(ids[4])
  expect(count.mock.calls).toEqual(Array.from({ length: 6 }, () => [false]))
  expect(progress).toHaveBeenCalledWith('コピー元を取得中 · 63 件')
})

it('does not send the next page when a read is cancelled', async () => {
  const controller = new AbortController()
  const request = vi.fn(async () => Response.json({ items: [], nextPageToken: '2' }))
  const api = createYouTube('mock', () => {}, request)
  await expect(api.items('source', controller.signal, () => controller.abort())).rejects.toMatchObject({ name: 'AbortError' })
  expect(request).toHaveBeenCalledTimes(1)
})
