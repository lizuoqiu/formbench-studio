# 淘宝采购交接

工作台不接管浏览器。买家在淘宝官方登录页登录（扫码入口由淘宝提供），本人在淘宝确认加购、检查购物车和付款。工作台不读取账号、Cookie、二维码或购物车，不会根据访问链接报告“已加购”。标准件和定制件可以进入同一份清单；定制件使用厂商实际给出的商品链接、报价规格与数量。

在本机服务端配置已获相应权限的 `TAOBAO_APP_KEY` 和 `TAOBAO_APP_SECRET`，`POST /api/cart` 会调用官方 TOP `taobao.item.carturl.get`，按最多九个 SKU 一组生成链接；`state: links_ready` 表示仅链接已生成。没有凭据或官方拒绝时，返回 `state: manual` 和逐项官方商品链接。服务不会把密钥发给浏览器。此接口签名不需要获取个人登录 Cookie。不能仅凭文档认定当前 AppKey 有权限；须使用真实授权应用联调。

`node tools/taobao-cart.mjs manifest.json --validate` 离线验证结构。`--links` 输出交接信息；`--login` 输出官方登录网址。旧 `--add` 和 `--check` 不再启动浏览器。

淘宝官方文档：[加购 URL 获取](https://developer.alibaba.com/docs/api.htm?apiId=40701&source=search)；[小程序电商能力（my.tb.addToCart）](https://developer.alibaba.com/docs/doc.htm?articleId=119062&docType=1&treeId=785)；[Web 应用 OAuth 授权流程](https://developer.alibaba.com/docs/doc.htm?articleId=102635&docType=1&treeId=1)。小程序接口与独立网页运行环境不同；买家扫码登录淘宝不等于授权工作台访问账户。
