// copies just what the capacitor app needs into a fresh www/, wiping whatever was there before.
// data/, data-scripts/, .venv/, node_modules/, README etc never go in here

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');

const FILES = ['index.html', 'style.css', 'favicon.svg'];
const DIRS = ['js', 'webdata'];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });

for (const name of FILES) copyRecursive(path.join(ROOT, name), path.join(WWW, name));
for (const name of DIRS) copyRecursive(path.join(ROOT, name), path.join(WWW, name));

console.log('copied index.html, style.css, favicon.svg, js/, webdata/ into www/');
