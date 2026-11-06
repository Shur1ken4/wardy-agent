import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The built page may only talk to its own origin, plus the public RPC it can read the anchored root from when asked.
// Dev mode can't use this, because hot reloading needs inline scripts.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  // The build inlines its smallest font files as data: URLs.
  "font-src 'self' data:",
  // NEAR RPC, for the Network root and for the wallet when someone signs in, and Meteor's wallet, which signs in a popup.
  "connect-src 'self' https://test.rpc.fastnear.com https://free.rpc.fastnear.com https://mw.rpc.fastnear.com https://wallet.meteorwallet.app",
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
  // The wallet libraries were written for Node too, and look for its `global`. In a browser that's `globalThis`.
  define: { global: "globalThis" },
});
