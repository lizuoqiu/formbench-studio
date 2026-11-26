# Private model-backed deployment

The public GitHub Pages preview runs static files. To use the AI from a browser, deploy the UI and Worker on the same Cloudflare hostname. API keys never belong in static assets, GitHub Pages settings exposed to frontend builds, or client-side storage. The Worker can request official cart links on the server. Browser-based shopping runs on the buyer’s own computer.

1. From the checkout run `npm ci --prefix server`, `npm ci --prefix tools`, then `node tools/build.mjs`. Authenticate the deployment CLI to the intended Cloudflare Workers account. Use a Wrangler version compatible with Workers Static Assets.
2. Deploy the unconfigured Worker with `npx wrangler deploy --config server/wrangler.worker.jsonc`. No model calls are available in this state. Use the actual hostname returned by Wrangler. Do not add API keys yet.
3. In Cloudflare Access, create a self-hosted application covering that entire hostname, including `/api/*`. Configure an Allow policy for only the designated team/account; no Bypass or Everyone. Confirm a signed-out private window is redirected to Access. Copy the application's exact audience tag and the team's issuer (`https://<team>.cloudflareaccess.com`, no trailing slash).
4. Run `npx wrangler secret put NAME --config server/wrangler.worker.jsonc` once per name: `ACCESS_ISSUER`, `ACCESS_AUD`, `OPENAI_MODEL` (actual API model ID enabled for the project), then `OPENAI_API_KEY`. Enter each value only in the tool's interactive prompt. Do not commit values or paste credentials in chat. Configure usage limits/alerts in the model provider account as appropriate.
5. Log in with an allowed identity and request a design. Check that anonymous users cannot generate designs, an allowed user receives a real result, and an authorised same-origin request can obtain the expected cart handoff. A static page load alone is not evidence the model works.

Optional backup keys use separate server secrets named `OPENAI_API_KEY_2`, `OPENAI_API_KEY_3`, and so on; keep the primary key. Confirmed credit/spend/usage exhaustion switches to the next distinct key within the API step, including SSE failures. Model and reasoning settings stay unchanged. This does not switch providers or bypass shared organization balances. No key value is included in browser responses or failover logs.

## Consumer projects and Taobao OAuth

The consumer page and the account service must use the same origin. A successful Cloudflare Access session allows access to the private deployment. The separate Taobao login determines the project owner. The server exchanges a short-lived authorization code, keeps only a derived project owner identifier, and issues an HTTP-only site session. A Taobao access token is not sent to the page.

1. Register a web application with Taobao Open Platform that is permitted to authorize the intended buyer accounts. Record its exact approved callback, e.g. `https://your-worker.example/api/auth/callback`. Check eligibility and permitted uses with the [official OAuth guide](https://developer.alibaba.com/docs/doc.htm?articleId=102635&docType=1). A personal Taobao username cannot stand in for the website's app registration.
2. Bind a project database as `FORM_DB` to this Worker (Cloudflare D1). If deploying by Wrangler, add the database binding to the deployment configuration using the actual database ID before deploying. The handler creates project/session tables on first use. Local testing uses an independent SQLite database in the user's .formbench directory.
3. Set `TAOBAO_APP_KEY`, `TAOBAO_APP_SECRET` and `TAOBAO_REDIRECT_URI` in the server environment. Keep secret values out of the client bundle. Verify two separate buyer accounts can only list and reopen their own projects, and that logout ends the session.
4. The Worker accepts the same-origin `/api/cart` endpoint for obtaining TOP-issued Taobao confirmation links when its app has permission. The optional desktop extension acts in the buyer's own browser. A link and an authenticated identity do not constitute a cart write receipt.

### 本机自动接力与日志

用 `FORMBENCH_ALLOW_LOCAL_CODEX=1 FORMBENCH_DEBUG=1 node server/local.mjs` 启动 Mac 工作台。默认先用 API；池中全部密钥确认额度耗尽后，把已保存的任务交给本机 Codex。两种方式均无额度时，任务停止；临时网络错误并不表示额度耗尽。公开网页不持有密钥，选择仅本机时不会调用 API。

开启 Debug 后终端和 `~/.formbench/debug/YYYY-MM-DD.jsonl`（UTC）同时记录每项任务的模型调用、等待、阶段、部件进度、检查与停止原因。按 `id` 筛选，`ai.wait` 只代表仍在等待；不要当作设计前进。保留约 14 天，可设置 `FORMBENCH_DEBUG_DIR`。日志不含需求原文、API 密钥、网页抓取正文或模型的私有推理。
