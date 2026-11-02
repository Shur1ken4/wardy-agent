import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The built page may only talk to its own origin, plus the public RPC it can read the anchored root from when asked.
// Dev mode can't use this, because hot reloading needs inline scripts.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://test.rpc.fastnear.com",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "wardy-agent-csp",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY }, injectTo: "head-prepend" }],
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  build: { sourcemap: false },
});
