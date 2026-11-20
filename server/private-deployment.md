# Private model-backed deployment

The public GitHub Pages preview runs static files. To use the AI from a browser, deploy the UI and Worker on the same Cloudflare hostname. API keys never belong in static assets, GitHub Pages settings exposed to frontend builds, or client-side storage. The Worker does not proxy the local purchasing bridge.

1. From the checkout run `node tools/build.mjs` and `npm ci --prefix server`. Authenticate the deployment CLI to the intended Cloudflare Workers account. Use a Wrangler version compatible with Workers Static Assets.
2. Deploy the unconfigured Worker with `npx wrangler deploy --config server/wrangler.worker.jsonc`. No model calls are available in this state. Use the actual hostname returned by Wrangler. Do not add API keys yet.
3. In Cloudflare Access, create a self-hosted application covering that entire hostname, including `/api/*`. Configure an Allow policy for only the designated team/account; no Bypass or Everyone. Confirm a signed-out private window is redirected to Access. Copy the application's exact audience tag and the team's issuer (`https://<team>.cloudflareaccess.com`, no trailing slash).
4. Run `npx wrangler secret put NAME --config server/wrangler.worker.jsonc` once per name: `ACCESS_ISSUER`, `ACCESS_AUD`, `OPENAI_MODEL` (actual API model ID enabled for the project), then `OPENAI_API_KEY`. Enter each value only in the tool's interactive prompt. Do not commit values or paste credentials in chat. Configure usage limits/alerts in the model provider account as appropriate.
5. Log in with an allowed identity and request a design. Check that anonymous users cannot generate designs, an allowed user receives a real result, and `/api/cart` is unavailable on the Worker. A static page load alone is not evidence the model works.
