<template>
  <Layout>
    <template #doc-before>
      <div v-if="$frontmatter.title" class="page-header">
        <h1 class="page-title">{{ $frontmatter.title }}</h1>
        <p v-if="$frontmatter.description" class="page-description">{{ $frontmatter.description }}</p>
      </div>
    </template>
  </Layout>
</template>

<script setup>
import DefaultTheme from 'vitepress/theme'
const { Layout } = DefaultTheme
</script>

<style scoped>
.page-header {
  margin-bottom: 2rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--vp-c-divider);
}

.page-title {
  font-size: 2.5rem;
  font-weight: 800;
  line-height: 1.2;
  color: var(--vp-c-text-1);
  margin: 0 0 1rem 0;
}

.page-description {
  font-size: 1.25rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  margin: 0;
  font-style: italic;
}

@media (max-width: 768px) {
  .page-title {
    font-size: 2rem;
  }

  .page-description {
    font-size: 1rem;
  }
}

/* Ensure proper spacing with content that follows */
.page-header+div {
  margin-top: 0;
}
</style>
