import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { authConfigured, loadAuth, revoke, signIn, type Session } from './auth'
import { csv, estimateQuota, filterVideos, initialFilters, playlistId, publishedDay, validateFilters, videoUrl } from './domain'
import { errorText, isRemaining, loadQueue, queueKey, runQueue, type JobStatus, type Queue } from './queue'
import { ApiError, compare, createYouTube } from './youtube'
import './style.css'

const exampleSource = 'https://www.youtube.com/playlist?list=PLBjvsplOhSrozBvdOopxKBFdvr4aOU8ZZ'
const exampleTarget = 'https://www.youtube.com/playlist?list=PLrDZAy5Hugol5zl8wJzFB2gsfYnkh64eQ'
const number = new Intl.NumberFormat('ja-JP')
const statusLabel: Record<JobStatus, string> = {
  pending: '待機中', sending: '送信中・要照合', added: '追加済み', skipped: 'スキップ', failed: '失敗',
}

function download(name: string, rows: Parameters<typeof csv>[0]) {
  const url = URL.createObjectURL(new Blob([csv(rows)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name + '.csv'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [authLoading, setAuthLoading] = useState(false)
  const [signing, setSigning] = useState(false)
  const [source, setSource] = useState(exampleSource)
  const [target, setTarget] = useState(exampleTarget)
  const [comparison, setComparison] = useState<Awaited<ReturnType<typeof compare>>>()
  const [filters, setFilters] = useState(initialFilters)
  const [showUnavailable, setShowUnavailable] = useState(false)
  const [selected, setSelected] = useState(new Set<string>())
  const [page, setPage] = useState(0)
  const [resultPage, setResultPage] = useState(0)
  const [readOnly, setReadOnly] = useState(false)
  const [budget, setBudget] = useState('250000')
  const [usage, setUsage] = useState(0)
  const [queue, setQueue] = useState<Queue | null>(null)
  const [storageReady, setStorageReady] = useState(false)
  const [mode, setMode] = useState<'reading' | 'writing'>()
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const confirmation = useRef<HTMLDialogElement>(null)
  const queuePanel = useRef<HTMLElement>(null)
  const busy = Boolean(mode)
  const remaining = queue?.jobs.filter(isRemaining).length ?? 0
  const resultPages = Math.max(1, Math.ceil((queue?.jobs.length ?? 0) / 50))
  const activeResultPage = Math.min(resultPage, resultPages - 1)
  const matches = useMemo(() => filterVideos(comparison?.videos ?? [], filters), [comparison, filters])
  const unavailable = useMemo(() => comparison?.videos.filter(video => video.issue) ?? [], [comparison])
  const shown = showUnavailable ? unavailable : matches
  const currentPage = Math.min(page, Math.max(0, Math.ceil(shown.length / 25) - 1))
  const visible = shown.slice(currentPage * 25, (currentPage + 1) * 25)
  const jobById = useMemo(() => new Map(queue?.jobs.map(job => [job.id, job])), [queue])
  const filterError = validateFilters(filters)
  const targetPages = Math.max(1, Math.ceil((comparison?.targetCount ?? 0) / 50))
  const validBudget = /^\d+$/.test(budget)
  const currentJob = mode === 'writing' ? queue?.jobs.find(job => job.status === 'sending') : undefined
  const stage = mode === 'writing' ? 4 : mode === 'reading' ? 1 :
    progress === '追加処理が完了しました。' ? 5 : selected.size ? 3 :
    comparison ? 2 : queue ? (remaining ? 4 : 5) : 0

  function prepareAuth() {
    setAuthLoading(true)
    return loadAuth().then(() => setAuthReady(true)).catch(error => setError(errorText(error)))
      .finally(() => setAuthLoading(false))
  }

  useEffect(() => {
    if (authConfigured) void prepareAuth()
    function restore() {
      try {
        setQueue(loadQueue())
        setStorageReady(true)
      } catch (error) {
        setStorageReady(false)
        setError('保存済みの追加キューにアクセスできません。' + errorText(error))
      }
    }
    restore()
    function onStorage(event: StorageEvent) {
      if (event.key === queueKey || event.key === null) restore()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    if (!session) return
    const timeout = setTimeout(() => setSession(current => current === session ? null : current),
      Math.max(0, session.expires - Date.now()))
    return () => clearTimeout(timeout)
  }, [session])

  function api(token: string) {
    return createYouTube(token, write => setUsage(total => total + estimateQuota(Number(!write), Number(write))))
  }

  function handleError(error: unknown) {
    if (error instanceof ApiError && error.status === 401) setSession(null)
    setError(errorText(error))
  }

  function token() {
    if (session && session.expires > Date.now()) return session.token
    throw new Error('Google で認証してください。')
  }

  async function authenticate() {
    setError('')
    if (!authReady) {
      await prepareAuth()
      return
    }
    setSigning(true)
    try {
      setSession(await signIn())
    } catch (error) {
      handleError(error)
    } finally {
      setSigning(false)
    }
  }

  function clearComparison() {
    setComparison(undefined)
    setSelected(new Set())
    setPage(0)
    setShowUnavailable(false)
    setProgress('')
  }

  async function fetchDifference(event: FormEvent) {
    event.preventDefault()
    setError('')
    let signal: AbortSignal | undefined
    try {
      const sourceId = playlistId(source)
      const targetId = playlistId(target)
      if (sourceId === targetId) throw new Error('コピー元と追加先に異なる再生リストを指定してください。')
      const access = token()
      clearComparison()
      setProgress('再生リストを確認中')
      setMode('reading')
      controller.current = new AbortController()
      signal = controller.current.signal
      const result = await compare(api(access), sourceId, targetId, signal, setProgress)
      signal.throwIfAborted()
      setComparison(result)
      setProgress('比較完了')
    } catch (error) {
      if (signal?.aborted) setProgress('差分取得を中止しました。')
      else {
        handleError(error)
        setProgress('')
      }
    } finally {
      controller.current = null
      setMode(undefined)
    }
  }

  async function processQueue(start?: Queue) {
    setError('')
    let signal: AbortSignal | undefined
    try {
      const access = token()
      if (readOnly) throw new Error('追加するには「比較のみ」をオフにしてください。')
      if (!navigator.locks || !storageReady) throw new Error('キューの保存と排他制御には HTTPS または localhost の対応ブラウザが必要です。')
      setMode('writing')
      controller.current = new AbortController()
      signal = controller.current.signal
      const runSignal = signal
      await navigator.locks.request(queueKey, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('別のタブで追加処理を実行しています。')
        const stored = loadQueue()
        if (start && stored?.jobs.some(isRemaining)) throw new Error('保存されたキューに未処理の動画があります。先に再開してください。')
        const active = start ?? stored
        if (!active) return
        function save(snapshot: Queue) {
          localStorage.setItem(queueKey, JSON.stringify(snapshot))
          setQueue(snapshot)
        }
        save(active)
        if (start) {
          setSelected(new Set())
          setResultPage(0)
        }
        queuePanel.current?.scrollIntoView({ block: 'nearest' })
        setProgress('追加先を照合中')
        await runQueue(active, api(access), save, runSignal)
      })
      setProgress(signal.aborted ? '追加処理を停止しました。' : '追加処理が完了しました。')
    } catch (error) {
      if (signal?.aborted) setProgress('追加処理を停止しました。')
      else {
        handleError(error)
        setProgress('追加処理が停止しました。')
      }
    } finally {
      controller.current = null
      setMode(undefined)
    }
  }

  function approve() {
    if (!comparison || !selected.size) return
    const jobs = comparison.videos.filter(video => !video.issue && selected.has(video.id))
      .map(video => ({ id: video.id, title: video.title, status: 'pending' as const }))
    confirmation.current?.close()
    void processQueue({ version: 1, target: playlistId(target), title: comparison.targetTitle, jobs })
  }

  function exportVideos(filtered: boolean) {
    const videos = filtered ? matches : comparison?.videos ?? []
    download(filtered ? 'filtered-videos' : 'playlist-difference', [
      ['動画ID', 'タイトル', 'チャンネル', '公開日（日本時間）', '再生回数', 'URL', '状態'],
      ...videos.map(video => [
        video.id, video.title, video.channel, publishedDay(video.published), video.views ?? '',
        videoUrl(video.id), video.issue ?? '取得済み',
      ]),
    ])
  }

  function exportJobs(queue: Queue) {
    download('playlist-results', [
      ['追加先ID', '動画ID', 'タイトル', 'URL', '状態', '詳細'],
      ...queue.jobs.map(job => [queue.target, job.id, job.title, videoUrl(job.id), statusLabel[job.status], job.detail ?? '']),
    ])
  }

  return <>
    <header className="top">
      <div className="shell top-inner">
        <div className="brand"><span className="logo" aria-hidden="true">▶</span> Playlist Automation</div>
        <div className="auth">
          <span className={session ? 'online' : ''} role="status">{session ? '認証済み' : '未認証'}</span>
          {session
            ? <button disabled={busy} onClick={() => { revoke(session.token); setSession(null) }}>ログアウト</button>
            : <button disabled={!authConfigured || authLoading || signing || busy} onClick={() => void authenticate()}>
                {signing ? '認証中…' : authLoading ? '読み込み中…' : 'Google で認証'}
              </button>}
        </div>
      </div>
    </header>
    <main className="shell">
      <div className="intro">
        <h1>YouTube 再生リスト自動化</h1>
        <p>再生リストを比較して、追加先にまだない動画を見つけます。</p>
      </div>
      <ol className="steps" aria-label="作業ステップ">
        {['入力', '差分取得', 'フィルター', 'プレビュー', '追加', '完了'].map((label, index) =>
          <li key={label} aria-current={stage === index ? 'step' : undefined}>{label}</li>)}
      </ol>

      {!authConfigured && <p className="notice">Google 認証には OAuth Client ID の設定が必要です。README の Google Cloud 設定を参照してください。</p>}

      <section className="card" aria-labelledby="playlist-heading">
        <h2 id="playlist-heading">再生リスト</h2>
        <form onSubmit={fetchDifference}>
          <div className="two">
            <label>コピー元
              <input value={source} required disabled={busy} onChange={event => { setSource(event.target.value); clearComparison() }} />
              {comparison && <span className="muted title">{comparison.sourceTitle}</span>}
            </label>
            <label>追加先
              <input value={target} required disabled={busy} onChange={event => { setTarget(event.target.value); clearComparison() }} />
              {comparison && <span className="muted title">{comparison.targetTitle}</span>}
            </label>
          </div>
          <p className="muted">URL または再生リスト ID を指定できます。</p>
          <div className="actions">
            <button className="primary" disabled={busy || !session}>差分を取得</button>
            <label className="check"><input type="checkbox" checked={readOnly} disabled={busy}
              onChange={event => setReadOnly(event.target.checked)} /> 比較のみ</label>
            {mode === 'reading' && <button type="button" onClick={() => controller.current?.abort()}>取得を中止</button>}
          </div>
        </form>
        {!progress.startsWith('追加') && !progress.startsWith('停止中') && <p role="status" className="feedback">{progress}</p>}
        {error && <p role="alert" className="error">{error}</p>}
      </section>

      {comparison && <>
        <section className="card" aria-labelledby="filter-heading">
          <div className="section-head"><h2 id="filter-heading">フィルター</h2>
            <button onClick={() => { setFilters(initialFilters); setPage(0); setShowUnavailable(false) }}>条件をクリア</button>
          </div>
          <fieldset disabled={busy}>
            <div className="filter-grid">
              <label>公開年<input inputMode="numeric" value={filters.year} placeholder="指定なし"
                onChange={event => { setFilters({ ...filters, year: event.target.value }); setPage(0) }} /></label>
              <label>公開日・開始（日本時間）<input type="date" value={filters.from}
                onChange={event => { setFilters({ ...filters, from: event.target.value }); setPage(0) }} /></label>
              <label>公開日・終了（日本時間）<input type="date" value={filters.to}
                onChange={event => { setFilters({ ...filters, to: event.target.value }); setPage(0) }} /></label>
              <label>再生回数の下限<input inputMode="numeric" value={filters.min} placeholder="指定なし"
                onChange={event => { setFilters({ ...filters, min: event.target.value }); setPage(0) }} /></label>
              <label>再生回数の上限<input inputMode="numeric" value={filters.max} placeholder="指定なし"
                onChange={event => { setFilters({ ...filters, max: event.target.value }); setPage(0) }} /></label>
              <label>タイトル検索<input value={filters.title} placeholder="キーワード"
                onChange={event => { setFilters({ ...filters, title: event.target.value }); setPage(0) }} /></label>
            </div>
            <div className="actions presets">
              <button onClick={() => { setFilters({ ...filters, year: '2026' }); setPage(0) }}>2026年</button>
              <button onClick={() => { setFilters({ ...filters, min: '1000000' }); setPage(0) }}>100万再生以上</button>
              <button onClick={() => { setFilters({ ...filters, min: '10000000' }); setPage(0) }}>1000万再生以上</button>
            </div>
          </fieldset>
          {filterError && <p className="error" role="alert">{filterError}</p>}
        </section>

        <section className="card" aria-labelledby="preview-heading">
          <div className="section-head"><h2 id="preview-heading">プレビュー</h2>
            <label className="sort">並べ替え
              <select value={filters.sort} onChange={event => { setFilters({ ...filters, sort: event.target.value }); setPage(0) }}>
                <option value="source">元リスト順</option><option value="new">公開日が新しい順</option>
                <option value="old">公開日が古い順</option><option value="high">再生回数が多い順</option>
                <option value="low">再生回数が少ない順</option>
              </select>
            </label>
          </div>
          <div className="metrics" aria-live="polite">
            <span>元にのみ存在 <b>{number.format(comparison.videos.length)}</b></span>
            <span>フィルター一致 <b>{number.format(matches.length)}</b></span>
            <span>選択済み <b>{number.format(selected.size)}</b></span>
          </div>
          <div className="actions">
            <button disabled={busy || !matches.length} onClick={() => setSelected(new Set(matches.map(video => video.id)))}>すべて選択（一致分）</button>
            <button disabled={busy || showUnavailable || !visible.length} onClick={() => setSelected(new Set([...selected, ...visible.map(video => video.id)]))}>表示分を選択</button>
            <button disabled={busy || !selected.size} onClick={() => setSelected(new Set())}>選択解除</button>
            <button aria-pressed={showUnavailable} onClick={() => { setShowUnavailable(!showUnavailable); setPage(0) }}>
              {showUnavailable ? 'フィルター一致を表示' : '取得不可・制限あり (' + unavailable.length + ')'}
            </button>
          </div>
          {selected.size > 0 && <p className="muted">フィルターを変更しても選択済みの動画は保持されます。</p>}
          <div className="table-wrap" tabIndex={0} role="region" aria-label="候補動画の一覧">
            <table>
              <thead><tr><th scope="col">選択</th><th scope="col">動画</th><th scope="col">公開日（JST）</th>
                <th scope="col">再生回数</th><th scope="col">状態</th></tr></thead>
              <tbody>{visible.map(video => {
                const job = queue?.target === playlistId(target) ? jobById.get(video.id) : undefined
                return <tr key={video.id}>
                  <td><input type="checkbox" aria-label={video.title + ' を選択'} disabled={busy || Boolean(video.issue)}
                    checked={selected.has(video.id)} onChange={event => {
                      const next = new Set(selected)
                      if (event.target.checked) next.add(video.id)
                      else next.delete(video.id)
                      setSelected(next)
                    }} /></td>
                  <td><div className="video">
                    {video.thumbnail && <img src={video.thumbnail} width="92" height="52" alt="" loading="lazy" />}
                    <div><a href={videoUrl(video.id)} target="_blank" rel="noreferrer">{video.title}</a>
                      <div className="muted">{video.channel}</div></div>
                  </div></td>
                  <td>{publishedDay(video.published) || '不明'}</td>
                  <td>{video.views === undefined ? '不明' : number.format(video.views)}</td>
                  <td>{video.issue ?? (job ? statusLabel[job.status] : '追加候補')}</td>
                </tr>
              })}</tbody>
            </table>
          </div>
          {!visible.length && <p className="muted">表示する動画がありません。</p>}
          <div className="actions spread">
            <div className="actions">
              <button onClick={() => exportVideos(false)}>全件 CSV</button>
              <button onClick={() => exportVideos(true)}>フィルター結果 CSV</button>
            </div>
            {shown.length > 25 && <nav className="actions" aria-label="候補動画のページ">
              <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>前へ</button>
              <span>{currentPage + 1} / {Math.ceil(shown.length / 25)}</span>
              <button disabled={(currentPage + 1) * 25 >= shown.length} onClick={() => setPage(currentPage + 1)}>次へ</button>
            </nav>}
          </div>
          <div className="actions batch">
            <button className="primary" disabled={!session || !selected.size || readOnly || busy || remaining > 0 || !storageReady}
              onClick={() => confirmation.current?.showModal()}>選択した {number.format(selected.size)} 件を追加</button>
            <span>追加処理の見積もり <b>{number.format(estimateQuota(targetPages, selected.size))}</b></span>
          </div>
        </section>
      </>}

      <section className="card" aria-labelledby="quota-heading">
        <h2 id="quota-heading">クォータ見積もり</h2>
        <div className="actions quota">
          <label>クォータ予算<input inputMode="numeric" value={budget} onChange={event => setBudget(event.target.value)} /></label>
          <span>推定消費 <b>{number.format(usage)}</b></span>
          <span>予算からの推定残り <b>{validBudget ? number.format(BigInt(budget) > BigInt(usage) ? BigInt(budget) - BigInt(usage) : 0n) : '—'}</b></span>
        </div>
        <p className="muted">このページで送信した操作の推計です。Google Cloud の実残量は表示できません。</p>
        {!validBudget && <p className="error">予算には非負整数を入力してください。</p>}
      </section>

      <section ref={queuePanel} className="card" aria-labelledby="queue-heading">
        <h2 id="queue-heading">追加結果</h2>
        <p className="muted">追加先・選択動画・処理結果は、このブラウザに保存されます。</p>
        {queue ? <>
          <h3>{queue.title}</h3>
          {mode === 'writing' && <p role="status" className="feedback">{currentJob ? '処理中 · ' + currentJob.title : progress}</p>}
          {!mode && (progress.startsWith('追加処理')) && <p role="status" className="feedback">{progress}</p>}
          <div className="metrics" aria-live="polite">
            <span>成功 <b>{queue.jobs.filter(job => job.status === 'added').length}</b></span>
            <span>失敗 <b>{queue.jobs.filter(job => job.status === 'failed').length}</b></span>
            <span>スキップ <b>{queue.jobs.filter(job => job.status === 'skipped').length}</b></span>
            <span>残件数 <b>{remaining}</b></span>
          </div>
          <div className="actions">
            {mode === 'writing'
              ? <button onClick={() => { controller.current?.abort(); setProgress('停止中 · 送信済みの操作を確認しています。') }}>停止</button>
              : <button disabled={!remaining || !session || readOnly || busy || !storageReady} onClick={() => void processQueue()}>再開</button>}
            <button onClick={() => exportJobs(queue)}>追加結果 CSV</button>
          </div>
          <div className="table-wrap result-wrap" tabIndex={0} role="region" aria-label="追加結果の一覧">
            <table><thead><tr><th scope="col">動画</th><th scope="col">状態</th><th scope="col">詳細</th></tr></thead>
              <tbody>{queue.jobs.slice(activeResultPage * 50, (activeResultPage + 1) * 50).map(job => <tr key={job.id}>
                <td><a href={videoUrl(job.id)} target="_blank" rel="noreferrer">{job.title}</a></td>
                <td>{statusLabel[job.status]}</td><td>{job.detail ?? '—'}</td>
              </tr>)}</tbody>
            </table>
          </div>
          {resultPages > 1 && <nav className="actions spread" aria-label="追加結果のページ">
            <button disabled={activeResultPage === 0} onClick={() => setResultPage(activeResultPage - 1)}>前へ</button>
            <span>{activeResultPage + 1} / {resultPages}</span>
            <button disabled={activeResultPage + 1 === resultPages} onClick={() => setResultPage(activeResultPage + 1)}>次へ</button>
          </nav>}
        </> : <p className="muted">保存された追加処理はありません。</p>}
      </section>

      <dialog ref={confirmation} aria-labelledby="confirm-title">
        <h2 id="confirm-title">追加を確認</h2>
        <p>「{comparison?.targetTitle}」に選択した {number.format(selected.size)} 件の動画を実際に追加します。</p>
        <p>推定クォータ {number.format(estimateQuota(targetPages, selected.size))}（追加先の再取得を含む）</p>
        <div className="confirm-list" tabIndex={0} role="region" aria-label="追加対象の動画">
          <ul>{comparison?.videos.filter(video => selected.has(video.id)).map(video => <li key={video.id}>{video.title}</li>)}</ul>
        </div>
        <div className="actions">
          <button autoFocus onClick={() => confirmation.current?.close()}>キャンセル</button>
          <button className="primary" onClick={approve}>承認して追加</button>
        </div>
      </dialog>
    </main>
  </>
}

createRoot(document.getElementById('root')!).render(<App />)
