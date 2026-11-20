const scope = 'https://www.googleapis.com/auth/youtube.force-ssl'
const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim()

interface GoogleOAuth {
  initTokenClient(config: {
    client_id: string
    scope: string
    include_granted_scopes: boolean
    callback: (response: { access_token?: string; expires_in?: number; scope?: string; error?: string }) => void
    error_callback: (response: { type: string }) => void
  }): { requestAccessToken: () => void }
  revoke(token: string, callback: (response: { successful?: boolean }) => void): void
}

function oauth() {
  return (window as Window & { google?: { accounts: { oauth2: GoogleOAuth } } }).google?.accounts.oauth2
}

export const authConfigured = Boolean(clientId)

export function loadAuth() {
  if (oauth()) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      script.remove()
      reject(new Error('Google 認証を読み込めません。接続を確認してください。'))
    }
    document.head.append(script)
  })
}

export interface Session {
  token: string
  expires: number
}

export function signIn() {
  return new Promise<Session>((resolve, reject) => {
    const google = oauth()
    if (!google || !clientId) throw new Error('Google OAuth の設定を確認してください。')
    google.initTokenClient({
      client_id: clientId,
      scope,
      include_granted_scopes: false,
      callback: response => {
        if (!response.access_token || !response.scope?.split(' ').includes(scope)) {
          reject(new Error('YouTube のアクセス権限を許可してください。' + (response.error ? ' (' + response.error + ')' : '')))
          return
        }
        resolve({ token: response.access_token, expires: Date.now() + Number(response.expires_in ?? 3600) * 1000 })
      },
      error_callback: response => reject(new Error(response.type === 'popup_closed'
        ? '認証画面が閉じられました。' : 'Google の認証画面を開けません。ポップアップの設定を確認してください。')),
    }).requestAccessToken()
  })
}

export function revoke(token: string) {
  oauth()?.revoke(token, () => {})
}
