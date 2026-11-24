'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { renderMockup, MOCKUP_PRESETS, DEVICE_TEMPLATES } = require('../src/services/mockup');
const { renderPortfolio, portfolioDescription, portfolioInfo } = require('../src/services/portfolio');

function screenshot(width, height, background) {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
}

async function pixel(image, left, top) {
  return sharp(image).extract({ left, top, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
}

test('mockup contains the real input screenshot, and exports the requested image type and size', async () => {
  const image = await screenshot(480, 270, '#fd290c');
  const options = { image, width: 640, height: 360, device: 'desktop', title: 'HTML <&> Canvas' };
  const output = await renderMockup(options);
  const meta = await sharp(output).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['png', 640, 360]);
  const [r, g, b] = await pixel(output, 320, 180);
  assert.ok(r > 225 && g < 65 && b < 45, `expected the orange source image, got ${[r, g, b]}`);

  const jpeg = await renderMockup({ ...options, width: 3840, height: 2160, format: 'jpeg', quality: 83 });
  const jpegMeta = await sharp(jpeg).metadata();
  assert.deepEqual([jpegMeta.format, jpegMeta.width, jpegMeta.height], ['jpeg', 3840, 2160]);
});

test('all original presets and device frames render, including a small preview of a 4K canvas', async () => {
  const image = await screenshot(480, 270, '#644adc');
  const mobileImage = await screenshot(215, 455, '#46e0a4');
  const options = { image, mobileImage, width: 3840, height: 2160, previewWidth: 320, subtitle: 'Test & review' };
  const outputs = [];
  for (const template of Object.keys(MOCKUP_PRESETS)) {
    const output = await renderMockup({ ...options, template });
    const meta = await sharp(output).metadata();
    assert.deepEqual([meta.width, meta.height], [320, 180]);
    outputs.push(output.toString('base64'));
  }
  assert.equal(new Set(outputs).size, 8);

  for (const device of Object.keys(DEVICE_TEMPLATES)) {
    const result = await renderMockup({ ...options, device, rotation: 10, perspective: 30 });
    assert.equal((await sharp(result).metadata()).format, 'png');
  }
});

test('mockup rejects image files that are not supported raster input', async () => {
  const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  await assert.rejects(renderMockup({ image }), /Select a PNG/);
});

test('portfolio exports actual assets alongside editable text and plain project information', async () => {
  const project = {
    name: 'Studio & Co.',
    category: 'Portfolio',
    description: 'A small design studio.',
    url: 'https://example.com/',
    technologies: ['HTML', 'JavaScript'],
    features: ['Responsive gallery', 'Custom typography'],
    exportFolder: 'C:\\private',
  };
  const desktopImage = await screenshot(480, 270, '#173af0');
  const mobileImage = await screenshot(215, 455, '#ed3067');
  const output = await renderPortfolio({ project, desktopImage, mobileImage, preset: 'social', width: 720, height: 800 });
  const meta = await sharp(output).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['png', 720, 800]);

  const [desktopRed, desktopGreen, desktopBlue] = await pixel(output, 200, 404);
  assert.ok(desktopBlue > 200 && desktopGreen < 90 && desktopRed < 55, 'expected the desktop screenshot in the rendered portfolio');
  const [mobileRed, mobileGreen, mobileBlue] = await pixel(output, 602, 404);
  assert.ok(mobileRed > 200 && mobileGreen < 80 && mobileBlue > 65, 'expected the mobile screenshot in the rendered portfolio');
  assert.deepEqual(portfolioInfo(project).features, project.features);
  assert.equal(Object.hasOwn(portfolioInfo(project), 'exportFolder'), false);
  assert.match(portfolioDescription(project), /https:\/\/example\.com\//);
  assert.match(portfolioDescription(project), /- Responsive gallery\n- Custom typography/);
  assert.doesNotMatch(portfolioDescription(project), /C:\\private/);
});
