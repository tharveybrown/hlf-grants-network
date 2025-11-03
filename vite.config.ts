import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5000,
    strictPort: true,
    allowedHosts: "c65e8c44-1323-463c-a434-43ecd18acbc3-00-2jtcwtdasi5e4.spock.replit.dev",
    proxy: {
      '/api': 'http://localhost:4000'
    }
  }
})

