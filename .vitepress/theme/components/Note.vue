<template>
  <span class="post-note">
    <span v-if="markdown" v-html="processedMarkdown"></span>
    <slot v-else>{{ text }}</slot>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  text?: string
  markdown?: string
}

const props = defineProps<Props>()

const processedMarkdown = computed(() => {
  if (!props.markdown) return ''
  
  // Simple markdown processing for common cases
  return props.markdown
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Italic  
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Bold (alternative syntax)
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    // Italic (alternative syntax)
    .replace(/_([^_]+)_/g, '<em>$1</em>')
})
</script>

<style scoped>
.post-note {
  display: block;
  white-space: pre-wrap;
  text-align: right;
  margin-top: 0;
  color: var(--vp-c-text-2);
  font-size: 0.9em;
  line-height: 1.4;
  background: var(--vp-code-bg);
  padding: 8px 16px;
  border-radius: 0 0 8px 8px;
  border: 1px solid var(--vp-c-divider-light);
  border-top: none;
  /* Breakout styling to match code blocks - use same breakpoints as VitePress */
}

@media (min-width: 900px) {
  .post-note {
    margin-left: -3rem;
    margin-right: -3rem;
  }
}

@media (min-width: 640px) and (max-width: 899px) {
  .post-note {
    margin-left: -1rem;
    margin-right: -1rem;
  }
}

@media (max-width: 639px) {
  .post-note {
    margin-left: -0.5rem;
    margin-right: -0.5rem;
  }
}

.post-note :deep(code) {
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
  padding: 2px 4px;
  border-radius: 3px;
  font-size: inherit;
}
</style>
