import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ plugins: [react()], base: '/apps/evaluation/', build: { outDir: 'dist-public', rollupOptions: { input: 'public-replay.html' } } })
