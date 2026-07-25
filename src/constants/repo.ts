// ============================================
// GitHub 仓库相关常量
//
// TODO(发布前必改): 将 GITHUB_REPO 替换为你自己的 GitHub 仓库地址。
// 用途：
//   1. 应用内「检查更新」（Releases API）
//   2. CI 自动发布（.github/workflows/release.yml 打 tag 后上传 DMG 到 Release）
// ============================================

export const GITHUB_REPO = 'OWNER/pi-opencode-ui'

export const REPO_URL = `https://github.com/${GITHUB_REPO}`
export const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
export const RELEASES_PAGE_URL = `${REPO_URL}/releases/latest`
