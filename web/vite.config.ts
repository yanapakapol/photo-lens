import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Base path for GitHub Pages project site; override with BASE_PATH=/ for custom domain.
export default defineConfig({
  base: process.env.BASE_PATH || '/photo-lens/',
  plugins: [react()],
})
