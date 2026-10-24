'use strict';
const fs = require('node:fs');
const path = require('node:path');
require('./build-version');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist');
fs.mkdirSync(out, { recursive: true });
// Only public assets enter the CDN. Backend modules, tests and configuration
// are bundled into functions, never copied into the website's publish folder.
const files = ['index.html', 'vendex.html', 'vendora-login.html', 'vendora-dashboard.html', 'vendora-credits.html',
  'vendora-privacy.html', 'vendora-tos.html', 'favicon.png', 'vendora-icon.png', 'vendora-enhanced.png',
  'version.json', 'robots.txt', 'sitemap.xml', 'pages-sitemap.xml'];
for (const file of files) fs.copyFileSync(path.join(root, file), path.join(out, file));
for (const folder of ['assets', 'icons']) fs.cpSync(path.join(root, folder), path.join(out, folder), { recursive: true });
console.log(`Prepared ${files.length} public files and asset folders for Netlify.`);
