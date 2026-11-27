// Each SVG unit is one pixel of the original 16 × 13 sprite.
const BODY = '#927CE5';
const PAW = '#725EC8';
const INK = '#181820';
const BLUSH = '#F472B6';

function rect(x, y, width = 1, height = 1, color = BODY) {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${color}"/>`;
}

function face(mode) {
  if (mode === 'happy') {
    const smile = x => rect(x, 5, 1, 1, INK) + rect(x + 1, 4, 1, 1, INK) + rect(x + 2, 5, 1, 1, INK);
    return smile(2) + smile(8) + rect(1, 6, 1, 1, BLUSH) + rect(11, 6, 1, 1, BLUSH);
  }
  if (mode === 'angry') {
    return rect(2, 4, 1, 1, INK) + rect(3, 5, 2, 1, INK) + rect(8, 5, 2, 1, INK) + rect(10, 4, 1, 1, INK);
  }
  if (mode === 'shake') {
    return rect(2, 5, 2, 1, INK) + rect(9, 4, 2, 1, INK);
  }
  if (mode === 'sleeping') {
    return rect(2, 5, 2, 1, INK) + rect(8, 5, 2, 1, INK);
  }
  return rect(2, 4, 1, 2, INK) + rect(9, 4, 1, 2, INK);
}

function legs(xs) {
  return xs.map(x => rect(x, 9) + rect(x, 10, 1, 1, PAW)).join('');
}

const bubbles = { hop: '喵~', happy: '♥', shake: '哼!', angry: '💢 别戳啦!' };

function overlay(mode) {
  if (Object.hasOwn(bubbles, mode)) {
    return `<span class="cat-meow" aria-hidden="true">${bubbles[mode]}</span>`;
  }
  if (mode === 'sleeping') {
    return '<span class="cat-zzz" aria-hidden="true"><span>z</span><span>Z</span><span>z</span></span>';
  }
  if (mode === 'working') return '<span class="cat-badge spark" aria-hidden="true">✦</span>';
  if (mode === 'blocked') return '<span class="cat-badge blocked" aria-hidden="true">!</span>';
  return '';
}

export function renderPixelCat({ mode = 'strolling', reaction, label = '点击像素小猫', freezeLeft, freezeFlip }) {
  const reacting = Object.hasOwn(bubbles, reaction);
  const pose = reacting ? reaction : ['working', 'blocked', 'sleeping'].includes(mode) ? mode : 'strolling';
  const walkerStyle = reacting && Number.isFinite(freezeLeft) ? `style="left:${freezeLeft}px"` : '';
  const facingStyle = reacting ? `style="transform:scaleX(${freezeFlip === -1 ? -1 : 1})"` : '';
  const name = String(label).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `
    <button type="button" id="btnCatPet" class="cat-runway mode-${pose} tip-trigger tip-bottom-right"
            data-tip="${name}" aria-label="${name}">
      <span class="cat-walker" ${walkerStyle}>
        ${overlay(pose)}
        <span class="cat-facing" ${facingStyle}>
          <svg class="cat-svg" viewBox="0 0 16 13" width="26" height="21" shape-rendering="crispEdges" aria-hidden="true">
            <rect x="1" y="11" width="12" height="1" fill="var(--cat-shadow)"/>
            ${rect(1, 0)}${rect(1, 1, 2)}${rect(12, 0)}${rect(11, 1, 2)}
            ${rect(1, 2, 12, 7)}
            <g class="cat-tail">${rect(13, 6, 1, 1, PAW)}${rect(13, 7)}${rect(14, 4, 1, 3)}</g>
            ${face(pose)}
            <g class="cat-legs-a">${legs([2, 4, 9, 11])}</g>
            <g class="cat-legs-b">${legs([1, 5, 8, 12])}</g>
          </svg>
        </span>
      </span>
    </button>`;
}
