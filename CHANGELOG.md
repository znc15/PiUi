# Changelog

## [v0.1.0-beta.4] - 2026-07-28 (Pre-release)

- fix: 检测 models.json 自定义 provider，修复已配置却弹「未配置」引导浮层 (32f6da2)

## [v0.1.0-beta.3] - 2026-07-27 (Pre-release)

- fix(desktop): 去掉 bridge 入口脚本路径的 `\\?\` 前缀，修复 Windows 安装版启动崩溃（EISDIR） (92ea122)
- fix(dev): vite 忽略 src-tauri/target，避免 dev 启动与 cargo 并发构建抢锁 EBUSY (1d799bb)

## [v0.1.0-beta.2] - 2026-07-27 (Pre-release)

- fix(desktop): 本地 bridge 请求绕过系统代理，修复 Clash 环境下健康检查 502 (79f157f)
- chore(desktop): 应用 clippy 建议（冗余 into / trim_end_matches 切片） (80df174)

## [v0.1.0-beta.1] - 2026-07-27 (Pre-release)

- chore(ci): 升级 GitHub Actions 至 node24 版本并清理 lint 死代码 (2b3402c)
- fix(ci): 桌面端产物上传路径补上 target 三元组 (0939457)
- fix(android): 移除 fork 遗留的 gen/android 脚手架，CI 按需生成 (7b947a1)
- ci: 四端自动构建流水线（macOS×2 / Windows / Linux / Android） (6ebba25)
- feat(server): 加载 pi 扩展注册的 provider（修复 bailian-tp 不显示） (00b3817)
- fix(desktop): 服务看门狗，bridge 崩溃/外部服务消失后自动恢复 (021f9f6)
- fix(server): 升级 Pi SDK 至 0.82，模型配置刷新真正生效 (798881d)
- ci: 提交自动校验 + macOS 打包，tag 自动发布 Release (06b10e8)
- feat(update): 检查更新改为指向自有仓库（占位常量） (44bf948)
- fix(models): 模型列表支持强制刷新，与 pi 配置实时同步 (511bd4a)
- chore: 移除 OpenCodeUI 遗留文件 (539b4ed)
- fix(desktop): Pi 认证状态改为 Rust 侧直接检测，不再依赖 bridge (eea710f)
- docs: 项目文档（架构 / 开发 / 打包 / MCP 指南） (1a783bb)
- feat(desktop): Tauri 桌面端（bridge 自动启动 / 环境检测 / 窗口管理） (dd53ed2)
- feat(server): Pi bridge 后端（Pi SDK 会话桥接 + MCP 配置管理） (556cec5)
- feat(ui): React 前端界面与状态管理 (d2d227e)
- feat(api): 前端 API 层与类型定义（解耦 @opencode-ai/sdk） (8a930a6)
- chore: 初始化工程脚手架与构建配置 (45e223b)
