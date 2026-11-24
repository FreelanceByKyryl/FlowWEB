'use strict';

const fs = require('node:fs/promises');
const sharp = require('sharp');

const MAX_ASSET_BYTES = 96 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;

function number(value, fallback, min, max) {
  const resolved = value === '' || value == null ? fallback : Number(value);
  return Number.isFinite(resolved) ? Math.min(max, Math.max(min, resolved)) : fallback;
}

function dimensions(options, defaults) {
  return {
    width: Math.round(number(options.width, defaults.width, 160, 4096)),
    height: Math.round(number(options.height, defaults.height, 160, 4096)),
  };
}

function color(value, fallback) {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : fallback;
}

function escapeXml(value) {
  return String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

function wrapText(value, maxLength, maxLines) {
  const characters = Array.from(String(value ?? '').replace(/\s+/g, ' ').trim());
  const lines = [];

  while (characters.length && lines.length < maxLines) {
    let end = maxLength;
    if (characters.length > maxLength) {
      const splitAt = characters.slice(0, maxLength + 1).lastIndexOf(' ');
      if (splitAt > maxLength * 0.45) end = splitAt;
    }
    lines.push(characters.splice(0, end).join('').trim());
    while (characters[0] === ' ') characters.shift();
  }

  if (characters.length) lines[lines.length - 1] = Array.from(lines.at(-1)).slice(0, -1).join('') + '…';
  return lines;
}

function svgText(lines, { x, y, size, lineHeight = size * 1.16, fill, weight = 400, anchor = 'start' }) {
  return lines.map((line, index) => (
    `<text x="${x}" y="${y + index * lineHeight}" font-family="sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}">${escapeXml(line)}</text>`
  )).join('');
}

function hasSupportedMagic(buffer) {
  const header = buffer.subarray(0, 32);
  return (
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || header.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    || ['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6))
    || (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP')
    || (header.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(header.toString('ascii', 8)))
  );
}

async function readImage(input) {
  let buffer;
  if (Buffer.isBuffer(input)) {
    buffer = input;
  } else if (typeof input === 'string') {
    const info = await fs.stat(input);
    if (!info.isFile() || info.size > MAX_ASSET_BYTES) {
      throw new Error('Select a regular image file under 96 MB.');
    }
    buffer = await fs.readFile(input);
  }

  if (!buffer || buffer.length > MAX_ASSET_BYTES || !hasSupportedMagic(buffer)) {
    throw new Error('Select a PNG, JPEG, WebP, GIF or AVIF image under 96 MB.');
  }
  return buffer;
}

async function embeddedImage(input, width, height, { position = 'centre', background = '#171720', fit = 'cover' } = {}) {
  const buffer = await readImage(input);
  const fitted = await sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS })
    .rotate()
    .resize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), { fit, position, background })
    .flatten({ background })
    .jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return `data:image/jpeg;base64,${fitted.toString('base64')}`;
}

async function encodeSvg(body, width, height, options = {}) {
  const outputWidth = options.previewWidth ? Math.round(number(options.previewWidth, width, 160, width)) : width;
  const outputHeight = Math.round(height * outputWidth / width);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${width} ${height}">${body}</svg>`,
  );
  const image = sharp(svg);
  if (['jpg', 'jpeg'].includes(String(options.format).toLowerCase())) {
    image.jpeg({ quality: Math.round(number(options.quality, 92, 1, 100)), chromaSubsampling: '4:4:4' });
  } else {
    image.png({ compressionLevel: 6 });
  }
  return image.toBuffer();
}

module.exports = { number, dimensions, color, escapeXml, wrapText, svgText, embeddedImage, encodeSvg };
