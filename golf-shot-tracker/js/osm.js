// Looks up real golf courses via OpenStreetMap's free, no-signup public APIs:
// Nominatim for text/zip search, Overpass for the actual hole/tee/green geometry.
// Coverage varies per course -- some are mapped hole-by-hole, many only have an
// outline. Callers should treat missing tee/green points as "needs manual pins."
(function (global) {
  'use strict';

  var NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
  var OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
  var METERS_PER_MILE = 1609.344;

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

  function nominatimSearch(query) {
    var params = {
      format: 'jsonv2',
      addressdetails: '1',
      extratags: '1',
      limit: '6'
    };
    if (isZip(query)) {
      params.postalcode = query.trim();
      params.country = 'us';
    } else {
      params.q = query;
    }
    var qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    return fetch(NOMINATIM_URL + '?' + qs, { headers: { 'Accept': 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('Location lookup failed (' + res.status + ').');
        return res.json();
      });
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
      name: (p.namedetails && p.namedetails.name) || p.display_name.split(',')[0],
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

  function parseCourseDetail(json, meta) {
    var elements = json.elements || [];
    var courseEl = elements.find(function (el) {
      return el.id === meta.osmId && el.type === meta.osmType;
    });

    var holesByRef = {};
    var teesByRef = {};
    var greensByRef = {};
    var fairwayRings = [];
    var bunkerRings = [];

    elements.forEach(function (el) {
      var tags = el.tags || {};
      if (el === courseEl) return;
      if (tags.golf === 'hole') {
        var ref = parseInt(tags.ref, 10);
        if (!ref) return;
        var entry = holesByRef[ref] = holesByRef[ref] || {};
        if (tags.par) entry.par = parseInt(tags.par, 10);
        if (el.geometry && el.geometry.length) {
          entry.lineStart = el.geometry[0];
          entry.lineEnd = el.geometry[el.geometry.length - 1];
        }
      } else if (tags.golf === 'tee') {
        var refT = parseInt(tags.ref, 10);
        var ptT = centroidOf(el);
        if (ptT && refT) (teesByRef[refT] = teesByRef[refT] || []).push(ptT);
      } else if (tags.golf === 'green') {
        var refG = parseInt(tags.ref, 10);
        var ptG = centroidOf(el);
        if (ptG && refG) (greensByRef[refG] = greensByRef[refG] || []).push(ptG);
      } else if (tags.golf === 'fairway') {
        var ringF = ringOf(el);
        if (ringF) fairwayRings.push(ringF);
      } else if (tags.golf === 'bunker') {
        var ringB = ringOf(el);
        if (ringB) bunkerRings.push(ringB);
      }
    });

    var holeNumbers = Object.keys(holesByRef).map(Number).sort(function (a, b) { return a - b; });
    var holes = holeNumbers.map(function (num) {
      var h = holesByRef[num];
      var teePt = teesByRef[num] && teesByRef[num].length ? averagePts(teesByRef[num]) : (h.lineStart || null);
      var greenPt = greensByRef[num] && greensByRef[num].length ? averagePts(greensByRef[num]) : (h.lineEnd || null);
      return {
        number: num,
        par: h.par || 4,
        defaultTeeLat: teePt ? teePt.lat : null,
        defaultTeeLon: teePt ? teePt.lon : null,
        greenLat: greenPt ? greenPt.lat : null,
        greenLon: greenPt ? greenPt.lon : null,
        teeOverrides: {}
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
      holes: holes
    };
  }

  // Fetches full hole-by-hole geometry for a specific course (already found via searchCourses).
  function loadCourseDetail(hit) {
    var areaId = (hit.osmType === 'relation' ? 3600000000 : 2400000000) + hit.osmId;
    var ql = '[out:json][timeout:30];' +
      '(way(id:' + hit.osmId + ');relation(id:' + hit.osmId + '););out tags geom;' +
      'area(' + areaId + ')->.searchArea;' +
      '(' +
      'way(area.searchArea)[golf=hole];' +
      'node(area.searchArea)[golf=tee];way(area.searchArea)[golf=tee];' +
      'node(area.searchArea)[golf=green];way(area.searchArea)[golf=green];' +
      'way(area.searchArea)[golf=fairway];' +
      'way(area.searchArea)[golf=bunker];' +
      ');out geom;';
    return overpassQuery(ql).then(function (json) {
      return parseCourseDetail(json, {
        osmType: hit.osmType, osmId: hit.osmId,
        fallbackName: hit.name, fallbackLat: hit.lat, fallbackLon: hit.lon
      });
    });
  }

  global.GolfOSM = {
    searchCourses: searchCourses,
    loadCourseDetail: loadCourseDetail,
    distanceMeters: distanceMeters
  };
})(window);
