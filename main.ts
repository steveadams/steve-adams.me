import { serveDir } from "@std/http";

Deno.serve(async (req) => {
  const pathname = new URL(req.url).pathname;

  // Serve static files
  const response = await serveDir(req, {
    fsRoot: "dist",
    urlRoot: "",
    showDirListing: false,
    enableCors: true,
    quiet: true,
  });

  // For 404s on non-file paths, serve index.html (SPA fallback)
  if (response.status === 404 && !pathname.includes('.')) {
    return serveDir(
      new Request(new URL('/index.html', req.url)),
      {
        fsRoot: "dist",
        quiet: true,
      }
    );
  }

  return response;
});
