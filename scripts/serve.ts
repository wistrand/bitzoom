const port = parseInt(Deno.env.get("PORT") || "8000");

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "application/javascript",
  css: "text/css",
  json: "application/json",
  edges: "text/plain; charset=utf-8",
  labels: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  gz: "application/gzip",
  md: "text/plain; charset=utf-8",
};

const NO_CACHE = {
  "cache-control": "no-cache, no-store, must-revalidate",
  "pragma": "no-cache",
  "expires": "0",
};

// Map URL paths to filesystem directories.
// /data/* serves from ./data/, everything else from ./docs/
function resolve(pathname: string): string {
  if (pathname === "/") return "docs/index.html";
  const clean = pathname.replace(/^\/+/, "");
  if (clean.startsWith("data/")) return clean;
  return `docs/${clean}`;
}

Deno.serve({ port }, async (req: Request) => {
  const url = new URL(req.url);
  const filePath = resolve(url.pathname);
  try {
    const file = await Deno.open(filePath, { read: true });
    const ext = filePath.split(".").pop() || "";
    return new Response(file.readable, {
      headers: {
        "content-type": MIME[ext] || "application/octet-stream",
        ...NO_CACHE,
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
});
