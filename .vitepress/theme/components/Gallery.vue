<template>
  <div class="gallery">
    <div class="gallery-grid" :class="gridClass">
      <div v-for="(image, index) in images" :key="index" class="gallery-item" :ref="el => setItemRef(el, index)"
        @click="openLightbox(index)">
        <img :src="image" :alt="`Gallery image ${index + 1}`" loading="lazy" @load="onImageLoad($event, index)" />
      </div>
    </div>

    <p v-if="caption" class="gallery-caption">{{ caption }}</p>

    <!-- Lightbox Modal -->
    <div v-if="showLightbox" class="lightbox" @click="closeLightbox">
      <div class="lightbox-content" @click.stop>
        <button class="lightbox-close" @click="closeLightbox">&times;</button>
        <img :src="images[currentImage]" :alt="`Gallery image ${currentImage + 1}`" />
        <div class="lightbox-nav">
          <button class="nav-btn prev" @click="prevImage" :disabled="currentImage === 0">
            &#8249;
          </button>
          <span class="image-counter">
            {{ currentImage + 1 }} / {{ images.length }}
          </span>
          <button class="nav-btn next" @click="nextImage" :disabled="currentImage === images.length - 1">
            &#8250;
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

interface Props {
  images: string[]
  caption?: string
  columns?: number
}

const props = withDefaults(defineProps<Props>(), {
  columns: 3
})

const showLightbox = ref(false)
const currentImage = ref(0)
const itemRefs = ref<Array<HTMLElement | null>>([])

const gridClass = computed(() => {
  const cols = Math.min(props.columns, props.images.length)
  return `columns-${cols}`
})

const setItemRef = (el: HTMLElement | null, index: number) => {
  if (itemRefs.value) {
    itemRefs.value[index] = el
  }
}

const onImageLoad = (event: Event, index: number) => {
  const img = event.target as HTMLImageElement
  const container = itemRefs.value[index]
  if (!img || !container) return

  // Calculate width based on aspect ratio
  // Fixed height of 200px, width varies based on aspect ratio
  const aspectRatio = img.naturalWidth / img.naturalHeight
  const baseHeight = 200
  const calculatedWidth = Math.floor(baseHeight * aspectRatio)
  
  // Set minimum and maximum widths for better layout
  const minWidth = 150
  const maxWidth = 400
  const finalWidth = Math.min(maxWidth, Math.max(minWidth, calculatedWidth))
  
  container.style.width = `${finalWidth}px`
}

const openLightbox = (index: number) => {
  currentImage.value = index
  showLightbox.value = true
  document.body.style.overflow = 'hidden'
}

const closeLightbox = () => {
  showLightbox.value = false
  document.body.style.overflow = 'auto'
}

const nextImage = () => {
  if (currentImage.value < props.images.length - 1) {
    currentImage.value++
  }
}

const prevImage = () => {
  if (currentImage.value > 0) {
    currentImage.value--
  }
}

const handleKeydown = (event: KeyboardEvent) => {
  if (!showLightbox.value) return
  
  switch (event.key) {
    case 'Escape':
      closeLightbox()
      break
    case 'ArrowLeft':
      prevImage()
      break
    case 'ArrowRight':
      nextImage()
      break
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  document.body.style.overflow = 'auto'
})
</script>

<style scoped>
.gallery {
  margin: 2rem 0;
  /* Make gallery slightly wider than content column */
  width: calc(100% + 6rem);
  margin-left: -3rem;
  margin-right: -3rem;
}

/* On smaller screens, reduce the overflow */
@media (max-width: 768px) {
  .gallery {
    width: calc(100% + 2rem);
    margin-left: -1rem;
    margin-right: -1rem;
  }
}

/* On very large screens, limit the expansion */
@media (min-width: 1400px) {
  .gallery {
    width: calc(100% + 4rem);
    margin-left: -2rem;
    margin-right: -2rem;
  }
}

.gallery-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

@media (max-width: 768px) {
  .gallery-grid {
    gap: 0.25rem;
  }
}

.gallery-item {
  cursor: pointer;
  overflow: hidden;
  border-radius: 4px;
  transition: transform 0.2s ease;
  flex: 1 0 auto;
  height: 200px;
  background: var(--vp-c-bg-soft);
}

.gallery-item:hover {
  transform: scale(1.01);
}

.gallery-item img {
  width: 100%;
  height: 100%;
  display: block;
  border-radius: 4px;
  object-fit: cover;
}

.gallery-caption {
  font-style: italic;
  color: var(--vp-c-text-2);
  text-align: center;
  margin: 0.5rem 0 0 0;
  font-size: 0.9em;
}

/* Lightbox Styles */
.lightbox {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.9);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  cursor: pointer;
}

.lightbox-content {
  position: relative;
  max-width: 90vw;
  max-height: 90vh;
  cursor: default;
}

.lightbox-content img {
  max-width: 100%;
  max-height: 80vh;
  object-fit: contain;
  border-radius: 4px;
}

.lightbox-close {
  position: absolute;
  top: -40px;
  right: 0;
  background: none;
  border: none;
  color: white;
  font-size: 2rem;
  cursor: pointer;
  padding: 0.5rem;
  line-height: 1;
}

.lightbox-close:hover {
  opacity: 0.7;
}

.lightbox-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin-top: 1rem;
}

.nav-btn {
  background: rgba(255, 255, 255, 0.2);
  border: none;
  color: white;
  font-size: 1.5rem;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.2s ease;
}

.nav-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.3);
}

.nav-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.image-counter {
  color: white;
  font-size: 0.9rem;
}
</style>
