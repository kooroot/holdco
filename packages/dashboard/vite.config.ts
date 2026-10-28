import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { zyzz } from "zyzz/vite"

export default defineConfig({
  plugins: [react(), zyzz()],
  server: { port: 5173, proxy: { "/api": { target: `http://127.0.0.1:${process.env["HOLDCO_DASHBOARD_PORT"] ?? 7118}`, changeOrigin: true } } },
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
})
