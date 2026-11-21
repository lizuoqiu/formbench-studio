# Formbench · 硬件设计工作台

这是一个独立实现的中文硬件研究原型，附 Pico 桌面指示器参考项目。用 Node 22 或更新版本先运行 `node tools/build.mjs`，再运行 `node server/local.mjs`，在 `http://127.0.0.1:4173` 打开。采购核对记录存储在当前浏览器，清除浏览器数据将丢失记录。

设计服务需要在服务端环境设置 `OPENAI_API_KEY` 和有权限的 `OPENAI_MODEL`；没有配置时仍可操作参考项目。生成接口只返回候选器件和步骤，不会把任意文字设计自动变成已经验证的打印件。

`node tools/build.mjs` 生成静态工作台 `dist/`。GitHub Pages 工作流在启用 Actions 发布之后部署 `main`；Cloudflare 静态部署使用 `npx wrangler deploy`，需要目标账号授权。静态部署不包含本地模型服务或购物会话，不要把密钥上传到公开目录。

采购页可记录商品、外壳报价与装配安排，再导出加购清单。确认商品后通过淘宝官方加购链接或商品页完成加购，详见 [加购助手](tools/taobao-cart.md)。只询价不排产；未取得真实报价和购物车核对前，不应据此付款。

团队私有云后端的部署说明见 [Cloudflare Worker](server/private-deployment.md)。公开演示无需登录，不使用团队额度。

机械页提供 Pico 参考外壳的独立 ForgeCAD 参数源码、STL 和 STEP。参见 [Forge 模型与尺寸](forge/README.md) 和 [本机重新计算](docs/local-forge.md)。采购候选和可下载 CAD 都不代表实物已装配通过。

结构页可开盖查看 Pico 默认内部布局，并按当前 BOM 逐项检查候选硬件几何、尺寸和来源。见[模型目录、授权与摆位依据](docs/hardware-models.md)。
