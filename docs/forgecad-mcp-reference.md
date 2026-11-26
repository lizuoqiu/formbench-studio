# ForgeCAD 托管 MCP 能力核对

2026-11-24，工作台从已授权的 ForgeCAD MCP 取得 HTTP 200，服务标识为 `forgecad 1.0.0`。实际目录公布 70 个工具，涵盖官方代理指南具名的全部 35 个，另外 35 个包含零件接口、运动研究、文件、库存和缺陷证据等。共 23 个标为只读，47 个标为可能写入、删除或消耗额度。还公布了一个 MCP App 界面资源，未公布 prompts 或资源模板。[完整工具清单及参数](validation/2026-11-24-forge-mcp-catalog.json) · [官方代理指南](https://forgecad.io/docs-raw/AI/agents.md)

## 只读实测

- 9 个工具返回实际结果。`read_docs` 以同一修订号读完全部 5 页，6 份必读文档的 10 个片段均完整。`search_docs` 成功检索关节和 STEP 导入。工作台还成功查询了项目、团队、目录、库存和调用历史。[分页验证记录](validation/2026-11-24-forge-doc-reads.json)
- 账户的项目列表返回 0 项。用官方作品集提供的旋转闸机版本链接实测，`read_interface` 从已保存的构建读出 20 个部件、19 个关节和 39 个端口。`list_uses` 查询成功，关联列表为空。[公开闸机项目](https://forgecad.io/gallery/611946a6-17e9-4372-8006-459acd6abda4)
- 在同一个公开作品上，版本列表、文件列表、证据、保存视图、链接和版本图片 6 项调用均返回 `project_not_found`。其余 8 个只读工具受测试对象、文件、历史版本或团队资料条件所限，此次未运行。已成功读取界面资源 `ui://forgecad/version.html`。测试没有提交云端构建、仿真、渲染或导出，也没有修改或复制项目。[实测结果及各项状态](validation/2026-11-24-forge-mcp-read-results.json)

## 查询可复用的机构

工作台使用已授权账户重新执行 `list_projects({})`，返回 0 项，`truncated=false`。这是 ForgeCAD 为当前身份自动列出的云端项目。本机工作台的 BOM、CAD 和任务历史另行存储。公开作品可从 Gallery 的 Open 按钮取得项目版本链接，再按版本读取。

| 已保存的公开版本 | 免费读取阶段的实测结果 |
| --- | --- |
| [旋转闸机 v3](https://forgecad.io/app/projects/611946a6-17e9-4372-8006-459acd6abda4/dc109de0-6674-4a86-a49f-1041af926391?from=gallery) | 存储的接口包括 20 个部件、39 个端口、16 个固定关节和 3 个转动关节。左右闸门的角限分别为 0…85° 和 −85…0°，可用于判断转向或安装方式。 |
| [气弹簧显示器支臂 v3](https://forgecad.io/app/projects/5b23cf2e-2104-4538-8347-106b7ec2285f/940be88d-7efe-4b65-9b25-63afe192ffbb?from=gallery) | 作品可定位，`read_interface` 返回 `interface_not_built`，该版本没有存储可读接口。此次没有提交新的构建。 |

官方制造指南允许在购买件上记录型号、供应链接、数量规则等，再从装配生成清单。这些字段需要先有对应资料。公开作品的名字和几何外形不足以证明其对应某一原厂商品。以上查询没有启动计费计算，返回结果未附逐次账单。[制造指南](https://forgecad.io/docs-raw/guides/manufacturing.md)

## 官方代理指南具名的 35 个工具

| 使用阶段 | 指南写明的工具名称 | 验证目标 |
|---|---|---|
| 读取项目与文档 | `read_docs`、`search_docs`、`list_projects`、`list_versions`、`list_drafts` | 取齐文档分页，选定项目、基础版本和已知草稿 |
| 创建、修改、合并和保存 | `create_project`、`create_draft`、`merge_draft`、`edit_file`、`write_file`、`save_version` | 修改指定草稿，按受检 revision 留存版本 |
| 构建与比较 | `build_model`、`build_variants`、`check_names`、`compare_versions`、`compare_to_reference` | 验证当前构型及变体、拓扑名稳定性、与旧版或供应商参考件的差异 |
| 机构、制造与仿真 | `check_fit`、`check_assembly`、`check_joint_torque`、`check_strength`、`check_manufacturing`、`read_make_list`、`check_simready` | 分别检查碰撞、装配路径、关节载荷、强度、工艺及仿真输入 |
| 外观与表面 | `view_model`、`check_surfaces`、`paint_model`、`add_surface_detail`、`generate_image_asset` | 观察切面和视角、检查纹理坐标与法线；后三项会写入草稿 |
| 输出与结果 | `export_model`、`export_drawing`、`render_picture`、`render_video`、`get_job`、`get_link`、`read_version_picture` | 导出几何、工程图或渲染，读取异步任务和已有输出 |

这个列表的边界是代理指南明确写出的工具名。账号实际公布的工具、参数、结果类型和协议扩展由认证后的运行时目录决定。公开机构指南提供闭环、负载和锁扣的建模例子，公共作品集可浏览公开模型。现已用官方作品集明确链接的闸机项目核对公开版本的读取范围。[机构示例](https://forgecad.io/docs-raw/modeling/mechanisms.md) · [公共作品](https://forgecad.io/gallery)

## 授权与成本

FormBench 本机后端可用 `node tools/auth-forge-mcp.mjs` 打开浏览器授权，并复用签发给本客户端的登录。无浏览器服务可从 ForgeCAD 账号 Connected agents 页面签发 MCP token，并通过服务端 `FORGECAD_MCP_ACCESS_TOKEN` 提供。单独使用 Codex 客户端时，官方提供 `codex mcp add forgecad --url https://forgecad.io/mcp` 和 `codex mcp login forgecad`。本机 CLI 帮助已确认这两条子命令。授权服务器公开元数据显示支持授权码、S256 和刷新令牌。[代理授权](https://forgecad.io/docs-raw/AI/agents.md) · [OAuth 元数据](https://forgecad.io/.well-known/oauth-authorization-server)

官方按服务器计算时间为检查计费，多数检查为 1–5 credits，单次上限 100。客户端可以设 `maxCredits` 和 `maxDurationSeconds`。模型错误、超时和内存耗尽可能消耗额度；服务端自身故障免计。生成外观、保存版本、创建草稿和可计费检查应在已指定的测试项目、草稿和费用范围内执行。官方写明 Free、Basic、Standard 新建项目默认公开。指南没有列出元数据查询的逐项费率或每分钟请求上限。[代理权限与计费](https://forgecad.io/docs-raw/AI/agents.md) · [托管输出权限与报价](https://forgecad.io/docs-raw/hosted-outputs.md)

## 本地复核

认证后，先执行 `node --env-file=.env.local tools/check-forge-mcp.mjs` 取得当前目录。以下两条命令生成并执行公共文档查询和项目列表样例。给第一条命令附上已有测试项目的 ID 可再验证该项目的版本与草稿列表。

```sh
node --env-file=.env.local server/forge-mcp-read-cases.mjs > /tmp/forge-read-cases.json
node --env-file=.env.local tools/check-forge-mcp.mjs --cases /tmp/forge-read-cases.json
```

第一条命令只请求目录。它用实时 inputSchema 筛选已具名的文档或列表读取，跳过未提供参数、schema 不兼容或被标记会修改数据的工具。第二条命令执行清单里的代表性请求，不包含建模、渲染、导出、写草稿和保存版本。完整文档包已另用真实会话逐页读取并复核。到账单侧的费用对账、云端建模、写入和导出尚未执行。
