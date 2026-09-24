// ?fastrefresh=1 to watch ticks and jobs in the console
const FAST_REFRESH = new URLSearchParams(location.search).get('fastrefresh') === '1';

const TICK_MS = 10 * 1000;
const jobs = [];

function registerJob(name, interval, fn) {
  jobs.push({ name, interval, fn, lastRun: 0 });
}

function runDueJobs() {
  const now = Date.now();
  const ran = [];
  jobs.forEach(job => {
    if (now - job.lastRun >= job.interval) {
      job.fn();
      job.lastRun = now;
      ran.push(job.name);
    }
  });
  return ran;
}

function tick() {
  updateFreshnessText();
  updateBanner();
  const ran = runDueJobs();
  if (FAST_REFRESH) console.log('tick', new Date().toLocaleTimeString(), 'ran:', ran);
}

// weather api caps out at 300/day, keep it slow. alerts are free-ish so a bit more often
registerJob('weather', 5 * 60 * 1000, loadWeather);
registerJob('alerts', 3 * 60 * 1000, loadAlerts);

let loopTimer = null;

function startLoop() {
  loopTimer = setInterval(tick, TICK_MS);
}

// no point burning quota on a tab nobody's looking at
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(loopTimer);
  } else {
    tick();
    startLoop();
  }
});

tick();
startLoop();
