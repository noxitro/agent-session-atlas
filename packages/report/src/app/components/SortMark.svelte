<script lang="ts">
  let { state }: { state: 'asc' | 'desc' | 'none' } = $props();
</script>

<svg class="sortmark" width="8" height="10" viewBox="0 0 8 10" aria-hidden="true" focusable="false">
  <path d="M4 1 7 4H1z" fill={state === 'asc' ? 'currentColor' : 'none'} stroke="currentColor" stroke-width={state === 'none' ? 0.6 : 0} opacity={state === 'desc' ? 0.25 : 1} />
  <path d="M4 9 1 6h6z" fill={state === 'desc' ? 'currentColor' : 'none'} stroke="currentColor" stroke-width={state === 'none' ? 0.6 : 0} opacity={state === 'asc' ? 0.25 : 1} />
</svg>

<style>
  .sortmark {
    display: inline-block;
    margin-left: 4px;
    vertical-align: -1px;
  }
</style>
