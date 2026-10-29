# 长文输入与滚动性能（2026-10-29）

基线为 5071725。使用 examples/private 中唯一的本机样本，105,880 字节、2,434 行（按 LF 分割计数），约 1,070 段、140 个标题、11 个表格、2 个代码块，无图片节点。样本正文和文件名未写入本记录或公开测试，没有修改原件。

## 测量方式

本机 Windows 上的 headless Microsoft Edge，1200 × 850 视口、deviceScaleFactor 1.25，加载实际 main.ts 应用界面及生产 MarkdownSurface。只在临时 Vite transform 中暴露测试句柄，源文件没有性能后门。按键使用真实键盘事件连续输入 24 个 x、间隔 40ms；捕获 keydown 到下一 rAF、serializeRich 耗时及调用次数。滚轮为 32 次、每次 420px、间隔 70ms，先下后上，输入与滚动各重载同一原文。脚本没有把样本传到外网，也没有写入原文件。

滚动同时采集 CDP CPU profile 和 ScriptDuration / LayoutDuration / RecalcStyleDuration；另测“输入一次后立刻持续滚动”，监测其整个时间段的 rAF 帧间隔。rAF 指标是本机 Edge 基准，不等同真实桌面 WebView2 帧率或中文 IME 选词延迟。

## 同脚本前后对比

| 指标 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 输入：keydown 到下一帧中位数 | 608.7ms | 6.4ms |
| 输入：keydown 到下一帧 P95 | 641.8ms | 7.4ms |
| 24 次按键触发的全文序列化次数 | 24 | 1（停手后） |
| 单次全文序列化中位数 | 601.9ms | 656.4ms |
| 输入后持续滚动：最大帧间隔 | 635.2ms | 11.9ms |
| 输入后持续滚动：超过 50ms 的帧间隔 | 2 | 0 |
| 输入后持续滚动期间的全文序列化次数 | 1 | 0 |
| 输入后持续滚动：脚本累计执行时间 | 707.0ms | 12.0ms |
| 纯滚轮：帧间隔 P95 | 6.0ms | 6.0ms |
| 纯滚轮：最大帧间隔 | 6.3ms | 11.8ms |
| 纯滚轮：脚本累计执行时间 | 11.3ms | 9.3ms |

首次独立基线的输入中位数为 753.4ms，序列化为 746.2ms；同脚本复测基线为上表的 608.7 / 601.9ms，反映机器负载和缓存差异。两次均是每键一次全文整理；上表使用完整对照脚本的同场景数据。

## 原因和修复边界

- 输入热路径确实是 getMarkdown → serializeRich 及多次保真解析。现在每键只更新内核文档和待同步修改状态，300ms 停手后统一整理，字数与大纲也随最终 onChange 更新；重新输入时取消旧统计定时器，统计仅解析已同步的 session.text，避免旧定时器绕过防抖强制读取富编辑文档。保存 / 另存为、新建 / 打开、源码切换、关闭确认继续先同步 getMarkdown，不依赖定时器及时执行。
- 纯滚轮的 CPU profile 主要是 idle / program，未观察到 Layout 或 RecalcStyle 累计增长，也没有超过 50ms 的帧间隔。BlockEdit 已关闭；样本没有图片，只有两个代码块，不能把它们直接列为本轮已证实的滚动原因。没有贸然关闭编辑功能或加入可能影响光标定位的内容虚拟化。
- 输入后滚动时，原有同步全文整理会阻塞主线程，出现约 635ms 长帧。现在滚动事件只在已有待同步任务时重置其空闲计时，滚动停止后再整理，干净文档滚动不标脏。
- 单次整理本身仍约 640ms，没有宣称全文解析成本消失。停手和手动保存时仍需执行它；若在这项同步工作开始后输入，仍可能短暂等待。纯滚轮在真实 WebView2 的卡顿尚未由这次 Edge 基准复现。

## 样式与测试配置

分割线原来继承 Crepe 的上下 6px padding，实际高约 12px；清零 padding 后按官方 github.css / night.css 使用 2px，浅色 #e7e7e7、上下 margin16px，Night #474d54、margin24px。有序 label 原来继承浅边框色，空项和普通项现在直接继承正文色 #333 / #b8bfc6，不改任务复选框。

tests/server.ts 统一实际 Vite 测试服务器配置，忽略 .tools、src-tauri 和私人目录监听，仅扫描 tests/harness.html，使用 node_modules/.vite-tests 缓存；所有浏览器测试共用它。vitest.config.ts 默认单 worker、文件不并行并限制测试发现范围，没有提高原超时。新增防抖回归覆盖立即保存 / 关闭 / 源码切换、输入法组合、撤销、跨文档和销毁后的定时器隔离、滚动延期。

原始匿名指标和 CPU profiles 保留在本机 Codex 输出目录 performance：baseline.json、baseline-mixed.json、after-final.json、对应 scroll.cpuprofile。未将原始私人样本或轨迹加入仓库。

## 最终验证与构建

TypeScript 检查通过；不附加任何并发或超时参数的 `npm test` 14 个文件、273 / 273 项全部通过，包含全部往返保真、私人样本以及 11 项防抖同步测试。`build.ps1` 构建成功，exe 本机修改时间为 2026-10-29 02:50:47，晚于最新源码 02:45:30；版本保持 0.2.0。target 约 4.56 GiB，保留缓存。最终日志为 performance/final-tests.log、performance/final-build.log。
