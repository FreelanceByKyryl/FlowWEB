'use strict';

const { number, dimensions, color, wrapText, svgText, embeddedImage, encodeSvg } = require('./graphics');

const DEVICE_TEMPLATES = Object.freeze({
  desktop: 'Desktop monitor',
  laptop: 'Laptop',
  smartphone: 'Smartphone',
  tablet: 'Tablet',
  browser: 'Browser window',
  'laptop-phone': 'Laptop and smartphone',
  'desktop-mobile': 'Desktop and mobile',
});

const MOCKUP_PRESETS = Object.freeze({
  'minimal-dark': { label: 'Minimal Dark', background: '#17181d', text: '#f1f2f7', muted: '#a6a9b5', accent: '#7376a4', device: 'desktop', layout: 'top', motif: 'none' },
  'minimal-light': { label: 'Minimal Light', background: '#f0f0ee', text: '#181820', muted: '#535464', accent: '#adabc6', device: 'laptop', layout: 'top', motif: 'none' },
  'purple-gradient': { label: 'Purple Gradient', background: '#613bd0', gradient: '#181d50', text: '#fffaff', muted: '#e2d9fe', accent: '#ffeded', device: 'laptop-phone', layout: 'top', motif: 'orbit' },
  'premium-studio': { label: 'Premium Studio', background: '#202734', gradient: '#0c1119', text: '#f9f3eb', muted: '#aeb6c3', accent: '#b4a18b', device: 'desktop', layout: 'bottom', motif: 'spotlight' },
  'floating-devices': { label: 'Floating Devices', background: '#f2e9f7', gradient: '#c9d8ef', text: '#232139', muted: '#494563', accent: '#62568f', device: 'laptop-phone', layout: 'side', motif: 'orbit' },
  'browser-showcase': { label: 'Browser Showcase', background: '#222939', gradient: '#11161e', text: '#eff6ff', muted: '#b1bdce', accent: '#749abe', device: 'browser', layout: 'top', motif: 'grid' },
  editorial: { label: 'Editorial Presentation', background: '#e7dccc', text: '#201d19', muted: '#595149', accent: '#8b6b53', device: 'tablet', layout: 'side', motif: 'rules' },
  'clean-portfolio': { label: 'Clean Portfolio', background: '#f3f5f4', gradient: '#dbe8e5', text: '#192d2c', muted: '#4a6361', accent: '#6b8d88', device: 'desktop-mobile', layout: 'bottom', motif: 'rules' },
});

const FRAME_SPECS = {
  desktop: { width: 926, height: 606, screen: [13, 13, 900, 506], corner: 7 },
  laptop: { width: 1000, height: 608, screen: [75, 21, 850, 531], corner: 8 },
  smartphone: { width: 300, height: 606, screen: [13, 13, 274, 580], corner: 33 },
  tablet: { width: 794, height: 606, screen: [20, 20, 754, 566], corner: 15 },
  browser: { width: 944, height: 566, screen: [1, 47, 942, 518], corner: 12 },
};

function motif(name, width, height, accent) {
  if (name === 'orbit') {
    return `<circle cx="${width * 0.76}" cy="${height * 0.35}" r="${height * 0.54}" fill="none" stroke="${accent}" stroke-opacity=".2"/>
      <circle cx="${width * 0.76}" cy="${height * 0.35}" r="${height * 0.68}" fill="none" stroke="${accent}" stroke-opacity=".14"/>`;
  }
  if (name === 'spotlight') {
    return `<defs><radialGradient id="spotlight"><stop stop-color="${accent}" stop-opacity=".31"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient></defs>
      <ellipse cx="${width * 0.5}" cy="${height * 0.48}" rx="${width * 0.46}" ry="${height * 0.55}" fill="url(#spotlight)"/>`;
  }
  if (name === 'grid') {
    return `<defs><pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M 48 0 H 0 V 48" fill="none" stroke="${accent}" stroke-opacity=".15"/></pattern></defs>
      <rect width="${width}" height="${height}" fill="url(#grid)"/>`;
  }
  if (name === 'rules') {
    return `<path d="M ${width * 0.04} ${height * 0.054} H ${width * 0.96} M ${width * 0.04} ${height * 0.946} H ${width * 0.96}"
      stroke="${accent}" stroke-opacity=".43" stroke-width="1.5"/>`;
  }
  return '';
}

function tone(hex) {
  const digits = hex.slice(1);
  const pairs = digits.length === 3 ? Array.from(digits, (digit) => digit + digit) : digits.match(/../g);
  const [red, green, blue] = pairs.map((pair) => Number.parseInt(pair, 16));
  return red * 0.21 + green * 0.72 + blue * 0.07;
}

function frameChassis(device) {
  const metal = 'url(#metal)';
  switch (device) {
    case 'desktop':
      return `<path d="M424 520h78l10 63H414z" fill="${metal}"/><rect x="346" y="581" width="234" height="16" rx="8" fill="${metal}"/>
        <rect width="926" height="538" rx="21" fill="#111218" stroke="#565967" stroke-width="2"/>
        <path d="M4 520h918v3a14 14 0 0 1-14 14H18A14 14 0 0 1 4 523z" fill="#292b34"/>
        <circle cx="463" cy="529" r="2.8" fill="#666e8e"/>`;
    case 'laptop':
      return `<rect x="61" y="5" width="878" height="565" rx="23" fill="#15161d" stroke="#606473" stroke-width="2"/>
        <path d="M7 568h986v12l-34 11H41L7 580z" fill="${metal}" stroke="#5c6170" stroke-width="1.5"/>
        <path d="M420 569h160l-10 7H430z" fill="#363943"/><circle cx="500" cy="12" r="3.5" fill="#5c6685"/>`;
    case 'smartphone':
      return `<rect x="-2" y="94" width="5" height="54" rx="2" fill="#5b5e6b"/>
        <rect x="297" y="111" width="5" height="66" rx="2" fill="#5b5e6b"/>
        <rect width="300" height="606" rx="45" fill="#111218" stroke="#5c5f6b" stroke-width="2.5"/>`;
    case 'tablet':
      return `<rect width="794" height="606" rx="37" fill="#181921" stroke="#5b5f71" stroke-width="2.5"/>
        <circle cx="397" cy="10" r="3" fill="#6a7087"/>`;
    case 'browser':
      return `<rect width="944" height="566" rx="16" fill="#282b35" stroke="#535969" stroke-width="2"/>
        <circle cx="25" cy="23" r="5" fill="#ed777f"/><circle cx="43" cy="23" r="5" fill="#eac271"/><circle cx="61" cy="23" r="5" fill="#7ad39e"/>
        <rect x="105" y="12" width="739" height="23" rx="6" fill="#181a22"/>
        <path d="M458 23h28" stroke="#5d6274" stroke-width="2.5" stroke-linecap="round"/>`;
  }
}

function screenDetails(device) {
  if (device !== 'smartphone') return '';
  return '<rect x="107" y="22" width="86" height="18" rx="9" fill="#111218"/><path d="M121 578h58" stroke="#9c9dac" stroke-width="3" stroke-linecap="round"/>';
}

async function frame(device, asset, key, scale, radius) {
  const spec = FRAME_SPECS[device];
  const [x, y, width, height] = spec.screen;
  const uri = await embeddedImage(asset, width * scale, height * scale, { position: 'north' });
  const clip = radius == null ? spec.corner : Math.min(height / 2, width / 2, radius / scale);
  return `<defs><clipPath id="screen-${key}"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${clip}"/></clipPath></defs>
    ${frameChassis(device)}
    <image x="${x}" y="${y}" width="${width}" height="${height}" clip-path="url(#screen-${key})" xlink:href="${uri}"/>
    ${screenDetails(device)}`;
}

function textLayout(options, palette, width, height, padding) {
  const side = palette.layout === 'side' && width > height * 1.15;
  const bottom = palette.layout === 'bottom';
  const widthAvailable = side ? width * 0.3 : width - padding * 2;
  const titleSize = Math.min(height * 0.068, widthAvailable * 0.115);
  const detailSize = titleSize * 0.38;
  const title = wrapText(options.title, Math.max(8, Math.floor(widthAvailable / (titleSize * 0.63))), 2);
  const subtitle = wrapText(options.subtitle, Math.max(10, Math.floor(widthAvailable / (detailSize * 0.63))), 2);
  const text = wrapText(options.text, Math.max(10, Math.floor(widthAvailable / (detailSize * 0.63))), 2);

  const blocks = [
    { lines: title, size: titleSize, fill: palette.text, weight: 700 },
    { lines: subtitle, size: detailSize, fill: palette.text, weight: 500 },
    { lines: text, size: detailSize * 0.92, fill: palette.muted, weight: 400 },
  ].filter((block) => block.lines.length);
  const gap = detailSize * 0.46;
  const textHeight = blocks.reduce((total, block) => total + block.size * (1 + 1.16 * (block.lines.length - 1)), 0)
    + Math.max(0, blocks.length - 1) * gap;
  const anchors = { left: 'start', center: 'middle', right: 'end' };
  const anchor = Object.hasOwn(anchors, options.align) ? anchors[options.align] : (side ? 'start' : 'middle');
  const x = ({ start: padding, middle: padding + widthAvailable / 2, end: padding + widthAvailable })[anchor];
  const from = side ? (height - textHeight) / 2 : (bottom ? height - padding - textHeight : padding);
  let lineTop = from;
  const markup = blocks.map((block) => {
    const result = svgText(block.lines, { x, y: lineTop + block.size * 0.84, anchor, ...block });
    lineTop += block.size * (1 + 1.16 * (block.lines.length - 1)) + gap;
    return result;
  }).join('');
  return { side: side && textHeight > 0, bottom, textHeight, markup };
}

async function renderMockup(options = {}) {
  const { width, height } = dimensions(options, { width: 1920, height: 1080 });
  const preset = Object.hasOwn(MOCKUP_PRESETS, options.template)
    ? MOCKUP_PRESETS[options.template]
    : MOCKUP_PRESETS['minimal-dark'];
  const device = Object.hasOwn(DEVICE_TEMPLATES, options.device) ? options.device : preset.device;
  const image = options.image ?? options.mobileImage;
  if (!image) throw new Error('Choose a website screenshot to create a mockup.');

  const background = color(options.background, preset.background);
  const gradient = options.gradient === false ? null : color(options.gradient, preset.gradient);
  const isLight = (tone(background) + tone(gradient ?? background)) / 2 > 153;
  const usePresetText = isLight === (tone(preset.text) < 153);
  const palette = {
    ...preset,
    text: usePresetText ? preset.text : (isLight ? '#17151e' : '#ffffff'),
    muted: usePresetText ? preset.muted : (isLight ? '#3f3b4b' : '#e6e1ed'),
  };
  const padding = number(options.padding, Math.min(width, height) * 0.065, 0, Math.min(width, height) * 0.3);
  const radius = options.radius == null || options.radius === '' ? null : number(options.radius, 16, 0, 300);
  const text = textLayout(options, palette, width, height, padding);
  const textSpace = text.textHeight ? text.textHeight + Math.min(width, height) * 0.03 : 0;

  const scene = { x: padding, y: padding, width: width - padding * 2, height: height - padding * 2 };
  if (text.side) {
    const textWidth = width * 0.32;
    scene.x += textWidth;
    scene.width -= textWidth;
  } else {
    scene.height -= textSpace;
    if (!text.bottom) scene.y += textSpace;
  }
  scene.width = Math.max(scene.width, width * 0.16);
  scene.height = Math.max(scene.height, height * 0.16);

  const combo = ['laptop-phone', 'desktop-mobile'].includes(device);
  const primaryDevice = device === 'laptop-phone' ? 'laptop' : device === 'desktop-mobile' ? 'desktop' : device;
  const spec = FRAME_SPECS[primaryDevice];
  const frameWidth = spec.width + (combo ? 126 : 0);
  const frameHeight = spec.height + (combo ? 20 : 0);
  const scale = Math.min(scene.width / frameWidth, scene.height / frameHeight)
    * number(options.scale, 92, 20, 180) / 100;
  const centerX = scene.x + scene.width / 2 + width * number(options.positionX, 0, -100, 100) / 100;
  const centerY = scene.y + scene.height / 2 + height * number(options.positionY, 0, -100, 100) / 100;
  const rotation = number(options.rotation, 0, -45, 45);
  const perspective = number(options.perspective, 0, -65, 65);
  const skew = perspective * 0.27;
  const perspectiveScale = Math.cos(perspective * Math.PI / 180);
  const shadow = number(options.shadow, 55, 0, 100) / 100;
  const previewFraction = options.previewWidth ? Math.min(1, number(options.previewWidth, width, 160, width) / width) : 1;
  const phoneScale = 0.62;
  const [primary, secondary, backdrop] = await Promise.all([
    frame(primaryDevice, primaryDevice === 'smartphone' ? options.mobileImage ?? image : image, 'primary', scale * previewFraction, radius === null ? null : radius * previewFraction),
    combo ? frame('smartphone', options.mobileImage ?? image, 'phone', scale * phoneScale * previewFraction, radius === null ? null : radius * previewFraction) : '',
    options.backgroundImage ? embeddedImage(options.backgroundImage, width * previewFraction, height * previewFraction, { background }) : '',
  ]);
  const backgroundArt = backdrop
    ? `<image width="${width}" height="${height}" xlink:href="${backdrop}"/>`
    : motif(palette.motif, width, height, palette.accent);
  const tint = backdrop && text.textHeight
    ? `<rect width="${width}" height="${height}" fill="${background}" opacity=".58"/>`
    : '';

  const composition = `<defs>
    <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
      <stop stop-color="#aeb2bf"/><stop offset="1" stop-color="#444753"/>
    </linearGradient>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">
      <stop stop-color="${background}"/><stop offset="1" stop-color="${gradient ?? background}"/>
    </linearGradient>
    <filter id="shadow" x="-60%" y="-160%" width="220%" height="420%"><feGaussianBlur stdDeviation="25 17"/></filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#background)"/>
  ${backgroundArt}
  ${tint}
  <g transform="translate(${centerX} ${centerY}) rotate(${rotation}) skewY(${skew}) scale(${scale * perspectiveScale} ${scale}) translate(${-frameWidth / 2} ${-frameHeight / 2})">
    ${shadow ? `<ellipse cx="${frameWidth / 2}" cy="${frameHeight - 10}" rx="${frameWidth * 0.43}" ry="${frameHeight * 0.045}"
      fill="#090814" opacity="${shadow * 0.59}" filter="url(#shadow)"/>` : ''}
    ${primary}
    ${secondary ? `<g transform="translate(${frameWidth - FRAME_SPECS.smartphone.width * phoneScale} ${frameHeight - FRAME_SPECS.smartphone.height * phoneScale}) scale(${phoneScale})">${secondary}</g>` : ''}
  </g>
  ${text.markup}`;

  return encodeSvg(composition, width, height, options);
}

module.exports = { renderMockup, MOCKUP_PRESETS, DEVICE_TEMPLATES };
