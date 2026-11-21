# 如何把选定型号、CAD 和步骤交给装配者

在「设计总览 → 装配指引」选择「下载示例项目包」，或直接打开仓库中的 [Pico 与门磁示例 JSON](../samples/assembly-example.json)。在同一位置选择「导入项目包」，先检查项目名称、零件数和附件数，再按「替换当前项目」。要保留原项目，可以先导出。项目包随附零件规格、装配步骤、厂家型号和绑定的模型资料，不传递购物车、报价或付款确认。

**按步骤装配。** 示例使用一块初代 Pico 和**一套** Adafruit 375。BOM 的两行门磁分别指安装在盒体的有线侧和安装在盒盖的磁铁侧，采购时不要买两套。用「上一步／下一步」查看操作和这个步骤关联的零件；零件下方显示该型号的安装备注。若更换了型号，原绑定失效，重新核对并绑定后再使用其安装说明。

**核对几何。** 在「机械结构 → 当前清单的零件」选中具体 BOM 行。Pico 可以查看与初代板对应的原厂 R3 模型。门磁厂商只给出每一侧壳体的外包络，本例分别以 **29 × 15.2 × 9 mm** 的长方体表示两侧，没有推算安装孔、支耳或出线位置。包中可选的 `placements` 让收件人查看整机组合；此例仅显示同一台面的试放位置，模型之间的间距不能用作触发距离或开孔依据。

来源：[Raspberry Pi Pico 原厂产品与 STEP 文件入口](https://www.raspberrypi.com/products/raspberry-pi-pico/)、[Pico 数据手册附录 A 的 SC0915 订货码](https://pip-assets.raspberrypi.com/categories/610-raspberry-pi-pico/documents/RP-008307-DS/pico-datasheet.pdf)、[Adafruit 375 单侧尺寸与成套说明](https://www.adafruit.com/product/375)。

## 用自己的零件替换示例

在零件页展开「按选购型号绑定模型」。有制造商或供货商的对应文件时，选对来源，填写具体型号和版本，选择 `.step`、`.stp` 或 `.stl` 文件；STL 按毫米读取。只有规格书或实测尺寸时，可选择长方体或圆柱，填写三个方向的尺寸、来源与安装备注。有图纸依据才添加贯穿 Z 方向的通孔。备注最好回答组装者能现场核对的问题，例如「接口朝哪个方向」「盖合时哪条线不能被夹住」。

确认后，在步骤内勾选用到的零件并导出装配项目包。单个 CAD 文件最多 2 MiB，整个项目包最多 6 MiB；文件直接嵌入 JSON，接收方不需要本机路径。只有型号或商品链接时也能交接 BOM，无须虚构一个尺寸模型。

## 让 AI 或供应商直接编写项目包

以示例 JSON 为模板，保留顶层 `format: "formwork-assembly-project"` 和 `version: 1`：

| 字段 | 写法 |
| --- | --- |
| `design` | `name`、`summary`；`parts` 用 `{name,spec,qty}`；`steps` 是按顺序排列的操作说明字符串。 |
| `items` | 以从 0 开始的 BOM 行号为键，按已有资料写 `manufacturer`、`mpn`、`title`、`sku`、`skuId`、`url`。可用供货商的 HTTPS 产品链接；淘宝的数字 SKU ID 不等于厂商料号。 |
| `cadBindings` | 同样按 BOM 行号关联。已有文件时写 `kind: "manufacturer"` 或 `"supplier"`，提供 `model`、`fileName` 和原始文件字节的 `fileBase64`（不加 data URL 前缀）；可附 `sourceUrl`、`notes`。 |
| 尺寸近似 | 在绑定中写 `kind: "dimensions"`、`model`、`shape`（`box` 或 `cylinder`）、`sizeMm: [长,宽,高]`，并写明来源链接或备注。圆柱的长、宽均为直径。只知道外包络时省略 `holes`。 |
| `assemblyStepParts` | 步骤序号 → BOM 行号数组；两者均从 0 开始。例如 `"0": [1,2]` 表示第一步使用第二、第三行的两个装配件。不知道映射时留空。 |

示例中的 `placements` 是摆位数组，每条含 BOM 行号 `partIndex`、底面中心的世界坐标 `positionMm: [X,Y,Z]` 和欧拉角 `rotationDeg: [X,Y,Z]`。单位分别为毫米和度，世界坐标 Z 向上；依次绕 X、Y、Z 轴旋转。没有现场位置资料时可以省略。

新包无需生成工作台内部的 `partKey`、`purchaseKey` 或 `profile`。工作台导出的既有包会携带原来的绑定标识，用来发现料号或规格变更。能预览模型和打开装配指引，只证明资料可传递；孔位、配合和功能是否符合要求，仍要由装配者按实物记录。
