import { difference, normalizeVideo, type VideoResource } from './domain'

export class ApiError extends Error {
  constructor(public status: number, public reason: string, message: string) {
    super(message)
  }
  get quota() {
    return ['quotaExceeded', 'dailyLimitExceeded', 'dailyLimitExceededUnreg'].includes(this.reason)
  }
  get transient() {
    return this.status === 0 || this.status === 429 || this.status >= 500 ||
      ['rateLimitExceeded', 'userRateLimitExceeded'].includes(this.reason)
  }
}

interface Page<T> {
  items: T[]
  nextPageToken?: string
}

export function createYouTube(token: string, onRequest: (write: boolean) => void, request = fetch) {
  async function call<T>(path: string, params: Record<string, string>, signal?: AbortSignal, body?: object): Promise<T> {
    signal?.throwIfAborted()
    onRequest(Boolean(body))
    let response: Response
    try {
      response = await request('https://www.googleapis.com/youtube/v3/' + path + '?' + new URLSearchParams(params), {
        method: body ? 'POST' : 'GET',
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
        headers: { Authorization: 'Bearer ' + token, ...(body && { 'Content-Type': 'application/json' }) },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new ApiError(0, 'network', '通信に失敗しました。')
    }
    if (!response.ok) {
      const data = await response.json().catch(() => undefined)
      const reason = data?.error?.errors?.[0]?.reason ?? ''
      throw new ApiError(response.status, reason, data?.error?.message ?? 'YouTube API エラー (' + response.status + ')')
    }
    return response.json()
  }

  return {
    async titles(ids: string[], signal?: AbortSignal) {
      const page = await call<Page<{ id: string; snippet: { title: string } }>>(
        'playlists', { part: 'snippet', id: ids.join(',') }, signal,
      )
      return new Map(page.items.map(item => [item.id, item.snippet.title]))
    },
    async items(id: string, signal?: AbortSignal, progress?: (count: number) => void) {
      const ids: string[] = []
      let pageToken: string | undefined
      do {
        const page: Page<{ contentDetails?: { videoId?: string } }> = await call(
          'playlistItems', { part: 'contentDetails', playlistId: id, maxResults: '50', ...(pageToken && { pageToken }) }, signal,
        )
        for (const item of page.items) {
          if (item.contentDetails?.videoId) ids.push(item.contentDetails.videoId)
        }
        progress?.(ids.length)
        pageToken = page.nextPageToken
      } while (pageToken)
      return ids
    },
    async videos(ids: string[], signal?: AbortSignal, progress?: (count: number) => void) {
      const videos = []
      for (let offset = 0; offset < ids.length; offset += 50) {
        const batch = ids.slice(offset, offset + 50)
        const page = await call<Page<VideoResource>>(
          'videos', { part: 'snippet,statistics,contentDetails', id: batch.join(',') }, signal,
        )
        const resources = new Map(page.items.map(video => [video.id, video]))
        videos.push(...batch.map(id => normalizeVideo(id, resources.get(id))))
        progress?.(videos.length)
      }
      return videos
    },
    async insert(target: string, id: string) {
      await call('playlistItems', { part: 'snippet' }, undefined, {
        snippet: { playlistId: target, resourceId: { kind: 'youtube#video', videoId: id } },
      })
    },
  }
}
export type YouTube = ReturnType<typeof createYouTube>

export async function compare(api: YouTube, source: string, target: string, signal: AbortSignal, progress: (text: string) => void) {
  const titles = await api.titles([source, target], signal)
  const sourceTitle = titles.get(source)
  const targetTitle = titles.get(target)
  if (sourceTitle === undefined || targetTitle === undefined) {
    throw new Error((sourceTitle === undefined ? 'コピー元' : '追加先') + 'の再生リストを取得できません。ID と閲覧権限を確認してください。')
  }
  const sourceIds = await api.items(source, signal, count => progress('コピー元を取得中 · ' + count + ' 件'))
  const targetIds = await api.items(target, signal, count => progress('追加先を取得中 · ' + count + ' 件'))
  const ids = difference(sourceIds, targetIds)
  const videos = await api.videos(ids, signal, count => progress('動画情報を取得中 · ' + count + ' / ' + ids.length + ' 件'))
  return { sourceTitle, targetTitle, targetCount: targetIds.length, videos }
}
