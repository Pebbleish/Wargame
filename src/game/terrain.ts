import { MAP } from '../sim/config';
import {
  CROSSINGS, HILLS, MARSHES, OBJECTIVES, RIVER, RIVER_WIDTH, ROADS, VILLAGE_RADIUS, Vec, WOODS,
} from '../sim/map';
import { Rng } from '../sim/rng';

/** Paints the battlefield once into a canvas, in the muted painted-map style of the reference. */
export function paintTerrain(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = MAP.width;
  canvas.height = MAP.height;
  const g = canvas.getContext('2d')!;
  const rng = new Rng(1866);

  g.fillStyle = '#a9a86c';
  g.fillRect(0, 0, MAP.width, MAP.height);

  // Broad colour variation across the fields.
  for (let i = 0; i < 520; i++) {
    const x = rng.range(0, MAP.width);
    const y = rng.range(0, MAP.height);
    const r = rng.range(120, 380);
    const light = rng.next() < 0.5;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, light ? 'rgba(212,203,140,0.16)' : 'rgba(104,122,62,0.16)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Ploughed field patches with fine hatching.
  for (let i = 0; i < 300; i++) {
    const x = rng.range(0, MAP.width);
    const y = rng.range(0, MAP.height);
    const w = rng.range(140, 340);
    const h = rng.range(90, 220);
    const a = rng.range(-0.6, 0.6);
    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.fillStyle = rng.next() < 0.5 ? 'rgba(190,180,110,0.12)' : 'rgba(120,135,70,0.12)';
    g.fillRect(-w / 2, -h / 2, w, h);
    g.strokeStyle = 'rgba(70,70,40,0.07)';
    g.lineWidth = 2;
    g.beginPath();
    for (let k = -w / 2; k < w / 2; k += 9) {
      g.moveTo(k, -h / 2);
      g.lineTo(k, h / 2);
    }
    g.stroke();
    g.restore();
  }

  // Hills: a raised, lit top and hachures down the slopes.
  for (const h of HILLS) {
    const grad = g.createRadialGradient(h.x - h.r * 0.25, h.y - h.r * 0.25, h.r * 0.1, h.x, h.y, h.r);
    grad.addColorStop(0, 'rgba(232,222,160,0.35)');
    grad.addColorStop(0.7, 'rgba(160,150,95,0.15)');
    grad.addColorStop(1, 'rgba(80,80,45,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(h.x, h.y, h.r, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(80,70,40,0.25)';
    g.lineWidth = 2;
    for (let k = 0; k < 90; k++) {
      const a = (k / 90) * Math.PI * 2;
      const r0 = h.r * rng.range(0.55, 0.7);
      const r1 = h.r * rng.range(0.85, 1);
      g.beginPath();
      g.moveTo(h.x + Math.cos(a) * r0, h.y + Math.sin(a) * r0);
      g.lineTo(h.x + Math.cos(a) * r1, h.y + Math.sin(a) * r1);
      g.stroke();
    }
  }

  // Marshes: dark wet ground with pools and reed tufts.
  for (const m of MARSHES) {
    const grad = g.createRadialGradient(m.x, m.y, m.r * 0.2, m.x, m.y, m.r);
    grad.addColorStop(0, 'rgba(70,90,70,0.45)');
    grad.addColorStop(0.8, 'rgba(80,95,65,0.3)');
    grad.addColorStop(1, 'rgba(80,95,65,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    g.fill();
    for (let k = 0; k < 10; k++) {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.sqrt(rng.next()) * m.r * 0.75;
      g.fillStyle = 'rgba(90,130,150,0.45)';
      g.beginPath();
      g.ellipse(m.x + Math.cos(a) * d, m.y + Math.sin(a) * d, rng.range(10, 26), rng.range(5, 12), rng.range(0, 3), 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = 'rgba(50,60,30,0.55)';
    g.lineWidth = 2;
    for (let k = 0; k < 60; k++) {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.sqrt(rng.next()) * m.r * 0.9;
      const x = m.x + Math.cos(a) * d;
      const y = m.y + Math.sin(a) * d;
      g.beginPath();
      g.moveTo(x - 4, y); g.lineTo(x - 6, y - 9);
      g.moveTo(x, y); g.lineTo(x, y - 11);
      g.moveTo(x + 4, y); g.lineTo(x + 6, y - 9);
      g.stroke();
    }
  }

  // Roads.
  const strokeLine = (pts: Vec[], width: number, color: string) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    pts.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.y) : g.lineTo(p.x, p.y)));
    g.stroke();
  };
  for (const r of ROADS) strokeLine(r, 18, 'rgba(120,100,62,0.55)');
  for (const r of ROADS) strokeLine(r, 11, '#c8b489');

  // River with soft banks (some maps have none).
  if (RIVER.length) {
  strokeLine(RIVER, RIVER_WIDTH + 26, 'rgba(70,85,45,0.35)');
  strokeLine(RIVER, RIVER_WIDTH + 6, '#4f84ad');
  strokeLine(RIVER, RIVER_WIDTH - 12, '#6aa3cc');
  strokeLine(RIVER, 6, 'rgba(190,225,245,0.5)');
  }

  // Bridge and fords.
  for (const c of CROSSINGS) {
    if (c.ford) {
      g.fillStyle = 'rgba(220,210,170,0.55)';
      g.beginPath();
      g.ellipse(c.x, c.y, 55, 30, 0.1, 0, Math.PI * 2);
      g.fill();
    } else {
      g.save();
      g.translate(c.x, c.y);
      g.rotate(0.05);
      g.fillStyle = 'rgba(40,30,20,0.35)';
      g.fillRect(-46, -11, 92, 26);
      g.fillStyle = '#9b8a72';
      g.fillRect(-46, -14, 92, 26);
      g.strokeStyle = '#5d4f3e';
      g.lineWidth = 3;
      g.strokeRect(-46, -14, 92, 26);
      g.restore();
    }
  }

  // Woods: clusters of small painted trees with shadows.
  // Woods are made of overlapping lobes; each lobe skips the ground an earlier lobe already covered.
  WOODS.forEach((w, wi) => {
    const count = Math.floor((w.r * w.r) / 140);
    const trees: Vec[] = [];
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.sqrt(rng.next()) * w.r;
      const t = { x: w.x + Math.cos(a) * d, y: w.y + Math.sin(a) * d };
      if (WOODS.slice(0, wi).some((o) => Math.hypot(t.x - o.x, t.y - o.y) < o.r)) continue;
      trees.push(t);
    }
    trees.sort((a, b) => a.y - b.y);
    for (const t of trees) {
      g.fillStyle = 'rgba(30,40,20,0.35)';
      g.beginPath();
      g.ellipse(t.x + 6, t.y + 7, 11, 7, 0, 0, Math.PI * 2);
      g.fill();
    }
    for (const t of trees) {
      const r = rng.range(8, 13);
      g.fillStyle = rng.next() < 0.5 ? '#3e5a2c' : '#4a6834';
      g.beginPath();
      g.arc(t.x, t.y, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(150,180,90,0.35)';
      g.beginPath();
      g.arc(t.x - r * 0.3, t.y - r * 0.35, r * 0.45, 0, Math.PI * 2);
      g.fill();
    }
  });

  // Villages and supply depots: red-roofed houses clustered along the roads.
  for (const o of OBJECTIVES) {
    if (o.kind === 'bridge') continue;
    const houses = o.kind === 'depot' ? 6 : 16;
    for (let i = 0; i < houses; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(15, VILLAGE_RADIUS);
      const x = o.x + Math.cos(a) * d;
      const y = o.y + Math.sin(a) * d;
      const rot = rng.range(-0.4, 0.4) + (rng.next() < 0.5 ? 0 : Math.PI / 2);
      g.save();
      g.translate(x, y);
      g.rotate(rot);
      g.fillStyle = 'rgba(40,30,20,0.35)';
      g.fillRect(-12, -6, 28, 18);
      g.fillStyle = '#b4573e';
      g.fillRect(-14, -9, 28, 18);
      g.fillStyle = '#8c3f2c';
      g.fillRect(-14, -1, 28, 2);
      g.restore();
    }
    if (o.kind === 'depot') {
      // Supply tents and a wagon park.
      for (let i = 0; i < 6; i++) {
        const tx = o.x - 70 + (i % 3) * 45;
        const ty = o.y + 40 + Math.floor(i / 3) * 34;
        g.fillStyle = 'rgba(40,30,20,0.3)';
        g.beginPath(); g.moveTo(tx + 4, ty + 16); g.lineTo(tx + 20, ty - 4); g.lineTo(tx + 36, ty + 16); g.fill();
        g.fillStyle = '#e9e0c4';
        g.beginPath(); g.moveTo(tx, ty + 12); g.lineTo(tx + 16, ty - 8); g.lineTo(tx + 32, ty + 12); g.closePath(); g.fill();
      }
      for (let i = 0; i < 5; i++) {
        g.fillStyle = '#6b5236';
        g.fillRect(o.x + 70, o.y - 40 + i * 22, 30, 12);
      }
    }
  }

  // Drifting cloud shadows and a soft vignette.
  for (let i = 0; i < 36; i++) {
    const x = rng.range(0, MAP.width);
    const y = rng.range(0, MAP.height);
    const r = rng.range(250, 600);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(30,40,30,0.09)');
    grad.addColorStop(1, 'rgba(30,40,30,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const vg = g.createRadialGradient(MAP.width / 2, MAP.height / 2, MAP.height * 0.5, MAP.width / 2, MAP.height / 2, MAP.width * 0.65);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(40,35,20,0.35)');
  g.fillStyle = vg;
  g.fillRect(0, 0, MAP.width, MAP.height);

  return canvas;
}
