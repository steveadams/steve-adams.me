---
title: Archive
description: All blog posts
---

<script setup>
import { data as posts } from './posts.data.js'

function formatDate(date) {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

// Group posts by year
const postsByYear = posts.reduce((acc, post) => {
  const year = new Date(post.frontmatter.date).getFullYear()
  if (!acc[year]) acc[year] = []
  acc[year].push(post)
  return acc
}, {})

const sortedYears = Object.keys(postsByYear).sort((a, b) => b - a)
</script>

# Archive

<div v-for="year in sortedYears" :key="year" class="year-section">
  <h2 :id="year.toString().toLowerCase()">{{ year }}</h2>
  
  <div class="posts-list">
    <article v-for="post in postsByYear[year]" :key="post.url" class="post-item">
      <time class="post-date">{{ formatDate(post.frontmatter.date) }}</time>
      <div class="post-content">
        <h3 class="post-title">
          <a :href="post.url">{{ post.frontmatter.title }}</a>
        </h3>
        <p v-if="post.frontmatter.description" class="post-description">
          {{ post.frontmatter.description }}
        </p>
      </div>
    </article>
  </div>
</div>

<style scoped>
.year-section {
  margin-bottom: 3rem;
}

.year-section h2 {
  color: var(--vp-c-brand-1);
  border-bottom: 1px solid var(--vp-c-divider);
  padding-bottom: 0.5rem;
  margin-bottom: 1.5rem;
}

.posts-list {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.post-item {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 1rem;
  align-items: start;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--vp-c-divider-light);
}

@media (max-width: 768px) {
  .post-item {
    grid-template-columns: 1fr;
    gap: 0.5rem;
  }
}

.post-date {
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  white-space: nowrap;
}

.post-content {
  min-width: 0;
}

.post-title {
  margin: 0 0 0.5rem 0;
  font-size: 1.1rem;
  line-height: 1.4;
}

.post-title a {
  color: var(--vp-c-text-1);
  text-decoration: none;
}

.post-title a:hover {
  color: var(--vp-c-brand-1);
}

.post-description {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  line-height: 1.5;
}
</style>
