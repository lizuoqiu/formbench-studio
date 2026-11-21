# Formwork 硬件设计

[打开用户端](https://lizuoqiu.github.io/formbench-studio/)。输入需求即可生成零件清单和按尺寸计算的外壳概念 CAD。结果页支持开盖、修改零件尺寸、导出底壳和上盖 STL、查看有来源的淘宝商品候选及按型号搜索。默认首页面向采购者，工程与装配工具仍可从[工程工作台](https://lizuoqiu.github.io/formbench-studio/workbench.html#overview)打开。

## 在本机运行

使用 Node 22.13 或更新版本和 zip。Windows 构建使用 PowerShell。

```sh
npm ci --prefix server
node tools/build.mjs
node server/local.mjs
```

打开 <http://127.0.0.1:4173/>。GitHub Pages 提供静态用户端、示例 CAD 及浏览器加购助手。生成新设计只通过服务端的 OpenAI Responses API。本机和私有 Worker 均须配置 `OPENAI_API_KEY` 以及项目有权使用的模型 ID `OPENAI_MODEL`；缺少任一项，生成按钮显示未连接，设计接口返回 503。本机可使用被 Git 忽略的 `.env.local`，Worker 使用服务端秘密变量。网页不接触密钥。

## 淘宝与项目

安装浏览器助手后，清单中的「去淘宝选规格」可以打开商品或搜索页。在淘宝选好规格，点击扩展图标，标题、链接和选中的规格会带回原项目。这个动作只记录选型。

桌面浏览器助手用当前浏览器已登录的淘宝账号处理勾选的商品。安装入口在结果页的采购区。下载包后解压，在 Chrome 或 Edge 扩展管理页开启开发者模式，加载解压目录，再刷新工作台。扩展会在自己的确认页展示商品、规格和数量。只有淘宝页面出现新加购回执时才报告成功；扫码、验证码、规格不明确或回执不明时由买家接手。最终下单付款始终在淘宝完成。另一条路径是通过获准的淘宝开放平台应用生成[官方加购链接](https://developer.alibaba.com/docs/api.htm?apiId=40701&source=search)。

未登录时，「我的项目」保存在当前浏览器。淘宝账号登录需应用的 App Key、App Secret、已登记的回调地址和账户数据库。本机使用 SQLite，私有 Worker 使用 D1。服务器用淘宝返回的账号标识隔离项目；本机与云端为不同的项目库。参见[私有部署与淘宝授权](server/private-deployment.md)。

工程模型的来源与使用方式见[硬件模型目录](docs/hardware-models.md)、[ForgeCAD 模型及尺寸](forge/README.md)、[本机重新计算](docs/local-forge.md)和[采购件 CAD 与装配包](docs/purchased-cad.md)。
