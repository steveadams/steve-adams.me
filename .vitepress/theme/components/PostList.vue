<template>
  <div class="home-container">
    <header class="home-hero">
      <h1 class="home-title">Steve Adams</h1>
      <p class="home-subtitle">Software Developer</p>
    </header>

    <main class="post-list-container">
      <div class="post-list">
        <article v-for="post in postList" :key="post.url" class="post-card">
          <a class="post-link" :href="post.url">
            <div class="post-content">
              <h2 class="post-title">{{ post.title }}</h2>
              <p v-if="post.description" class="post-excerpt">{{ post.description }}</p>
              <footer class="post-meta">
                <time class="post-date" :datetime="post.date">
                  {{ formatDate(post.date) }}
                </time>
                <span v-if="post.readingTime" class="post-reading-time">
                  {{ post.readingTime }} min read
                </span>
              </footer>
            </div>
          </a>
        </article>
      </div>
    </main>
  </div>
</template>

<script setup>
import { data as posts } from '../data/posts.data.js'

function formatDate(dateString) {
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

// Ensure posts is always an array
const postList = Array.isArray(posts) ? posts : []
</script>

<style scoped>
.home-container {
  max-width: 1104px;
  margin: 0 auto;
  padding: 3rem 2rem;
}

.home-hero {
  margin: 0 auto 4rem auto;
  max-width: 752px;
}

.home-title {
  font-size: 3rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin: 0 0 1rem 0;
  line-height: 1.2;
}

.home-subtitle {
  font-size: 1.25rem;
  color: var(--vp-c-text-2);
  margin: 0;
  font-weight: 400;
}

.post-list-container {
  max-width: 752px;
  margin: 0 auto;
}

.post-list {
  display: flex;
  flex-direction: column;
  gap: 4rem;
}

.post-card {
  overflow: hidden;
  background: var(--vp-c-bg);
  opacity: 0.9;
}

.post-link {
  display: block;
  text-decoration: none;
  color: inherit;
}

.post-content {}

.post-title {
  font-size: 2.5rem;
  font-weight: 800;
  margin: 0 0 1rem 0;
  color: var(--vp-c-text-1);
  line-height: 1.3;
}

.post-card:hover {
  opacity: 1;
}

.post-excerpt {
  font-size: 1.25rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  margin: 0 0 1.5rem 0;
  font-style: italic;
}

.post-meta {
  display: flex;
  align-items: center;
  gap: 1rem;
  font-size: 1rem;
  color: var(--vp-c-text-3);
}

.post-date {
  color: var(--vp-c-text-3);
}

.post-reading-time::before {
  content: "•";
  margin-right: 0.5rem;
  color: var(--vp-c-divider);
}

/* VitePress responsive breakpoints */
@media (min-width: 1280px) {
  .home-container {
    max-width: 1104px;
  }
  
  .home-hero {
    max-width: 784px;
  }
  
  .post-list-container {
    max-width: 784px;
  }
}

@media (min-width: 992px) and (max-width: 1279px) {
  .home-container {
    max-width: 992px;
  }
  
  .home-hero {
    max-width: 752px;
  }
  
  .post-list-container {
    max-width: 752px;
  }
}

@media (max-width: 768px) {
  .home-container {
    padding: 2rem 1rem;
  }

  .home-hero {
    margin-bottom: 3rem;
  }

  .home-title {
    font-size: 2.5rem;
  }

  .home-subtitle {
    font-size: 1.125rem;
  }

  .post-content {
    padding: 1.5rem;
  }

  .post-title {
    font-size: 1.25rem;
  }
}
</style>
