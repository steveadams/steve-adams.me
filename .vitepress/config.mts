import { defineConfig } from "vitepress";
import { generateSidebar } from "./generateSidebar.js";
import { genFeed } from "./rss.mjs";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  srcDir: "src",

  outDir: "dist",

  title: "Steve Adams",
  description: "Software Developer",

  head: [
    // Mux Player web component
    ['script', { src: 'https://cdn.jsdelivr.net/npm/@mux/mux-player' }],
    // Umami analytics (if you want to add it)
    ['script', {
      defer: '',
      src: 'https://cloud.umami.is/script.js',
      'data-website-id': '4b002139-b9d6-41e6-9479-246b6cdec509'
    }],
    ['link', { rel: 'alternate', type: 'application/rss+xml', title: 'RSS', href: '/feed.xml' }]
  ],
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: "Home", link: "/" },
      { text: "About", link: "/about" },
      { text: "Work With Me", link: "/work-with-me" },
    ],

    sidebar: generateSidebar(),

    outline: {
      level: [2, 4], // Show h2, h3, and h4 in "On this page"
      label: "On this page",
    },

    // Fix chronological navigation for blog posts
    docFooter: {
      prev: 'Newer Post',
      next: 'Older Post'
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/steveadams" },
      { icon: "bluesky", link: "https://bsky.app/profile/steve-adams.me" },
      {
        icon: {
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6.18 15.64a2.18 2.18 0 0 1 2.18 2.18C8.36 19.02 7.38 20 6.18 20C4.98 20 4 19.02 4 17.82a2.18 2.18 0 0 1 2.18-2.18M4 4.44A15.56 15.56 0 0 1 19.56 20h-2.83A12.73 12.73 0 0 0 4 7.27V4.44m0 5.66a9.9 9.9 0 0 1 9.9 9.9h-2.83A7.07 7.07 0 0 0 4 12.93V10.1Z"/></svg>',
        },
        link: "/feed.xml",
      },
    ],
  },

  buildEnd: genFeed,

  markdown: {
    // This will automatically add H1 titles from frontmatter
    attrs: {
      leftDelimiter: '{',
      rightDelimiter: '}'
    }
  },

  vite: {
    // Prevent any web fonts from being bundled
    optimizeDeps: {
      exclude: ['@fontsource/*']
    },
    build: {
      rollupOptions: {
        external: ['@fontsource/*']
      }
    }
  }
});
