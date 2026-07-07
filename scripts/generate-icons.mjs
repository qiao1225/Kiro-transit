import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const BUILD_DIR = path.join(ROOT, "build");
const ASSETS_DIR = path.join(ROOT, "desktop", "assets");

app.whenReady().then(() => {
  const pngPath = path.join(BUILD_DIR, "icon.png");
  
  if (!fs.existsSync(pngPath)) {
    console.error(`未找到应用图标源文件: ${pngPath}，请确保该文件已存在于项目目录中。`);
    process.exit(1);
  }

  // 1. 将现有的 PNG 图标编译为 macOS 原生 ICNS 图标
  if (process.platform === "darwin") {
    try {
      console.log("正在将 icon.png 编译为 macOS 原生 icon.icns...");
      const iconsetDir = path.join(BUILD_DIR, "icon.iconset");
      fs.mkdirSync(iconsetDir, { recursive: true });
      
      const sipsCommands = [
        `sips -z 16 16     ${pngPath} --out ${path.join(iconsetDir, "icon_16x16.png")}`,
        `sips -z 32 32     ${pngPath} --out ${path.join(iconsetDir, "icon_16x16@2x.png")}`,
        `sips -z 32 32     ${pngPath} --out ${path.join(iconsetDir, "icon_32x32.png")}`,
        `sips -z 64 64     ${pngPath} --out ${path.join(iconsetDir, "icon_32x32@2x.png")}`,
        `sips -z 128 128   ${pngPath} --out ${path.join(iconsetDir, "icon_128x128.png")}`,
        `sips -z 256 256   ${pngPath} --out ${path.join(iconsetDir, "icon_128x128@2x.png")}`,
        `sips -z 256 256   ${pngPath} --out ${path.join(iconsetDir, "icon_256x256.png")}`,
        `sips -z 512 512   ${pngPath} --out ${path.join(iconsetDir, "icon_256x256@2x.png")}`,
        `sips -z 512 512   ${pngPath} --out ${path.join(iconsetDir, "icon_512x512.png")}`,
        `sips -z 1024 1024 ${pngPath} --out ${path.join(iconsetDir, "icon_512x512@2x.png")}`
      ];
      
      sipsCommands.forEach(cmd => execSync(cmd));
      execSync(`iconutil -c icns ${iconsetDir} -o ${path.join(BUILD_DIR, "icon.icns")}`);
      execSync(`rm -rf ${iconsetDir}`);
      console.log("macOS 应用图标编译成功：build/icon.icns");
    } catch (err) {
      console.error("编译 icns 图标时出错:", err);
    }
  }

  // 2. 托盘 (Tray) 小图标
  // 说明：Electron 的 nativeImage 不支持直接栅格化 SVG（createFromBuffer 只认
  // PNG/JPEG 等已编码位图），早期用 SVG 生成会得到空文件。托盘模板图标已作为
  // 静态资源提交在 desktop/assets/trayTemplate.png 与 @2x（黑色 K，模板图，
  // 自动适配菜单栏明暗），无需在此运行时生成。
  const trayPng = path.join(ASSETS_DIR, "trayTemplate.png");
  if (fs.existsSync(trayPng) && fs.statSync(trayPng).size > 0) {
    console.log("托盘小图标已就绪（静态模板资源）：desktop/assets/trayTemplate.png / @2x");
  } else {
    console.warn("警告：未找到有效的托盘图标 desktop/assets/trayTemplate.png，请补充该静态资源。");
  }

  app.quit();
}).catch((err) => {
  console.error("生成图标时出错:", err);
  process.exit(1);
});
