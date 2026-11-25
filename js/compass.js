// Kompassanzeige wie in Jagd-Apps üblich: eine halbrunde Gradskala am unteren Rand.
// Die Skala ist ein Kreis, dessen oberer Bogen sichtbar ist. Sie dreht sich um -Richtung,
// damit die aktuelle Blickrichtung immer oben unter der festen Marke steht.

import { compassName } from './geo.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 300, CX = 150, CY = 175, R = 155;          // Kreismittelpunkt liegt unterhalb des sichtbaren Bereichs
const DIRS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];

export function buildDial(container) {
  const parts = [];
  for (let d = 0; d < 360; d += 5) {
    const major = d % 45 === 0, mid = d % 15 === 0;
    const len = major ? 20 : mid ? 13 : 8;
    const w = major ? 2.6 : mid ? 1.8 : 1.2;
    parts.push(`<line class="tick" x1="${CX}" y1="${CY - R}" x2="${CX}" y2="${CY - R + len}" stroke-width="${w}" transform="rotate(${d} ${CX} ${CY})"/>`);
    if (major) {
      parts.push(`<text class="dir${d === 0 ? ' n' : ''}" x="${CX}" y="${CY - R - 6}" text-anchor="middle" transform="rotate(${d} ${CX} ${CY})">${DIRS[d / 45]}</text>`);
      parts.push(`<text class="num" x="${CX}" y="${CY - R + 36}" text-anchor="middle" transform="rotate(${d} ${CX} ${CY})">${d}</text>`);
    } else if (d % 15 === 0) {
      parts.push(`<text class="num" x="${CX}" y="${CY - R + 31}" text-anchor="middle" font-size="10" opacity=".8" transform="rotate(${d} ${CX} ${CY})">${d}</text>`);
    }
  }
  container.innerHTML = `
    <svg viewBox="0 -14 ${W} 136" style="overflow:hidden" aria-hidden="true">
      <defs><clipPath id="dial-clip"><rect x="0" y="-14" width="${W}" height="136"/></clipPath></defs>
      <g clip-path="url(#dial-clip)">
        <g id="dial-rot">${parts.join('')}</g>
      </g>
      <!-- feste Marke: Linie über die Skala und Dreieck darunter zeigen auf die aktuelle Richtung -->
      <line x1="${CX}" y1="${CY - R - 2}" x2="${CX}" y2="${CY - R + 22}" stroke="#d9822b" stroke-width="3.2" stroke-linecap="round"/>
      <path class="index" d="M${CX} ${CY - R + 41} L${CX + 8} ${CY - R + 53} L${CX - 8} ${CY - R + 53}Z"/>
      <text class="read" id="dial-read" x="${CX}" y="112" text-anchor="middle">–</text>
    </svg>`;
  const rot = container.querySelector('#dial-rot');
  const read = container.querySelector('#dial-read');
  let pending = null, raf = 0;

  function draw() {
    raf = 0;
    if (pending === null) return;
    rot.setAttribute('transform', `rotate(${(-pending).toFixed(1)} ${CX} ${CY})`);
    read.textContent = `${Math.round(pending) % 360}° ${compassName(pending)}`;
  }

  return {
    /** h = Richtung in Grad (0 = Nord) oder null zum Ausblenden */
    update(h) {
      if (h === null || h === undefined) { container.hidden = true; pending = null; return; }
      container.hidden = false;
      pending = h;
      if (!raf) raf = requestAnimationFrame(draw); // höchstens einmal pro Bildschirmbild zeichnen
    }
  };
}
