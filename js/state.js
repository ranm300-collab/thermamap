// shared app state instead of loose globals scattered across files
const state = {
  start: null,
  dest: null,
  leaveTimeMs: null,
  weather: {
    feelsLike: null,
    uv: null,
    readingTime: null
  }
}
