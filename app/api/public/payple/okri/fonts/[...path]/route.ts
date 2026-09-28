const prefix = "/api/public/payple/okri/fonts/";

export async function GET(request: Request) {
  const path = new URL(request.url).pathname.slice(prefix.length);
  if (path !== "pretendardvariable-dynamic-subset.css" && !/^woff2-dynamic-subset\/PretendardVariable\.subset\.\d{1,2}\.woff2$/.test(path)) {
    return new Response(null, { status: 404 });
  }
  // Fixed public font origin only; keep other mamuree services' /fonts untouched.
  const font = await fetch(`https://okri.ai/fonts/pretendard-1.3.9/${path}`, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!font.ok) return new Response(null, { status: 502 });
  return new Response(font.body, { headers: {
    "Content-Type": path.endsWith(".css") ? "text/css; charset=utf-8" : "font/woff2",
    "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff",
  } });
}
