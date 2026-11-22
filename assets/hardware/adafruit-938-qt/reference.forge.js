// Adafruit 938 dual STEMMA QT. Millimetres, PCB midpoint at origin, JP2 at +Z and glass facing -Y.
// Groups use the manufacturer STEP geometry, with plated rings from the matching board file.
// Keep these seven STL files alongside this source. The original STEP is also available for B-rep CAD.
return group(
  {name: "四孔 PCB 与八针焊排", shape: importMesh("./pcb.stl").color("#27425c")},
  {name: "OLED 玻璃与屏面", shape: importMesh("./glass.stl").color("#17202b")},
  {name: "OLED 柔性排线", shape: importMesh("./flex.stl").color("#a95a26")},
  {name: "两侧 STEMMA QT 插座", shape: importMesh("./sockets.stl").color("#e2dac7")},
  {name: "稳压器、二极管和电平转换器", shape: importMesh("./ic.stl").color("#35373c")},
  {name: "阻容器件与板载指示灯", shape: importMesh("./passives.stl").color("#94856f")},
  {name: "JP2 与安装孔双面焊环", shape: importMesh("./pads.stl").color("#caa857")}
);
