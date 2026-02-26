import path from "path";
import { writeFileSync } from "fs";
import { Feed } from "feed";
import { createContentLoader, type SiteConfig } from "vitepress";

const siteUrl = "https://steve-adams.me";

export async function genFeed(config: SiteConfig) {
  const feed = new Feed({
    title: "Steve Adams",
    description: "Software Developer",
    id: siteUrl,
    link: siteUrl,
    language: "en",
    copyright: "Steve Adams",
    feedLinks: {
      rss: `${siteUrl}/feed.xml`,
    },
  });

  const posts = await createContentLoader("*.md", {
    includeSrc: false,
    render: true,
    excerpt: false,
    transform(rawData) {
      const excludePages = [
        "/",
        "/about",
        "/archive",
        "/work-with-me",
        "/resume",
      ];

      return rawData
        .filter((page) => {
          const url = page.url.replace(/\.html$/, "");
          return !excludePages.includes(url) && page.frontmatter.date;
        })
        .sort(
          (a, b) =>
            new Date(b.frontmatter.date).getTime() -
            new Date(a.frontmatter.date).getTime()
        );
    },
  }).load();

  for (const post of posts) {
    const { frontmatter, url, html } = post;
    feed.addItem({
      title: frontmatter.title,
      id: `${siteUrl}${url}`,
      link: `${siteUrl}${url}`,
      description: html ?? "",
      date: new Date(frontmatter.date),
    });
  }

  writeFileSync(path.join(config.outDir, "feed.xml"), feed.rss2());
}
