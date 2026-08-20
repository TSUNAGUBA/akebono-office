<template>
  <div class="mb-2 flex flex-wrap items-center gap-1.5">
    <slot />
    <div v-if="$slots.trailing" class="ml-auto flex items-center gap-1.5">
      <slot name="trailing" />
    </div>
  </div>
</template>
