<template>
  <div class="assembly-line">
    <div class="line-container">
      <!-- Queue -->
      <div class="queue-area">
        <div class="area-label">Queue</div>
        <div class="card-stack">
          <span
            v-for="(m, i) in queueVisible"
            :key="m.id"
            class="card material-chip"
            :class="[`material-${m.type}`, { 'card-first': i === 0 }]"
            :style="{ zIndex: MAX_CARDS - i }"
          >
            {{ m.type }}
          </span>
          <span
            v-if="queueOverflow > 0"
            class="card overflow-badge"
            :class="{ 'card-first': queueVisible.length === 0 }"
          >
            +{{ queueOverflow }}
          </span>
          <span v-if="materialQueue.length === 0" class="empty-hint">empty</span>
        </div>
      </div>

      <!-- Stations -->
      <div class="stations">
        <div
          v-for="station in stations"
          :key="station.name"
          class="station"
          :class="{
            active: station.part !== null && station.part.ticksLeft > 0,
            done: station.part !== null && station.part.ticksLeft === 0
          }"
        >
          <div class="station-label">{{ station.name }}</div>
          <div class="station-body">
            <Transition name="part">
              <span
                v-if="station.part"
                :key="station.part.id"
                class="material-chip"
                :class="`material-${station.part.type}`"
              >
                {{ station.display }}
              </span>
            </Transition>
            <span v-if="!station.part" class="idle-text">idle</span>
          </div>
        </div>
      </div>

      <!-- Output -->
      <div class="output-area">
        <div class="area-label">Output</div>
        <div class="card-stack">
          <span
            v-for="(w, i) in outputVisible"
            :key="w.serial"
            class="card widget-badge"
            :class="{ passed: w.passed, rejected: !w.passed, 'card-first': i === 0 }"
            :style="{ zIndex: MAX_CARDS - i }"
          >
            {{ w.serial }} {{ w.passed ? '&#10003;' : '&#10007;' }}
          </span>
          <span
            v-if="outputOverflow > 0"
            class="card overflow-badge"
            :class="{ 'card-first': outputVisible.length === 0 }"
          >
            +{{ outputOverflow }}
          </span>
          <span v-if="outputWidgets.length === 0" class="empty-hint">empty</span>
        </div>
      </div>
    </div>

    <!-- Controls -->
    <div class="controls">
      <div class="control-left">
        <select v-model="selectedMaterial" class="material-select">
          <option value="steel">Steel</option>
          <option value="aluminum">Aluminum</option>
          <option value="titanium">Titanium</option>
        </select>
        <button class="btn" @click="addMaterial">Add Material</button>
      </div>
      <div class="control-right">
        <button
          class="btn"
          :class="running ? 'btn-danger' : 'btn-primary'"
          @click="toggle"
        >
          {{ running ? 'Stop' : 'Start' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'

interface QueuedMaterial {
  id: number
  type: string
  length: number
}

interface PartInFlight {
  id: number
  type: string
  length: number
  size: number
  serial: string
  color: string
  passed: boolean
  ticksLeft: number
}

interface StationState {
  name: string
  part: PartInFlight | null
  display: string
}

interface Widget {
  type: string
  size: number
  serial: string
  color: string
  passed: boolean
}

const TICK_MS = 600
const MAX_CARDS = 5

const materialQueue = ref<QueuedMaterial[]>([])
const outputWidgets = ref<Widget[]>([])
const selectedMaterial = ref('steel')
const running = ref(false)

let nextId = 0
let serialCounter = 1
let tickTimer: ReturnType<typeof setInterval> | null = null

const stations = ref<StationState[]>([
  { name: 'Materials', part: null, display: '' },
  { name: 'Cut', part: null, display: '' },
  { name: 'Stamp', part: null, display: '' },
  { name: 'Paint', part: null, display: '' },
  { name: 'Inspect', part: null, display: '' },
])

const COLORS: Record<string, string> = {
  steel: 'blue',
  aluminum: 'silver',
  titanium: 'black',
}

const queueVisible = computed(() => materialQueue.value.slice(0, MAX_CARDS))
const queueOverflow = computed(() => Math.max(0, materialQueue.value.length - MAX_CARDS))

const outputVisible = computed(() => outputWidgets.value.slice(-MAX_CARDS).reverse())
const outputOverflow = computed(() => Math.max(0, outputWidgets.value.length - MAX_CARDS))

function addMaterial() {
  materialQueue.value.push({
    id: nextId++,
    type: selectedMaterial.value,
    length: Math.random() * 20 + 5,
  })
}

function enterStation(index: number, part: PartInFlight) {
  const s = stations.value[index]
  part.ticksLeft = 1

  switch (index) {
    case 0:
      s.display = `${part.type} (${part.length.toFixed(1)})`
      break
    case 1:
      part.size = Math.min(part.length, 10)
      s.display = `size: ${part.size.toFixed(1)}`
      break
    case 2:
      part.serial = `WDG-${String(serialCounter++).padStart(4, '0')}`
      s.display = part.serial
      break
    case 3:
      part.color = COLORS[part.type] ?? 'grey'
      s.display = part.color
      break
    case 4:
      part.passed = part.size >= 8
      s.display = part.passed ? 'PASS' : 'FAIL'
      break
  }

  s.part = part
}

function clearStation(index: number) {
  stations.value[index].part = null
  stations.value[index].display = ''
}

function tick() {
  const s = stations.value

  // 1. Decrement ticks for all processing parts
  for (const station of s) {
    if (station.part && station.part.ticksLeft > 0) {
      station.part.ticksLeft--
    }
  }

  // 2. Advance done parts right-to-left
  // Station 4 done → output
  if (s[4].part && s[4].part.ticksLeft === 0) {
    const p = s[4].part
    outputWidgets.value.push({
      type: p.type,
      size: p.size,
      serial: p.serial,
      color: p.color,
      passed: p.passed,
    })
    clearStation(4)
  }

  // Stations 3→0: advance into next station if it's empty
  for (let i = 3; i >= 0; i--) {
    if (s[i].part && s[i].part!.ticksLeft === 0 && !s[i + 1].part) {
      const part = s[i].part!
      clearStation(i)
      enterStation(i + 1, part)
    }
  }

  // 3. Feed from queue into station 0
  if (!s[0].part && materialQueue.value.length > 0) {
    const m = materialQueue.value.shift()!
    const part: PartInFlight = {
      id: m.id,
      type: m.type,
      length: m.length,
      size: 0,
      serial: '',
      color: '',
      passed: false,
      ticksLeft: 0,
    }
    enterStation(0, part)
  }
}

function toggle() {
  running.value = !running.value
  if (running.value) {
    tick()
    tickTimer = setInterval(tick, TICK_MS)
  } else if (tickTimer !== null) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

onUnmounted(() => {
  if (tickTimer !== null) clearInterval(tickTimer)
})
</script>

<style scoped>
.assembly-line {
  margin: 2rem 0;
  padding: 1.5rem;
  background: var(--vp-c-bg-soft);
  border-radius: 8px;
}

@media (max-width: 768px) {
  .assembly-line {
    padding: 1rem;
  }
}

.line-container {
  display: flex;
  align-items: stretch;
  gap: 0.5rem;
}

@media (max-width: 768px) {
  .line-container {
    flex-direction: column;
  }
}

.area-label,
.station-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vp-c-text-2);
  margin-bottom: 0.5rem;
  text-align: center;
}

/* Queue & Output */
.queue-area,
.output-area {
  flex: 0 0 90px;
  padding: 0.75rem;
  background: var(--vp-code-bg);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.card-stack {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.card {
  position: relative;
  margin-top: -0.6rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
  transition: margin 0.2s ease, opacity 0.2s ease;
}

.card.card-first {
  margin-top: 0;
}

.overflow-badge {
  display: block;
  position: relative;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 600;
  text-align: center;
  color: var(--vp-c-text-3);
  background: var(--vp-c-bg-soft);
  border: 1px dashed var(--vp-c-divider);
  margin-top: -0.6rem;
}

.overflow-badge.card-first {
  margin-top: 0;
}

/* Stations row */
.stations {
  display: flex;
  gap: 0.5rem;
  flex: 1;
}

@media (max-width: 768px) {
  .stations {
    flex-wrap: wrap;
  }
}

.station {
  flex: 1 1 0%;
  min-width: 0;
  padding: 0.75rem;
  background: var(--vp-code-bg);
  border-radius: 6px;
  border: 2px solid transparent;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.station.active {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 8px color-mix(in srgb, var(--vp-c-brand-1) 30%, transparent);
}

.station.done {
  border-color: var(--vp-c-green-1, #10b981);
}

.station-body {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 2rem;
}

.idle-text,
.empty-hint {
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
  font-style: italic;
}

/* Material chips */
.material-chip {
  display: block;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
  text-align: center;
  white-space: nowrap;
}

.material-steel {
  background: #3b82f6;
  color: #fff;
}

.material-aluminum {
  background: #94a3b8;
  color: #1e293b;
}

.material-titanium {
  background: #1e293b;
  color: #e2e8f0;
}

/* Widget badges */
.widget-badge {
  display: block;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-size: 0.7rem;
  white-space: nowrap;
  font-weight: 500;
  font-family: var(--vp-font-family-mono);
  text-align: center;
}

.widget-badge.passed {
  background: color-mix(in srgb, var(--vp-c-green-1, #10b981) 20%, transparent);
  color: var(--vp-c-green-1, #10b981);
}

.widget-badge.rejected {
  background: color-mix(in srgb, var(--vp-c-red-1, #ef4444) 20%, transparent);
  color: var(--vp-c-red-1, #ef4444);
  text-decoration: line-through;
}

/* Part transition */
.part-enter-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.part-leave-active {
  transition: opacity 0.15s ease;
}
.part-enter-from {
  opacity: 0;
  transform: translateX(-8px);
}
.part-leave-to {
  opacity: 0;
}

/* Controls */
.controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 1rem;
  gap: 1rem;
}

@media (max-width: 768px) {
  .controls {
    flex-direction: column;
    align-items: stretch;
  }
}

.control-left,
.control-right {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

@media (max-width: 768px) {
  .control-left,
  .control-right {
    justify-content: center;
  }
}

.material-select {
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.85rem;
  cursor: pointer;
}

.btn {
  padding: 0.4rem 0.8rem;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.85rem;
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease;
}

.btn:hover:not(:disabled) {
  border-color: var(--vp-c-brand-1);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--vp-c-brand-1);
  color: var(--vp-c-white, #fff);
  border-color: var(--vp-c-brand-1);
}

.btn-primary:hover:not(:disabled) {
  background: var(--vp-c-brand-2);
  border-color: var(--vp-c-brand-2);
}

.btn-danger {
  background: var(--vp-c-red-1, #ef4444);
  color: #fff;
  border-color: var(--vp-c-red-1, #ef4444);
}

.btn-danger:hover:not(:disabled) {
  background: var(--vp-c-red-2, #dc2626);
  border-color: var(--vp-c-red-2, #dc2626);
}
</style>
