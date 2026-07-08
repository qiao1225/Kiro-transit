# 安装包(Apple Silicon / M 芯片)

由于上传网络对大文件单次传输有限制,`Kiro Desktop Relay 1.0.3` 的 arm64 安装包被拆分为多个分卷(通过 Git LFS 存储)。下载后需要先合并再使用。

## 合并分卷

在本目录下执行:

```bash
cat Kiro-Desktop-Relay-1.0.3-arm64.dmg.part-* > Kiro-Desktop-Relay-1.0.3-arm64.dmg
```

得到完整的 `Kiro-Desktop-Relay-1.0.3-arm64.dmg` 后,双击打开,把 App 拖入「应用程序」即可。首次打开如提示未验证开发者,右键 App → 打开。

## 校验(可选)

```bash
shasum -a 256 Kiro-Desktop-Relay-1.0.3-arm64.dmg
```

> 说明:仓库使用 Git LFS 存储这些分卷,克隆/拉取时需要安装 git-lfs(`git lfs install`)才能获取真实文件。
> 未签名 / 未公证,仅适用于 Apple Silicon (arm64) Mac。

完整 DMG 的 SHA-256:

```
a45716016152b0631ae85f112771909772da7ba24564da162770f60645603ff4
```
