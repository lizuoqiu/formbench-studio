# Formwork 硬件设计

[打开用户端](https://lizuoqiu.github.io/formbench-studio/)。输入需求即可生成零件清单和按尺寸计算的外壳概念 CAD。结果页支持开盖、修改零件尺寸、导出底壳和上盖 STL、查看有来源的淘宝商品候选及按型号搜索。默认首页面向采购者，工程与装配工具仍可从[工程工作台](https://lizuoqiu.github.io/formbench-studio/workbench.html#overview)打开。

## 分享项目与建模依据

首页的「工作室精选」可以直接打开某一版设计、查看 BOM 与装配、下载 CAD，也可以保存个人副本继续修改。[打开阅读计时器](https://lizuoqiu.github.io/formbench-studio/?share=reading-timer)。

新建和修改设计共用 [硬件建模 skill](server/skills/interaction-hardware/SKILL.md)。它按具体型号和版本匹配参考 CAD，结合供应商提供的机械尺寸、用户指定尺寸和可选参考图生成独立零件，并把它们放到装配坐标中。模型响应记录所用的 skill 版本。结果页的「零件与尺寸依据」可以查看采购件采用的资料、估算范围和安装位置。每个分享版本的核验说明记录实际检查过的内容。

对于已封装的主控，逐件查证会把原厂资料里能核对到具体型号的触屏、显示屏或时钟关联到该零件。同一块触屏可以有多个操作。单独连接的传感器、驱动器和电源仍按实际接线检查。

## 在本机运行

使用 Node 22.13 或更新版本和 zip。Windows 构建使用 PowerShell。

```sh
npm ci --prefix server
npm ci --prefix tools
node tools/build.mjs
node server/local.mjs
```

打开 <http://127.0.0.1:4173/>。GitHub Pages 提供静态用户端、示例 CAD 及浏览器加购助手。Mac 本机默认先用 OpenAI API，所有配置密钥均明确用尽额度才切换到本机 Codex；两者均用尽即停止。用 `FORMBENCH_ALLOW_LOCAL_CODEX=1` 启用本机接力；增加 `FORMBENCH_DEBUG=1` 可在终端与本机日志中跟踪进度。在高级选项也可以指定只用其中一种。私有 Worker 只能运行 API，需配置密钥和 `OPENAI_MODEL`。本机使用被 Git 忽略的 `.env.local`，Worker 使用服务端秘密变量。网页不接触密钥。

保留主密钥 `OPENAI_API_KEY`，备用密钥依次写入 `OPENAI_API_KEY_2`、`OPENAI_API_KEY_3` 等。当前密钥明确耗尽余额、达到组织/项目支出上限或组织用量上限时，后台自动用下一把不同密钥重试当前步骤；HTTP 和生成中的流式错误都支持切换。成功后继续使用可用密钥，本机运行期间跳过已耗尽项。普通速率限制、网络、鉴权或模型权限错误不触发额度切换。所有备用密钥使用同一个 `OPENAI_MODEL` 和 `OPENAI_REASONING_EFFORT`；当前本机设为 `gpt-6.2-sol` / `max`。同组织的密钥仍共享该组织的余额或上限。

修改 `.env.local` 后重启本机服务加载配置。在自动模式下，所有 API 密钥明确达到额度上限后会交给已启用的本机 Codex；本机 Codex 也达到额度上限时才保存进度并停止。仅 API 模式在所有密钥达到上限时停止。恢复额度后用原任务的“继续”重新检查；本机重启会重建密钥状态。密钥仅用于服务端请求，任务、日志和前端不保存明文；切换日志只记录配置项名称。Cloudflare 的切换在请求内执行，不能据此声称已部署本机的持久任务。

本机 Codex 首次查零件资料默认使用 `gpt-6.2-sol` 的 `medium` 推理。可用 `FORMBENCH_LOCAL_CODEX_LOOKUP_MODEL` 和 `FORMBENCH_LOCAL_CODEX_LOOKUP_EFFORT` 配置这一步，例如本机账号已提供的 `gpt-6-luna` 和 `medium`。关键接口复核、建模、整机设计和评审沿用主模型及其推理档位。调试日志记录每次实际使用的模型、档位和耗时。

## 在本机查看机构运动

打开有活动关节的项目，在装配视图中拖动关节，旁边可查看父关节、初始轴向和限位，展开可见固定端和随动实体。在「零件 CAD 文件 → 运动学 URDF」下载 ZIP，其中包含关节描述和可用的零位网格。

要查看 RobotCAD 或 ROS 导出的机构，在「工程工作台 → 文件 → 查看本地 URDF…」选择展开后的 URDF。这个入口在浏览器本地加载连杆骨架，可逐轴操作并读出位置。项目自身带外壳和硬件的装配仍在项目 CAD 视图查看。

## 淘宝与项目

安装浏览器助手后，清单中的「去淘宝选规格」可以打开商品或搜索页。在淘宝选好规格，点击扩展图标，标题、链接和选中的规格会带回原项目。这个动作只记录选型。

桌面浏览器助手用当前浏览器已登录的淘宝账号处理勾选的商品。安装入口在结果页的采购区。下载包后解压，在 Chrome 或 Edge 扩展管理页开启开发者模式，加载解压目录，再刷新工作台。扩展会在自己的确认页展示商品、规格和数量。只有淘宝页面出现新加购回执时才报告成功；扫码、验证码、规格不明确或回执不明时由买家接手。最终下单付款始终在淘宝完成。另一条路径是通过获准的淘宝开放平台应用生成[官方加购链接](https://developer.alibaba.com/docs/api.htm?apiId=40701&source=search)。

未登录时，「我的项目」保存在当前浏览器。淘宝账号登录需应用的 App Key、App Secret、已登记的回调地址和账户数据库。本机使用 SQLite，私有 Worker 使用 D1。服务器用淘宝返回的账号标识隔离项目；本机与云端为不同的项目库。参见[私有部署与淘宝授权](server/private-deployment.md)。

工程模型的来源与使用方式见[硬件模型目录](docs/hardware-models.md)、[ForgeCAD 模型及尺寸](forge/README.md)、[本机重新计算](docs/local-forge.md)和[采购件 CAD 与装配包](docs/purchased-cad.md)。
