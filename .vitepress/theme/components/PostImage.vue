<template>
  <figure class="post-image" :class="{ 'full-width': fullWidth, 'breakout': breakout }">
    <img :src="src" :alt="alt" :loading="lazy ? 'lazy' : 'eager'" @load="onImageLoad" />
    <figcaption v-if="caption" class="post-image-caption">
      {{ caption }}
    </figcaption>
  </figure>
</template>

<script setup>
const props = defineProps({
  src: {
    type: String,
    required: true
  },
  alt: {
    type: String,
    default: ''
  },
  caption: {
    type: String,
    default: ''
  },
  fullWidth: {
    type: Boolean,
    default: false
  },
  breakout: {
    type: Boolean,
    default: true
  },
  lazy: {
    type: Boolean,
    default: true
  }
})

const onImageLoad = (event) => {
  // Add loaded class for potential animations
  event.target.classList.add('loaded')
}
</script>

<style scoped>
.post-image {
  margin: 2rem 0;
  text-align: center;
}

.post-image img {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  transition: opacity 0.3s ease;
  opacity: 0;
}

.post-image img.loaded {
  opacity: 1;
}

.post-image img:hover {}

/* Breakout style - extends beyond normal content width but not full viewport */
.post-image.breakout {
  width: calc(100% + 6rem);
  margin-left: -3rem;
  margin-right: -3rem;
}

/* Full width style - extends to full viewport width */
.post-image.full-width {
  width: 100vw;
  margin-left: calc(-50vw + 50%);
  margin-right: calc(-50vw + 50%);
}

.post-image-caption {
  margin-top: 1rem;
  font-size: 0.875rem;
  color: var(--vp-c-text-2);
  font-style: italic;
  line-height: 1.4;
  max-width: 600px;
  margin-left: auto;
  margin-right: auto;
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .post-image.breakout {
    width: calc(100% + 2rem);
    margin-left: -1rem;
    margin-right: -1rem;
  }

  .post-image.full-width {
    width: calc(100% + 2rem);
    margin-left: -1rem;
    margin-right: -1rem;
  }

  .post-image img {
    border-radius: 4px;
  }

  .post-image-caption {
    font-size: 0.8rem;
    margin-left: 1rem;
    margin-right: 1rem;
  }
}

/* Dark mode adjustments */
@media (prefers-color-scheme: dark) {}
</style>
