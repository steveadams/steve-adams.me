import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const postsDir = path.join(__dirname, '../src')

function getAllPosts() {
  const files = fs.readdirSync(postsDir).filter(file => file.endsWith('.md'))
  const posts = []

  for (const file of files) {
    // Skip non-post files
    const excludeFiles = ['index.md', 'about.md', 'archive.md', 'work-with-me.md', 'resume.md', 'markdown-examples.md', 'api-examples.md']
    if (excludeFiles.includes(file)) continue

    const filePath = path.join(postsDir, file)
    const content = fs.readFileSync(filePath, 'utf-8')
    
    // Extract frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
    if (!frontmatterMatch) continue

    const frontmatterStr = frontmatterMatch[1]
    const frontmatter = {}
    
    // Simple frontmatter parser
    frontmatterStr.split('\n').forEach(line => {
      const match = line.match(/^(\w+):\s*"?([^"]*)"?$/)
      if (match) {
        frontmatter[match[1]] = match[2]
      }
    })

    if (frontmatter.date && frontmatter.title) {
      posts.push({
        title: frontmatter.title,
        date: frontmatter.date,
        url: `/${file.replace('.md', '')}`
      })
    }
  }

  return posts.sort((a, b) => new Date(b.date) - new Date(a.date))
}

export function generateSidebar() {
  const posts = getAllPosts()
  
  // All posts in one list
  const allPosts = posts.map(post => ({
    text: post.title,
    link: post.url
  }))

  return [
    {
      text: "Posts",
      items: allPosts
    }
  ]
}