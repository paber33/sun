'use strict';

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  lat: 51.5074,
  lng: -0.1278,
  locationName: 'London, UK',
  date: new Date(),
  minutes: new Date().getHours() * 60 + new Date().getMinutes(),
  isRealTime: true,
};

// ─── Map globals ─────────────────────────────────────────────────────────────
let map, marker, sunriseLine, sunsetLine, coordLabel;
let clockInterval = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initControls();
  initSearch();
  initSkyViewButtons();
  registerSW();
  updateAll();
  startClock();
  initSplash();
});

// ─── Service Worker ───────────────────────────────────────────────────────────
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ─── Leaflet Map ──────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
  }).setView([state.lat, state.lng], 11);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '© OpenStreetMap',
  }).addTo(map);

  const markerIcon = L.divIcon({
    className: '',
    html: '<div class="custom-marker"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
  marker = L.marker([state.lat, state.lng], { icon: markerIcon }).addTo(map);

  map.on('click', e => {
    setLocation(e.latlng.lat, e.latlng.lng, `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`);
  });
}

function updateMap(sunTimes) {
  marker.setLatLng([state.lat, state.lng]);
  map.setView([state.lat, state.lng], map.getZoom(), { animate: true });

  // Remove old direction lines
  if (sunriseLine) { map.removeLayer(sunriseLine); sunriseLine = null; }
  if (sunsetLine)  { map.removeLayer(sunsetLine);  sunsetLine  = null; }

  if (!isValidDate(sunTimes.sunrise) || !isValidDate(sunTimes.sunset)) return;

  const srPos = SunCalc.getPosition(sunTimes.sunrise, state.lat, state.lng);
  const ssPos = SunCalc.getPosition(sunTimes.sunset,  state.lat, state.lng);
  const srBearing = toCompassBearing(srPos.azimuth);
  const ssBearing = toCompassBearing(ssPos.azimuth);

  const dist = 15; // km
  const srEnd = destinationPoint(state.lat, state.lng, srBearing, dist);
  const ssEnd = destinationPoint(state.lat, state.lng, ssBearing, dist);

  sunriseLine = L.polyline([[state.lat, state.lng], srEnd], {
    color: '#fb923c', weight: 2, opacity: 0.8, dashArray: '6 4',
  }).addTo(map);

  sunsetLine = L.polyline([[state.lat, state.lng], ssEnd], {
    color: '#c084fc', weight: 2, opacity: 0.8, dashArray: '6 4',
  }).addTo(map);

  // Update coord label
  updateCoordLabel();
}

function updateCoordLabel() {
  const el = document.querySelector('.map-coords');
  if (el) el.textContent = `${state.lat.toFixed(4)}°, ${state.lng.toFixed(4)}°`;
}

// ─── Sun Arc (SVG) ────────────────────────────────────────────────────────────
function drawSunArc(sunTimes, currentDate) {
  const pathEl  = document.getElementById('arc-path');
  const sunDot  = document.getElementById('sun-dot');
  const timeDisp = document.getElementById('arc-time-display');

  const SVG_LEFT   = 38;
  const SVG_RIGHT  = 295;
  const SVG_BOTTOM = 140;
  const SVG_TOP    = 14;
  const W = SVG_RIGHT - SVG_LEFT;
  const H = SVG_BOTTOM - SVG_TOP;

  const sunrise = sunTimes.sunrise;
  const sunset  = sunTimes.sunset;

  if (!isValidDate(sunrise) || !isValidDate(sunset)) {
    pathEl.setAttribute('d', '');
    sunDot.setAttribute('transform', 'translate(-100,-100)');
    timeDisp.textContent = 'No sunrise/sunset today';
    return;
  }

  const srMs = sunrise.getTime();
  const ssMs = sunset.getTime();
  const totalMs = ssMs - srMs;

  // Sample arc points (every 5 min)
  const STEPS = 72;
  const segments = { golden: [], main: [] };
  const ghEnd = sunTimes.goldenHourEnd;
  const ghStart = sunTimes.goldenHour;

  const points = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const ms = srMs + t * totalMs;
    const pos = SunCalc.getPosition(new Date(ms), state.lat, state.lng);
    const altDeg = pos.altitude * 180 / Math.PI;
    if (altDeg >= 0) {
      const x = SVG_LEFT + t * W;
      const y = SVG_BOTTOM - (altDeg / 90) * H;
      points.push({ x, y, t, ms });
    }
  }

  if (points.length < 2) {
    pathEl.setAttribute('d', '');
    return;
  }

  // Build path
  const d = 'M ' + points.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ');
  pathEl.setAttribute('d', d);
  pathEl.setAttribute('stroke', '#f59e0b');
  pathEl.setAttribute('stroke-opacity', '0.65');

  // Draw golden hour overlay (separate colored segments)
  const svg = document.getElementById('sun-arc');

  // Remove previous overlays
  svg.querySelectorAll('.arc-overlay').forEach(el => el.remove());

  const drawSegment = (pts, color, opacity) => {
    if (pts.length < 2) return;
    const seg = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    seg.setAttribute('d', 'M ' + pts.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L '));
    seg.setAttribute('fill', 'none');
    seg.setAttribute('stroke', color);
    seg.setAttribute('stroke-width', '2.5');
    seg.setAttribute('stroke-opacity', opacity);
    seg.setAttribute('stroke-linecap', 'round');
    seg.setAttribute('stroke-linejoin', 'round');
    seg.setAttribute('class', 'arc-overlay');
    svg.insertBefore(seg, sunDot);
  };

  if (isValidDate(ghEnd) && isValidDate(ghStart)) {
    const ghEndMs   = ghEnd.getTime();
    const ghStartMs = ghStart.getTime();
    const morningGold = points.filter(p => p.ms <= ghEndMs);
    const daylight    = points.filter(p => p.ms > ghEndMs && p.ms < ghStartMs);
    const eveningGold = points.filter(p => p.ms >= ghStartMs);
    if (morningGold.length > 1) drawSegment(morningGold, '#fbbf24', '0.9');
    if (daylight.length > 1)    drawSegment(daylight,    '#fffbeb', '0.5');
    if (eveningGold.length > 1) drawSegment(eveningGold, '#fbbf24', '0.9');
  }

  // Current sun position dot
  const nowMs = currentDate.getTime();
  const t = Math.max(0, Math.min(1, (nowMs - srMs) / totalMs));
  const pos = SunCalc.getPosition(currentDate, state.lat, state.lng);
  const altDeg = pos.altitude * 180 / Math.PI;

  if (altDeg > 0) {
    const dotX = SVG_LEFT + t * W;
    const dotY = SVG_BOTTOM - (altDeg / 90) * H;
    sunDot.setAttribute('transform', `translate(${dotX.toFixed(1)},${dotY.toFixed(1)})`);
  } else {
    sunDot.setAttribute('transform', 'translate(-100,-100)');
  }

  // Time display
  timeDisp.textContent = formatTime(currentDate) + (altDeg <= 0 ? ' · Below horizon' : ` · Alt ${altDeg.toFixed(1)}°`);
}

// ─── Info Cards ───────────────────────────────────────────────────────────────
function updateInfoCards(sunTimes, currentDate) {
  const pos = SunCalc.getPosition(currentDate, state.lat, state.lng);
  const altDeg = pos.altitude * 180 / Math.PI;
  const azDeg  = toCompassBearing(pos.azimuth);

  // Sunrise
  setText('sunrise-time', isValidDate(sunTimes.sunrise) ? formatTime(sunTimes.sunrise) : '—');
  const srPos = isValidDate(sunTimes.sunrise)
    ? SunCalc.getPosition(sunTimes.sunrise, state.lat, state.lng) : null;
  setText('sunrise-dir', srPos ? bearingLabel(toCompassBearing(srPos.azimuth)) : '—');

  // Sunset
  setText('sunset-time', isValidDate(sunTimes.sunset) ? formatTime(sunTimes.sunset) : '—');
  const ssPos = isValidDate(sunTimes.sunset)
    ? SunCalc.getPosition(sunTimes.sunset, state.lat, state.lng) : null;
  setText('sunset-dir', ssPos ? bearingLabel(toCompassBearing(ssPos.azimuth)) : '—');

  // Noon
  setText('noon-time', isValidDate(sunTimes.solarNoon) ? formatTime(sunTimes.solarNoon) : '—');
  if (isValidDate(sunTimes.solarNoon)) {
    const noonPos = SunCalc.getPosition(sunTimes.solarNoon, state.lat, state.lng);
    setText('noon-alt', `Alt: ${(noonPos.altitude * 180 / Math.PI).toFixed(1)}°`);
  } else {
    setText('noon-alt', '—');
  }

  // Day length
  if (isValidDate(sunTimes.sunrise) && isValidDate(sunTimes.sunset)) {
    const mins = Math.round((sunTimes.sunset - sunTimes.sunrise) / 60000);
    setText('day-length', `${Math.floor(mins / 60)}h ${mins % 60}m`);
  } else {
    setText('day-length', '—');
  }

  // Golden hour
  if (isValidDate(sunTimes.goldenHour)) {
    setText('golden-hour', `Golden: ${formatTime(sunTimes.goldenHour)}`);
  } else {
    setText('golden-hour', '');
  }

  // Current position
  setText('current-azimuth', `${azDeg.toFixed(1)}°`);
  setText('current-altitude', `${altDeg.toFixed(1)}°`);
  setText('sun-phase', getSunPhase(sunTimes, currentDate));
}

// ─── Main update ──────────────────────────────────────────────────────────────
function updateAll() {
  const currentDate = buildCurrentDate();
  const sunTimes = SunCalc.getTimes(state.date, state.lat, state.lng);

  updateInfoCards(sunTimes, currentDate);
  updateMap(sunTimes);
  drawSunArc(sunTimes, currentDate);

  // Slider progress color
  const slider = document.getElementById('time-slider');
  const pct = (state.minutes / 1440) * 100;
  slider.style.background = `linear-gradient(to right, var(--accent) ${pct}%, var(--bg3) ${pct}%)`;

  // Slider label
  const h = Math.floor(state.minutes / 60);
  const m = state.minutes % 60;
  setText('slider-time-label', `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
}

function buildCurrentDate() {
  const d = new Date(state.date);
  d.setHours(Math.floor(state.minutes / 60), state.minutes % 60, 0, 0);
  return d;
}

// ─── Real-time clock ──────────────────────────────────────────────────────────
function startClock() {
  if (clockInterval) clearInterval(clockInterval);
  clockInterval = setInterval(() => {
    if (!state.isRealTime) return;
    const now = new Date();
    state.minutes = now.getHours() * 60 + now.getMinutes();
    state.date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    document.getElementById('time-slider').value = state.minutes;
    updateAll();
  }, 60000);
}

// ─── Controls ─────────────────────────────────────────────────────────────────
function initControls() {
  const slider = document.getElementById('time-slider');
  const datePicker = document.getElementById('date-picker');
  const todayBtn = document.getElementById('today-btn');

  // Set initial values
  slider.value = state.minutes;
  datePicker.value = toDateInputValue(state.date);

  slider.addEventListener('input', () => {
    state.minutes = parseInt(slider.value, 10);
    state.isRealTime = false;
    updateAll();
  });

  datePicker.addEventListener('change', () => {
    if (!datePicker.value) return;
    const [y, mo, d] = datePicker.value.split('-').map(Number);
    state.date = new Date(y, mo - 1, d);
    state.isRealTime = false;
    updateAll();
  });

  todayBtn.addEventListener('click', () => {
    const now = new Date();
    state.date    = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    state.minutes = now.getHours() * 60 + now.getMinutes();
    state.isRealTime = true;
    slider.value = state.minutes;
    datePicker.value = toDateInputValue(state.date);
    updateAll();
    showToast('Showing current time');
  });
}

// ─── Geolocation ──────────────────────────────────────────────────────────────
function tryGeolocation() {
  document.getElementById('locate-btn').addEventListener('click', requestGeolocation);
}

function requestGeolocation() {
  if (!navigator.geolocation) {
    showToast('Geolocation not supported');
    return;
  }
  showLoading(true);
  showToast('Locating…');
  navigator.geolocation.getCurrentPosition(
    pos => {
      showLoading(false);
      setLocation(pos.coords.latitude, pos.coords.longitude, 'My Location');
      reverseGeocode(pos.coords.latitude, pos.coords.longitude);
    },
    () => {
      showLoading(false);
      showToast('Location access denied');
    },
    { timeout: 10000, maximumAge: 60000 }
  );
}

function reverseGeocode(lat, lng) {
  fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`)
    .then(r => r.json())
    .then(data => {
      if (data && data.address) {
        const a = data.address;
        const name = a.city || a.town || a.village || a.county || a.state || 'My Location';
        const country = a.country_code ? a.country_code.toUpperCase() : '';
        state.locationName = country ? `${name}, ${country}` : name;
        document.getElementById('search-input').value = state.locationName;
      }
    })
    .catch(() => {});
}

function setLocation(lat, lng, name) {
  state.lat = lat;
  state.lng = lng;
  state.locationName = name;
  document.getElementById('search-input').value = name;
  updateAll();
}

// ─── Search (Nominatim) ────────────────────────────────────────────────────────
let searchTimeout = null;

function initSearch() {
  const input    = document.getElementById('search-input');
  const dropdown = document.getElementById('search-dropdown');

  input.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = input.value.trim();
    if (q.length < 3) { closeDropdown(); return; }
    searchTimeout = setTimeout(() => doSearch(q), 350);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeDropdown();
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrapper') && !e.target.closest('.search-dropdown')) {
      closeDropdown();
    }
  });
}

function doSearch(q) {
  fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=1`)
    .then(r => r.json())
    .then(results => showDropdown(results))
    .catch(() => closeDropdown());
}

function showDropdown(results) {
  const dropdown = document.getElementById('search-dropdown');
  dropdown.innerHTML = '';

  if (!results.length) {
    dropdown.classList.remove('hidden');
    const item = document.createElement('div');
    item.className = 'search-item';
    item.textContent = 'No results found';
    item.style.color = 'var(--muted)';
    dropdown.appendChild(item);
    return;
  }

  results.forEach(r => {
    const item = document.createElement('div');
    item.className = 'search-item';
    const name  = r.address
      ? (r.address.city || r.address.town || r.address.village || r.address.county || r.name || r.display_name.split(',')[0])
      : r.display_name.split(',')[0];
    const detail = r.display_name.split(',').slice(1, 3).join(',').trim();
    item.innerHTML = `<div class="place-name">${escapeHtml(name)}</div><div class="place-detail">${escapeHtml(detail)}</div>`;
    item.addEventListener('click', () => {
      setLocation(parseFloat(r.lat), parseFloat(r.lon), name + (detail ? `, ${detail.split(',')[0]}` : ''));
      closeDropdown();
    });
    dropdown.appendChild(item);
  });

  dropdown.classList.remove('hidden');
}

function closeDropdown() {
  document.getElementById('search-dropdown').classList.add('hidden');
}

// ─── Utility: Astronomy ───────────────────────────────────────────────────────
function toCompassBearing(azRad) {
  // SunCalc azimuth: 0 = south, clockwise → convert to 0 = north, clockwise
  return ((azRad * 180 / Math.PI) + 180 + 360) % 360;
}

function destinationPoint(lat, lng, bearing, distKm) {
  const R  = 6371;
  const d  = distKm / R;
  const φ1 = lat * Math.PI / 180;
  const λ1 = lng * Math.PI / 180;
  const θ  = bearing * Math.PI / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
  return [φ2 * 180 / Math.PI, λ2 * 180 / Math.PI];
}

function bearingLabel(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const idx = Math.round(deg / 22.5) % 16;
  return `${dirs[idx]} · ${deg.toFixed(0)}°`;
}

function getSunPhase(sunTimes, date) {
  const t = date.getTime();
  if (!isValidDate(sunTimes.sunrise)) return 'No sunrise';
  if (t < sunTimes.nightEnd.getTime())      return 'Night';
  if (t < sunTimes.nauticalDawn.getTime())  return 'Astro Twilight';
  if (t < sunTimes.dawn.getTime())          return 'Nautical Twil.';
  if (t < sunTimes.sunrise.getTime())       return 'Civil Twilight';
  if (t < sunTimes.goldenHourEnd.getTime()) return 'Golden Hour ✨';
  if (t < sunTimes.sunsetStart.getTime())   return 'Daylight';
  if (t < sunTimes.sunset.getTime())        return 'Golden Hour ✨';
  if (t < sunTimes.dusk.getTime())          return 'Civil Twilight';
  if (t < sunTimes.nauticalDusk.getTime())  return 'Nautical Twil.';
  if (t < sunTimes.night.getTime())         return 'Astro Twilight';
  return 'Night';
}

// ─── Utility: DOM / Formatting ────────────────────────────────────────────────
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function formatTime(date) {
  if (!isValidDate(date)) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function toDateInputValue(date) {
  const y  = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d  = String(date.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function isValidDate(d) {
  return d instanceof Date && !isNaN(d.getTime());
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 2500);
}

// ─── Sky View integration ─────────────────────────────────────────────────────
function initSplash() {
  const splash = document.getElementById('splash');
  if (!splash) return;
  splash.addEventListener('click', () => {
    splash.style.opacity = '0';
    splash.style.transition = 'opacity 0.4s';
    setTimeout(() => splash.remove(), 400);
    tryGeolocation();
    openSkyView().catch(() => {});
  }, { once: true });
}

function initSkyViewButtons() {
  document.getElementById('skyview-btn').addEventListener('click', () => {
    // openSkyView is async but we handle errors inside it
    openSkyView().then(() => {
      const hint = document.getElementById('skyview-hint');
      if (hint) { hint.classList.remove('hidden'); setTimeout(() => hint.classList.add('hidden'), 3000); }
    }).catch(() => showToast('Sky View unavailable'));
  });
  document.getElementById('skyview-close').addEventListener('click', () => {
    closeSkyView();
  });
}

// Expose data for skyview.js
window.getSkyData = () => ({
  lat:     state.lat,
  lng:     state.lng,
  date:    state.date,
  minutes: state.minutes,
});

function showLoading(on) {
  let bar = document.querySelector('.loading-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'loading-bar';
    document.body.prepend(bar);
  }
  bar.classList.toggle('active', on);
}
