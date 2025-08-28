import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const postsDir = path.join(__dirname, '../../../src')

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
      // Estimate reading time (rough calculation)
      const wordCount = content.replace(/^---\n[\s\S]*?\n---/, '').split(/\s+/).length
      const readingTime = Math.max(1, Math.round(wordCount / 200))

      posts.push({
        title: frontmatter.title,
        description: frontmatter.description || '',
        date: frontmatter.date,
        url: `/${file.replace('.md', '')}/`,
        readingTime
      })
    }
  }

  return posts.sort((a, b) => new Date(b.date) - new Date(a.date))
}

export default {
  load() {
    return getAllPosts()
  }
}