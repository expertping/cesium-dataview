<template>

  <el-main class="p-0 relative h-screen w-screen overflow-hidden">
    <div class="absolute left-6 top-1/2 -translate-y-1/2 z-50">
      <!-- <DynamicTimeline :data="timelineData" /> -->
    </div>
    <CesiumViewer />
  </el-main>
</template>

<script setup lang="ts">
import CesiumViewer from './components/CesiumViewer.vue'

</script>

<style>
/* Remove default element plus padding if necessary */
.el-main {
  --el-main-padding: 0 !important;
}
.cesium-viewer-bottom {
  display: none !important;
}
.cesium-credit-logoContainer{
  display: none !important;
}
</style>
