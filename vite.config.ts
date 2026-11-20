import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/youtube-playlist-automation/',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
})
