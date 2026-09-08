const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, "..")];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
// Substitute only the web preview entry, never a concurrent native build.
config.resolver.resolveRequest = (context, name, platform) => {
  if (process.env.OKRI_PREVIEW === "1" && platform === "web" && name === "./App"
    && path.resolve(context.originModulePath) === path.resolve(__dirname, "index.ts")) {
    return { type: "sourceFile", filePath: path.resolve(__dirname, "preview/App.tsx") };
  }
  return context.resolveRequest(context, name, platform);
};
module.exports = config;
