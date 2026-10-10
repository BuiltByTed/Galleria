import sharp from 'sharp';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const defaultIconsDir = path.join(projectRoot, 'config', 'icons');
const publicDir = path.join(projectRoot, 'frontend', 'public');
const photosDir = path.join(process.env.DATA_DIR || path.join(projectRoot, 'data'), 'photos');
const customAvatarPath = path.join(photosDir, 'avatar.png');

console.log('🎨 Setting up icons and favicons...');

try {
  // Check if custom avatar exists (user uploaded custom favicon)
  let sourceImagePath;
  let isCustomAvatar = false;

  if (fs.existsSync(customAvatarPath)) {
    console.log('✓ Found custom avatar.png, will use it for icons and favicons');
    sourceImagePath = customAvatarPath;
    isCustomAvatar = true;
  } else {
    console.log('📦 No custom avatar found, using default icon-192.png');
    sourceImagePath = path.join(defaultIconsDir, 'icon-192.png');
    
    if (!fs.existsSync(sourceImagePath)) {
      console.error('❌ Default icon-192.png not found in config/icons/!');
      process.exit(1);
    }
  }

  // Always regenerate icons and favicons from the source (either custom avatar or default)
  // This ensures icons stay in sync after deployment
  console.log(`🔄 Generating icons and favicons from ${isCustomAvatar ? 'custom avatar' : 'default icon'}...`);

  // Generate icon-192.png (192x192)
  const icon192Path = path.join(publicDir, 'icon-192.png');
  await sharp(sourceImagePath)
    .rotate() // Auto-rotate based on EXIF
    .resize(192, 192, { fit: 'cover' })
    .png()
    .toFile(icon192Path);
  console.log('✓ Generated icon-192.png');

  // Generate icon-512.png (512x512)
  const icon512Path = path.join(publicDir, 'icon-512.png');
  await sharp(sourceImagePath)
    .rotate()
    .resize(512, 512, { fit: 'cover' })
    .png()
    .toFile(icon512Path);
  console.log('✓ Generated icon-512.png');

  // Generate apple-touch-icon.png (192x192)
  const appleTouchIconPath = path.join(publicDir, 'apple-touch-icon.png');
  await sharp(sourceImagePath)
    .rotate()
    .resize(192, 192, { fit: 'cover' })
    .png()
    .toFile(appleTouchIconPath);
  console.log('✓ Generated apple-touch-icon.png');

  // Generate favicon.png (512x512)
  const faviconPngPath = path.join(publicDir, 'favicon.png');
  await sharp(sourceImagePath)
    .rotate()
    .resize(512, 512, { fit: 'cover' })
    .png()
    .toFile(faviconPngPath);
  console.log('✓ Generated favicon.png');

  // Generate favicon.ico (32x32)
  const faviconIcoPath = path.join(publicDir, 'favicon.ico');
  await sharp(sourceImagePath)
    .rotate()
    .resize(32, 32, { fit: 'cover' })
    .toFormat('png')
    .toFile(faviconIcoPath);
  console.log('✓ Generated favicon.ico');

  console.log(`✨ Icon setup and favicon generation complete! ${isCustomAvatar ? '(using custom avatar)' : '(using defaults)'}`);
} catch (error) {
  console.error('Error setting up icons/favicons:', error);
  process.exit(1);
}

