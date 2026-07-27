// Looks up real golf courses via OpenStreetMap's free, no-signup public APIs:
// Nominatim for text/zip search, Overpass for the actual hole/tee/green geometry.
// Coverage varies per course -- some are mapped hole-by-hole with per-colour tee
// boxes, many only have an outline. Callers should treat missing tee/green
// points as "needs manual pins."
(function (global) {
  'use strict';

  var NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
  var OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
  var METERS_PER_MILE = 1609.344;
  // How far an untagged tee/green may sit from a hole line's start/end and
  // still be treated as belonging to that hole.
  var TEE_MATCH_METERS = 250;
  var GREEN_MATCH_METERS = 150;

  function distanceMeters(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var toRad = function (d) { return (d * Math.PI) / 180; };
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function isZip(q) { return /^\d{5}(-\d{4})?$/.test(q.trim()); }

  function nominatimFetch(params) {
    params.format = 'jsonv2';
    params.addressdetails = '1';
    params.extratags = '1';
    params.limit = '6';
    var qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    return fetch(NOMINATIM_URL + '?' + qs, { headers: { 'Accept': 'application/json' } })
      .then(function (res) {
        if (res.status === 429) throw new Error('The free location service is rate-limited right now. Wait a few seconds and try again.');
        if (!res.ok) throw new Error('Location lookup failed (' + res.status + ').');
        return res.json();
      });
  }

  // Structured postal-code lookups on Nominatim miss some US zips entirely,
  // so fall back to a free-form query before giving up.
  function nominatimSearch(query) {
    var q = query.trim();
    if (isZip(q)) {
      return nominatimFetch({ postalcode: q, country: 'us' }).then(function (places) {
        if (places.length) return places;
        return nominatimFetch({ q: q + ', USA' });
      });
    }
    return nominatimFetch({ q: q });
  }

  function overpassQuery(ql) {
    return fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(ql)
    }).then(function (res) {
      if (!res.ok) throw new Error('Course data lookup failed (' + res.status + '). Overpass may be busy -- try again shortly.');
      return res.json();
    });
  }

  function nominatimHitToCourse(p) {
    if (!p) return null;
    var isGolf = p.class === 'leisure' && p.type === 'golf_course';
    if (!isGolf && p.extratags && p.extratags.leisure === 'golf_course') isGolf = true;
    if (!isGolf) return null;
    if (p.osm_type !== 'way' && p.osm_type !== 'relation') return null;
    return {
      osmType: p.osm_type,
      osmId: p.osm_id,
      name: p.display_name.split(',')[0],
      address: p.display_name,
      lat: parseFloat(p.lat),
      lon: parseFloat(p.lon),
      distanceMiles: null
    };
  }

  function parseNearbyCourses(json, originLat, originLon) {
    return (json.elements || [])
      .filter(function (el) { return el.tags && el.tags.name; })
      .map(function (el) {
        var center = el.center || (el.type === 'node' ? { lat: el.lat, lon: el.lon } : null);
        if (!center) return null;
        var meters = distanceMeters(originLat, originLon, center.lat, center.lon);
        return {
          osmType: el.type,
          osmId: el.id,
          name: el.tags.name,
          address: el.tags['addr:city'] ? (el.tags['addr:city'] + (el.tags['addr:state'] ? ', ' + el.tags['addr:state'] : '')) : '',
          lat: center.lat,
          lon: center.lon,
          distanceMiles: meters / METERS_PER_MILE
        };
      })
      .filter(Boolean)
      .sort(function (a, b) { return a.distanceMiles - b.distanceMiles; });
  }

  // Finds candidate real-world golf courses matching a zip code, city, or course name.
  function searchCourses(query) {
    return nominatimSearch(query).then(function (places) {
      var direct = places.map(nominatimHitToCourse).filter(Boolean);
      if (direct.length) return direct;

      var anchor = places[0];
      if (!anchor) return [];
      var lat = parseFloat(anchor.lat), lon = parseFloat(anchor.lon);
      var ql = '[out:json][timeout:25];' +
        '(' +
        'way(around:40000,' + lat + ',' + lon + ')[leisure=golf_course];' +
        'relation(around:40000,' + lat + ',' + lon + ')[leisure=golf_course];' +
        ');out center tags;';
      return overpassQuery(ql).then(function (data) {
        return parseNearbyCourses(data, lat, lon);
      });
    });
  }

  function centroidOf(el) {
    if (el.type === 'node') return { lat: el.lat, lon: el.lon };
    if (el.geometry && el.geometry.length) {
      var sLat = 0, sLon = 0, n = 0;
      el.geometry.forEach(function (g) { if (g) { sLat += g.lat; sLon += g.lon; n++; } });
      if (!n) return null;
      return { lat: sLat / n, lon: sLon / n };
    }
    return null;
  }

  function ringOf(el) {
    if (el.geometry && el.geometry.length > 2) {
      return el.geometry.map(function (g) { return [g.lat, g.lon]; });
    }
    return null;
  }

  function boundaryFromElement(el) {
    if (!el) return null;
    if (el.type === 'way') return ringOf(el);
    if (el.type === 'relation' && el.members) {
      var ring = [];
      el.members.forEach(function (m) {
        if (m.role === 'outer' && m.geometry) {
          m.geometry.forEach(function (g) { ring.push([g.lat, g.lon]); });
        }
      });
      return ring.length > 2 ? ring : null;
    }
    return null;
  }

  function averagePts(pts) {
    var sLat = 0, sLon = 0;
    pts.forEach(function (p) { sLat += p.lat; sLon += p.lon; });
    return { lat: sLat / pts.length, lon: sLon / pts.length };
  }

  function bboxAround(points, fallbackLat, fallbackLon) {
    var s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    (points || []).forEach(function (p) {
      var lat = p[0], lon = p[1];
      if (lat < s) s = lat;
      if (lat > n) n = lat;
      if (lon < w) w = lon;
      if (lon > e) e = lon;
    });
    if (s === Infinity) {
      // ~1.3km square around the course center when we have no outline at all
      s = fallbackLat - 0.012; n = fallbackLat + 0.012;
      w = fallbackLon - 0.015; e = fallbackLon + 0.015;
    } else {
      // pad ~200m so tee boxes just outside the drawn boundary still match
      s -= 0.002; n += 0.002; w -= 0.0025; e += 0.0025;
    }
    return { s: s, w: w, n: n, e: e };
  }

  function parseCourseDetail(courseEl, json, meta) {
    var elements = json.elements || [];
    var holeEls = [];
    var teeEls = [];
    var greenEls = [];
    var fairwayRings = [];
    var bunkerRings = [];

    elements.forEach(function (el) {
      var tags = el.tags || {};
      if (courseEl && el.id === courseEl.id && el.type === courseEl.type) return;
      if (tags.golf === 'hole') {
        holeEls.push(el);
      } else if (tags.golf === 'tee') {
        var ptT = centroidOf(el);
        if (ptT) {
          teeEls.push({
            pt: ptT,
            ref: parseInt(tags.ref, 10) || null,
            colour: ((tags.colour || tags.color || '') + '').toLowerCase() || null,
            name: tags.name || null
          });
        }
      } else if (tags.golf === 'green') {
        var ptG = centroidOf(el);
        if (ptG) greenEls.push({ pt: ptG, ref: parseInt(tags.ref, 10) || null });
      } else if (tags.golf === 'fairway') {
        var ringF = ringOf(el);
        if (ringF) fairwayRings.push(ringF);
      } else if (tags.golf === 'bunker') {
        var ringB = ringOf(el);
        if (ringB) bunkerRings.push(ringB);
      }
    });

    // Build holes keyed by number. Refs win; holes with no usable ref get
    // sequential numbers after the highest tagged one (first occurrence wins
    // on collision).
    var holesByNum = {};
    var seq = 0;
    holeEls.forEach(function (el) {
      var tags = el.tags || {};
      var num = parseInt(tags.ref, 10);
      if (!num || num < 1) { seq++; num = 100 + seq; }
      if (holesByNum[num]) return;
      var line = (el.geometry || []).map(function (g) { return [g.lat, g.lon]; });
      if (line.length < 2) return;
      holesByNum[num] = {
        number: num,
        par: parseInt(tags.par, 10) || 4,
        line: line,
        start: { lat: line[0][0], lon: line[0][1] },
        end: { lat: line[line.length - 1][0], lon: line[line.length - 1][1] }
      };
    });
    // Renumber any placeholder (100+) holes into the gaps after tagged ones.
    var nums = Object.keys(holesByNum).map(Number).sort(function (a, b) { return a - b; });
    var fixed = {};
    var nextNum = 1;
    nums.forEach(function (num) {
      var target = num < 100 ? num : nextNum;
      while (fixed[target]) target++;
      fixed[target] = holesByNum[num];
      fixed[target].number = target;
      nextNum = Math.max(nextNum, target + 1);
    });
    holesByNum = fixed;
    nums = Object.keys(holesByNum).map(Number).sort(function (a, b) { return a - b; });

    function nearestHole(pt, endName, maxMeters) {
      var best = null, bestD = Infinity;
      nums.forEach(function (num) {
        var anchor = holesByNum[num][endName];
        var d = distanceMeters(pt.lat, pt.lon, anchor.lat, anchor.lon);
        if (d < bestD) { bestD = d; best = num; }
      });
      return bestD <= maxMeters ? best : null;
    }

    // Assign greens: ref wins, otherwise nearest hole-line end.
    var greensByHole = {};
    greenEls.forEach(function (g) {
      var num = (g.ref && holesByNum[g.ref]) ? g.ref : nearestHole(g.pt, 'end', GREEN_MATCH_METERS);
      if (num) (greensByHole[num] = greensByHole[num] || []).push(g.pt);
    });

    // Assign tees: ref wins, otherwise nearest hole-line start. Group into
    // named sets by colour tag so Blue/White/Red pins come in automatically.
    var teesByHole = {};       // hole -> all tee pts (for the default point)
    var teeSetsByKey = {};     // setKey -> { key, holes: { num: [pts] } }
    teeEls.forEach(function (t) {
      var num = (t.ref && holesByNum[t.ref]) ? t.ref : nearestHole(t.pt, 'start', TEE_MATCH_METERS);
      if (!num) return;
      (teesByHole[num] = teesByHole[num] || []).push(t.pt);
      var key = t.colour || (t.name ? t.name.toLowerCase() : null);
      if (key) {
        var set = teeSetsByKey[key] = teeSetsByKey[key] || { key: key, holes: {} };
        (set.holes[num] = set.holes[num] || []).push(t.pt);
      }
    });

    var teeSetKeys = Object.keys(teeSetsByKey);

    var holes = nums.map(function (num) {
      var h = holesByNum[num];
      var teePt = teesByHole[num] ? averagePts(teesByHole[num]) : h.start;
      var greenPt = greensByHole[num] ? averagePts(greensByHole[num]) : h.end;
      var teesBySet = {};
      teeSetKeys.forEach(function (key) {
        var pts = teeSetsByKey[key].holes[num];
        if (pts) teesBySet[key] = averagePts(pts);
      });
      return {
        number: num,
        par: h.par,
        line: h.line,
        defaultTeeLat: teePt ? teePt.lat : null,
        defaultTeeLon: teePt ? teePt.lon : null,
        greenLat: greenPt ? greenPt.lat : null,
        greenLon: greenPt ? greenPt.lon : null,
        teesBySet: teesBySet
      };
    });

    return {
      osmType: meta.osmType,
      osmId: meta.osmId,
      name: (courseEl && courseEl.tags && courseEl.tags.name) || meta.fallbackName,
      lat: meta.fallbackLat,
      lon: meta.fallbackLon,
      boundary: boundaryFromElement(courseEl),
      fairwayRings: fairwayRings,
      bunkerRings: bunkerRings,
      teeSetKeys: teeSetKeys,
      holes: holes
    };
  }

  // Fetches full hole-by-hole geometry for a specific course (already found
  // via searchCourses). Two round-trips: the course outline first, then every
  // golf feature inside its (padded) bounding box -- Overpass "area"
  // derivation is unreliable for some courses, a plain bbox is not.
  function loadCourseDetail(hit) {
    var meta = {
      osmType: hit.osmType, osmId: hit.osmId,
      fallbackName: hit.name, fallbackLat: hit.lat, fallbackLon: hit.lon
    };
    var q1 = '[out:json][timeout:25];(' + hit.osmType + '(id:' + hit.osmId + '););out tags geom;';
    return overpassQuery(q1).then(function (j1) {
      var courseEl = (j1.elements || []).find(function (el) {
        return el.id === hit.osmId && el.type === hit.osmType;
      }) || null;
      var boundary = boundaryFromElement(courseEl);
      var box = bboxAround(boundary, hit.lat, hit.lon);
      var q2 = '[out:json][timeout:30][bbox:' + box.s + ',' + box.w + ',' + box.n + ',' + box.e + '];' +
        '(' +
        'way[golf=hole];' +
        'node[golf=tee];way[golf=tee];' +
        'node[golf=green];way[golf=green];' +
        'way[golf=fairway];' +
        'way[golf=bunker];' +
        ');out geom;';
      return overpassQuery(q2).then(function (j2) {
        return parseCourseDetail(courseEl, j2, meta);
      });
    });
  }

  global.GolfOSM = {
    searchCourses: searchCourses,
    loadCourseDetail: loadCourseDetail,
    distanceMeters: distanceMeters
  };
})(window);
