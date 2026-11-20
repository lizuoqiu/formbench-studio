# 淘宝加购助手（本机运行）

该可选助手需要已安装 Google Chrome、Node.js 和本地 `playwright` 包。凭据仅保存在本机独立的 `~/.hardware-workbench/taobao/profile`，不提交网站、Git 或云服务。运行前在本目录安装依赖：`npm install --prefix tools --no-save --no-package-lock playwright`。

创建本地 JSON 清单，替换下方**所有**占位内容（不用搜索结果页或 ¥1 询价链接）。`title`、`options` 为商家显示的完整标题和精确 SKU 选项；`skuId` 为已选规格的数字 ID，`qty` 是期望的最终总数量。

```json
{"items":[{"title":"商品完整标题","url":"https://item.taobao.com/item.htm?id=<商品ID>","skuId":"<SKU编号>","options":["商家页面上的精确规格"],"qty":1}]}
```

```sh
node tools/taobao-cart.mjs manifest.json --validate
node tools/taobao-cart.mjs manifest.json --check
node tools/taobao-cart.mjs manifest.json --add
```

默认 `--check`；只有 `--add` 会点击加入购物车。商家、价格与三维打印报价需要先单独核对。对于定制件先发送实际制造文件、版本、材料、数量，拿到对应报价后才将定制 SKU 写入清单。工具不会提交订单、付款、发送消息或上传文件。出现登录或平台验证时操作暂停：本人在已打开窗口完成操作，回车关闭后重新运行。无法证明已选 SKU、数量或独立购物车行时，程序停止，不报告成功。网页版本、懒加载或商家模板不同可能导致核对失败；请以账户内购物车实况为准。浏览器回执仅代表当时的商品记录，不代表整机服务可以结算。

若点击后回读不明确，助手会为该 SKU 在 `~/.hardware-workbench/taobao` 下留下 `.pending` 标记，防止重复加购。先人工核对；数量正确且程序可识别时重新执行 `--check` 自动清除标记。尚未针对真实账户完成端到端测试。

本机工作台可从 `http://127.0.0.1:<本地端口>` 调用 POST `/api/cart`，JSON 为 `{mode:"check"或"add",items:[...]}`；用 GET `/api/cart-status` 查看最近一次任务。运行状态为 `running`、`verified`、`needs_attention` 或 `error`。云端网页不能直接启动本机浏览器。首次本人登录建议先用 CLI 的 `--check` 打开专用浏览器；后台运行时遇登录会停止，不会等待。在账户内更改购物车后须重新核对。
