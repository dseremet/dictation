<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 0..1 */
    level: number
    bars?: number
  }>(),
  { bars: 5 },
)

const active = computed(() => {
  const l = Math.max(0, Math.min(1, props.level || 0))
  return Math.round(l * props.bars)
})
</script>

<template>
  <span class="dct-meter" role="img" :aria-label="`${Math.round((level || 0) * 100)}%`">
    <span
      v-for="i in bars"
      :key="i"
      class="dct-meter__bar"
      :class="{ 'dct-meter__bar--on': i <= active }"
      :style="{ height: `${40 + (i / bars) * 60}%` }"
    />
  </span>
</template>

<style scoped>
.dct-meter {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 1em;
  width: calc(var(--dct-meter-bars, 5) * 5px);
  vertical-align: middle;
}
.dct-meter__bar {
  flex: 1 1 0;
  min-width: 3px;
  border-radius: 1px;
  background: var(--dct-meter-off, rgba(127, 127, 127, 0.3));
  transition: background-color 80ms linear;
}
.dct-meter__bar--on {
  background: var(--dct-meter-on, var(--dct-accent, #2563eb));
}
</style>
