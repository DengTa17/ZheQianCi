# 折千词

> 千词可折，一词一心

折千词是一款浏览器端背单词工具。打开网站即可使用，学习数据保存在当前浏览器本地。

## 功能

- 手动导入与智谱 GLM-OCR 拍照识别
- DeepSeek 批量解析、释义与例句补全
- 在线词典、国内可用发音、学习与复习
- 电子书式翻页遮挡、主题与难度设置
- 自定义 OpenAI 兼容模型

## Cloudflare Pages 部署

仓库根目录的 `index.html` 是应用首页，`functions/api` 提供同域 AI 代理。

Cloudflare Pages 配置：

- Framework preset：`None`
- Build command：留空
- Build output directory：`.`
- Root directory：留空（仓库根目录）

在项目的 `Settings > Variables and Secrets` 中添加并加密：

- `ZHIPU_API_KEY`
- `DEEPSEEK_API_KEY`

可选变量 `AI_ENABLED=false` 可以紧急暂停全部内置 AI 请求。

API Key 仅存在 Cloudflare Secrets 中，不得写入仓库、`.env` 或 `.dev.vars` 后提交。

## 本地数据

学习记录保存在浏览器本地。清理浏览器数据或更换设备前，请先使用应用内的导出备份功能。
