import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5179,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.API_TARGET || "http://localhost:4110",
        changeOrigin: true
      }
    }
  }
});
