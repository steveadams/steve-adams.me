import { createContentLoader } from 'vitepress'

export default createContentLoader('posts/*.md', {
  includeSrc: false,
  render: false,
  excerpt: false,
  transform(rawData) {
    // Filter out non-post pages
    const posts = rawData
      .filter((page) => {
        const excludePages = ['index.md', 'about.md', 'archive.md', 'markdown-examples.md', 'api-examples.md']
        const filename = page.url.split('/').pop() + '.md'
        return !excludePages.includes(filename) && page.frontmatter.date
      })
      .sort((a, b) => {
        return new Date(b.frontmatter.date).getTime() - new Date(a.frontmatter.date).getTime()
      })

    // Get recent posts (last 5)
    const recentPosts = posts.slice(0, 5).map(post => ({
      text: post.frontmatter.title,
      link: post.url
    }))

    // Group posts by year for archive links
    const postsByYear = posts.reduce((acc, post) => {
      const year = new Date(post.frontmatter.date).getFullYear()
      if (!acc[year]) acc[year] = 0
      acc[year]++
      return acc
    }, {})

    const archiveLinks = Object.keys(postsByYear)
      .sort((a, b) => b - a)
      .map(year => ({
        text: `${year} (${postsByYear[year]})`,
        link: `/archive#${year}`
      }))

    return {
      recentPosts,
      archiveLinks
    }
  }
})