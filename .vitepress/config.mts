import { defineConfig } from "vitepress";
import { generateSidebar } from "./generateSidebar.js";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  srcDir: "src",

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
    }]
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
    ],
  },
  
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
