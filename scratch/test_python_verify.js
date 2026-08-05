const { execFile } = require('child_process');

const cmds = [
  'python',
  'python3',
  'py',
  'C:\\Users\\SOURAV SENAPATI\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
];
const testScript = 'import sys; import mediapipe; import PIL; import numpy; print("OK")';

function tryCheck(index) {
  if (index >= cmds.length) {
    console.log('No working Python found.');
    return;
  }
  const cmd = cmds[index];
  execFile(cmd, ['-c', testScript], (error, stdout, stderr) => {
    if (!error && stdout.trim().includes('OK')) {
      console.log(`SUCCESS: Python setup verified using command: '${cmd}'`);
    } else {
      console.log(`Failed for '${cmd}':`, error ? error.message : stderr);
      tryCheck(index + 1);
    }
  });
}

tryCheck(0);
