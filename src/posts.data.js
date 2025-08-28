import { createContentLoader } from "vitepress";

export default createContentLoader("*.md", {
  includeSrc: false,
  render: false,
  excerpt: false,
  transform(rawData) {
    // Filter out non-post pages and sort by date (newest first)
    return rawData
      .filter((page) => {
        // Exclude index, about, archive pages - only include blog posts
        const excludePages = [
          "index.md",
          "about.md",
          "archive.md",
          "work-with-me.md",
          "resume.md",
        ];
        const filename = page.url.split("/").pop() + ".md";
        return !excludePages.includes(filename) && page.frontmatter.date;
      })
      .sort((a, b) => {
        return (
          new Date(b.frontmatter.date).getTime() -
          new Date(a.frontmatter.date).getTime()
        );
      });
  },
});
