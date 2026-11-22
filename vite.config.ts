import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error plain JS server module
import { handle } from "./server/api.mjs";

export default defineConfig({
  plugins: [
    react(),
    { name: "scout-studio-api", configureServer(server) { server.middlewares.use(async (req, res, next) => { if (!(await handle(req, res))) next(); }); } },
  ],
  server: { port: 4801, strictPort: true, host: "127.0.0.1" },
});
