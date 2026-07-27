(function () {
  'use strict';

  var STORAGE_KEY = 'golfShotMapper.v2';
  var YARDS_PER_METER = 1.0936133;
  var TEE_COLORS = ['#1b5e3a', '#1565c0', '#c0392b', '#e08e0b', '#6a3fa0', '#00838f'];
  // Standard scorecard tee colours -> pin colours, for tee boxes OSM has
  // tagged with colour=*.
  var TEE_COLOR_HEX = {
    black: '#1f1f1f', blue: '#1565c0', white: '#f5f5f5', red: '#c0392b',
    gold: '#d4a017', yellow: '#e3c000', green: '#2e7d32', silver: '#9aa0a6',
    orange: '#e07b00', purple: '#6a3fa0', brown: '#795548', grey: '#757575', gray: '#757575'
  };

  function isLightColor(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return false;
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 170;
  }

  function colorForTeeKey(key, index) {
    return TEE_COLOR_HEX[key] || TEE_COLORS[index % TEE_COLORS.length];
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  var DEFAULT_CLUBS = [
    'Driver', '3 Wood', '5 Wood', '3 Hybrid',
    '4 Iron', '5 Iron', '6 Iron', '7 Iron', '8 Iron', '9 Iron',
    'PW', 'GW', 'SW', 'LW', 'Putter'
  ];

  var state = null;
  var ui = {
    view: 'play',
    startCourseId: null,
    shotSheet: null,
    courseEditor: null,
    scorecardRoundId: null,
    lastClub: null,
    message: null,
    search: { query: '', loading: false, searched: false, results: [], error: '' }
  };

  // ---------------- storage ----------------

  function defaultState() {
    return { courses: [], rounds: [], clubs: DEFAULT_CLUBS.slice(), activeRoundId: null };
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      var parsed = JSON.parse(raw);
      if (!parsed.clubs || !parsed.clubs.length) parsed.clubs = DEFAULT_CLUBS.slice();
      if (!parsed.courses) parsed.courses = [];
      if (!parsed.rounds) parsed.rounds = [];
      if (typeof parsed.activeRoundId === 'undefined') parsed.activeRoundId = null;
      return parsed;
    } catch (e) {
      return defaultState();
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------------- geo ----------------

  function distanceYards(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var toRad = function (d) { return (d * Math.PI) / 180; };
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c * YARDS_PER_METER;
  }

  function getPosition() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation is not supported on this device or browser.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy });
        },
        function (err) { reject(new Error(err.message || 'Location request failed.')); },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  // ---------------- data helpers ----------------

  function findCourse(id) { return state.courses.find(function (c) { return c.id === id; }); }
  function activeRound() {
    return state.activeRoundId ? state.rounds.find(function (r) { return r.id === state.activeRoundId; }) : null;
  }
  function currentHoleObj(round) { return round.holes[round.currentHole - 1]; }

  function makeBlankHoles(n) {
    var arr = [];
    for (var i = 1; i <= n; i++) {
      arr.push({ number: i, par: 4, line: null, greenLat: null, greenLon: null, defaultTeeLat: null, defaultTeeLon: null, teeOverrides: {} });
    }
    return arr;
  }

  function getTeePoint(course, hole, teeSetId) {
    var ov = hole.teeOverrides && hole.teeOverrides[teeSetId];
    if (ov) return ov;
    if (hole.defaultTeeLat != null) return { lat: hole.defaultTeeLat, lon: hole.defaultTeeLon };
    return null;
  }

  function getTeeYards(course, hole, teeSetId) {
    var tp = getTeePoint(course, hole, teeSetId);
    if (!tp || hole.greenLat == null) return null;
    return Math.round(distanceYards(tp.lat, tp.lon, hole.greenLat, hole.greenLon));
  }

  function courseTotalYards(course, teeSetId) {
    var yards = 0, mapped = 0;
    course.holes.forEach(function (h) {
      var y = getTeeYards(course, h, teeSetId);
      if (y != null) { yards += y; mapped++; }
    });
    return { yards: yards, mapped: mapped, total: course.holes.length };
  }

  function lastPlayPoint(hole) {
    if (hole.shots.length) return hole.shots[hole.shots.length - 1];
    if (hole.teeLat != null) return { lat: hole.teeLat, lon: hole.teeLon };
    return null;
  }

  function remainingYards(hole) {
    if (hole.greenLat == null) return null;
    var from = lastPlayPoint(hole);
    if (!from) return null;
    return Math.max(0, Math.round(distanceYards(from.lat, from.lon, hole.greenLat, hole.greenLon)));
  }

  function scoreToParClass(diff) {
    if (diff < 0) return 'under';
    if (diff > 0) return 'over';
    return 'even';
  }
  function formatToPar(diff) {
    if (diff === 0) return 'E';
    return diff > 0 ? '+' + diff : String(diff);
  }

  function clubStats() {
    var map = {};
    state.rounds.forEach(function (r) {
      r.holes.forEach(function (h) {
        h.shots.forEach(function (s) {
          if (!map[s.club]) map[s.club] = [];
          map[s.club].push(s.distance);
        });
      });
    });
    return Object.keys(map).map(function (club) {
      var arr = map[club];
      var avg = arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
      return {
        club: club, avg: Math.round(avg),
        min: Math.round(Math.min.apply(null, arr)), max: Math.round(Math.max.apply(null, arr)),
        count: arr.length
      };
    }).sort(function (a, b) { return b.avg - a.avg; });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  var escapeAttr = escapeHtml;

  function flash(text, type) {
    ui.message = { text: text, type: type || 'info' };
    render();
    clearTimeout(flash._t);
    flash._t = setTimeout(function () { ui.message = null; render(); }, 4000);
  }

  // ---------------- round lifecycle ----------------

  function startRound(courseId, teeSetId) {
    var course = findCourse(courseId);
    var teeSet = course.teeSets.find(function (t) { return t.id === teeSetId; });
    var round = {
      id: uid(), courseId: course.id, courseName: course.name,
      teeSetId: teeSet.id, teeSetName: teeSet.name,
      date: new Date().toISOString(), currentHole: 1, finished: false,
      holes: course.holes.map(function (h) {
        var tp = getTeePoint(course, h, teeSetId);
        return {
          number: h.number, par: h.par, line: h.line || null,
          teeLat: tp ? tp.lat : null, teeLon: tp ? tp.lon : null,
          greenLat: h.greenLat, greenLon: h.greenLon,
          shots: [], score: null
        };
      })
    };
    state.rounds.push(round);
    state.activeRoundId = round.id;
    saveState();
  }

  // ---------------- Leaflet map lifecycle ----------------
  // A single persistent map + DOM node survive across renders. Since render()
  // rebuilds view HTML from a string, the map's placeholder slot gets replaced
  // each time -- so instead of destroying/recreating the map, we reparent the
  // same live element into the fresh slot (appendChild moves a node without
  // destroying it or its listeners) and just invalidateSize() + redraw layers.

  var mapEl = null;
  var leafletMap = null;
  var mapLayers = {};
  var lastFitKey = null;

  function pinIcon(color, label, size) {
    size = size || 26;
    var light = isLightColor(color);
    var style = 'background:' + color + ';width:' + size + 'px;height:' + size + 'px;line-height:' + size + 'px' +
      ';color:' + (light ? '#222' : '#fff') +
      (light ? ';border-color:#555' : '');
    return L.divIcon({
      className: 'golf-pin',
      html: '<div class="golf-pin-inner" style="' + style + '">' + (label || '') + '</div>',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2]
    });
  }
  function greenIcon() {
    return L.divIcon({ className: 'golf-pin-flag', html: '&#9971;', iconSize: [26, 26], iconAnchor: [8, 24] });
  }
  function teeIcon(color) { return pinIcon(color, 'T', 22); }
  function shotIcon(n) { return pinIcon('#2c3e50', String(n), 24); }

  function ensureMap() {
    if (leafletMap) return leafletMap;
    mapEl = document.createElement('div');
    mapEl.style.width = '100%';
    mapEl.style.height = '100%';
    leafletMap = L.map(mapEl, { tap: true });
    // Satellite by default: golfers need to see actual fairways and greens,
    // and it makes even OSM-unmapped courses usable for pin placement.
    var satTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, attribution: 'Tiles &copy; Esri'
    }).addTo(leafletMap);
    var osmTiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
    });
    L.control.layers({ 'Satellite': satTiles, 'Street Map': osmTiles }, {}, { position: 'topright' }).addTo(leafletMap);
    leafletMap.setView([39.8283, -98.5795], 4);
    leafletMap.on('click', handleMapClick);
    return leafletMap;
  }

  function mountMap(slotId) {
    var slot = document.getElementById(slotId);
    if (!slot) return null;
    ensureMap();
    slot.appendChild(mapEl);
    leafletMap.invalidateSize();
    return leafletMap;
  }

  function clearMapLayers() {
    var existing = mapLayers.current || [];
    existing.forEach(function (l) { leafletMap.removeLayer(l); });
    mapLayers.current = [];
  }

  function handleMapClick(e) {
    if (ui.view === 'play') {
      var round = activeRound();
      if (!round || round.finished) return;
      var hole = currentHoleObj(round);
      if (hole.score != null || hole.teeLat == null) return;
      if (ui.shotSheet) return;
      ui.shotSheet = { lat: e.latlng.lat, lon: e.latlng.lng, club: ui.lastClub || state.clubs[0], error: '', locating: false };
      render();
    } else if (ui.view === 'courseEditor') {
      var ed = ui.courseEditor;
      var h = ed.course.holes[ed.currentHole - 1];
      if (ed.mode.type === 'green') {
        h.greenLat = e.latlng.lat; h.greenLon = e.latlng.lng;
      } else {
        h.teeOverrides[ed.mode.teeSetId] = { lat: e.latlng.lat, lon: e.latlng.lng };
      }
      render();
    }
  }

  function drawPlayLayers() {
    var round = activeRound();
    if (!round || round.finished) return;
    var hole = currentHoleObj(round);
    clearMapLayers();
    var layers = [];

    if (hole.line && hole.line.length > 1) {
      layers.push(L.polyline(hole.line, { color: '#ffffff', weight: 2, opacity: 0.65, dashArray: '2,6' }).addTo(leafletMap));
    }
    if (hole.teeLat != null) {
      layers.push(L.marker([hole.teeLat, hole.teeLon], { icon: teeIcon('#1b5e3a') }).addTo(leafletMap).bindTooltip('Tee'));
    }
    if (hole.greenLat != null) {
      layers.push(L.marker([hole.greenLat, hole.greenLon], { icon: greenIcon() }).addTo(leafletMap).bindTooltip('Green'));
    }
    var linePts = [];
    if (hole.teeLat != null) linePts.push([hole.teeLat, hole.teeLon]);
    hole.shots.forEach(function (s, idx) {
      layers.push(L.marker([s.lat, s.lon], { icon: shotIcon(idx + 1) }).addTo(leafletMap)
        .bindTooltip(s.club + ' &middot; ' + Math.round(s.distance) + ' yds'));
      linePts.push([s.lat, s.lon]);
    });
    if (linePts.length > 1) {
      layers.push(L.polyline(linePts, { color: '#1b5e3a', weight: 3 }).addTo(leafletMap));
    }
    if (linePts.length && hole.greenLat != null) {
      var lastPt = linePts[linePts.length - 1];
      layers.push(L.polyline([lastPt, [hole.greenLat, hole.greenLon]], { color: '#1b5e3a', weight: 2, dashArray: '6,8', opacity: 0.7 }).addTo(leafletMap));
    }
    mapLayers.current = layers;

    var key = 'play-' + round.id + '-' + hole.number;
    if (key !== lastFitKey) {
      var pts = linePts.slice();
      if (hole.greenLat != null) pts.push([hole.greenLat, hole.greenLon]);
      if (pts.length === 1) leafletMap.setView(pts[0], 17);
      else if (pts.length > 1) leafletMap.fitBounds(pts, { padding: [40, 40] });
      lastFitKey = key;
    }
  }

  function drawEditorLayers() {
    var ed = ui.courseEditor;
    if (!ed) return;
    var course = ed.course;
    var hole = course.holes[ed.currentHole - 1];
    clearMapLayers();
    var layers = [];

    if (course.boundary && course.boundary.length > 2) {
      layers.push(L.polygon(course.boundary, { color: '#1b5e3a', weight: 2, fillOpacity: 0.03 }).addTo(leafletMap));
    }
    (course.fairwayRings || []).forEach(function (ring) {
      layers.push(L.polygon(ring, { color: '#7cb87c', weight: 1, fillOpacity: 0.25, stroke: false }).addTo(leafletMap));
    });
    (course.bunkerRings || []).forEach(function (ring) {
      layers.push(L.polygon(ring, { color: '#e8d9a0', weight: 1, fillOpacity: 0.4, stroke: false }).addTo(leafletMap));
    });
    if (hole.line && hole.line.length > 1) {
      layers.push(L.polyline(hole.line, { color: '#ffffff', weight: 2, opacity: 0.65, dashArray: '2,6' }).addTo(leafletMap));
    }

    if (hole.greenLat != null) {
      var greenMarker = L.marker([hole.greenLat, hole.greenLon], { icon: greenIcon(), draggable: true })
        .addTo(leafletMap).bindTooltip('Green');
      greenMarker.on('dragend', function (ev) {
        var p = ev.target.getLatLng();
        hole.greenLat = p.lat; hole.greenLon = p.lng;
        render();
      });
      layers.push(greenMarker);
    }
    course.teeSets.forEach(function (t) {
      var tp = getTeePoint(course, hole, t.id);
      if (!tp) return;
      var teeMarker = L.marker([tp.lat, tp.lon], { icon: teeIcon(t.color), draggable: true })
        .addTo(leafletMap).bindTooltip(t.name + ' tee');
      teeMarker.on('dragend', function (ev) {
        var p = ev.target.getLatLng();
        hole.teeOverrides[t.id] = { lat: p.lat, lon: p.lng };
        render();
      });
      layers.push(teeMarker);
    });
    mapLayers.current = layers;

    var key = 'editor-' + course.id + '-' + ed.currentHole;
    if (key !== lastFitKey) {
      var pts = [];
      if (hole.greenLat != null) pts.push([hole.greenLat, hole.greenLon]);
      course.teeSets.forEach(function (t) { var tp = getTeePoint(course, hole, t.id); if (tp) pts.push([tp.lat, tp.lon]); });
      if (pts.length >= 2) leafletMap.fitBounds(pts, { padding: [50, 50] });
      else if (pts.length === 1) leafletMap.setView(pts[0], 17);
      else if (course.boundary && course.boundary.length) leafletMap.fitBounds(course.boundary, { padding: [20, 20] });
      else leafletMap.setView([course.lat, course.lon], 16);
      lastFitKey = key;
    }
  }

  // ---------------- render: root ----------------

  function render() {
    var app = document.getElementById('app');
    var banner = '';
    if (ui.message) {
      banner = '<div class="card" style="border-color:' + (ui.message.type === 'err' ? 'var(--danger)' : 'var(--green-700)') + '">' +
        escapeHtml(ui.message.text) + '</div>';
    }
    var html;
    switch (ui.view) {
      case 'play': html = renderPlay(); break;
      case 'scorecard': html = renderScorecard(); break;
      case 'courses': html = renderCourses(); break;
      case 'courseEditor': html = renderCourseEditor(); break;
      case 'history': html = renderHistory(); break;
      case 'clubs': html = renderClubs(); break;
      default: html = renderPlay();
    }
    app.innerHTML = banner + html;
    renderModal();
    if (document.getElementById('map-slot')) {
      mountMap('map-slot');
      if (ui.view === 'courseEditor') drawEditorLayers();
      else if (ui.view === 'play') drawPlayLayers();
    }
    updateNavHighlight();
  }

  function updateNavHighlight() {
    var buttons = document.querySelectorAll('#bottom-nav .nav-btn');
    buttons.forEach(function (b) {
      var v = b.getAttribute('data-view');
      b.classList.toggle('active', v === ui.view || (ui.view === 'courseEditor' && v === 'courses'));
    });
  }

  // ---------------- render: play ----------------

  function renderPlay() {
    var round = activeRound();
    if (!round) return renderStartRound();

    var hole = currentHoleObj(round);
    var remaining = remainingYards(hole);
    var totalHoles = round.holes.length;
    var isComplete = hole.score != null;
    var hasTee = hole.teeLat != null;
    var hasGreen = hole.greenLat != null;

    var dots = round.holes.map(function (h, i) {
      var cls = 'hole-dot' + (i + 1 === round.currentHole ? ' current' : '') + (h.score != null ? ' done' : '');
      return '<button class="' + cls + '" data-action="goto-hole" data-index="' + i + '">' + h.number + '</button>';
    }).join('');

    var shotsHtml = hole.shots.map(function (s, idx) {
      return '<div class="shot-row"><div class="shot-badge">' + (idx + 1) + '</div>' +
        '<div><div class="shot-club">' + escapeHtml(s.club) + '</div><div class="shot-dist">' + Math.round(s.distance) + ' yds</div></div>' +
        '<div class="spacer"></div>' +
        '<button class="shot-remove" data-action="remove-shot" data-shot="' + s.id + '" aria-label="Remove shot">&#10005;</button></div>';
    }).join('') || '<p class="hole-meta">No shots logged yet. Tap the map where your ball landed.</p>';

    var missingDataNote = '';
    if (!hasTee || !hasGreen) {
      missingDataNote = '<div class="card"><strong>This hole needs mapping</strong>' +
        '<p class="hole-meta">' + (!hasTee ? 'No tee location for ' + escapeHtml(round.teeSetName) + ' tees. ' : '') + (!hasGreen ? 'No green location. ' : '') +
        'Place the missing pins in Courses &rarr; Edit Map.</p>' +
        '<button class="btn secondary small" data-action="edit-active-course">Edit Map</button></div>';
    }

    return '' +
      '<div class="row between">' +
      '<button class="hole-nav-arrow" data-action="prev-hole" ' + (round.currentHole <= 1 ? 'disabled' : '') + '>&#8249;</button>' +
      '<div style="text-align:center"><div style="font-weight:700">Hole ' + hole.number + ' of ' + totalHoles + '</div>' +
      '<div class="hole-meta">Par ' + hole.par + ' &middot; ' + escapeHtml(round.teeSetName) + ' tees</div></div>' +
      '<button class="hole-nav-arrow" data-action="next-hole" ' + (round.currentHole >= totalHoles ? 'disabled' : '') + '>&#8250;</button>' +
      '</div>' +
      '<div class="hole-strip">' + dots + '</div>' +
      missingDataNote +
      '<div class="remaining-box"><div class="num">' + (remaining != null ? remaining : '&mdash;') + '</div><div class="unit">yds remaining to green</div></div>' +
      '<div class="row between" style="margin-bottom:8px"><span class="hole-meta">' + (isComplete ? 'Hole complete' : 'Tap the map where your shot landed') + '</span>' +
      '<button class="btn ghost small" data-action="recenter-map">&#127919; Recenter</button></div>' +
      '<div id="map-slot" style="height:320px;border-radius:14px;overflow:hidden;margin-bottom:12px"></div>' +
      '<div class="section-title">Shots</div>' +
      '<div class="shot-list">' + shotsHtml + '</div>' +
      (isComplete ?
        '<div class="card"><div class="row between"><div><strong>Hole complete</strong><div class="hole-meta">Score: ' + hole.score + '</div></div>' +
        '<button class="btn secondary small" data-action="reopen-hole">Edit</button></div></div>'
        :
        '<button class="btn secondary block" data-action="open-shot-modal" ' + (hasTee ? '' : 'disabled') + '>+ Log Shot (use my location)</button>' +
        (hole.shots.length ? '<button class="btn block" style="margin-top:8px" data-action="finish-hole">&#127937; Holed Out / Finish Hole</button>' : '')
      ) +
      (round.currentHole >= totalHoles && isComplete ? '<button class="btn block" style="margin-top:14px" data-action="finish-round">Finish Round</button>' : '') +
      '<button class="btn ghost block" style="margin-top:10px" data-action="finish-round">End round now</button>';
  }

  function renderStartRound() {
    if (!state.courses.length) {
      return '<div class="empty-state"><div class="big">&#9971;</div><h3>No courses yet</h3>' +
        '<p>Search for a real course in the Courses tab, then come back here to start a round.</p></div>' +
        '<button class="btn block" data-action="nav" data-view="courses">Find a Course</button>';
    }
    var selectedCourseId = (ui.startCourseId && findCourse(ui.startCourseId)) ? ui.startCourseId : state.courses[0].id;
    var course = findCourse(selectedCourseId);
    var courseOptions = state.courses.map(function (c) {
      return '<option value="' + c.id + '"' + (c.id === selectedCourseId ? ' selected' : '') + '>' + escapeHtml(c.name) + '</option>';
    }).join('');
    var teeOptions = course.teeSets.map(function (t) {
      var tot = courseTotalYards(course, t.id);
      var label = t.name;
      if (tot.mapped) {
        label += ' — ' + tot.yards.toLocaleString() + ' yds' +
          (tot.mapped < tot.total ? ' (' + tot.mapped + '/' + tot.total + ' holes mapped)' : '');
      } else {
        label += ' — needs pins';
      }
      return '<option value="' + t.id + '">' + escapeHtml(label) + '</option>';
    }).join('');
    return '' +
      '<div class="card">' +
      '<h3>Start a Round</h3>' +
      '<div class="field"><label>Course</label><select data-action="select-start-course">' + courseOptions + '</select></div>' +
      '<div class="field"><label>Tees</label><select id="start-tee-select">' + teeOptions + '</select></div>' +
      '<button class="btn block" data-action="start-round" data-course="' + course.id + '">Start Round</button>' +
      '</div>';
  }

  // ---------------- render: scorecard ----------------

  function renderScorecard() {
    var round = ui.scorecardRoundId ?
      state.rounds.find(function (r) { return r.id === ui.scorecardRoundId; }) :
      activeRound();

    if (!round) {
      return '<div class="empty-state"><div class="big">&#128220;</div><h3>No round in progress</h3>' +
        '<p>Start a round from the Play tab, or view a past round in History.</p></div>' +
        '<button class="btn block" data-action="nav" data-view="play">Go to Play</button>';
    }

    var totalPar = 0, totalScore = 0, scoredHoles = 0, scoredPar = 0;
    var rows = round.holes.map(function (h) {
      totalPar += h.par;
      if (h.score != null) { totalScore += h.score; scoredHoles++; scoredPar += h.par; }
      var diff = h.score != null ? (h.score - h.par) : null;
      return '<tr>' +
        '<td class="hole-cell">' + h.number + '</td>' +
        '<td>' + h.par + '</td>' +
        '<td><input class="score-input" type="number" min="1" inputmode="numeric" value="' + (h.score != null ? h.score : '') + '" ' +
        'data-action="edit-score" data-hole="' + h.number + '" ' + (round.finished ? 'disabled' : '') + '></td>' +
        '<td>' + (diff != null ? '<span class="to-par ' + scoreToParClass(diff) + '">' + formatToPar(diff) + '</span>' : '&mdash;') + '</td>' +
        '</tr>';
    }).join('');

    var overallDiff = totalScore - scoredPar;

    return '' +
      '<div class="card">' +
      '<h3>' + escapeHtml(round.courseName) + '</h3>' +
      '<p class="hole-meta">' + escapeHtml(round.teeSetName) + ' tees &middot; ' + new Date(round.date).toLocaleDateString() +
      (round.finished ? ' &middot; Final' : ' &middot; In progress') + '</p>' +
      '<div style="overflow-x:auto"><table class="scorecard-table"><thead><tr><th>Hole</th><th>Par</th><th>Score</th><th>+/-</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '<tfoot><tr><td class="hole-cell">Total</td><td>' + totalPar + '</td>' +
      '<td>' + (scoredHoles ? totalScore : '&mdash;') + '</td>' +
      '<td>' + (scoredHoles ? '<span class="to-par ' + scoreToParClass(overallDiff) + '">' + formatToPar(overallDiff) + '</span>' : '&mdash;') + '</td></tr></tfoot>' +
      '</table></div>' +
      (!round.finished ? '<button class="btn block" style="margin-top:12px" data-action="finish-round">Finish Round</button>' : '') +
      (round.finished ? '<button class="btn danger ghost block" style="margin-top:8px" data-action="delete-round" data-round="' + round.id + '">Delete This Round</button>' : '') +
      '</div>' +
      clubStatsCardForRound(round);
  }

  function clubStatsCardForRound(round) {
    var map = {};
    round.holes.forEach(function (h) {
      h.shots.forEach(function (s) { (map[s.club] = map[s.club] || []).push(s.distance); });
    });
    var clubs = Object.keys(map);
    if (!clubs.length) return '';
    var rows = clubs.map(function (c) {
      var arr = map[c];
      var avg = Math.round(arr.reduce(function (a, b) { return a + b; }, 0) / arr.length);
      return '<div class="club-stat-row"><span class="club-stat-name">' + escapeHtml(c) + '</span>' +
        '<span class="club-stat-detail">avg ' + avg + ' yds &middot; ' + arr.length + ' shot' + (arr.length !== 1 ? 's' : '') + '</span></div>';
    }).join('');
    return '<div class="card"><h3>Club Distances (this round)</h3>' + rows + '</div>';
  }

  // ---------------- render: courses ----------------

  function renderCourses() {
    var search = ui.search;
    var html = '<div class="card">' +
      '<h3>Find a Course</h3>' +
      '<div class="row"><input type="text" id="course-search-input" placeholder="Zip code, city, or course name" value="' + escapeAttr(search.query) + '">' +
      '<button class="btn" data-action="run-course-search">Search</button></div>' +
      (search.loading ? '<p class="hint">Searching OpenStreetMap&hellip;</p>' : '') +
      (search.error ? '<div class="gps-status err">' + escapeHtml(search.error) + '</div>' : '') +
      '</div>';

    if (search.results.length) {
      html += '<div class="section-title">Results</div>' + search.results.map(function (r, i) {
        return '<div class="card course-card" data-action="select-search-result" data-index="' + i + '">' +
          '<div><div style="font-weight:700">' + escapeHtml(r.name) + '</div>' +
          '<div class="meta">' + (r.address ? escapeHtml(r.address) + (r.distanceMiles != null ? ' &middot; ' : '') : '') +
          (r.distanceMiles != null ? r.distanceMiles.toFixed(1) + ' mi away' : '') + '</div></div>' +
          '<div class="btn secondary small">Load</div>' +
          '</div>';
      }).join('');
    } else if (search.searched && !search.loading && !search.error) {
      html += '<p class="hint">No golf courses found nearby. Try a broader search, like just the city or state.</p>';
    }

    html += '<div class="section-title" style="margin-top:18px">My Saved Courses</div>';
    if (!state.courses.length) {
      html += '<p class="hint">Courses you load will appear here, ready to play.</p>';
    } else {
      html += state.courses.map(function (c) {
        var mappedHoles = c.holes.filter(function (h) { return h.greenLat != null; }).length;
        return '<div class="card course-card">' +
          '<div><div style="font-weight:700">' + escapeHtml(c.name) + '</div>' +
          '<div class="meta">' + mappedHoles + '/' + c.holes.length + ' holes mapped &middot; ' +
          c.teeSets.map(function (t) { return escapeHtml(t.name); }).join(' / ') + ' tees</div></div>' +
          '<div class="row">' +
          '<button class="btn secondary small" data-action="open-saved-course" data-course="' + c.id + '">Edit Map</button>' +
          '<button class="btn danger ghost small" data-action="delete-course" data-course="' + c.id + '">Delete</button>' +
          '</div></div>';
      }).join('');
    }
    return html;
  }

  function renderCourseEditor() {
    var ed = ui.courseEditor;
    var course = ed.course;
    var hole = course.holes[ed.currentHole - 1];
    var totallyUnmapped = course.holes.every(function (h) { return h.greenLat == null && h.defaultTeeLat == null; });

    var holeDots = course.holes.map(function (h, i) {
      var mapped = h.greenLat != null && (h.defaultTeeLat != null || Object.keys(h.teeOverrides).length);
      return '<button class="hole-dot' + (i + 1 === ed.currentHole ? ' current' : '') + (mapped ? ' done' : '') + '" data-action="editor-goto-hole" data-index="' + i + '">' + h.number + '</button>';
    }).join('');

    var modeChips = '<button class="tab-btn' + (ed.mode.type === 'green' ? ' active' : '') + '" data-action="editor-set-mode" data-mode="green">&#9971; Green</button>' +
      course.teeSets.map(function (t) {
        var active = ed.mode.type === 'tee' && ed.mode.teeSetId === t.id;
        var chipStyle = active ?
          ('background:' + t.color + ';border-color:' + (isLightColor(t.color) ? '#555' : t.color) + ';color:' + (isLightColor(t.color) ? '#222' : '#fff')) :
          ('border-color:' + (isLightColor(t.color) ? '#999' : t.color));
        return '<button class="tab-btn' + (active ? ' active' : '') + '" data-action="editor-set-mode" data-mode="tee" data-tee="' + t.id + '" style="' + chipStyle + '">' + escapeHtml(t.name) + '</button>';
      }).join('') +
      '<button class="tab-btn" data-action="editor-add-tee-set">+ Tee Set</button>';

    var activeTeeSet = ed.mode.type === 'tee' ? course.teeSets.find(function (t) { return t.id === ed.mode.teeSetId; }) : null;
    var hint = ed.mode.type === 'green' ?
      'Tap the map to place the green for hole ' + hole.number + '. Drag the pin to fine-tune it.' :
      'Tap the map to place the ' + escapeHtml(activeTeeSet ? activeTeeSet.name : '') + ' tee for hole ' + hole.number + '. Drag the pin to fine-tune it.';

    var yardageLines = course.teeSets.map(function (t) {
      var y = getTeeYards(course, hole, t.id);
      return '<div class="club-stat-row"><span class="club-stat-name">' + escapeHtml(t.name) + '</span><span class="club-stat-detail">' + (y != null ? y + ' yds' : 'needs pins') + '</span></div>';
    }).join('');

    var teeSetChips = course.teeSets.map(function (t) {
      return '<span class="chip-remove" style="border-color:' + t.color + '">' + escapeHtml(t.name) +
        (course.teeSets.length > 1 ? ' <button data-action="editor-remove-tee-set" data-tee="' + t.id + '">&#10005;</button>' : '') + '</span>';
    }).join('');

    return '' +
      '<div class="card">' +
      '<h3 style="margin:0">' + escapeHtml(course.name) + '</h3>' +
      (course.address ? '<p class="hole-meta">' + escapeHtml(course.address) + '</p>' : '') +
      (totallyUnmapped ? '<p class="hint">OpenStreetMap doesn\'t have hole-by-hole data for this course (coverage is volunteer-mapped and varies). The satellite view below shows the real fairways and greens &mdash; tap each hole\'s tee and green once to map it, and it\'s saved for good.</p>' : '') +
      '</div>' +
      '<div class="hole-strip">' + holeDots + '</div>' +
      '<div class="tabs">' + modeChips + '</div>' +
      '<div id="map-slot" style="height:340px;border-radius:14px;overflow:hidden;margin-bottom:12px"></div>' +
      '<p class="hint">' + hint + '</p>' +
      '<div class="card">' +
      '<div class="field"><label>Par (hole ' + hole.number + ')</label><input type="number" min="3" max="6" value="' + hole.par + '" data-action="editor-edit-par"></div>' +
      yardageLines +
      '</div>' +
      '<div class="card"><label>Tee Sets</label><div class="row wrap">' + teeSetChips + '</div></div>' +
      '<div class="row" style="gap:10px">' +
      '<button class="btn secondary block" data-action="cancel-course-editor">Cancel</button>' +
      '<button class="btn block" data-action="save-course">Save Course</button>' +
      '</div>' +
      (!ed.isNew ? '<button class="btn danger ghost block" style="margin-top:8px" data-action="delete-course" data-course="' + course.id + '">Delete Course</button>' : '');
  }

  // ---------------- render: clubs ----------------

  function renderClubs() {
    var chips = state.clubs.map(function (c, i) {
      return '<span class="chip-remove">' + escapeHtml(c) + ' <button data-action="remove-club" data-index="' + i + '">&#10005;</button></span>';
    }).join('');
    return '<div class="card"><h3>Your Clubs</h3><div class="row wrap">' + chips + '</div>' +
      '<div class="field" style="margin-top:14px"><label>Add a club</label>' +
      '<div class="row"><input type="text" id="new-club-input" placeholder="e.g. 2 Iron">' +
      '<button class="btn" data-action="add-club">Add</button></div></div>' +
      '<button class="btn secondary block" style="margin-top:10px" data-action="reset-clubs">Reset to Default Set</button>' +
      '</div>';
  }

  // ---------------- render: history ----------------

  function renderHistory() {
    var rounds = state.rounds.filter(function (r) { return r.finished; })
      .sort(function (a, b) { return new Date(b.date) - new Date(a.date); });

    var listHtml;
    if (!rounds.length) {
      listHtml = '<div class="empty-state"><div class="big">&#128197;</div><h3>No rounds yet</h3><p>Finished rounds will show up here.</p></div>';
    } else {
      listHtml = rounds.map(function (r) {
        var scored = r.holes.filter(function (h) { return h.score != null; });
        var total = scored.reduce(function (s, h) { return s + h.score; }, 0);
        var par = scored.reduce(function (s, h) { return s + h.par; }, 0);
        var diff = total - par;
        return '<div class="card history-item" data-action="view-round" data-round="' + r.id + '">' +
          '<div class="row between">' +
          '<div><div style="font-weight:700">' + escapeHtml(r.courseName) + '</div>' +
          '<div class="hole-meta">' + escapeHtml(r.teeSetName) + ' tees &middot; ' + new Date(r.date).toLocaleDateString() + '</div></div>' +
          '<div style="text-align:right"><div class="history-score">' + (scored.length ? total : '&mdash;') + '</div>' +
          (scored.length ? '<div class="to-par ' + scoreToParClass(diff) + '">' + formatToPar(diff) + '</div>' : '') +
          '</div></div></div>';
      }).join('');
    }

    var stats = clubStats();
    var statsHtml = '';
    if (stats.length) {
      statsHtml = '<div class="section-title" style="margin-top:18px">All-Time Club Distances</div><div class="card">' +
        stats.map(function (s) {
          return '<div class="club-stat-row"><span class="club-stat-name">' + escapeHtml(s.club) + '</span>' +
            '<span class="club-stat-detail">avg ' + s.avg + ' yds &middot; range ' + s.min + '-' + s.max + ' &middot; ' + s.count + ' shots</span></div>';
        }).join('') + '</div>';
    }

    return '<div class="section-title">Past Rounds</div>' + listHtml + statsHtml;
  }

  // ---------------- render: shot sheet modal ----------------

  function renderModal() {
    var root = document.getElementById('modal-root');
    if (!ui.shotSheet) { root.innerHTML = ''; return; }
    var m = ui.shotSheet;

    var clubChips = state.clubs.map(function (c) {
      return '<button class="club-chip' + (m.club === c ? ' selected' : '') + '" data-action="select-club" data-club="' + escapeAttr(c) + '">' + escapeHtml(c) + '</button>';
    }).join('');

    var locationLine = m.locating ? 'Locating your position&hellip;' :
      (m.lat != null ? 'Shot location set (' + m.lat.toFixed(5) + ', ' + m.lon.toFixed(5) + ').' : 'Tap the map to set a location.');

    root.innerHTML = '' +
      '<div class="modal-overlay">' +
      '<div class="modal-sheet">' +
      '<div class="modal-title">Log Shot</div>' +
      '<label>Club</label>' +
      '<div class="club-grid">' + clubChips + '</div>' +
      '<p class="gps-status' + (m.lat != null ? ' ok' : '') + '">' + escapeHtml(locationLine) + '</p>' +
      (m.error ? '<div class="gps-status err">' + escapeHtml(m.error) + '</div>' : '') +
      '<div class="row" style="margin-top:14px;gap:10px">' +
      '<button class="btn secondary block" data-action="close-modal">Cancel</button>' +
      '<button class="btn block" data-action="confirm-add-shot" ' + (m.lat == null ? 'disabled' : '') + '>Add Shot</button>' +
      '</div>' +
      '</div>' +
      '</div>';
  }

  // ---------------- search helper ----------------

  function runCourseSearch() {
    var input = document.getElementById('course-search-input');
    var q = input ? input.value.trim() : '';
    if (!q) return;
    ui.search.query = q;
    ui.search.loading = true;
    ui.search.error = '';
    ui.search.results = [];
    ui.search.searched = false;
    render();
    window.GolfOSM.searchCourses(q).then(function (results) {
      ui.search.loading = false;
      ui.search.results = results;
      ui.search.searched = true;
      render();
    }).catch(function (err) {
      ui.search.loading = false;
      ui.search.error = err.message;
      ui.search.searched = true;
      render();
    });
  }

  // ---------------- action handling ----------------

  function handleAction(action, el) {
    var round, hole, ed, course;

    switch (action) {
      case 'nav':
        ui.view = el.getAttribute('data-view');
        render();
        break;

      case 'run-course-search':
        runCourseSearch();
        break;

      case 'select-search-result': {
        var idx = parseInt(el.getAttribute('data-index'), 10);
        var hit = ui.search.results[idx];
        ui.search.loading = true;
        render();
        window.GolfOSM.loadCourseDetail(hit).then(function (detail) {
          // Build tee sets straight from OSM colour tags (Blue/White/Red...)
          // when present; otherwise a single editable Default set.
          var teeSetKeys = detail.teeSetKeys || [];
          var teeSets, keyToId = {};
          if (teeSetKeys.length) {
            teeSets = teeSetKeys.map(function (key, i) {
              var id = uid() + i;
              keyToId[key] = id;
              return { id: id, name: capitalize(key), color: colorForTeeKey(key, i) };
            });
          } else {
            teeSets = [{ id: uid(), name: 'Default', color: TEE_COLORS[0] }];
          }
          var holes = (detail.holes.length ? detail.holes : makeBlankHoles(18)).map(function (h) {
            var overrides = {};
            Object.keys(h.teesBySet || {}).forEach(function (key) {
              if (keyToId[key]) overrides[keyToId[key]] = h.teesBySet[key];
            });
            return {
              number: h.number, par: h.par, line: h.line || null,
              defaultTeeLat: h.defaultTeeLat != null ? h.defaultTeeLat : null,
              defaultTeeLon: h.defaultTeeLon != null ? h.defaultTeeLon : null,
              greenLat: h.greenLat != null ? h.greenLat : null,
              greenLon: h.greenLon != null ? h.greenLon : null,
              teeOverrides: overrides
            };
          });
          var newCourse = {
            id: uid(), source: 'osm', osmType: detail.osmType, osmId: detail.osmId,
            name: detail.name, address: hit.address, lat: detail.lat, lon: detail.lon,
            boundary: detail.boundary, fairwayRings: detail.fairwayRings || [], bunkerRings: detail.bunkerRings || [],
            holes: holes,
            teeSets: teeSets
          };
          // Longest tees first, matching how scorecards order them.
          newCourse.teeSets.sort(function (a, b) {
            return (courseTotalYards(newCourse, b.id).yards || 0) - (courseTotalYards(newCourse, a.id).yards || 0);
          });
          ui.search.loading = false;
          ui.courseEditor = { course: newCourse, isNew: true, currentHole: 1, mode: { type: 'green' } };
          ui.view = 'courseEditor';
          lastFitKey = null;
          render();
        }).catch(function (err) {
          ui.search.loading = false;
          render();
          flash('Could not load that course: ' + err.message, 'err');
        });
        break;
      }

      // start round
      case 'start-round': {
        var teeSelect = document.getElementById('start-tee-select');
        if (!teeSelect) return;
        startRound(el.getAttribute('data-course'), teeSelect.value);
        lastFitKey = null;
        render();
        break;
      }

      // hole navigation
      case 'prev-hole':
        round = activeRound();
        round.currentHole = Math.max(1, round.currentHole - 1);
        saveState(); render();
        break;
      case 'next-hole':
        round = activeRound();
        round.currentHole = Math.min(round.holes.length, round.currentHole + 1);
        saveState(); render();
        break;
      case 'goto-hole':
        round = activeRound();
        round.currentHole = parseInt(el.getAttribute('data-index'), 10) + 1;
        saveState(); render();
        break;
      case 'recenter-map':
        lastFitKey = null;
        render();
        break;

      case 'open-shot-modal':
        round = activeRound();
        ui.shotSheet = { lat: null, lon: null, club: ui.lastClub || state.clubs[0], error: '', locating: true };
        render();
        getPosition().then(function (pt) {
          if (!ui.shotSheet) return;
          ui.shotSheet.lat = pt.lat; ui.shotSheet.lon = pt.lon; ui.shotSheet.locating = false;
          render();
        }).catch(function (err) {
          if (!ui.shotSheet) return;
          ui.shotSheet.error = err.message; ui.shotSheet.locating = false;
          render();
        });
        break;
      case 'select-club':
        ui.shotSheet.club = el.getAttribute('data-club');
        ui.shotSheet.error = '';
        render();
        break;
      case 'close-modal':
        ui.shotSheet = null;
        render();
        break;
      case 'confirm-add-shot': {
        var m = ui.shotSheet;
        round = activeRound();
        hole = currentHoleObj(round);
        if (!m.club) { m.error = 'Select a club.'; render(); return; }
        if (m.lat == null) { m.error = 'Set a location for this shot first.'; render(); return; }
        var prev = lastPlayPoint(hole);
        if (!prev) { m.error = 'This hole has no tee location yet.'; render(); return; }
        var dist = distanceYards(prev.lat, prev.lon, m.lat, m.lon);
        hole.shots.push({ id: uid(), club: m.club, lat: m.lat, lon: m.lon, distance: dist, time: Date.now() });
        ui.lastClub = m.club;
        ui.shotSheet = null;
        saveState();
        render();
        break;
      }
      case 'remove-shot':
        round = activeRound();
        hole = currentHoleObj(round);
        hole.shots = hole.shots.filter(function (s) { return s.id !== el.getAttribute('data-shot'); });
        saveState(); render();
        break;

      case 'finish-hole': {
        round = activeRound();
        hole = currentHoleObj(round);
        var defaultScore = hole.shots.length || hole.par;
        var input = window.prompt('Strokes for hole ' + hole.number + ' (par ' + hole.par + '):', String(defaultScore));
        if (input === null) return;
        var n = parseInt(input, 10);
        if (!n || n < 1) return;
        hole.score = n;
        if (round.currentHole < round.holes.length) round.currentHole++;
        saveState(); render();
        break;
      }
      case 'reopen-hole':
        round = activeRound();
        hole = currentHoleObj(round);
        hole.score = null;
        saveState(); render();
        break;

      case 'finish-round': {
        round = activeRound() || (ui.scorecardRoundId && state.rounds.find(function (r) { return r.id === ui.scorecardRoundId; }));
        if (!round) return;
        if (!window.confirm('Finish this round? You can still view it later in History.')) return;
        round.finished = true;
        round.finishedAt = new Date().toISOString();
        if (state.activeRoundId === round.id) state.activeRoundId = null;
        ui.scorecardRoundId = round.id;
        ui.view = 'scorecard';
        saveState(); render();
        break;
      }

      case 'view-round':
        ui.scorecardRoundId = el.getAttribute('data-round');
        ui.view = 'scorecard';
        render();
        break;
      case 'delete-round':
        if (!window.confirm('Delete this round permanently?')) return;
        var rid = el.getAttribute('data-round');
        state.rounds = state.rounds.filter(function (r) { return r.id !== rid; });
        if (ui.scorecardRoundId === rid) ui.scorecardRoundId = null;
        ui.view = 'history';
        saveState(); render();
        break;

      // courses
      case 'open-saved-course': {
        course = findCourse(el.getAttribute('data-course'));
        var clone = JSON.parse(JSON.stringify(course));
        ui.courseEditor = { course: clone, isNew: false, currentHole: 1, mode: { type: 'green' } };
        ui.view = 'courseEditor';
        lastFitKey = null;
        render();
        break;
      }
      case 'edit-active-course': {
        round = activeRound();
        course = findCourse(round.courseId);
        var cloneA = JSON.parse(JSON.stringify(course));
        var ch = cloneA.holes[round.currentHole - 1];
        ui.courseEditor = {
          course: cloneA, isNew: false, currentHole: round.currentHole,
          mode: (ch.greenLat == null) ? { type: 'green' } : { type: 'tee', teeSetId: cloneA.teeSets[0].id }
        };
        ui.view = 'courseEditor';
        lastFitKey = null;
        render();
        break;
      }
      case 'delete-course':
        if (!window.confirm('Delete this course? Any saved rounds for it will remain in History.')) return;
        var cid = el.getAttribute('data-course');
        state.courses = state.courses.filter(function (c) { return c.id !== cid; });
        if (ui.courseEditor && ui.courseEditor.course.id === cid) {
          ui.courseEditor = null;
          ui.view = 'courses';
        }
        saveState(); render();
        break;

      case 'editor-goto-hole':
        ui.courseEditor.currentHole = parseInt(el.getAttribute('data-index'), 10) + 1;
        render();
        break;
      case 'editor-set-mode':
        ed = ui.courseEditor;
        ed.mode = el.getAttribute('data-mode') === 'green' ? { type: 'green' } : { type: 'tee', teeSetId: el.getAttribute('data-tee') };
        render();
        break;
      case 'editor-add-tee-set': {
        ed = ui.courseEditor;
        var name = window.prompt('Tee name (e.g. Blue, White, Red):', '');
        if (!name || !name.trim()) return;
        var newTeeSet = { id: uid(), name: name.trim(), color: TEE_COLORS[ed.course.teeSets.length % TEE_COLORS.length] };
        ed.course.teeSets.push(newTeeSet);
        ed.mode = { type: 'tee', teeSetId: newTeeSet.id };
        render();
        break;
      }
      case 'editor-remove-tee-set': {
        ed = ui.courseEditor;
        if (ed.course.teeSets.length <= 1) return;
        if (!window.confirm('Delete this tee set?')) return;
        var tsid = el.getAttribute('data-tee');
        ed.course.teeSets = ed.course.teeSets.filter(function (t) { return t.id !== tsid; });
        ed.course.holes.forEach(function (h) { delete h.teeOverrides[tsid]; });
        if (ed.mode.type === 'tee' && ed.mode.teeSetId === tsid) ed.mode = { type: 'green' };
        render();
        break;
      }
      case 'cancel-course-editor':
        ui.courseEditor = null;
        ui.view = 'courses';
        render();
        break;
      case 'save-course': {
        ed = ui.courseEditor;
        if (ed.isNew) state.courses.push(ed.course);
        else {
          var cidx = state.courses.findIndex(function (c) { return c.id === ed.course.id; });
          state.courses[cidx] = ed.course;
        }
        var ar = activeRound();
        if (ar && ar.courseId === ed.course.id) {
          ar.holes.forEach(function (rh) {
            var ch2 = ed.course.holes.find(function (h) { return h.number === rh.number; });
            if (!ch2) return;
            if (rh.teeLat == null) {
              var tp = getTeePoint(ed.course, ch2, ar.teeSetId);
              if (tp) { rh.teeLat = tp.lat; rh.teeLon = tp.lon; }
            }
            if (rh.greenLat == null && ch2.greenLat != null) { rh.greenLat = ch2.greenLat; rh.greenLon = ch2.greenLon; }
          });
        }
        saveState();
        ui.courseEditor = null;
        ui.view = 'courses';
        render();
        break;
      }

      // clubs
      case 'add-club': {
        var input2 = document.getElementById('new-club-input');
        var val2 = input2.value.trim();
        if (!val2) return;
        if (state.clubs.indexOf(val2) === -1) state.clubs.push(val2);
        saveState(); render();
        break;
      }
      case 'remove-club':
        state.clubs.splice(parseInt(el.getAttribute('data-index'), 10), 1);
        saveState(); render();
        break;
      case 'reset-clubs':
        if (!window.confirm('Reset your club list to the default set?')) return;
        state.clubs = DEFAULT_CLUBS.slice();
        saveState(); render();
        break;

      default:
        break;
    }
  }

  function handleChangeAction(action, el) {
    var round, hole;
    switch (action) {
      case 'select-start-course':
        ui.startCourseId = el.value;
        render();
        break;
      case 'edit-score':
        round = ui.scorecardRoundId ?
          state.rounds.find(function (r) { return r.id === ui.scorecardRoundId; }) :
          activeRound();
        if (!round) return;
        hole = round.holes.find(function (h) { return h.number === parseInt(el.getAttribute('data-hole'), 10); });
        var v = parseInt(el.value, 10);
        hole.score = (v && v > 0) ? v : null;
        saveState(); render();
        break;
      default:
        break;
    }
  }

  function handleSilentInput(action, el) {
    var ed;
    switch (action) {
      case 'editor-edit-par':
        ed = ui.courseEditor;
        ed.course.holes[ed.currentHole - 1].par = parseInt(el.value, 10) || 0;
        break;
      default:
        break;
    }
  }

  // ---------------- event wiring ----------------

  document.addEventListener('click', function (e) {
    if (e.target.classList && e.target.classList.contains('modal-overlay')) {
      ui.shotSheet = null;
      render();
      return;
    }
    var el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
    handleAction(el.getAttribute('data-action'), el);
  });

  document.addEventListener('change', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.tagName !== 'SELECT' && el.getAttribute('data-action') !== 'edit-score') return;
    handleChangeAction(el.getAttribute('data-action'), el);
  });

  document.addEventListener('input', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
    if (el.getAttribute('data-action') === 'edit-score') return;
    handleSilentInput(el.getAttribute('data-action'), el);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target && e.target.id === 'course-search-input') {
      e.preventDefault();
      runCourseSearch();
    }
  });

  // ---------------- init ----------------

  function init() {
    state = loadState();
    render();
  }

  init();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
