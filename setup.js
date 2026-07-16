const fs = require('fs');
const path = require('path');

const dirs = [
  'public',
  'public/js',
  'public/css',
  'public/models',
  'public/uploads'
];

console.log('Creating directories...');
dirs.forEach(dir => {
  const fullPath = path.join(__dirname, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
});

// Copy face-api.js distribution file
const faceApiDistSrc = path.join(__dirname, 'node_modules', '@vladmandic', 'face-api', 'dist', 'face-api.js');
const faceApiDistDest = path.join(__dirname, 'public', 'js', 'face-api.js');

console.log('Copying face-api.js...');
if (fs.existsSync(faceApiDistSrc)) {
  fs.copyFileSync(faceApiDistSrc, faceApiDistDest);
  console.log('Copied face-api.js to public/js/');
} else {
  console.warn('Could not find face-api.js in node_modules! Setup will require running npm install first.');
}

// Copy models
const modelsSrcDir = path.join(__dirname, 'node_modules', '@vladmandic', 'face-api', 'model');
const modelsDestDir = path.join(__dirname, 'public', 'models');

console.log('Copying model weight files...');
if (fs.existsSync(modelsSrcDir)) {
  const files = fs.readdirSync(modelsSrcDir);
  let copiedCount = 0;
  files.forEach(file => {
    const srcFile = path.join(modelsSrcDir, file);
    const destFile = path.join(modelsDestDir, file);
    // Copy only files, ignore directories
    if (fs.lstatSync(srcFile).isFile()) {
      fs.copyFileSync(srcFile, destFile);
      copiedCount++;
    }
  });
  console.log(`Copied ${copiedCount} model files to public/models/`);
} else {
  console.warn('Could not find models in node_modules! Setup will require running npm install first.');
}

// Initialize empty gallery.json if it doesn't exist
const galleryJsonPath = path.join(__dirname, 'public', 'gallery.json');
if (!fs.existsSync(galleryJsonPath)) {
  fs.writeFileSync(galleryJsonPath, JSON.stringify([], null, 2));
  console.log('Initialized public/gallery.json');
}

console.log('Setup utility executed.');
