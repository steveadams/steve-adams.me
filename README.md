# steve-adams.me

A personal site built on Vitepress.

## Hosting

- Hosted on Deno Deploy (static `dist/` from `pnpm build`).
- Cloudflare fronts the origin and handles edge redirects.

## Cloudflare redirect rules
### Otherwise I'll forget

- `/resume` → `/resume.html` (301, query string preserved).
  Configured in Cloudflare dashboard → Rules → Redirect Rules.
