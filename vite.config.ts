import { defineScoutThinViteConfig } from "scout-app/vite";
// @ts-expect-error plain ESM server module
import { handle } from "./server/api.mjs";

export default defineScoutThinViteConfig({
  product: "Studio",
  variant: "canvas",
  rail: "wide",
  port: 4801,
  apiHandler: handle,
  serverEntry: "src/server.ts",
});
