// Renders resources/icon.svg into resources/icon.ico (16–256 px) and icon.png using Electron itself.
// Run: pnpm icon
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const res = path.join(__dirname, "..", "resources");

async function render(svg, size = 1024) {
  const win = new BrowserWindow({ width: size, height: size, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(1);
  const html = `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${size}" height="${size}"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  return image;
}

// ICO with PNG-compressed entries (supported since Windows Vista).
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((x) => x.png)]);
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(res, "icon.svg"), "utf8");
  const big = await render(svg);
  const png = (size) => big.resize({ width: size, height: size, quality: "best" }).toPNG();
  fs.writeFileSync(path.join(res, "icon.ico"), ico(SIZES.map((size) => ({ size, png: png(size) }))));
  fs.writeFileSync(path.join(res, "icon.png"), png(512));
  app.quit();
});
