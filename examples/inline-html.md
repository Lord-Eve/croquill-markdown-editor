# 行内 HTML 渲染验收

前文 <span style="color:red">红色正文和 **粗体语法**</span>。光标进入红字或紧贴标签两端时，这一对标签会显示，红色仍然生效。旁边的 <kbd>Ctrl</kbd> 继续显示为按键框。

正文可混排 <sup>上标</sup>、<sub>下标</sub>、<u>下划线</u>、<ins>插入线</ins>、<s>删除线</s>、<del>删除文本</del>、<mark>高亮</mark>、<b>粗体</b>、<strong>强调粗体</strong>、<i>斜体</i>、<em>强调斜体</em>、<small>小字</small> 和 <a href="https://example.com">网页链接</a>。

嵌套 <b><i>粗斜体</i></b> 和 **<u>加粗下划线</u>**。同一段里有 <kbd>Ctrl</kbd>、==高亮==、[Markdown 链接](https://example.com) 和 <button>原文片段</button>。

带属性的 <br class="x">、<wbr>、<span onclick="void(0)">带事件的标签</span> 和 <!-- 备注：这段原文应可见 --> 都显示原文。普通的第一行<br>第二行仍应显示为换行。

本地图片 <img src="./assets/山景.svg" alt="山景" width="96" height="60"> 显示在行内。点击图片可修改标签。文件缺失时显示灰色源码，例如 <img src="./missing-sample.png" alt="缺失的图片">。

## 标题里的 <span style="color:red">颜色与 **粗体**</span>、<kbd>Ctrl</kbd> 和 <sup>2</sup>

### 标题里的图片 <img src="./assets/山景.svg" alt="山景" width="24">、<!-- 标题备注 -->、<br class="x">

| 位置 | 行内 HTML | 可编辑文字 |
| :--- | --- | ---: |
| 成对标签 | 前<span style="color:blue">单元格文字 **粗体**</span>后 | 修改这里 |
| 按键与上标 | <kbd>Ctrl</kbd> + <sup>2</sup> 和 <u>下划线</u> | 显示样式 |
| 单个标签 | <img src="./assets/山景.svg" width="24">、<br class="x">、<wbr> | 图片和原文片段 |
| 注释 | 前<!-- 表格备注 -->后 | 保留注释 |
| 转义竖线 | <span title="甲\|乙">内文\|原样</span> | 保留反斜杠和竖线 |
| 普通换行 | 第一行<br/>第二行<BR>第三行 | 换行行为不变 |

- 列表项前<span style="color:red">文字 **粗体**</span>后。
- 按键 <kbd>Ctrl</kbd>，上标 <sup>2</sup>，下划线 <u>文字</u>。
- 单标签 <img src="./assets/山景.svg" width="24">、<!-- 列表备注 -->、<br class="x"> 和 <wbr>。

> 引用段落前<span style="color:red">文字 **粗体**</span>后，还有 <kbd>Ctrl</kbd> 和 <sup>2</sup>。
>
> 引用中的单标签 <img src="./assets/山景.svg" width="24">、<!-- 引用备注 -->、<br class="x"> 和 <wbr>。

## 以下仍应整块保护

块级 HTML 应保留整个原文块：

<div>
这里是块级 HTML，<span>不会拆成可编辑段落</span>。
</div>

<table>
<tr><td>块级表格</td></tr>
</table>

<details>
<summary>块级详情</summary>
正文仍作为原文块。
</details>

这个标签没有结束：前<span style="color:red">未闭合，整段保护。

这对标签跨段落：前<kbd>开始。

到另一个段落才结束</kbd>，两个段落仍不能作为行内片段编辑。

| 跨单元格开始 | 跨单元格结束 |
| --- | --- |
| 前<span>开始 | 结束</span>后 |

## 手动验收步骤

1. 检查上半部分的颜色、按键框、图片和原文片段。点进普通元素、嵌套元素和图片，检查光标只展开它碰到的标签。
2. 直接保存，比较原文件字节。分别修改“红色正文”和“单元格文字”中的一个字，保存后逐字节比较。用 CRLF 和带 BOM 的副本复验。
3. 在红色文字内用中文输入法组词。删空一个按键框再输入文字，确认光标保留在两侧标签之间。
4. 在段落里逐字输入 `<kbd>A</kbd>`，检查打完结尾的 `>` 即显示按键框。试用方向键进入两侧标签，再删除一个标签字符，检查剩余源码可编辑。
5. Ctrl+单击网页链接，确认用默认浏览器打开。点击已加载的图片后删除标签中的一字，再撤销。
6. 在两种模式间来回切换，检查标签内外的光标位置。检查大纲和字数，查找 `kbd` 时应能找到标签原文。
