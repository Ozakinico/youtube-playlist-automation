import { describe, expect, it } from 'vitest'
import { csv, difference, estimateQuota, filterVideos, initialFilters, normalizeVideo, playlistId, validateFilters } from './domain'

describe('playlist comparison', () => {
  it('accepts IDs and playlist or watch URLs', () => {
    expect(playlistId(' PL_123 ')).toBe('PL_123')
    expect(playlistId('https://www.youtube.com/playlist?list=PL_123')).toBe('PL_123')
    expect(playlistId('youtube.com/watch?v=video&list=PL_123')).toBe('PL_123')
  })

  it.each([
    'javascript:alert(1)', 'https://youtube.com.example/watch?list=PL_123',
    'https://example.com@youtube.com/playlist?list=PL_123',
    'https://youtube.com/watch?list=PL_A&list=PL_B', 'https://youtube.com/?list=%3Cevil%3E',
  ])('rejects invalid input %s', input => expect(() => playlistId(input)).toThrow())

  it('uses IDs even if titles match, and removes duplicate IDs', () => {
    const original = [{ id: 'a', title: '同じタイトル' }, { id: 'b', title: '同じタイトル' }]
    expect(difference([...original.map(item => item.id), 'a', 'b'], ['b'])).toEqual(['a'])
  })
})

describe('filters', () => {
  function video(id: string, publishedAt: string, viewCount?: string, title = '東京ライブ') {
    return normalizeVideo(id, { id, snippet: { title, publishedAt }, statistics: { viewCount } })
  }

  const videos = [
    video('a', '2025-12-31T14:59:59Z', '10000000'),
    video('b', '2025-12-31T15:00:00Z', '1000000'),
    video('c', '2026-12-31T14:59:59Z', '10000000'),
    video('d', '2026-12-31T15:00:00Z', '10000000'),
    video('e', '2026-05-01T00:00:00Z', '999999'),
    video('f', '2026-05-01T00:00:00Z'),
    video('g', '2026-05-01T00:00:00Z', '10000001', '別のタイトル'),
    normalizeVideo('h'),
    normalizeVideo('i', {
      id: 'i', snippet: { title: '東京ライブ', publishedAt: '2026-05-01T00:00:00Z' },
      statistics: { viewCount: '10000000' }, contentDetails: { regionRestriction: { allowed: [] } },
    }),
  ]

  it('uses inclusive JST year boundaries and treats missing values and restrictions separately', () => {
    expect(filterVideos(videos, { ...initialFilters, year: '2026' }).map(item => item.id)).toEqual(['b', 'c', 'e', 'g'])
    expect(videos.slice(-2).every(item => item.issue)).toBe(true)
  })

  it('includes both view-count presets at their exact boundaries', () => {
    expect(filterVideos(videos, { ...initialFilters, year: '2026', min: '1000000' }).map(item => item.id)).toEqual(['b', 'c', 'g'])
    expect(filterVideos(videos, { ...initialFilters, year: '2026', min: '10000000' }).map(item => item.id)).toEqual(['c', 'g'])
  })

  it('combines year, dates, view range and title with AND', () => {
    const filters = { ...initialFilters, year: '2026', from: '2026-05-01', to: '2026-12-31', min: '2500000', max: '10000000', title: '東京' }
    expect(filterVideos(videos, filters).map(item => item.id)).toEqual(['c'])
    expect(filterVideos(videos, { ...filters, to: '2026-12-30' })).toEqual([])
    expect(validateFilters({ ...filters, max: '100' })).toBeTruthy()
  })
})

it('estimates reads and writes and escapes CSV formulas and quotes', () => {
  expect(estimateQuota(10, 55)).toBe(2760)
  expect(csv([[' =HYPERLINK("x")', '日本語', 10000000n]])).toBe('\uFEFF"\' =HYPERLINK(""x"")","日本語","10000000"')
})
