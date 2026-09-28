#!/usr/bin/env node

import { render } from './render.js';

if (process.argv[2] === '--version') {
  console.log(render('jsprobe 1.0.0'));
} else if (process.argv[2] === '--help') {
  console.log(render('usage: jsprobe [arguments...]'));
} else {
  console.log(render(JSON.stringify(process.argv.slice(2))));
}
