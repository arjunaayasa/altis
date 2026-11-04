const fs = require('node:fs');

module.exports = fs.readFileSync(process.argv[2]);
