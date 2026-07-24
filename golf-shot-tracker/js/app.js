(function () {
  'use strict';

  var STORAGE_KEY = 'golfShotMapper.v1';
  var YARDS_PER_METER = 1.0936133;

  var DEFAULT_CLUBS = [
    'Driver', '3 Wood', '5 Wood', '3 Hybrid',
    '4 Iron', '5 Iron', '6 Iron', '7 Iron', '8 Iron', '9 Iron',
    'PW', 'GW', 'SW', 'LW', 'Putter'
  ];

  var state = null;
  var ui = {
    view: 'play',
    startCourseId: null,
    shotModal: null,
    courseEditor: null,
    scorecardRoundId: null,
    lastClub: null,
    message: null
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
        function (err) {
          reject(new Error(err.message || 'Location request failed.'));
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  // ---------------- data helpers ----------------

  function findCourse(id) {
    return state.courses.find(function (c) { return c.id === id; });
  }
  function findTee(course, teeId) {
    return course.tees.find(function (t) { return t.id === teeId; });
  }
  function activeRound() {
    return state.activeRoundId ? state.rounds.find(function (r) { return r.id === state.activeRoundId; }) : null;
  }
  function currentHoleObj(round) {
    return round.holes[round.currentHole - 1];
  }
  function teeTotalYards(tee) {
    return tee.holes.reduce(function (s, h) { return s + (h.yards || 0); }, 0);
  }
  function makeTee(name, numHoles) {
    var holes = [];
    for (var i = 1; i <= numHoles; i++) {
      holes.push({ number: i, par: 4, yards: 0, teeLat: null, teeLon: null, greenLat: null, greenLon: null });
    }
    return { id: uid(), name: name, holes: holes };
  }

  function lastReferencePoint(hole) {
    for (var i = hole.shots.length - 1; i >= 0; i--) {
      if (hole.shots[i].lat != null) return { lat: hole.shots[i].lat, lon: hole.shots[i].lon };
    }
    if (hole.teeLat != null) return { lat: hole.teeLat, lon: hole.teeLon };
    return null;
  }

  function cumulativeDistance(hole) {
    return hole.shots.reduce(function (sum, s) { return sum + (s.distance || 0); }, 0);
  }

  function remainingYards(hole) {
    var shots = hole.shots;
    if (shots.length) {
      var last = shots[shots.length - 1];
      if (last.lat != null && hole.greenLat != null && hole.greenLon != null) {
        return Math.max(0, Math.round(distanceYards(last.lat, last.lon, hole.greenLat, hole.greenLon)));
      }
    }
    var used = cumulativeDistance(hole);
    return Math.max(0, Math.round((hole.yards || 0) - used));
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
        club: club,
        avg: Math.round(avg),
        min: Math.round(Math.min.apply(null, arr)),
        max: Math.round(Math.max.apply(null, arr)),
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
    flash._t = setTimeout(function () { ui.message = null; render(); }, 3500);
  }

  // ---------------- round lifecycle ----------------

  function startRound(courseId, teeId) {
    var course = findCourse(courseId);
    var tee = findTee(course, teeId);
    var round = {
      id: uid(),
      courseId: course.id,
      courseName: course.name,
      teeId: tee.id,
      teeName: tee.name,
      date: new Date().toISOString(),
      currentHole: 1,
      finished: false,
      holes: tee.holes.map(function (h) {
        return {
          number: h.number, par: h.par, yards: h.yards,
          teeLat: h.teeLat, teeLon: h.teeLon, greenLat: h.greenLat, greenLon: h.greenLon,
          shots: [], score: null
        };
      })
    };
    state.rounds.push(round);
    state.activeRoundId = round.id;
    saveState();
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
    var usingGpsRemaining = hole.shots.length &&
      hole.shots[hole.shots.length - 1].lat != null &&
      hole.greenLat != null;

    var dots = round.holes.map(function (h, i) {
      var cls = 'hole-dot' + (i + 1 === round.currentHole ? ' current' : '') + (h.score != null ? ' done' : '');
      return '<button class="' + cls + '" data-action="goto-hole" data-index="' + i + '">' + h.number + '</button>';
    }).join('');

    var shotsHtml = hole.shots.map(function (s, idx) {
      return '<div class="shot-row">' +
        '<div class="shot-badge">' + (idx + 1) + '</div>' +
        '<div><div class="shot-club">' + escapeHtml(s.club) + '</div>' +
        '<div class="shot-dist">' + Math.round(s.distance) + ' yds &middot; ' + (s.method === 'gps' ? 'GPS' : 'manual') + '</div></div>' +
        '<div class="spacer"></div>' +
        '<button class="shot-remove" data-action="remove-shot" data-hole="' + hole.number + '" data-shot="' + s.id + '" aria-label="Remove shot">&#10005;</button>' +
        '</div>';
    }).join('') || '<p class="hole-meta">No shots logged yet for this hole.</p>';

    var startPointBtn = '';
    if (!hole.shots.length && hole.teeLat == null) {
      startPointBtn = '<button class="btn secondary small" data-action="mark-tee-gps">&#128205; Mark tee location (GPS)</button>';
    }

    return '' +
      '<div class="row between">' +
      '<button class="hole-nav-arrow" data-action="prev-hole" ' + (round.currentHole <= 1 ? 'disabled' : '') + '>&#8249;</button>' +
      '<div style="text-align:center"><div style="font-weight:700">Hole ' + hole.number + ' of ' + totalHoles + '</div>' +
      '<div class="hole-meta">Par ' + hole.par + ' &middot; ' + hole.yards + ' yds &middot; ' + escapeHtml(round.teeName) + ' tees</div></div>' +
      '<button class="hole-nav-arrow" data-action="next-hole" ' + (round.currentHole >= totalHoles ? 'disabled' : '') + '>&#8250;</button>' +
      '</div>' +
      '<div class="hole-strip">' + dots + '</div>' +
      '<div class="remaining-box">' +
      '<div class="num">' + remaining + '</div>' +
      '<div class="unit">yds remaining to green' + (usingGpsRemaining ? ' (GPS)' : '') + '</div>' +
      '</div>' +
      (startPointBtn ? '<div class="row" style="margin-bottom:10px">' + startPointBtn + '</div>' : '') +
      '<div class="section-title">Shots</div>' +
      '<div class="shot-list">' + shotsHtml + '</div>' +
      (isComplete ?
        '<div class="card"><div class="row between"><div><strong>Hole complete</strong><div class="hole-meta">Score: ' + hole.score + '</div></div>' +
        '<button class="btn secondary small" data-action="reopen-hole">Edit</button></div></div>'
        :
        '<button class="btn block" data-action="open-shot-modal">+ Log Shot</button>' +
        (hole.shots.length ? '<button class="btn secondary block" style="margin-top:8px" data-action="finish-hole">&#127937; Holed Out / Finish Hole</button>' : '')
      ) +
      (round.currentHole >= totalHoles && isComplete ?
        '<button class="btn block" style="margin-top:14px" data-action="finish-round">Finish Round</button>' : '') +
      '<button class="btn ghost block" style="margin-top:10px" data-action="finish-round">End round now</button>';
  }

  function renderStartRound() {
    if (!state.courses.length) {
      return '<div class="empty-state"><div class="big">&#9971;</div><h3>No courses yet</h3>' +
        '<p>Add a course with its tee-to-green yardages first, then start a round here.</p></div>' +
        '<button class="btn block" data-action="nav" data-view="courses">Add a Course</button>';
    }
    var selectedCourseId = (ui.startCourseId && findCourse(ui.startCourseId)) ? ui.startCourseId : state.courses[0].id;
    var course = findCourse(selectedCourseId);
    var courseOptions = state.courses.map(function (c) {
      return '<option value="' + c.id + '"' + (c.id === selectedCourseId ? ' selected' : '') + '>' + escapeHtml(c.name) + '</option>';
    }).join('');
    var teeOptions = course.tees.map(function (t) {
      return '<option value="' + t.id + '">' + escapeHtml(t.name) + ' (' + teeTotalYards(t) + ' yds)</option>';
    }).join('');
    return '' +
      '<div class="card">' +
      '<h3>Start a Round</h3>' +
      '<div class="field"><label>Course</label><select data-action="select-start-course">' + courseOptions + '</select></div>' +
      (course.tees.length ?
        '<div class="field"><label>Tees</label><select id="start-tee-select">' + teeOptions + '</select></div>' +
        '<button class="btn block" data-action="start-round" data-course="' + course.id + '">Start Round</button>'
        : '<p class="hint">This course has no tees set up yet. Edit it in Courses to add yardages.</p>'
      ) +
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

    var totalPar = 0, totalYards = 0, totalScore = 0, scoredHoles = 0, scoredPar = 0;
    var rows = round.holes.map(function (h) {
      totalPar += h.par;
      totalYards += h.yards;
      if (h.score != null) { totalScore += h.score; scoredHoles++; scoredPar += h.par; }
      var diff = h.score != null ? (h.score - h.par) : null;
      return '<tr>' +
        '<td class="hole-cell">' + h.number + '</td>' +
        '<td>' + h.par + '</td>' +
        '<td>' + h.yards + '</td>' +
        '<td><input class="score-input" type="number" min="1" inputmode="numeric" value="' + (h.score != null ? h.score : '') + '" ' +
        'data-action="edit-score" data-hole="' + h.number + '" ' + (round.finished ? 'disabled' : '') + '></td>' +
        '<td>' + (diff != null ? '<span class="to-par ' + scoreToParClass(diff) + '">' + formatToPar(diff) + '</span>' : '&mdash;') + '</td>' +
        '</tr>';
    }).join('');

    var overallDiff = totalScore - scoredPar;

    return '' +
      '<div class="card">' +
      '<h3>' + escapeHtml(round.courseName) + '</h3>' +
      '<p class="hole-meta">' + escapeHtml(round.teeName) + ' tees &middot; ' + new Date(round.date).toLocaleDateString() +
      (round.finished ? ' &middot; Final' : ' &middot; In progress') + '</p>' +
      '<div style="overflow-x:auto"><table class="scorecard-table"><thead><tr><th>Hole</th><th>Par</th><th>Yds</th><th>Score</th><th>+/-</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '<tfoot><tr><td class="hole-cell">Total</td><td>' + totalPar + '</td><td>' + totalYards + '</td>' +
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
    if (!state.courses.length) {
      return '<div class="empty-state"><div class="big">&#127967;</div><h3>No courses yet</h3>' +
        '<p>Add the course you are about to play using tee-to-green yardages from the scorecard.</p></div>' +
        '<button class="btn block" data-action="new-course">+ Add Course</button>';
    }
    var cards = state.courses.map(function (c) {
      return '<div class="card course-card">' +
        '<div><div style="font-weight:700">' + escapeHtml(c.name) + '</div>' +
        '<div class="meta">' + c.tees.length + ' tee' + (c.tees.length !== 1 ? 's' : '') + ' &middot; ' + c.numHoles + ' holes</div></div>' +
        '<div class="row">' +
        '<button class="btn secondary small" data-action="edit-course" data-course="' + c.id + '">Edit</button>' +
        '<button class="btn danger ghost small" data-action="delete-course" data-course="' + c.id + '">Delete</button>' +
        '</div></div>';
    }).join('');
    return cards + '<button class="btn block" data-action="new-course">+ Add Course</button>';
  }

  function renderCourseEditor() {
    var ed = ui.courseEditor;
    var tee = ed.tees.find(function (t) { return t.id === ed.activeTeeId; }) || ed.tees[0];

    var teeTabs = ed.tees.map(function (t) {
      return '<button class="tab-btn' + (t.id === tee.id ? ' active' : '') + '" data-action="select-tee-tab" data-tee="' + t.id + '">' + escapeHtml(t.name) + '</button>';
    }).join('') + '<button class="tab-btn" data-action="add-tee">+ Tee</button>';

    var header = '<div class="hole-edit-row" style="font-size:.72rem;color:var(--text-muted);font-weight:700">' +
      '<div></div><div>PAR</div><div>YARDS</div><div></div></div>';

    var rows = tee.holes.map(function (h) {
      var gpsCol = ed.showGps ?
        '<div class="row" style="gap:4px">' +
        '<button class="gps-mini-btn' + (h.teeLat != null ? ' set' : '') + '" title="Set tee GPS" data-action="set-hole-gps" data-tee="' + tee.id + '" data-hole="' + h.number + '" data-point="tee">T</button>' +
        '<button class="gps-mini-btn' + (h.greenLat != null ? ' set' : '') + '" title="Set green GPS" data-action="set-hole-gps" data-tee="' + tee.id + '" data-hole="' + h.number + '" data-point="green">G</button>' +
        '</div>' : '<span></span>';
      return '<div class="hole-edit-row">' +
        '<div class="hnum">' + h.number + '</div>' +
        '<input type="number" inputmode="numeric" min="3" max="6" value="' + h.par + '" data-action="edit-par" data-tee="' + tee.id + '" data-hole="' + h.number + '">' +
        '<input type="number" inputmode="numeric" min="0" value="' + (h.yards || '') + '" placeholder="yds" data-action="edit-yards" data-tee="' + tee.id + '" data-hole="' + h.number + '">' +
        gpsCol +
        '</div>';
    }).join('');

    return '' +
      '<div class="card">' +
      '<div class="field"><label>Course Name</label>' +
      '<input type="text" value="' + escapeAttr(ed.name) + '" data-action="edit-course-name" placeholder="e.g. Pebble Beach Golf Links"></div>' +
      '<div class="field"><label># Holes</label><select data-action="edit-num-holes">' +
      '<option value="18"' + (ed.numHoles === 18 ? ' selected' : '') + '>18</option>' +
      '<option value="9"' + (ed.numHoles === 9 ? ' selected' : '') + '>9</option>' +
      '</select></div>' +
      '</div>' +
      '<div class="card">' +
      '<div class="row between"><h3 style="margin:0">Tees</h3>' +
      '<button class="btn ghost small" data-action="toggle-gps">' + (ed.showGps ? 'Hide GPS' : 'GPS capture') + '</button></div>' +
      '<div class="tabs">' + teeTabs + '</div>' +
      header + rows +
      (ed.tees.length > 1 ? '<button class="btn danger ghost small" style="margin-top:8px" data-action="delete-tee" data-tee="' + tee.id + '">Delete ' + escapeHtml(tee.name) + ' tees</button>' : '') +
      (ed.showGps ? '<p class="hint">Stand at the tee box or on the green and tap T / G to capture GPS coordinates for extra accuracy. Optional &mdash; yardage alone works fine.</p>' : '') +
      '</div>' +
      '<div class="row" style="gap:10px">' +
      '<button class="btn secondary block" data-action="cancel-course-editor">Cancel</button>' +
      '<button class="btn block" data-action="save-course">Save Course</button>' +
      '</div>';
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
          '<div class="hole-meta">' + escapeHtml(r.teeName) + ' tees &middot; ' + new Date(r.date).toLocaleDateString() + '</div></div>' +
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

  // ---------------- render: shot modal ----------------

  function renderModal() {
    var root = document.getElementById('modal-root');
    if (!ui.shotModal) { root.innerHTML = ''; return; }
    var m = ui.shotModal;

    var clubChips = state.clubs.map(function (c) {
      return '<button class="club-chip' + (m.club === c ? ' selected' : '') + '" data-action="select-club" data-club="' + escapeAttr(c) + '">' + escapeHtml(c) + '</button>';
    }).join('');

    var round = activeRound();
    var hole = round ? currentHoleObj(round) : null;
    var ref = hole ? lastReferencePoint(hole) : null;

    var methodSection = '';
    if (m.method === 'gps') {
      if (!ref) {
        var noRefLabel = hole.shots.length ?
          'Your last shot on this hole was entered manually, so there\'s no GPS point to measure from.' :
          'No starting point recorded for this hole yet.';
        methodSection = '<p class="hint">' + noRefLabel + '</p>' +
          '<button class="btn secondary block" data-action="mark-tee-gps">&#128205; Set my current position as the GPS reference point</button>';
      } else {
        var statusText = '', statusClass = '';
        if (m.gpsStatus === 'locating') { statusText = 'Locating&hellip;'; }
        else if (m.gpsStatus === 'ok') { statusText = 'Location captured (&plusmn;' + Math.round(m.gpsPoint.accuracy) + 'm accuracy).'; statusClass = 'ok'; }
        else if (m.gpsStatus && m.gpsStatus.indexOf('err:') === 0) { statusText = m.gpsStatus.slice(4); statusClass = 'err'; }
        methodSection = '<button class="btn secondary block" data-action="capture-gps">&#128205; Capture my location (ball position)</button>' +
          '<div class="gps-status ' + statusClass + '">' + statusText + '</div>';
      }
    } else {
      methodSection = '<div class="field"><label>Distance this shot traveled (yards)</label>' +
        '<input type="number" inputmode="numeric" data-action="manual-yards-input" value="' + escapeAttr(m.manualYards) + '" placeholder="e.g. 165"></div>';
    }

    root.innerHTML = '' +
      '<div class="modal-overlay">' +
      '<div class="modal-sheet">' +
      '<div class="modal-title">Log Shot</div>' +
      '<label>Club</label>' +
      '<div class="club-grid">' + clubChips + '</div>' +
      '<div class="method-toggle">' +
      '<button class="btn' + (m.method === 'gps' ? '' : ' secondary') + '" data-action="select-method" data-method="gps">GPS</button>' +
      '<button class="btn' + (m.method === 'manual' ? '' : ' secondary') + '" data-action="select-method" data-method="manual">Manual entry</button>' +
      '</div>' +
      methodSection +
      (m.error ? '<div class="gps-status err">' + escapeHtml(m.error) + '</div>' : '') +
      '<div class="row" style="margin-top:14px;gap:10px">' +
      '<button class="btn secondary block" data-action="close-modal">Cancel</button>' +
      '<button class="btn block" data-action="confirm-add-shot">Add Shot</button>' +
      '</div>' +
      '</div>' +
      '</div>';
  }

  // ---------------- action handling ----------------

  function handleAction(action, el) {
    var round, hole, ed, tee;

    switch (action) {
      case 'nav':
        ui.view = el.getAttribute('data-view');
        render();
        break;

      // start round
      case 'start-round': {
        var teeSelect = document.getElementById('start-tee-select');
        if (!teeSelect) return;
        startRound(el.getAttribute('data-course'), teeSelect.value);
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

      case 'mark-tee-gps':
        round = activeRound();
        hole = currentHoleObj(round);
        getPosition().then(function (pt) {
          hole.teeLat = pt.lat; hole.teeLon = pt.lon;
          saveState(); render();
        }).catch(function (err) { flash('Location error: ' + err.message, 'err'); });
        break;

      case 'open-shot-modal':
        round = activeRound();
        ui.shotModal = {
          club: ui.lastClub || state.clubs[0],
          method: navigator.geolocation ? 'gps' : 'manual',
          manualYards: '',
          gpsPoint: null,
          gpsStatus: '',
          error: ''
        };
        render();
        break;
      case 'select-club':
        ui.shotModal.club = el.getAttribute('data-club');
        ui.shotModal.error = '';
        render();
        break;
      case 'select-method':
        ui.shotModal.method = el.getAttribute('data-method');
        ui.shotModal.error = '';
        render();
        break;
      case 'capture-gps':
        ui.shotModal.gpsStatus = 'locating';
        render();
        getPosition().then(function (pt) {
          if (!ui.shotModal) return;
          ui.shotModal.gpsPoint = pt;
          ui.shotModal.gpsStatus = 'ok';
          render();
        }).catch(function (err) {
          if (!ui.shotModal) return;
          ui.shotModal.gpsStatus = 'err:' + err.message;
          render();
        });
        break;
      case 'close-modal':
        ui.shotModal = null;
        render();
        break;
      case 'confirm-add-shot': {
        var m = ui.shotModal;
        round = activeRound();
        hole = currentHoleObj(round);
        if (!m.club) { m.error = 'Select a club.'; render(); return; }
        var distance, lat = null, lon = null;
        if (m.method === 'gps') {
          if (!m.gpsPoint) { m.error = 'Tap "Capture my location" first.'; render(); return; }
          var ref = lastReferencePoint(hole);
          if (!ref) { m.error = 'Mark the tee location first, then capture this shot.'; render(); return; }
          distance = distanceYards(ref.lat, ref.lon, m.gpsPoint.lat, m.gpsPoint.lon);
          lat = m.gpsPoint.lat; lon = m.gpsPoint.lon;
        } else {
          var val = parseFloat(m.manualYards);
          if (!val || val <= 0) { m.error = 'Enter how many yards that shot traveled.'; render(); return; }
          distance = val;
        }
        hole.shots.push({ id: uid(), club: m.club, distance: distance, method: m.method, lat: lat, lon: lon, time: Date.now() });
        ui.lastClub = m.club;
        ui.shotModal = null;
        saveState();
        render();
        break;
      }
      case 'remove-shot':
        round = activeRound();
        hole = round.holes.find(function (h) { return h.number === parseInt(el.getAttribute('data-hole'), 10); });
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
      case 'new-course': {
        var newTee = makeTee('White', 18);
        ui.courseEditor = { id: null, name: '', numHoles: 18, tees: [newTee], activeTeeId: newTee.id, showGps: false };
        ui.view = 'courseEditor';
        render();
        break;
      }
      case 'edit-course': {
        var course = findCourse(el.getAttribute('data-course'));
        var clone = JSON.parse(JSON.stringify(course));
        ui.courseEditor = { id: clone.id, name: clone.name, numHoles: clone.numHoles, tees: clone.tees, activeTeeId: clone.tees[0].id, showGps: false };
        ui.view = 'courseEditor';
        render();
        break;
      }
      case 'delete-course':
        if (!window.confirm('Delete this course? Any saved rounds for it will remain in History.')) return;
        var cid = el.getAttribute('data-course');
        state.courses = state.courses.filter(function (c) { return c.id !== cid; });
        saveState(); render();
        break;

      case 'select-tee-tab':
        ui.courseEditor.activeTeeId = el.getAttribute('data-tee');
        render();
        break;
      case 'add-tee': {
        ed = ui.courseEditor;
        var name = window.prompt('Tee name (e.g. Blue, Red, Gold):', '');
        if (!name || !name.trim()) return;
        tee = ed.tees.find(function (t) { return t.id === ed.activeTeeId; }) || ed.tees[0];
        var copiedHoles = tee.holes.map(function (h) {
          return { number: h.number, par: h.par, yards: h.yards, teeLat: null, teeLon: null, greenLat: null, greenLon: null };
        });
        var addedTee = { id: uid(), name: name.trim(), holes: copiedHoles };
        ed.tees.push(addedTee);
        ed.activeTeeId = addedTee.id;
        render();
        break;
      }
      case 'delete-tee':
        ed = ui.courseEditor;
        if (ed.tees.length <= 1) return;
        if (!window.confirm('Delete this tee set?')) return;
        var tid = el.getAttribute('data-tee');
        ed.tees = ed.tees.filter(function (t) { return t.id !== tid; });
        ed.activeTeeId = ed.tees[0].id;
        render();
        break;
      case 'toggle-gps':
        ui.courseEditor.showGps = !ui.courseEditor.showGps;
        render();
        break;
      case 'set-hole-gps': {
        ed = ui.courseEditor;
        tee = ed.tees.find(function (t) { return t.id === el.getAttribute('data-tee'); });
        hole = tee.holes.find(function (h) { return h.number === parseInt(el.getAttribute('data-hole'), 10); });
        var point = el.getAttribute('data-point');
        getPosition().then(function (pt) {
          if (point === 'tee') { hole.teeLat = pt.lat; hole.teeLon = pt.lon; }
          else { hole.greenLat = pt.lat; hole.greenLon = pt.lon; }
          render();
        }).catch(function (err) { flash('Location error: ' + err.message, 'err'); });
        break;
      }
      case 'cancel-course-editor':
        ui.courseEditor = null;
        ui.view = 'courses';
        render();
        break;
      case 'save-course': {
        ed = ui.courseEditor;
        if (!ed.name.trim()) { flash('Please enter a course name.', 'err'); return; }
        var missingYards = ed.tees.some(function (t) { return t.holes.some(function (h) { return !h.yards || h.yards <= 0; }); });
        if (missingYards && !window.confirm('Some holes are missing yardage. Save anyway?')) return;
        var courseData = { id: ed.id || uid(), name: ed.name.trim(), numHoles: ed.numHoles, tees: ed.tees };
        if (ed.id) {
          var idx = state.courses.findIndex(function (c) { return c.id === ed.id; });
          state.courses[idx] = courseData;
        } else {
          state.courses.push(courseData);
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
    var round, hole, ed;
    switch (action) {
      case 'select-start-course':
        ui.startCourseId = el.value;
        render();
        break;
      case 'edit-num-holes':
        ed = ui.courseEditor;
        var n = parseInt(el.value, 10);
        ed.numHoles = n;
        ed.tees.forEach(function (t) {
          if (n > t.holes.length) {
            for (var i = t.holes.length + 1; i <= n; i++) {
              t.holes.push({ number: i, par: 4, yards: 0, teeLat: null, teeLon: null, greenLat: null, greenLon: null });
            }
          } else {
            t.holes = t.holes.slice(0, n);
          }
        });
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
    var ed, tee, hole;
    switch (action) {
      case 'edit-course-name':
        ui.courseEditor.name = el.value;
        break;
      case 'edit-par':
        ed = ui.courseEditor;
        tee = ed.tees.find(function (t) { return t.id === el.getAttribute('data-tee'); });
        hole = tee.holes.find(function (h) { return h.number === parseInt(el.getAttribute('data-hole'), 10); });
        hole.par = parseInt(el.value, 10) || 0;
        break;
      case 'edit-yards':
        ed = ui.courseEditor;
        tee = ed.tees.find(function (t) { return t.id === el.getAttribute('data-tee'); });
        hole = tee.holes.find(function (h) { return h.number === parseInt(el.getAttribute('data-hole'), 10); });
        hole.yards = parseInt(el.value, 10) || 0;
        break;
      case 'manual-yards-input':
        ui.shotModal.manualYards = el.value;
        break;
      default:
        break;
    }
  }

  // ---------------- event wiring ----------------

  document.addEventListener('click', function (e) {
    if (e.target.classList && e.target.classList.contains('modal-overlay')) {
      ui.shotModal = null;
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
