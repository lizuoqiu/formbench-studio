# 零件几何与装配视图

这个模块从明确的需求生成 BOM；发现需求属于上游。这里的模型库回答两个不同的问题：**这个 BOM 条目可以参考哪种零件？这一份参考外壳里面，具体怎么摆？** 前者可以逐件查看，后者只为默认尺寸的 Pico 桌面指示器提供。新项目不继承别的项目的装配坐标。

- **标准件**保留来源、许可和适用规格。一个封装可以描述同尺寸红绿 LED，但不能证明已选中某个商家的 SKU。未知零件留作未匹配。
- **外接附件、柔性件、紧固件**也可以有模型。线长、实际走线、螺钉长度或螺柱配合没有定下时，不能从 BOM 数量推定装配位置。
- **自制零件**（本项目的底壳和上盖）从 ForgeCAD 源码生成。视图的开盖和分解仅改变显示，下载的外壳仍是打印方向、毫米单位的独立实体。
- **装配依据**：默认外壳以底面为 Z=0；板支柱顶面约为 Z=4，四孔中心为 X=5/52、Y=10.3/21.7；两枚 LED 和按钮孔沿 Y=16、分别位于 X=21/33/46。元件展示姿态不代表已设计焊接支架、线束与固件，仍需实物复核。

**一个能直接看到的结构问题：** 在当前布局中，轻触按钮的安装基准为 Z=13.2 mm，模型按头高约 4.3 mm，顶面约 Z=17.5 mm；而盖子外表面为 Z=19 mm。按头低了约 1.5 mm。不能把这个 PCB 按钮当成开孔后就可使用的面板按钮；仍要确定载板支撑、帽子或更长按头，并实测行程。

**供后续设计程序复用：** [模型目录 JSON](https://lizuoqiu.github.io/formbench-studio/hardware-catalog.json) 记录每项的来源、许可与几何地址；[默认装配坐标 JSON](https://lizuoqiu.github.io/formbench-studio/pico-layout.json) 记录毫米单位、上盖翻转及电气元件位置。该姿态只适用于转好的 STL。原始 STEP 的模型坐标可能不同，请按各模型元数据中的坐标说明处理。

## 当前 BOM 的几何覆盖

“10 项”指当前 Pico 参考项目与两个交互示例（含静音/声音分支）合并去重后的十个清单条目。红/绿 LED 为两个不同 BOM 条目，共用一个物理封装。每个目录的 `metadata.json` 是具体几何与出处的记录。

| BOM 项 | 几何来源／选型边界 | 默认 Pico 装配 |
|---|---|---|
| [Raspberry Pi Pico](../assets/hardware/pico/metadata.json) | 初代 RP2040、Micro-B、无排针；参见[厂商资料](https://pip.raspberrypi.com/categories/610-raspberry-pi-pico)。不要与 Pico W、Pico 2 混用。 | 原厂板孔中心与四个支柱中心在数字模型中对齐 |
| [红、绿 5 mm LED](../assets/hardware/led/metadata.json)（两项） | KiCad 直插封装；颜色独立于几何，采购时核对法兰与引脚间距。 | 按上盖两孔定位，各一颗 |
| [轴向电阻](../assets/hardware/resistor/metadata.json) | KiCad DIN0207、脚距 10.16 mm；电阻值不由外观决定。 | 两个，示意摆放 |
| [瞬时按钮](../assets/hardware/button/metadata.json) | KiCad 6 × 6 mm、4.3 mm 高的直插候选；未指定采购料号。 | 按上盖操作孔对齐 |
| [USB 数据线](../assets/hardware/usb-cable/metadata.json) | A 至 Micro-B 整线，两个接头、线身与护套均建模；姿态不代表真实布线。 | 外接附件，仅单件查看 |
| [连接导线](../assets/hardware/wire/metadata.json) | 绝缘层与裸铜端分开；选购长度、线径与走线待定。 | 仅单件查看 |
| [固定螺钉](../assets/hardware/screw/metadata.json) | Innerscene M2×6 的开放 STEP 候选；不代表 6 mm 适配当前柱深。 | 仅单件查看 |
| [门磁开关与磁铁](../assets/hardware/reed/metadata.json) | 参照 Adafruit 375 公开资料独立重建整对壳体，无实物孔距验证。 | 仅在含门磁的 BOM 展示 |
| [有源蜂鸣模块](../assets/hardware/buzzer/metadata.json) | 参照 DFRobot DFR0032 的尺寸图和原理图独立重建整板；5 V 供电，逻辑兼容性需核实。 | 仅在含蜂鸣模块的 BOM 展示 |

## 参考 Blueprint 的范围

Blueprint [官方发布](https://www.linkedin.com/posts/blueprint-hardware_its-official-cad-generation-is-live-in-activity-7493373504600412160-2kfh)确认和 ForgeCAD 合作，为选中的零件生成 STEP、STL 或 GLB。[团队说明](https://www.linkedin.com/posts/sajeelpurewal_blueprintio-now-has-cad-generation-pick-activity-7493382220045307904-RR0F)称使用真实元件数据。我们观察到其公开客户端可以用方块、圆柱显示尚无逐件 CAD 的机械布局，并在取得零件 GLB 后加载该几何。上述资料均不能证明每个模型是原厂文件，也不能确定其具体资料库、训练模型、生成脚本或内部服务。本项目没有再分发其模型。
