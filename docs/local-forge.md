# 在本机用 ForgeCAD 生成整机与零件

## 需求生成的装配体

本工作台的研究原型使用官方 `forgecad@0.8.2`。下列命令安装该版本，并在本机启用真实的实体计算。

```sh
npm install --prefix "$HOME/.formbench/tools/forgecad-research-0.8.2" forgecad@0.8.2 --legacy-peer-deps
export FORGECAD_BIN="$HOME/.formbench/tools/forgecad-research-0.8.2/node_modules/.bin/forgecad"
export FORGECAD_RESEARCH_AUTOMATION=true
node tools/build.mjs
node server/local.mjs
```

打开 [本机碰拳示例](http://127.0.0.1:4173/?example=fist)。工作台把毫米尺寸、布尔运算、装配位置和运动参数写成 ForgeCAD 程序，再调用 CLI 为每个实体导出 STL。结果页显示实际执行的引擎，并提供整机源文件。拖动行程滑块可以查看固定零件与活动零件的相对位置。替换零件尺寸后，原先的安装位置需要重新设计。

本研究配置运行在回环地址。0.8.2 的使用范围见[该版本随包发布的许可](https://unpkg.com/forgecad@0.8.2/LICENSE)。静态站点可以加载随示例保存的 ForgeCAD 计算结果。编辑结构后，静态页面会显示此次预览实际使用的引擎。

`FORGECAD_RESEARCH_AUTOMATION` 是本工作台自己的配置开关。此路径依据固定版本 0.8.2 随包许可证对非生产用途的授权，在本地执行基础 `export stl`；不需要 ForgeCAD Pro，也不消耗 ForgeCAD 云端 credits。生成新设计时使用的模型 API 另行计费。后续升级 ForgeCAD 或把计算作为对外服务时，要按对应版本和用途重新核对[官方套餐](https://forgecad.io/pricing)。0.8.2 自带命令手册把 `render hq`（用 Blender Cycles 材质、灯光生成一张图）和 `export urdf` 列为 Pro 命令；本流程都不调用。FreeCAD 是另行验证过的本地 STEP 和实体检查工具，不是此配置的默认建模引擎。

## 在模型上试用交互

在有运动定义的项目中，关节详情列出父连杆 → 子连杆、关节坐标系中的轴向、角度或直线行程范围，以及对应的活动部件。工作台从同一份结构导出机器人描述文件（URDF）。要查看外部机器人的连杆关系，在本机工作台选「文件 → 查看本地 URDF…」。此入口展示可操作的关节骨架，不会自动寻找外部文件引用的网格。

2026-11-25 实测：默认后端用 ForgeCAD 0.8.2 生成了一个 12 × 10 × 8 mm 的带方孔测试件，实体体积为预期的 832 mm³。另用 ROS 的公开机器人文件在浏览器读取 16 条连杆、15 个关节；沿 X 轴拖动夹爪滑轨约 190 mm，末端实测移动相同距离，复位后回到原坐标。上述结果验证的是几何和运动关系，不代表电机能带动实物。

有交互定义的项目可以在工作台直接操作模型。拖动旋钮改变角度，按住按钮观察轴向行程，释放后观察屏幕或灯的反馈。空白区域用于转动视角。「交互原理」列出控制器、输入输出及引脚，点击「在模型中查看控制板」可以定位其装配位置。旧项目只展示该版本已经定义的功能。

「内部」显示主控板与器件的安装位置。在「参考走线」中选一条连接，可沿参考导线查看两端的引脚。USB 线缆在接口处配接。缺少端子位置的记录会单独列出。项目页的「ForgeCAD 工程」包含整机和已定位的参考线。用到外部模型的工程打包成 ZIP，解压后用 ForgeCAD 打开 `main.forge.js`；只依赖内建几何的工程可直接打开 `.forge.js`。

打开整机工程后，可在 ForgeCAD Studio 的 View 面板操作原生关节滑杆和播放动作。工作台把转动输出为 `addRevolute`，把按压与滑动输出为 `addPrismatic`，共用活动件的动作组合到装配坐标系中。0.8.2 的 CLI 与 Studio 已用同一组转动、按压关节验证。ForgeCAD 官方也提供可播放的装配案例和用于连接设计代理的 MCP 服务。本项目用本机 CLI 编译整机。托管 MCP 的项目配置见下文。[装配 API](https://forgecad.io/docs/assembly) · [原生交互演示](https://forgecad.io/) · [MCP 接入文档](https://forgecad.io/docs/ai-agents)

网页借用现有 CAD 视图的拾取结果，把使用者操作映射到指定实体，再用 XState 驱动设备状态和反馈。例如，旋钮转一格可以加一分钟，按下可以在运行与暂停之间切换。两种作用由每个项目自己的交互定义决定。需要验证程序如何处理真实引脚信号时，可另用 Wokwi 等电路与固件仿真工具；其编码器有独立的 A/B 相和按压输入。[XState](https://github.com/statelyai/xstate) · [Wokwi 编码器](https://docs.wokwi.com/parts/wokwi-ky-040)

生成和修改均使用[功能复核 skill](../server/skills/functional-review/SKILL.md)。复核包括 BOM 和 CAD 实体绑定、可检查姿态的几何相交、状态事件重放，以及独立模型对用户意图和实现的审阅。发现阻断问题时，生成器会带着具体问题修订并复查。公差、手感和真实通电结果需要样机测试。

## 既有的 Pico 模板

在自己的电脑按 ForgeCAD 的适用许可安装 `npm install -g forgecad@0.13.0 --legacy-peer-deps`，确认 `forgecad --version` 可用。若 CLI 没有加入 PATH，可将 `FORGECAD_BIN` 设置为其可执行文件的绝对路径。工作台不分发 ForgeCAD 运行时。执行 `node tools/build.mjs` 和 `node server/local.mjs`，打开 `http://127.0.0.1:4173/#mechanical`。

本机接口 `POST /api/forge` 接受 JSON，例如 `{"part":"lid","w":76,"d":32,"h":17}`，回传二进制 STL。`w`、`d`、`h` 分别为长度（62–100 mm）、宽度（29–64 mm）和底座高度（15–42 mm）；只可选择本项目的 `base`、`lid` 模板。此接口不涉及账户或 API key，不接收外部程序、脚本或源文件，也不在 GitHub Pages 中运行。打印与实际装配需另行验证。

## 让工作台的设计模型调用托管 MCP

[官方文档具名工具与实测入口](forgecad-mcp-reference.md)列出建模、机构、纹理和导出的用途、访问条件与计费。授权后可运行 `node --env-file=.env.local tools/check-forge-mcp.mjs` 获取本账号的目录。

系统管理员先从本机接口 `POST /api/forge/mcp` 发送 `{"operation":"inventory"}`，查看当前账户可用的工具名称、参数结构和只读标注。首次使用可打开工作台「文件 → 连接 ForgeCAD」，在官方页面给本机 Formbench 授权。返回后会显示当次目录，后端能复用和续期。命令行入口为 `node tools/auth-forge-mcp.mjs`。无浏览器的服务也可用 ForgeCAD Connected agents 签发的 `FORGECAD_MCP_ACCESS_TOKEN`。模型调用通过现有 OpenAI Responses API 执行，服务端用发现的 MCP schema 创建函数工具，实际调用 ForgeCAD 后将文本、结构化数据或预览图返回给模型。单件建模、整机生成、增量修订、修复计划和设计审阅都支持这个循环。每个阶段最多派发八次工具调用，最终设计仍经过工作台的本机编译与验证。

后端的 `FORMBENCH_FORGE_MCP_WORKFLOW` 接受一行 JSON。官方建议先读取 `main.usda` 确认入口，在已选草稿中修订现有入口文件。下面演示用已有草稿的 `main.forge.js` 对接一个已有工作台任务。将 `FORMBENCH_FORGE_MCP_JOB_ID` 设为该任务 ID。例子的输入字段已与 2026-11-24 的线上目录核对。目录明确文件版本为字符串，但没有提供读取结果的输出 schema。`resultPath` 暂以 `revision` 示意，应以草稿的一次真实只读返回核定。草稿可见性随所在项目，配置前先确认将工作内容写到该项目符合预期。[线上工具目录](validation/2026-11-24-forge-mcp-catalog.json) · [ForgeCAD 官方工作流](https://forgecad.io/docs-raw/AI/agents.md)

```json
{
  "project": "<沙箱项目 ID>",
  "draftId": "<此任务专属的现有草稿 ID>",
  "publicReadTools": ["read_docs", "search_docs"],
  "readTools": {
    "read_interface": {"projectId": "<沙箱项目 ID>", "versionId": "<已有构建的版本 ID>"},
    "read_evidence": {"projectId": "<沙箱项目 ID>", "draftId": "<此任务专属的现有草稿 ID>"}
  },
  "sandboxFiles": [{
    "name": "write_file",
    "projectField": "projectId",
    "draftField": "draftId",
    "pathField": "path",
    "contentField": "content",
    "bind": {"projectId": "<沙箱项目 ID>", "draftId": "<此任务专属的现有草稿 ID>", "path": "main.forge.js"},
    "revision": {"readTool": "read_file", "argument": "revision", "resultPath": "revision"}
  }]
}
```

- 模型先读取绑定文件的源码及 revision，随后提交新源码。后端把这次读取的版本传给写工具。发生冲突时，模型须重新读取并根据新内容调整。工作台在任务记录中保存最后一次读写的文件版本。工具返回嵌套结构时，`resultPath` 可以填写实际字段路径，例如 `file.revision`。
- `read_interface` 读取指定版本已有 Build 中的参数、端口、零件、关节和尺寸；`read_evidence` 读取已有故障、附件和修复记录。只需要读取时，保留 `readTools` 和所需的文档工具，省略 `sandboxFiles`。`study_motion` 运行模型声明的单关节运动研究并按云端运行时间计费，未包含在上述配置中。
- 此文件适配器用 `write_file` 默认的 `action=write` 提交修改后的完整源码。官方 `edit_file` 需要同一文件及版本，再传入唯一匹配的 `oldText` 和 `newText`。当前动态文件编辑入口只开放一个内容字段，直接调用 MCP 接口可使用官方的双字段局部编辑。超过 1 MiB 的文本，官方 `read_file` 返回下载链接，普通文本读写循环仅覆盖可直接读取源码的文件。
- `publicReadTools` 可开放公共文档查询。对某个特定项目或草稿的读取，可用 `readTools` 按工具名固定其项目、草稿或版本等参数。读取类工具应具有 `readOnlyHint: true`。缺少标注时仅采信官方明确描述的 `read_docs`、`search_docs`、`read_file`，仍须显式配置。检查和导出等可能消耗云端额度，可用固定参数与预算单独配置。
- 批量新建任务时，可用 `FORMBENCH_FORGE_MCP_DEFAULT_PROJECT` 保存新任务默认的项目，也可只在一个 `POST /api/design-jobs` 请求中指定 `forgeProject`。公共资料和受限的项目查询可直接用于这种方式。需要对多个任务分别写入不同的辅助文件时，路径可使用 `{jobId}`；使用 `{model}` 时，每个独立建模的采购件也会取得单独文件名。官方根入口应使用上面绑定专属草稿的方式。
- 对单个任务，`approvedCalls` 可给出准确的操作，条目形式为 `{"name":"<实际工具名>","arguments":{…},"label":"用途"}`。每条固定操作供该任务按需执行一次。沙箱写入和固定操作仅对建模、生成和修订阶段开放。写入结果未知时，程序保留已派发记录，防止重复写入。

结构化结果的 `forgeMcp.calls` 记录此轮实际尝试的工具与结果状态。空列表表示模型未调用工具。该配置作用于本机持久设计任务的 API 后端。此前为特定任务选择的 Codex 应急接力仍按原配置运行。[ForgeCAD 的 AI 接入说明](https://forgecad.io/docs/ai-agents)
