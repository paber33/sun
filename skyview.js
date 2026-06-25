'use strict';

// ─── Sky View: 3D dome renderer with gyroscope ────────────────────────────────

const SKY = {
  canvas: null,
  ctx: null,
  rafId: null,
  // Camera state
  alpha: 180,   // compass bearing camera faces (0=N, 90=E, 180=S, 270=W)
  beta:  90,    // device tilt (90 = upright portrait)
  gamma: 0,     // roll
  // Manual drag state (desktop / touch fallback)
  drag: { active: false, lastX: 0, lastY: 0 },
  hasGyro: false,
  // Sun data (set on open)
  lat: 0, lng: 0, date: null, minutes: 0,
  sunTimes: null,
  sunPathPoints: [],   // [{az, alt, ms, label}]
  FOV: 70,            // horizontal field of view in degrees
};

// ─── Public API ───────────────────────────────────────────────────────────────

async function openSkyView() {
  const overlay = document.getElementById('skyview-overlay');
  const canvas  = document.getElementById('skyview-canvas');
  overlay.classList.remove('hidden');
  // Ensure styles regardless of CSS cache state
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '9000',
    background: '#07080f', display: 'flex',
  });
  Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block', touchAction: 'none' });
  document.body.style.overflow = 'hidden';

  SKY.canvas = canvas;
  SKY.ctx    = canvas.getContext('2d');

  // Load current sun data
  const d = window.getSkyData ? window.getSkyData() : { lat: 51.5, lng: -0.1, date: new Date(), minutes: 720 };
  SKY.lat     = d.lat;
  SKY.lng     = d.lng;
  SKY.date    = d.date;
  SKY.minutes = d.minutes;

  // Pre-compute sun path
  _buildSunPath();

  // Default camera direction: face towards sun (or south in southern hemisphere)
  const cd0 = new Date(d.date);
  cd0.setHours(Math.floor(d.minutes / 60), d.minutes % 60, 0, 0);
  const pos0 = SunCalc.getPosition(cd0, d.lat, d.lng);
  const az0  = (pos0.azimuth * 180 / Math.PI + 180 + 360) % 360;
  const alt0 = pos0.altitude * 180 / Math.PI;
  SKY.alpha = az0;
  SKY.beta  = 90 + Math.max(0, Math.min(50, alt0));  // tilt up to show sun

  // Resize canvas
  _resize();
  window.addEventListener('resize', _resize);

  // Gyroscope
  SKY.hasGyro = false;
  try {
    await _requestOrientation();
    SKY.hasGyro = true;
  } catch (e) {
    // No gyro or denied — use drag mode
  }

  // Drag fallback
  _initDrag();

  // Start render loop
  SKY.rafId = requestAnimationFrame(_loop);
}

function closeSkyView() {
  const overlay = document.getElementById('skyview-overlay');
  overlay.classList.add('hidden');
  document.body.style.overflow = '';

  if (SKY.rafId) { cancelAnimationFrame(SKY.rafId); SKY.rafId = null; }
  window.removeEventListener('resize', _resize);
  window.removeEventListener('deviceorientation', _onOrientation, true);
  _removeDrag();
}

// ─── Orientation ──────────────────────────────────────────────────────────────

async function _requestOrientation() {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS 13+
    const perm = await DeviceOrientationEvent.requestPermission();
    if (perm !== 'granted') throw new Error('denied');
  } else if (typeof DeviceOrientationEvent === 'undefined') {
    throw new Error('not supported');
  }
  window.addEventListener('deviceorientation', _onOrientation, true);
}

function _onOrientation(e) {
  if (e.alpha == null) return;
  SKY.hasGyro = true;
  SKY.alpha = e.alpha || 0;
  SKY.beta  = e.beta  != null ? e.beta  : 90;
  SKY.gamma = e.gamma != null ? e.gamma : 0;
}

// ─── Drag (desktop + touch fallback) ─────────────────────────────────────────

function _initDrag() {
  const c = SKY.canvas;
  c.addEventListener('mousedown',  _dragStart);
  c.addEventListener('mousemove',  _dragMove);
  c.addEventListener('mouseup',    _dragEnd);
  c.addEventListener('mouseleave', _dragEnd);
  c.addEventListener('touchstart', _touchStart, { passive: true });
  c.addEventListener('touchmove',  _touchMove,  { passive: false });
  c.addEventListener('touchend',   _dragEnd);
}

function _removeDrag() {
  const c = SKY.canvas;
  if (!c) return;
  c.removeEventListener('mousedown',  _dragStart);
  c.removeEventListener('mousemove',  _dragMove);
  c.removeEventListener('mouseup',    _dragEnd);
  c.removeEventListener('mouseleave', _dragEnd);
  c.removeEventListener('touchstart', _touchStart);
  c.removeEventListener('touchmove',  _touchMove);
  c.removeEventListener('touchend',   _dragEnd);
}

function _dragStart(e) { if (SKY.hasGyro) return; SKY.drag.active = true; SKY.drag.lastX = e.clientX; SKY.drag.lastY = e.clientY; }
function _dragEnd()    { SKY.drag.active = false; }
function _dragMove(e) {
  if (!SKY.drag.active || SKY.hasGyro) return;
  const dx = e.clientX - SKY.drag.lastX;
  const dy = e.clientY - SKY.drag.lastY;
  SKY.alpha = (SKY.alpha + dx * 0.3 + 360) % 360;
  SKY.beta  = Math.max(20, Math.min(160, SKY.beta - dy * 0.3));
  SKY.drag.lastX = e.clientX;
  SKY.drag.lastY = e.clientY;
}
function _touchStart(e) {
  if (SKY.hasGyro || !e.touches[0]) return;
  SKY.drag.active = true;
  SKY.drag.lastX = e.touches[0].clientX;
  SKY.drag.lastY = e.touches[0].clientY;
}
function _touchMove(e) {
  if (!SKY.drag.active || SKY.hasGyro || !e.touches[0]) return;
  e.preventDefault();
  const dx = e.touches[0].clientX - SKY.drag.lastX;
  const dy = e.touches[0].clientY - SKY.drag.lastY;
  SKY.alpha = (SKY.alpha + dx * 0.3 + 360) % 360;
  SKY.beta  = Math.max(20, Math.min(160, SKY.beta - dy * 0.3));
  SKY.drag.lastX = e.touches[0].clientX;
  SKY.drag.lastY = e.touches[0].clientY;
}

// ─── Resize ───────────────────────────────────────────────────────────────────

function _resize() {
  SKY.canvas.width  = SKY.canvas.offsetWidth  * devicePixelRatio;
  SKY.canvas.height = SKY.canvas.offsetHeight * devicePixelRatio;
}

// ─── Render loop ──────────────────────────────────────────────────────────────

function _loop() {
  _render();
  SKY.rafId = requestAnimationFrame(_loop);
}

function _render() {
  const { ctx, canvas, alpha, beta, gamma, FOV } = SKY;
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;

  ctx.clearRect(0, 0, W, H);

  // Camera basis vectors
  const cam = _cameraBasis(alpha, beta, gamma);

  // ── Sky/ground gradient background ──────────────────────────────────────────
  // Determine what fraction of screen is sky vs ground based on camera elevation
  const elev = beta - 90;  // camera elevation angle in degrees
  const horizonY = cy + elev / (FOV * H / W * 0.5) * cy;

  const skyGrad = ctx.createLinearGradient(0, 0, 0, H);
  skyGrad.addColorStop(0,   '#07080f');
  skyGrad.addColorStop(0.4, '#0d1525');
  skyGrad.addColorStop(1,   '#111c32');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, W, H);

  // Ground
  const groundY = Math.max(0, Math.min(H, horizonY));
  if (groundY < H) {
    const groundGrad = ctx.createLinearGradient(0, groundY, 0, H);
    groundGrad.addColorStop(0, '#0a0e08');
    groundGrad.addColorStop(1, '#060a05');
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, groundY, W, H - groundY);
  }

  // ── Grid ─────────────────────────────────────────────────────────────────────
  _drawGrid(ctx, cam, W, H);

  // ── Sun path ─────────────────────────────────────────────────────────────────
  _drawSunPath(ctx, cam, W, H);

  // ── Sun dot ──────────────────────────────────────────────────────────────────
  _drawSunDot(ctx, cam, W, H);

  // ── HUD ──────────────────────────────────────────────────────────────────────
  _drawHUD(ctx, W, H);
}

// ─── Projection ───────────────────────────────────────────────────────────────

// Convert azimuth (compass degrees, 0=N) + altitude (degrees) → ENU unit vector
function _azAltToENU(azDeg, altDeg) {
  const az  = azDeg  * Math.PI / 180;
  const alt = altDeg * Math.PI / 180;
  return [
    Math.sin(az) * Math.cos(alt),   // East
    Math.cos(az) * Math.cos(alt),   // North
    Math.sin(alt)                   // Up
  ];
}

function _dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

// Camera basis: [fwd, right, up] from alpha (compass deg), beta (device tilt deg), gamma (roll deg)
function _cameraBasis(alphaDeg, betaDeg, gammaDeg) {
  const a  = alphaDeg * Math.PI / 180;
  const th = (betaDeg - 90) * Math.PI / 180;  // elevation angle camera looks at
  const g  = gammaDeg * Math.PI / 180;

  // Forward (camera looks in this direction)
  const fwd = [
     Math.sin(a) * Math.cos(th),
     Math.cos(a) * Math.cos(th),
     Math.sin(th)
  ];
  // Right (no roll)
  const right0 = [Math.cos(a), -Math.sin(a), 0];
  // Up (no roll)
  const up0 = [
    -Math.sin(a) * Math.sin(th),
    -Math.cos(a) * Math.sin(th),
     Math.cos(th)
  ];
  // Apply roll (gamma)
  const right = [
    right0[0] * Math.cos(g) + up0[0] * Math.sin(g),
    right0[1] * Math.cos(g) + up0[1] * Math.sin(g),
    right0[2] * Math.cos(g) + up0[2] * Math.sin(g),
  ];
  const up = [
    up0[0] * Math.cos(g) - right0[0] * Math.sin(g),
    up0[1] * Math.cos(g) - right0[1] * Math.sin(g),
    up0[2] * Math.cos(g) - right0[2] * Math.sin(g),
  ];
  return { fwd, right, up };
}

// Project ENU point to screen coords. Returns null if behind camera or outside FOV.
function _project(P, cam, W, H) {
  const df = _dot(P, cam.fwd);
  if (df < 0.05) return null;

  const dr = _dot(P, cam.right);
  const du = _dot(P, cam.up);

  const focal = (W / 2) / Math.tan(SKY.FOV / 2 * Math.PI / 180);
  const x = W / 2 + (dr / df) * focal;
  const y = H / 2 - (du / df) * focal;
  return { x, y, df };
}

// ─── Draw Grid ────────────────────────────────────────────────────────────────

function _drawGrid(ctx, cam, W, H) {
  ctx.save();
  ctx.lineWidth = Math.max(1, W / 600);

  // Altitude rings: 0° (horizon), 30°, 60°, 90°
  const altRings = [0, 30, 60, 90];
  altRings.forEach(alt => {
    const pts = [];
    for (let az = 0; az <= 360; az += 3) {
      const P = _azAltToENU(az, alt);
      const s = _project(P, cam, W, H);
      if (s) pts.push(s);
    }
    if (pts.length < 2) return;

    ctx.beginPath();
    ctx.strokeStyle = alt === 0 ? 'rgba(100,130,180,0.55)' : 'rgba(60,80,120,0.3)';
    ctx.setLineDash(alt === 0 ? [] : [W/80, W/60]);
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // Cardinal directions at horizon
  const dirs = [
    { az: 0,   label: 'N',  color: '#ef4444' },
    { az: 45,  label: 'NE', color: '#94a3b8' },
    { az: 90,  label: 'E',  color: '#94a3b8' },
    { az: 135, label: 'SE', color: '#94a3b8' },
    { az: 180, label: 'S',  color: '#94a3b8' },
    { az: 225, label: 'SW', color: '#94a3b8' },
    { az: 270, label: 'W',  color: '#94a3b8' },
    { az: 315, label: 'NW', color: '#94a3b8' },
  ];

  const labelSize = Math.max(14, W / 30);
  ctx.font = `bold ${labelSize}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  dirs.forEach(d => {
    const P = _azAltToENU(d.az, -2); // slightly below horizon so label sits on it
    const s = _project(P, cam, W, H);
    if (!s) return;
    // Only draw if on screen
    if (s.x < -50 || s.x > W+50 || s.y < -50 || s.y > H+50) return;

    ctx.fillStyle = d.color;
    ctx.shadowColor = d.color;
    ctx.shadowBlur = d.label === 'N' ? 8 : 0;
    ctx.fillText(d.label, s.x, s.y);
    ctx.shadowBlur = 0;
  });

  // Altitude labels (30°, 60°)
  const smallFont = Math.max(10, W / 45);
  ctx.font = `${smallFont}px -apple-system, system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(100,130,180,0.7)';
  [30, 60].forEach(alt => {
    const P = _azAltToENU(90, alt); // label on East side
    const s = _project(P, cam, W, H);
    if (!s || s.x < 0 || s.x > W || s.y < 0 || s.y > H) return;
    ctx.fillText(`${alt}°`, s.x + labelSize, s.y);
  });

  ctx.restore();
}

// ─── Draw Sun Path ────────────────────────────────────────────────────────────

function _buildSunPath() {
  const { lat, lng, date } = SKY;
  const sunTimes = SunCalc.getTimes(date, lat, lng);
  SKY.sunTimes = sunTimes;
  SKY.sunPathPoints = [];

  const sr = sunTimes.sunrise, ss = sunTimes.sunset;
  if (!sr || isNaN(sr.getTime())) return;

  const srMs = sr.getTime(), ssMs = ss.getTime();
  const STEPS = 144; // every 5 min

  for (let i = 0; i <= STEPS; i++) {
    const t  = i / STEPS;
    const ms = srMs + t * (ssMs - srMs);
    const d  = new Date(ms);
    const pos = SunCalc.getPosition(d, lat, lng);
    const az  = (pos.azimuth * 180 / Math.PI + 180 + 360) % 360;
    const alt = pos.altitude * 180 / Math.PI;

    // Hourly label
    let label = null;
    const minutes = d.getHours() * 60 + d.getMinutes();
    if (d.getMinutes() < 5) {
      label = `${d.getHours()}h`;
    }

    // Phase coloring
    let phase = 'day';
    const ghEnd   = sunTimes.goldenHourEnd;
    const ghStart = sunTimes.goldenHour;
    if (ghEnd && ms < ghEnd.getTime()) phase = 'golden';
    if (ghStart && ms > ghStart.getTime()) phase = 'golden';

    SKY.sunPathPoints.push({ az, alt, ms, label, phase });
  }

  // Also add below-horizon extension (dashed future/past)
  // 2h before sunrise
  for (let i = 24; i >= 0; i--) {
    const ms  = srMs - i * 5 * 60000;
    const pos = SunCalc.getPosition(new Date(ms), lat, lng);
    const az  = (pos.azimuth * 180 / Math.PI + 180 + 360) % 360;
    const alt = pos.altitude * 180 / Math.PI;
    SKY.sunPathPoints.unshift({ az, alt, ms, label: null, phase: 'below' });
  }
  // 2h after sunset
  for (let i = 0; i <= 24; i++) {
    const ms  = ssMs + i * 5 * 60000;
    const pos = SunCalc.getPosition(new Date(ms), lat, lng);
    const az  = (pos.azimuth * 180 / Math.PI + 180 + 360) % 360;
    const alt = pos.altitude * 180 / Math.PI;
    SKY.sunPathPoints.push({ az, alt, ms, label: null, phase: 'below' });
  }
}

function _drawSunPath(ctx, cam, W, H) {
  if (!SKY.sunPathPoints.length) return;
  ctx.save();
  ctx.lineWidth = Math.max(2, W / 250);
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  // Draw segments grouped by phase
  let prevPt = null, prevScreen = null;

  SKY.sunPathPoints.forEach(pt => {
    const P = _azAltToENU(pt.az, pt.alt);
    const s = _project(P, cam, W, H);

    if (s && prevScreen) {
      // Check if segment is roughly continuous (not wrapping around)
      const dist = Math.hypot(s.x - prevScreen.x, s.y - prevScreen.y);
      if (dist < W * 0.6) {
        ctx.beginPath();
        ctx.moveTo(prevScreen.x, prevScreen.y);
        ctx.lineTo(s.x, s.y);

        if (pt.phase === 'below') {
          ctx.strokeStyle = 'rgba(100,120,180,0.25)';
          ctx.setLineDash([W/120, W/80]);
        } else if (pt.phase === 'golden') {
          ctx.strokeStyle = 'rgba(251,191,36,0.85)';
          ctx.setLineDash([]);
        } else {
          ctx.strokeStyle = 'rgba(255,245,220,0.55)';
          ctx.setLineDash([]);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    prevPt = pt;
    prevScreen = s;

    // Hour labels
    if (pt.label && s) {
      ctx.save();
      const fontSize = Math.max(10, W / 50);
      ctx.font = `${fontSize}px -apple-system, system-ui, sans-serif`;
      ctx.fillStyle = pt.phase === 'golden' ? 'rgba(251,191,36,0.9)' : 'rgba(200,200,220,0.8)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      // Dot marker
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(2, W/200), 0, Math.PI * 2);
      ctx.fillStyle = pt.phase === 'golden' ? '#fbbf24' : 'rgba(200,200,220,0.7)';
      ctx.fill();
      // Label
      ctx.fillStyle = pt.phase === 'golden' ? 'rgba(251,191,36,0.95)' : 'rgba(200,200,220,0.85)';
      ctx.fillText(pt.label, s.x, s.y - W/120);
      ctx.restore();
    }
  });

  ctx.restore();
}

// ─── Draw Sun Dot ─────────────────────────────────────────────────────────────

function _drawSunDot(ctx, cam, W, H) {
  const { lat, lng, date, minutes } = SKY;
  const cd = new Date(date);
  cd.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  const pos = SunCalc.getPosition(cd, lat, lng);
  const az  = (pos.azimuth * 180 / Math.PI + 180 + 360) % 360;
  const alt = pos.altitude * 180 / Math.PI;

  SKY._currentAz  = az;
  SKY._currentAlt = alt;

  const P = _azAltToENU(az, alt);
  const s = _project(P, cam, W, H);
  if (!s) return;

  const r = Math.max(10, W / 40);

  // Glow
  const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 2.5);
  grad.addColorStop(0,   'rgba(251,191,36,0.6)');
  grad.addColorStop(0.4, 'rgba(245,158,11,0.3)');
  grad.addColorStop(1,   'rgba(245,158,11,0)');
  ctx.beginPath();
  ctx.arc(s.x, s.y, r * 2.5, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Core
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#f59e0b';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(s.x, s.y, r * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = '#fef3c7';
  ctx.fill();
}

// ─── Draw HUD ────────────────────────────────────────────────────────────────

function _drawHUD(ctx, W, H) {
  const dpr = devicePixelRatio;
  ctx.save();

  // ── Facing direction (top center) ──
  const facingAz = Math.round(SKY.alpha + 360) % 360;
  const facingDir = _azToCardinal(facingAz);
  const topFont = Math.max(14, W / 28) / dpr * dpr;

  ctx.font = `bold ${Math.max(14, W/28)}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 6;
  ctx.fillText(`${facingDir}  ${facingAz}°`, W / 2, Math.max(40, H / 18));
  ctx.shadowBlur = 0;

  // ── Sun info (bottom bar) ──
  if (SKY._currentAz != null) {
    const az  = SKY._currentAz;
    const alt = SKY._currentAlt;
    const barH = Math.max(50, H / 12);
    const barY = H - barH;

    ctx.fillStyle = 'rgba(7,8,15,0.75)';
    ctx.fillRect(0, barY, W, barH);

    ctx.font = `${Math.max(11, W/45)}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(200,200,220,0.8)';
    ctx.fillText('SUN', W * 0.05, barY + barH * 0.38);
    ctx.fillText('AZ', W * 0.38, barY + barH * 0.38);
    ctx.fillText('ALT', W * 0.65, barY + barH * 0.38);

    ctx.font = `bold ${Math.max(14, W/32)}px -apple-system, system-ui, sans-serif`;
    ctx.fillStyle = '#f59e0b';
    const cd = new Date(SKY.date);
    cd.setHours(Math.floor(SKY.minutes/60), SKY.minutes%60, 0, 0);
    ctx.fillText(cd.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', hour12: false }), W * 0.05, barY + barH * 0.78);

    ctx.fillStyle = alt > 0 ? '#fcd34d' : '#60a5fa';
    ctx.textAlign = 'left';
    ctx.fillText(`${az.toFixed(1)}°`, W * 0.38, barY + barH * 0.78);
    ctx.fillText(`${alt.toFixed(1)}°`, W * 0.65, barY + barH * 0.78);
  }

  // ── Compass rose (top-right) ──
  _drawCompassRose(ctx, W - Math.max(44, W / 10), Math.max(44, H / 14), Math.max(22, W / 22));

  // ── Gyro hint (if no gyro) ──
  if (!SKY.hasGyro) {
    ctx.font = `${Math.max(12, W/38)}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(148,163,184,0.7)';
    ctx.fillText('Drag to look around', W / 2, H - Math.max(70, H / 8));
  }

  ctx.restore();
}

function _drawCompassRose(ctx, cx, cy, r) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((SKY.alpha) * Math.PI / 180);

  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(13,16,32,0.7)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(60,80,120,0.6)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // N arrow
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.85);
  ctx.lineTo(r * 0.22, 0);
  ctx.lineTo(0, r * 0.25);
  ctx.lineTo(-r * 0.22, 0);
  ctx.closePath();
  ctx.fillStyle = '#ef4444';
  ctx.fill();

  // S arrow
  ctx.beginPath();
  ctx.moveTo(0, r * 0.85);
  ctx.lineTo(r * 0.22, 0);
  ctx.lineTo(0, -r * 0.25);
  ctx.lineTo(-r * 0.22, 0);
  ctx.closePath();
  ctx.fillStyle = 'rgba(148,163,184,0.7)';
  ctx.fill();

  ctx.restore();
}

function _azToCardinal(az) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(az / 22.5) % 16];
}
