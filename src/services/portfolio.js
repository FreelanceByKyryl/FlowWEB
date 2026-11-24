'use strict';

const { dimensions, number, wrapText, svgText, embeddedImage, encodeSvg } = require('./graphics');
const { renderMockup } = require('./mockup');

const PORTFOLIO_PRESETS = Object.freeze({
  fiverr: { label: 'Fiverr portfolio', width: 1280, height: 768 },
  freelancer: { label: 'Freelancer portfolio', width: 1600, height: 1200 },
  behance: { label: 'Behance presentation', width: 1400, height: 2000 },
  github: { label: 'GitHub project presentation', width: 1280, height: 640 },
  social: { label: 'Social media', width: 1080, height: 1080 },
  custom: { label: 'Custom dimensions', width: 1920, height: 1080 },
});

function field(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function items(value, delimiter) {
  const entries = Array.isArray(value) ? value : field(value).split(delimiter);
  return entries.map(field).filter(Boolean);
}

function portfolioInfo(project = {}) {
  return {
    name: field(project?.name),
    category: field(project?.category),
    description: field(project?.description),
    url: field(project?.url),
    technologies: items(project?.technologies, /[,\r\n]+/),
    features: items(project?.features ?? project?.mainFeatures, /\r?\n/),
  };
}

function portfolioDescription(project) {
  const info = portfolioInfo(project);
  const sections = [
    info.name,
    info.category && `Category: ${info.category}`,
    info.url && `Website: ${info.url}`,
    info.description,
    info.technologies.length && `Technologies: ${info.technologies.join(', ')}`,
    info.features.length && `Main features\n${info.features.map((item) => `- ${item}`).join('\n')}`,
  ].filter(Boolean);
  return sections.length ? sections.join('\n\n') + '\n' : '';
}

function copyBlock(info, frame, scale) {
  const { x, y, width, height } = frame;
  const size = 24 * scale;
  const lineHeight = size * 1.23;
  const limit = Math.max(12, Math.floor(width / (size * 0.61)));
  const blocks = [];
  if (info.description) blocks.push({ copy: info.description, lines: 3, fill: '#ccd0e0' });
  if (info.technologies.length) blocks.push({ copy: info.technologies.join(' · '), lines: 2, fill: '#c3b6f8' });
  if (info.features.length) blocks.push({ copy: info.features.join(' · '), lines: 3, fill: '#ccd0e0' });
  let top = y;
  return blocks.map((block, index) => {
    const reserved = blocks.length - index - 1;
    const available = Math.floor((height - (top - y) - size * 0.25 * reserved) / lineHeight) - reserved;
    if (available < 1) return '';
    const lines = wrapText(block.copy, limit, Math.min(block.lines, available));
    const markup = svgText(lines, { x, y: top + size * 0.77, size, lineHeight, fill: block.fill });
    top += lines.length * lineHeight + size * 0.25;
    return markup;
  }).join('');
}

function titleBlock(info, frame, scale) {
  const { x, y, width, height } = frame;
  const size = Math.min(86 * scale, width / 7.5, height * 0.35);
  const detail = Math.min(25 * scale, size * 0.45);
  const type = wrapText(info.category, Math.max(8, Math.floor(width / (detail * 0.61))), 1);
  const title = wrapText(info.name, Math.max(8, Math.floor(width / (size * 0.64))), 2);
  const host = wrapText(info.url, Math.max(8, Math.floor(width / (detail * 0.6))), 1);
  const titleY = y + (type.length ? detail * 1.5 : 0) + size * 0.84;
  const urlY = titleY + Math.max(0, title.length - 1) * size * 1.16 + detail * 1.54;
  return [
    svgText(type, { x, y: y + detail, size: detail, fill: '#c3b6f8', weight: 600 }),
    svgText(title, { x, y: titleY, size, fill: '#fbf9ff', weight: 700 }),
    svgText(host, { x, y: urlY, size: detail, fill: '#afb7cd' }),
  ].join('');
}

function artFrames(width, height, portrait, padding, size) {
  const gap = padding * 0.45;
  const labelSpace = 35 * size;
  const totalWidth = width - 2 * padding;
  const top = height * (portrait ? 0.39 : 0.34);
  const space = height - top - padding;
  if (portrait) {
    const desktopWidth = (totalWidth - gap) * 0.75;
    const rowHeight = space * 0.46;
    return [
      { key: 'desktop', label: 'Desktop', x: padding, y: top, width: desktopWidth, height: rowHeight - labelSpace },
      { key: 'mobile', label: 'Mobile', x: padding + desktopWidth + gap, y: top, width: totalWidth - desktopWidth - gap, height: rowHeight - labelSpace },
      { key: 'mockup', label: 'Device mockup', x: padding, y: top + rowHeight + gap, width: totalWidth, height: space - rowHeight - gap - labelSpace },
    ];
  }
  const usableWidth = totalWidth - gap * 2;
  const desktopWidth = usableWidth * 0.43;
  const phoneWidth = usableWidth * 0.16;
  return [
    { key: 'desktop', label: 'Desktop', x: padding, y: top, width: desktopWidth, height: space - labelSpace },
    { key: 'mobile', label: 'Mobile', x: padding + desktopWidth + gap, y: top, width: phoneWidth, height: space - labelSpace },
    { key: 'mockup', label: 'Device mockup', x: padding + desktopWidth + phoneWidth + gap * 2, y: top, width: usableWidth - desktopWidth - phoneWidth, height: space - labelSpace },
  ];
}

async function artPanel(asset, frame, scale, fraction) {
  const { key, label, x, y, width, height } = frame;
  const labelSize = 22 * scale;
  const top = y + 35 * scale;
  const r = 15 * scale;
  const uri = await embeddedImage(asset, width * fraction, height * fraction, { fit: 'contain', background: '#191824' });
  return `<defs><clipPath id="art-${key}"><rect x="${x}" y="${top}" width="${width}" height="${height}" rx="${r}"/></clipPath></defs>
    ${svgText([label], { x, y: y + labelSize * 0.83, size: labelSize, fill: '#c8c9d8', weight: 500 })}
    <image x="${x}" y="${top}" width="${width}" height="${height}" clip-path="url(#art-${key})" xlink:href="${uri}"/>
    <rect x="${x}" y="${top}" width="${width}" height="${height}" rx="${r}" fill="none" stroke="#f3f0ff" stroke-opacity=".21"/>`;
}

async function renderPortfolio(options = {}) {
  const info = portfolioInfo(options.project);
  if (!info.name) throw new Error('Choose a project for the portfolio presentation.');
  if (!options.desktopImage || !options.mobileImage) {
    throw new Error('Capture or choose desktop and mobile screenshots for the portfolio presentation.');
  }
  const preset = Object.hasOwn(PORTFOLIO_PRESETS, options.preset)
    ? PORTFOLIO_PRESETS[options.preset]
    : PORTFOLIO_PRESETS.custom;
  const { width, height } = dimensions(options, preset);
  const scale = Math.min(width, height) / 1080;
  const padding = 62 * scale;
  const fraction = options.previewWidth ? number(options.previewWidth, width, 160, width) / width : 1;
  const portrait = width < height * 1.08;
  const frames = artFrames(width, height, portrait, padding, scale);
  const mockupFrame = frames.at(-1);
  const mockupScale = Math.max(1, 320 / Math.min(mockupFrame.width, mockupFrame.height));
  const mockup = options.mockupImage ?? await renderMockup({
    image: options.desktopImage,
    mobileImage: options.mobileImage,
    template: 'purple-gradient',
    device: 'laptop-phone',
    width: Math.round(mockupFrame.width * mockupScale),
    height: Math.round(mockupFrame.height * mockupScale),
    previewWidth: options.previewWidth ? Math.round(mockupFrame.width * fraction) : undefined,
  });
  const panels = await Promise.all(frames.map((frame, index) => artPanel(
    [options.desktopImage, options.mobileImage, mockup][index],
    frame,
    scale,
    fraction,
  )));

  const titleFrame = {
    x: padding,
    y: padding,
    width: portrait ? width - padding * 2 : width * 0.5,
    height: height * (portrait ? 0.16 : 0.24),
  };
  const copyFrame = portrait
    ? { x: padding, y: height * 0.235, width: width - padding * 2, height: height * 0.126 }
    : { x: width * 0.59, y: padding, width: width * 0.41 - padding, height: height * 0.23 };
  return encodeSvg(`<defs>
    <linearGradient id="ink" x2="1" y2="1"><stop stop-color="#282039"/><stop offset="1" stop-color="#10131e"/></linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#ink)"/>
  <circle cx="${width * 0.93}" cy="${height * 0.06}" r="${height * 0.29}" fill="#8970ce" fill-opacity=".085"/>
  <path d="M ${padding} ${frames[0].y - 23 * scale} H ${width - padding}" stroke="#9b8cab" stroke-opacity=".36"/>
  ${titleBlock(info, titleFrame, scale)}
  ${copyBlock(info, copyFrame, scale)}
  ${panels.join('')}`, width, height, options);
}

module.exports = { PORTFOLIO_PRESETS, portfolioDescription, portfolioInfo, renderPortfolio };
