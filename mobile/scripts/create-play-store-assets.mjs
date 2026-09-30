import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const source = path.join(root, "mobile", "assets", "icon.png");
const logoSource = path.join(root, "public", "brand", "v1", "okri-logo.svg");
const outputDir = path.join(root, "mobile", "release", "store-assets", "android");
const output = path.join(outputDir, "icon-512.png");
const featureGraphic = path.join(outputDir, "feature-graphic-1024x500.png");

await mkdir(outputDir, { recursive: true });
await sharp(source)
  .resize(512, 512, { fit: "cover" })
  .flatten({ background: "#101010" })
  .png({ compressionLevel: 9 })
  .toFile(output);

const logo = await sharp(await readFile(logoSource))
  .resize({ width: 700, height: 200, fit: "inside" })
  .png()
  .toBuffer();

await sharp({
  create: {
    width: 1024,
    height: 500,
    channels: 3,
    background: "#ffffff",
  },
})
  .composite([{ input: logo, gravity: "center" }])
  .png({ compressionLevel: 9 })
  .toFile(featureGraphic);

console.log([output, featureGraphic].join("\n"));
