import { ApiError, type YouTube } from './youtube'

export type JobStatus = 'pending' | 'sending' | 'added' | 'skipped' | 'failed'
export interface Job {
  id: string
  title: string
  status: JobStatus
  detail?: string
}
export interface Queue {
  version: 1
  target: string
  title: string
  jobs: Job[]
}

export const queueKey = 'youtube-playlist-queue-v1'

export function loadQueue(storage: Pick<Storage, 'getItem'> = localStorage): Queue | null {
  const raw = storage.getItem(queueKey)
  if (!raw) return null
  const data: Queue = JSON.parse(raw)
  if (data.version !== 1 || typeof data.target !== 'string' || typeof data.title !== 'string' ||
      !/^[A-Za-z0-9_-]{2,128}$/.test(data.target) || !Array.isArray(data.jobs) ||
      data.jobs.some(job => typeof job.title !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(job.id) ||
        !['pending', 'sending', 'added', 'skipped', 'failed'].includes(job.status)) ||
      new Set(data.jobs.map(job => job.id)).size !== data.jobs.length) {
    throw new Error('保存したキューを読み込めません。')
  }
  return data
}

export function isRemaining(job: Job) {
  return job.status === 'pending' || job.status === 'sending'
}

export function errorText(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return '認証が失効しました。再認証してから再開してください。'
    if (error.quota) return 'YouTube API のクォータ上限に達しました。Google Cloud で確認してから再開してください。'
    if (error.destinationWriteBlocked) {
      return '追加先への書き込みが拒否されました。現在の YouTube チャンネルが所有する通常の再生リストを選ぶか、所有者のチャンネルで認証し直してください。 (' + error.reason + ')'
    }
    return [error.reason, error.message].filter(Boolean).join(' · ')
  }
  return error instanceof Error ? error.message : '処理に失敗しました。'
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function runQueue(
  queue: Queue,
  api: Pick<YouTube, 'items' | 'insert'>,
  save: (queue: Queue) => void,
  signal: AbortSignal,
  delay = wait,
) {
  const jobs = queue.jobs.map(job => ({ ...job }))
  function update(job: Job, status: JobStatus, detail?: string) {
    Object.assign(job, { status, detail })
    save({ ...queue, jobs: jobs.map(item => ({ ...item })) })
  }

  async function readDestination() {
    for (let attempt = 0; ; attempt++) {
      try {
        return new Set(await api.items(queue.target, signal))
      } catch (error) {
        if (!(error instanceof ApiError) || !error.transient || error.quota || attempt >= 3 || signal.aborted) throw error
        await delay(500 * 2 ** attempt + Math.random() * 350)
      }
    }
  }

  let existing = await readDestination()
  for (const job of jobs) {
    if (!isRemaining(job)) continue
    if (signal.aborted) break
    if (existing.has(job.id)) {
      update(job, 'skipped', '追加先に存在します')
      continue
    }

    for (let attempt = 0; attempt <= 3; attempt++) {
      if (signal.aborted) return
      // Save before sending so a reload or lost response can be reconciled.
      update(job, 'sending')
      try {
        await api.insert(queue.target, job.id)
      } catch (error) {
        if (error instanceof ApiError && (error.quota || error.status === 401 || error.destinationWriteBlocked)) {
          update(job, 'pending', errorText(error))
          throw error
        }
        const uncertain = !(error instanceof ApiError) || error.transient
        if (uncertain) {
          await delay(500 * 2 ** attempt + Math.random() * 350)
          if (signal.aborted) return
          existing = await readDestination()
          if (existing.has(job.id)) {
            update(job, 'skipped', '追加先を再取得して確認済み')
            break
          }
          if (attempt < 3) continue
        }
        update(job, 'failed', errorText(error))
        break
      }
      existing.add(job.id)
      update(job, 'added')
      break
    }
  }
}
