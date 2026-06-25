'use strict';

// ─── Sky View: 3D dome renderer with gyroscope ────────────────────────────────

const SKY = {
  canvas: null,
  ctx: null,
  rafId: null,
  // Camera state (smoothed)
  alpha: 180,   // compass bearing camera faces (0=N, 90=E, 180=S, 270=W)
  beta:  90,    // device tilt (90 = upright portrait = horizontal look)
  gamma: 0,     // roll
  // Manual drag state (desktop / touch fallback)
  drag: { active: false, lastX: 0, lastY: 0 },
  hasGyro: false,
  _absListener: null,   // which event is active
  _relListener: null,
  // Sun data (set on open)
  lat: 0, lng: 0, date: null, minutes: 0,
  sunTimes: null,
  sunPathPoints: [],
  FOV: 95,   // horizontal field of view in degrees — wide for dome feel
};

// Smoothing state (separate so we can reset without clobbering SKY.alpha)
const _sm = { alpha: 180, beta: 90, gamma: 0 };
const SMOOTH = 0.12;  // exponential factor: lower = smoother, higher = more responsive

// ─── Public API ───────────────────────────────────────────────────────────────

async function openSkyView() {
  const overlay = document.getElementById('skyview-overlay');
  const canvas  = document.getElementById('skyview-canvas');
  overlay.classList.remove('hidden');
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '9000',
    background: '#07080f', display: 'flex',
  });
  Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block', touchAction: 'none' });
  document.body.style.overflow = 'hidden';

  SKY.canvas = canvas;
  SKY.ctx    = canvas.getContext('2d');

  // Load current sun data
  const d = window.getSkyData
    ? window.getSkyData()
    : { lat: 51.5, lng: -0.1, date: new Date(), minutes: 720 };
  SKY.lat     = d.lat;
  SKY.lng     = d.lng;
  SKY.date    = d.date;
  SKY.minutes = d.minutes;

  _buildSunPath();

  // Time slider
  _initTimeSlider();
  _applyTimeBarStyles();

  // Default camera: face toward current sun azimuth, or south if below horizon
  const cd0 = new Date(d.date);
  cd0.setHours(Math.floor(d.minutes / 60), d.minutes % 60, 0, 0);
  const pos0 = SunCalc.getPosition(cd0, d.lat, d.lng);
  const az0  = (pos0.azimuth * 180 / Math.PI + 180 + 360) % 360;
  const alt0 = Math.max(0, pos0.altitude * 180 / Math.PI);
  SKY.alpha = az0;
  SKY.beta  = 90;   // start horizontal — user tilts up with gyro to find the sun
  _sm.alpha = SKY.alpha; _sm.beta = 90; _sm.gamma = 0;

  _resize();
  window.addEventListener('resize', _resize);

  SKY.hasGyro = false;
  try {
    await _requestOrientation();
    SKY.hasGyro = true;
  } catch (_) {
    // Drag mode fallback
  }

  _initDrag();
  SKY.rafId = requestAnimationFrame(_loop);
}

function closeSkyView() {
  const overlay = document.getElementById('skyview-overlay');
  overlay.classList.add('hidden');
  document.body.style.overflow = '';

  if (SKY.rafId) { cancelAnimationFrame(SKY.rafId); SKY.rafId = null; }
  window.removeEventListener('resize', _resize);
  if (SKY._absListener) {
    window.removeEventListener('deviceorientationabsolute', SKY._absListener, true);
    SKY._absListener = null;
  }
  if (SKY._relListener) {
    window.removeEventListener('deviceorientation', SKY._relListener, true);
    SKY._relListener = null;
  }
  _removeDrag();
  SKY.hasGyro = false;
}

// ─── Orientation ──────────────────────────────────────────────────────────────

function _handleOrientation(e) {
  SKY.hasGyro = true;

  // Compass-aligned heading:
  // iOS:     e.webkitCompassHeading (clockwise from North, always absolute)
  // Android: alpha from deviceorientationabsolute (clockwise from North)
  let alphaRaw;
  if (e.webkitCompassHeading != null && e.webkitCompassHeading >= 0) {
    alphaRaw = e.webkitCompassHeading;
  } else {
    alphaRaw = e.alpha ?? 0;
  }

  const betaRaw  = e.beta  ?? 90;
  const gammaRaw = e.gamma ?? 0;

  // Circular smoothing for alpha
  let da = alphaRaw - _sm.alpha;
  if (da >  180) da -= 360;
  if (da < -180) da += 360;
  _sm.alpha = (_sm.alpha + SMOOTH * da + 360) % 360;
  _sm.beta  = _sm.beta  + SMOOTH * (betaRaw  - _sm.beta);
  _sm.gamma = _sm.gamma + SMOOTH * (gammaRaw - _sm.gamma);

  SKY.alpha = _sm.alpha;
  SKY.beta  = Math.max(90, _sm.beta);  // never look below horizon
  SKY.gamma = _sm.gamma;
}

async function _requestOrientation() {
  if (typeof DeviceOrientationEvent === 'undefined') throw new Error('not supported');

  // iOS 13+: must ask permission on user gesture
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    const perm = await DeviceOrientationEvent.requestPermission();
    if (perm !== 'granted') throw new Error('denied');
    const handler = e => _handleOrientation(e);
    SKY._relListener = handler;
    window.addEventListener('deviceorientation', handler, true);
    return;
  }

  // Android: try deviceorientationabsolute first (compass-aligned)
  const absSupported = await new Promise(resolve => {
    const test = e => {
      clearTimeout(timer);
      resolve(e.alpha != null);
    };
    window.addEventListener('deviceorientationabsolute', test, { once: true, capture: true });
    const timer = setTimeout(() => {
      window.removeEventListener('deviceorientationabsolute', test, true);
      resolve(false);
    }, 400);
  });

  if (absSupported) {
    const handler = e => _handleOrientation(e);
    SKY._absListener = handler;
    window.addEventListener('deviceorientationabsolute', handler, true);
  } else {
    // Fallback: regular deviceorientation (alpha may be relative, not compass)
    const handler = e => _handleOrientation(e);
    SKY._relListener = handler;
    window.addEventListener('deviceorientation', handler, true);
  }
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
  SKY.alpha = (SKY.alpha + dx * 0.25 + 360) % 360;
  SKY.beta  = Math.max(90, Math.min(170, SKY.beta - dy * 0.25));
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
  SKY.alpha = (SKY.alpha + dx * 0.25 + 360) % 360;
  SKY.beta  = Math.max(90, Math.min(170, SKY.beta - dy * 0.25));
  SKY.drag.lastX = e.touches[0].clientX;
  SKY.drag.lastY = e.touches[0].clientY;
}

// ─── Time slider ─────────────────────────────────────────────────────────────

function _applyTimeBarStyles() {
  const bar = document.getElementById('skyview-time-bar');
  if (!bar) return;
  Object.assign(bar.style, {
    position: 'absolute', bottom: '0', left: '0', right: '0',
    height: '72px', background: 'rgba(4,5,12,0.92)',
    borderTop: '1px solid rgba(60,90,150,0.5)',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    gap: '6px', padding: '0 20px', zIndex: '9015',
  });
  const label = document.getElementById('skyview-time-label');
  if (label) Object.assign(label.style, {
    fontSize: '13px', fontWeight: '600', color: '#f59e0b',
    letterSpacing: '1px', fontFamily: '-apple-system, system-ui, sans-serif',
  });
  const slider = document.getElementById('skyview-slider');
  if (slider) Object.assign(slider.style, {
    width: '100%', height: '4px', cursor: 'pointer',
    accentColor: '#f59e0b', outline: 'none',
  });
}

function _initTimeSlider() {
  const slider = document.getElementById('skyview-slider');
  const label  = document.getElementById('skyview-time-label');
  if (!slider) return;

  slider.value = SKY.minutes;
  label.textContent = _minsToTime(SKY.minutes);

  slider.oninput = () => {
    SKY.minutes = parseInt(slider.value, 10);
    label.textContent = _minsToTime(SKY.minutes);
  };
}

function _minsToTime(mins) {
  const h = Math.floor(mins / 60).toString().padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
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

  ctx.clearRect(0, 0, W, H);

  const cam = _cameraBasis(alpha, beta, 0);  // ignore roll so horizon stays level

  // ── Horizon screen position ─────────────────────────────────────────────────
  // Horizon point projects at cy + tan(elev)*focal (positive = lower on screen when looking up)
  const elev   = (beta - 90) * Math.PI / 180;
  const focal  = (W / 2) / Math.tan(FOV / 2 * Math.PI / 180);
  const hY     = H * (0.5 + HORIZON_Y) + Math.tan(elev) * focal;
  const skyBot = Math.max(0, Math.min(H, hY));

  // ── Sky gradient ────────────────────────────────────────────────────────────
  const skyGrad = ctx.createLinearGradient(0, 0, 0, skyBot);
  skyGrad.addColorStop(0,    '#020308');
  skyGrad.addColorStop(0.55, '#07091a');
  skyGrad.addColorStop(1,    '#0d1428');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, W, skyBot);

  // ── Horizon atmospheric glow ────────────────────────────────────────────────
  const glowH = Math.max(30, H / 15);
  if (skyBot > 0 && skyBot < H) {
    const glowGrad = ctx.createLinearGradient(0, skyBot - glowH, 0, skyBot + glowH * 0.5);
    glowGrad.addColorStop(0,   'rgba(30,60,120,0)');
    glowGrad.addColorStop(0.5, 'rgba(40,80,160,0.18)');
    glowGrad.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = glowGrad;
    ctx.fillRect(0, Math.max(0, skyBot - glowH), W, glowH * 1.5);
  }

  // ── Ground ──────────────────────────────────────────────────────────────────
  if (skyBot < H) {
    const gGrad = ctx.createLinearGradient(0, skyBot, 0, H);
    gGrad.addColorStop(0,   '#0b0f0a');
    gGrad.addColorStop(0.4, '#080b07');
    gGrad.addColorStop(1,   '#050705');
    ctx.fillStyle = gGrad;
    ctx.fillRect(0, skyBot, W, H - skyBot);
  }

  // ── Grid ────────────────────────────────────────────────────────────────────
  _drawGrid(ctx, cam, W, H);

  // ── Sun path ────────────────────────────────────────────────────────────────
  _drawSunPath(ctx, cam, W, H);

  // ── Sun dot ─────────────────────────────────────────────────────────────────
  _drawSunDot(ctx, cam, W, H);

  // ── HUD ─────────────────────────────────────────────────────────────────────
  _drawHUD(ctx, W, H);
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

function _azAltToENU(azDeg, altDeg) {
  const az  = azDeg  * Math.PI / 180;
  const alt = altDeg * Math.PI / 180;
  return [
    Math.sin(az) * Math.cos(alt),  // East
    Math.cos(az) * Math.cos(alt),  // North
    Math.sin(alt)                  // Up
  ];
}

function _dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

// Camera basis from spherical coords:
// alpha = compass heading of camera (0=N,90=E,180=S,270=W)
// beta  = device tilt: 90=upright→horizontal look, >90=tilting up, <90=tilting down
// gamma = roll (phone tilt left/right)
function _cameraBasis(alphaDeg, betaDeg, gammaDeg) {
  const a  = alphaDeg * Math.PI / 180;
  const th = (betaDeg - 90) * Math.PI / 180;  // elevation angle
  const g  = gammaDeg * Math.PI / 180;

  const fwd = [
     Math.sin(a) * Math.cos(th),
     Math.cos(a) * Math.cos(th),
     Math.sin(th)
  ];
  const right0 = [ Math.cos(a), -Math.sin(a), 0];
  const up0    = [-Math.sin(a)*Math.sin(th), -Math.cos(a)*Math.sin(th), Math.cos(th)];

  // Apply roll (gamma): rotate right/up around fwd
  const cg = Math.cos(g), sg = Math.sin(g);
  const right = [
    right0[0]*cg + up0[0]*sg,
    right0[1]*cg + up0[1]*sg,
    right0[2]*cg + up0[2]*sg,
  ];
  const up = [
    up0[0]*cg - right0[0]*sg,
    up0[1]*cg - right0[1]*sg,
    up0[2]*cg - right0[2]*sg,
  ];
  return { fwd, right, up };
}

// Horizon offset: 0 = center, positive = lower on screen (sky gets more space)
const HORIZON_Y = 0.25;  // horizon sits at 75% from top (1/4 below center)

function _project(P, cam, W, H) {
  const df = _dot(P, cam.fwd);
  if (df < 0.05) return null;
  const focal = (W / 2) / Math.tan(SKY.FOV / 2 * Math.PI / 180);
  return {
    x: W / 2 + (_dot(P, cam.right) / df) * focal,
    y: H * (0.5 + HORIZON_Y) - (_dot(P, cam.up) / df) * focal,
    df
  };
}

// ─── Draw Grid ────────────────────────────────────────────────────────────────

function _drawGrid(ctx, cam, W, H) {
  ctx.save();
  const lw = Math.max(1, W / 700);

  // ── Altitude rings every 15° ──────────────────────────────────────────────
  for (let alt = 0; alt <= 90; alt += 15) {
    const isHorizon = alt === 0;
    const isZenith  = alt === 90;

    // Collect visible segments (break line when gap is too large)
    const segs = [[]];
    for (let az = 0; az <= 360; az += 2) {
      const s = _project(_azAltToENU(az, alt), cam, W, H);
      if (s) {
        const cur = segs[segs.length - 1];
        if (cur.length > 0) {
          const last = cur[cur.length - 1];
          if (Math.hypot(s.x - last.x, s.y - last.y) > W * 0.4) segs.push([]);
        }
        segs[segs.length - 1].push(s);
      } else {
        if (segs[segs.length - 1].length > 0) segs.push([]);
      }
    }

    segs.forEach(pts => {
      if (pts.length < 2) return;
      // Glow pass for horizon
      if (isHorizon) {
        ctx.beginPath();
        ctx.lineWidth = lw * 6;
        ctx.strokeStyle = 'rgba(80,130,220,0.12)';
        ctx.setLineDash([]);
        pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();
      }
      // Main line
      ctx.beginPath();
      ctx.lineWidth = isHorizon ? lw * 2.2 : lw * 0.9;
      ctx.strokeStyle = isHorizon
        ? 'rgba(140,185,255,0.75)'
        : isZenith
          ? 'rgba(80,120,200,0.3)'
          : 'rgba(60,90,160,0.32)';
      ctx.setLineDash(isHorizon || isZenith ? [] : [W / 65, W / 50]);
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Altitude label near the visible ring
    if (alt > 0 && alt < 90) {
      // Try multiple azimuths to find one on-screen
      for (const testAz of [90, 270, 0, 180, 45, 135, 225, 315]) {
        const ls = _project(_azAltToENU(testAz, alt), cam, W, H);
        if (ls && ls.x > W * 0.05 && ls.x < W * 0.95 && ls.y > H * 0.02 && ls.y < H * 0.92) {
          const fs = Math.max(9, W / 58);
          ctx.font = `${fs}px -apple-system, system-ui, sans-serif`;
          ctx.fillStyle = 'rgba(120,160,220,0.65)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${alt}°`, ls.x, ls.y - fs * 0.8);
          break;
        }
      }
    }
  }

  // ── Zenith crosshair ──────────────────────────────────────────────────────
  const zenith = _project([0, 0, 1], cam, W, H);
  if (zenith && zenith.x > 0 && zenith.x < W && zenith.y > 0 && zenith.y < H) {
    const cr = Math.max(8, W / 55);
    ctx.strokeStyle = 'rgba(140,180,255,0.55)';
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(zenith.x - cr, zenith.y); ctx.lineTo(zenith.x + cr, zenith.y);
    ctx.moveTo(zenith.x, zenith.y - cr); ctx.lineTo(zenith.x, zenith.y + cr);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(zenith.x, zenith.y, cr * 0.4, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(140,180,255,0.4)';
    ctx.stroke();
    const fs = Math.max(9, W / 60);
    ctx.font = `${fs}px -apple-system, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(140,180,255,0.5)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('90°', zenith.x, zenith.y + cr * 0.7);
  }

  // ── Azimuth spokes every 15° ──────────────────────────────────────────────
  for (let az = 0; az < 360; az += 15) {
    const pts = [];
    for (let alt = 0; alt <= 90; alt += 2) {
      const s = _project(_azAltToENU(az, alt), cam, W, H);
      if (s) {
        if (pts.length > 0 && Math.hypot(s.x - pts[pts.length-1].x, s.y - pts[pts.length-1].y) > W * 0.3) break;
        pts.push(s);
      }
    }
    if (pts.length < 2) continue;
    ctx.beginPath();
    ctx.lineWidth = az % 90 === 0 ? lw * 1.1 : lw * 0.7;
    ctx.strokeStyle = az % 90 === 0 ? 'rgba(80,115,185,0.38)' : 'rgba(50,75,140,0.2)';
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.stroke();
  }

  // ── Horizon tick marks + degree numbers every 30° ────────────────────────
  const tickAzStep = 30;
  const majFs  = Math.max(12, W / 32);
  const minFs  = Math.max(9,  W / 50);
  const tickLw = Math.max(1,  W / 600);

  for (let az = 0; az < 360; az += 10) {
    const isMaj  = az % tickAzStep === 0;
    const isCard = az % 90 === 0;
    const s0 = _project(_azAltToENU(az,  0.3), cam, W, H);
    const s1 = _project(_azAltToENU(az, -1.8), cam, W, H);
    if (!s0 || !s1) continue;
    if (s0.x < -40 || s0.x > W + 40) continue;

    // Tick line
    ctx.beginPath();
    ctx.lineWidth = tickLw * (isCard ? 2.5 : isMaj ? 1.6 : 1);
    ctx.strokeStyle = isCard
      ? 'rgba(180,210,255,0.7)'
      : isMaj
        ? 'rgba(120,160,220,0.5)'
        : 'rgba(80,110,170,0.3)';
    ctx.moveTo(s0.x, s0.y); ctx.lineTo(s1.x, s1.y);
    ctx.stroke();

    if (!isMaj) continue;

    // Cardinal letters
    const cardLabel = { 0:'N', 90:'E', 180:'S', 270:'W' }[az];
    const label = cardLabel || `${az}°`;
    const isN = az === 0;
    const fs  = isCard ? majFs : minFs;

    const sL = _project(_azAltToENU(az, -3.5), cam, W, H);
    if (!sL || sL.x < -30 || sL.x > W + 30 || sL.y < -20 || sL.y > H + 20) continue;

    ctx.font = `bold ${fs}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.shadowColor = isN ? '#ef4444' : 'rgba(0,0,0,0.8)';
    ctx.shadowBlur  = isN ? 12 : 4;
    ctx.fillStyle   = isN ? '#f87171' : isCard ? '#e2e8f0' : 'rgba(148,163,184,0.85)';
    ctx.fillText(label, sL.x, sL.y);
    ctx.shadowBlur = 0;
  }

  ctx.restore();
}

// ─── Draw Sun Path ────────────────────────────────────────────────────────────

function _buildSunPath() {
  const { lat, lng, date } = SKY;
  SKY.sunTimes = SunCalc.getTimes(date, lat, lng);
  SKY.sunPathPoints = [];

  const { sunrise, sunset, goldenHourEnd, goldenHour } = SKY.sunTimes;
  if (!sunrise || isNaN(sunrise.getTime())) return;

  const srMs = sunrise.getTime(), ssMs = sunset.getTime();
  const ghEndMs = goldenHourEnd ? goldenHourEnd.getTime() : srMs + 60 * 60000;
  const ghStartMs = goldenHour   ? goldenHour.getTime()    : ssMs - 60 * 60000;

  // 2h before sunrise → 2h after sunset, every 5 min
  const startMs = srMs - 2 * 3600000;
  const endMs   = ssMs + 2 * 3600000;
  const steps   = Math.round((endMs - startMs) / (5 * 60000));

  for (let i = 0; i <= steps; i++) {
    const ms  = startMs + i * 5 * 60000;
    const pos = SunCalc.getPosition(new Date(ms), lat, lng);
    const az  = (pos.azimuth * 180 / Math.PI + 180 + 360) % 360;
    const alt = pos.altitude * 180 / Math.PI;

    let phase = alt < 0 ? 'below' : ms < ghEndMs || ms > ghStartMs ? 'golden' : 'day';

    let label = null;
    const d = new Date(ms);
    if (d.getMinutes() < 5 && alt > -5) label = `${d.getHours()}h`;

    SKY.sunPathPoints.push({ az, alt, ms, label, phase });
  }
}

function _drawSunPath(ctx, cam, W, H) {
  if (!SKY.sunPathPoints.length) return;
  ctx.save();
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  const baseLw   = Math.max(3, W / 150);
  const glowLw   = Math.max(10, W / 40);

  // Two passes: glow (wide, low alpha) then solid (sharp)
  for (const pass of ['glow', 'solid']) {
    let prevScreen = null;

    SKY.sunPathPoints.forEach(pt => {
      const s = _project(_azAltToENU(pt.az, pt.alt), cam, W, H);

      if (s && prevScreen) {
        const dist = Math.hypot(s.x - prevScreen.x, s.y - prevScreen.y);
        if (dist < W * 0.5) {
          ctx.beginPath();
          ctx.moveTo(prevScreen.x, prevScreen.y);
          ctx.lineTo(s.x, s.y);

          if (pt.phase === 'below') {
            if (pass === 'solid') {
              ctx.lineWidth = Math.max(1.5, W / 300);
              ctx.strokeStyle = 'rgba(70,90,150,0.25)';
              ctx.setLineDash([W / 90, W / 60]);
              ctx.stroke();
              ctx.setLineDash([]);
            }
          } else if (pt.phase === 'golden') {
            if (pass === 'glow') {
              ctx.lineWidth = glowLw;
              ctx.strokeStyle = 'rgba(251,140,10,0.12)';
              ctx.stroke();
            } else {
              ctx.lineWidth = baseLw * 1.3;
              ctx.strokeStyle = 'rgba(251,175,20,0.95)';
              ctx.stroke();
            }
          } else {
            if (pass === 'glow') {
              ctx.lineWidth = glowLw * 0.7;
              ctx.strokeStyle = 'rgba(200,200,255,0.08)';
              ctx.stroke();
            } else {
              ctx.lineWidth = baseLw;
              ctx.strokeStyle = 'rgba(220,230,255,0.75)';
              ctx.stroke();
            }
          }
        }
      }
      prevScreen = s;

      // Hour label (solid pass only)
      if (pass === 'solid' && pt.label && s &&
          s.x >= 0 && s.x <= W && s.y >= 0 && s.y <= H) {
        const fs = Math.max(10, W / 50);
        const isGold = pt.phase === 'golden';
        const dotR = Math.max(3, W / 160);

        ctx.beginPath();
        ctx.arc(s.x, s.y, dotR, 0, Math.PI * 2);
        ctx.fillStyle = isGold ? '#fbbf24' : 'rgba(210,220,255,0.85)';
        ctx.fill();

        ctx.font = `bold ${fs}px -apple-system, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur  = 5;
        ctx.fillStyle   = isGold ? '#fde68a' : 'rgba(210,220,255,0.9)';
        ctx.fillText(pt.label, s.x, s.y - dotR - 2);
        ctx.shadowBlur = 0;
      }
    });
  }

  ctx.restore();
}

// ─── Draw Sun Dot ─────────────────────────────────────────────────────────────

function _drawSunDot(ctx, cam, W, H) {
  const cd = new Date(SKY.date);
  cd.setHours(Math.floor(SKY.minutes / 60), SKY.minutes % 60, 0, 0);
  const pos = SunCalc.getPosition(cd, SKY.lat, SKY.lng);
  const az  = (pos.azimuth * 180 / Math.PI + 180 + 360) % 360;
  const alt = pos.altitude * 180 / Math.PI;
  SKY._currentAz  = az;
  SKY._currentAlt = alt;

  const s = _project(_azAltToENU(az, alt), cam, W, H);
  if (!s) return;

  const r = Math.max(12, W / 38);

  // Outer glow
  const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 3);
  grad.addColorStop(0,   'rgba(251,191,36,0.55)');
  grad.addColorStop(0.45,'rgba(245,158,11,0.25)');
  grad.addColorStop(1,   'rgba(245,158,11,0)');
  ctx.beginPath();
  ctx.arc(s.x, s.y, r * 3, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Rays
  ctx.save();
  ctx.translate(s.x, s.y);
  for (let i = 0; i < 8; i++) {
    ctx.rotate(Math.PI / 4);
    ctx.beginPath();
    ctx.moveTo(0, r * 1.2);
    ctx.lineTo(0, r * 2.0);
    ctx.strokeStyle = 'rgba(251,191,36,0.4)';
    ctx.lineWidth = Math.max(1.5, W / 350);
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  ctx.restore();

  // Core disk
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#f59e0b';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(s.x, s.y, r * 0.5, 0, Math.PI * 2);
  ctx.fillStyle = '#fef9c3';
  ctx.fill();
}

// ─── Draw HUD ────────────────────────────────────────────────────────────────

function _drawHUD(ctx, W, H) {
  ctx.save();

  // ── Facing direction (top center) ──────────────────────────────────────────
  const facingAz  = Math.round(SKY.alpha + 360) % 360;
  const facingDir = _azToCardinal(facingAz);

  ctx.font = `bold ${Math.max(15, W / 26)}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 8;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(`${facingDir}  ${facingAz}°`, W / 2, Math.max(20, H / 22));
  ctx.shadowBlur = 0;

  // ── Bottom info bar (sits above the HTML time slider, ~72px) ───────────────
  if (SKY._currentAz != null) {
    const sliderH = 72 * devicePixelRatio;
    const barH = Math.max(56, H / 11);
    const barY = H - sliderH - barH;

    // Semi-transparent backdrop
    ctx.fillStyle = 'rgba(4,5,12,0.82)';
    ctx.fillRect(0, barY, W, barH);
    // Top edge line
    ctx.strokeStyle = 'rgba(60,90,150,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, barY); ctx.lineTo(W, barY); ctx.stroke();

    const labelFs = Math.max(10, W / 50);
    const valueFs = Math.max(14, W / 32);
    const col1 = W * 0.08, col2 = W * 0.38, col3 = W * 0.66;

    ctx.font = `${labelFs}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(148,163,184,0.75)';
    ctx.fillText('TIME',    col1, barY + barH * 0.1);
    ctx.fillText('AZIMUTH', col2, barY + barH * 0.1);
    ctx.fillText('ALTITUDE',col3, barY + barH * 0.1);

    const cd = new Date(SKY.date);
    cd.setHours(Math.floor(SKY.minutes / 60), SKY.minutes % 60, 0, 0);
    const timeStr = cd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const altColor = SKY._currentAlt > 0 ? '#fcd34d' : '#60a5fa';

    ctx.font = `bold ${valueFs}px -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#f59e0b';
    ctx.fillText(timeStr, col1, barY + barH * 0.95);
    ctx.fillStyle = altColor;
    ctx.fillText(`${SKY._currentAz.toFixed(1)}°`, col2, barY + barH * 0.95);
    ctx.fillText(`${SKY._currentAlt.toFixed(1)}°`, col3, barY + barH * 0.95);
  }

  // ── Compass rose (top-right) ───────────────────────────────────────────────
  const roseR = Math.max(24, W / 20);
  const roseX = W - roseR - Math.max(12, W / 40);
  const roseY = Math.max(24, H / 16) + roseR + Math.max(15, W / 26);
  _drawCompassRose(ctx, roseX, roseY, roseR);

  // ── Drag hint (desktop / no gyro) ─────────────────────────────────────────
  if (!SKY.hasGyro) {
    ctx.font = `${Math.max(12, W / 40)}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(148,163,184,0.65)';
    ctx.fillText('Drag to look around', W / 2, H - Math.max(65, H / 9));
  }

  ctx.restore();
}

function _drawCompassRose(ctx, cx, cy, r) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-SKY.alpha * Math.PI / 180);

  // Background circle
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(4,5,12,0.75)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(60,90,150,0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Tick marks every 45°
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    const inner = i % 2 === 0 ? r * 0.62 : r * 0.75;
    ctx.beginPath();
    ctx.moveTo(Math.sin(a) * inner, -Math.cos(a) * inner);
    ctx.lineTo(Math.sin(a) * r * 0.9, -Math.cos(a) * r * 0.9);
    ctx.strokeStyle = 'rgba(100,130,180,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // N arrow (red)
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.82);
  ctx.lineTo(r * 0.2, r * 0.12);
  ctx.lineTo(0, 0);
  ctx.lineTo(-r * 0.2, r * 0.12);
  ctx.closePath();
  ctx.fillStyle = '#ef4444';
  ctx.fill();

  // S arrow (gray)
  ctx.beginPath();
  ctx.moveTo(0, r * 0.82);
  ctx.lineTo(r * 0.2, -r * 0.12);
  ctx.lineTo(0, 0);
  ctx.lineTo(-r * 0.2, -r * 0.12);
  ctx.closePath();
  ctx.fillStyle = 'rgba(148,163,184,0.65)';
  ctx.fill();

  // N label
  ctx.rotate(0);
  const fs = Math.max(8, r / 2.8);
  ctx.font = `bold ${fs}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = '#ef4444';
  ctx.fillText('N', 0, -r * 0.82 - 2);

  ctx.restore();
}

function _azToCardinal(az) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(az / 22.5) % 16];
}
