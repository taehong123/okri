import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../preview-dist/", import.meta.url));
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".png": "image/png", ".ttf": "font/ttf", ".json": "application/json" };
export function createPreviewServer({ port = 3199, log = false } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const path = resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
      if (!path.startsWith(resolve(root) + sep)) throw new Error("Invalid path");
      const bytes = await readFile(path);
      response.writeHead(200, { "Content-Type": mime[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" }); response.end(bytes);
    } catch { response.writeHead(404); response.end("Not found"); }
  });
  server.listen(port, "127.0.0.1", () => {
    if (log) console.log(`Mocked native UI preview: http://127.0.0.1:${port}`);
  });
  return server;
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const server = createPreviewServer({ log: true });
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 1_000).unref();
  });
}
