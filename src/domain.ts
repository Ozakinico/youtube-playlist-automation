export interface Video {
  id: string
  title: string
  channel: string
  published: string
  views?: bigint
  thumbnail?: string
  issue?: string
}

export interface VideoResource {
  id: string
  snippet?: {
    title?: string
    channelTitle?: string
    publishedAt?: string
    thumbnails?: { medium?: { url: string }; default?: { url: string } }
  }
  statistics?: { viewCount?: string }
  contentDetails?: { regionRestriction?: { allowed?: string[]; blocked?: string[] } }
}

export const initialFilters = {
  year: '', from: '', to: '', min: '', max: '', title: '', sort: 'source',
}
export type Filters = typeof initialFilters

export function playlistId(input: string): string {
  const value = input.trim()
  const validId = /^[A-Za-z0-9_-]{2,128}$/
  if (validId.test(value)) return value
  try {
    const url = new URL(value.startsWith('youtube.com/') || value.startsWith('www.youtube.com/')
      ? 'https://' + value : value)
    const id = url.searchParams.get('list') ?? ''
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.port &&
        ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname) &&
        url.searchParams.getAll('list').length === 1 && validId.test(id)) return id
  } catch {
    // Use the same validation message for malformed URLs and unsupported input.
  }
  throw new Error('YouTube 再生リストの URL または ID を入力してください。')
}

export function difference(source: string[], target: string[]): string[] {
  const existing = new Set(target)
  return [...new Set(source)].filter(id => !existing.has(id))
}

export function normalizeVideo(id: string, resource?: VideoResource): Video {
  const snippet = resource?.snippet
  const count = resource?.statistics?.viewCount
  const views = count !== undefined && /^\d+$/.test(count) ? BigInt(count) : undefined
  const region = resource?.contentDetails?.regionRestriction
  const limited = region && (region.allowed !== undefined || Boolean(region.blocked?.length))
  const published = snippet?.publishedAt ?? ''
  let issue: string | undefined
  if (!resource) issue = '取得不可（非公開・削除・権限など）'
  else if (limited) issue = '地域制限あり'
  else if (!publishedDay(published) || !snippet?.title) issue = '動画情報が不足'
  else if (views === undefined) issue = '再生回数が取得できません'
  return {
    id, title: snippet?.title ?? id, channel: snippet?.channelTitle ?? '',
    published, views, thumbnail: snippet?.thumbnails?.medium?.url ?? snippet?.thumbnails?.default?.url, issue,
  }
}

const tokyoDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short' })

export function publishedDay(value: string) {
  const time = Date.parse(value)
  return Number.isFinite(time) ? tokyoDate.format(time) : ''
}

export function validateFilters(filters: Filters) {
  if (filters.year && !/^[1-9]\d{3}$/.test(filters.year)) return '公開年は4桁の西暦で入力してください。'
  if (filters.from && filters.to && filters.from > filters.to) return '公開日の開始は終了以前にしてください。'
  if ([filters.min, filters.max].some(value => value && !/^\d+$/.test(value))) return '再生回数は非負整数で入力してください。'
  if (filters.min && filters.max && BigInt(filters.min) > BigInt(filters.max)) return '再生回数の下限は上限以下にしてください。'
  return ''
}

export function filterVideos(videos: Video[], filters: Filters) {
  if (validateFilters(filters)) return []
  const minimum = filters.min ? BigInt(filters.min) : undefined
  const maximum = filters.max ? BigInt(filters.max) : undefined
  const query = filters.title.trim().toLocaleLowerCase('ja')
  const matches = videos.filter(video => {
    if (video.issue || video.views === undefined) return false
    const day = publishedDay(video.published)
    return (!filters.year || day.slice(0, 4) === filters.year) &&
      (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to) &&
      (minimum === undefined || video.views >= minimum) && (maximum === undefined || video.views <= maximum) &&
      video.title.toLocaleLowerCase('ja').includes(query)
  })
  if (filters.sort === 'new') matches.sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
  if (filters.sort === 'old') matches.sort((a, b) => Date.parse(a.published) - Date.parse(b.published))
  if (filters.sort === 'high' || filters.sort === 'low') {
    const direction = filters.sort === 'high' ? -1 : 1
    matches.sort((a, b) => {
      const difference = a.views! - b.views!
      return difference === 0n ? 0 : difference > 0n ? direction : -direction
    })
  }
  return matches
}

export function estimateQuota(reads: number, writes: number) {
  return reads + writes * 50
}

export function csv(rows: (string | number | bigint)[][]) {
  return '\uFEFF' + rows.map(row => row.map(cell => {
    let value = String(cell)
    if (typeof cell === 'string' && (/^\s*[=+\-@＝＋－＠]/u.test(value) || /^[\t\r\n]/.test(value))) value = "'" + value
    return '"' + value.replaceAll('"', '""') + '"'
  }).join(',')).join('\r\n')
}

export function videoUrl(id: string) {
  return 'https://www.youtube.com/watch?v=' + encodeURIComponent(id)
}
