// =====================
// KONFIGURASI
// =====================
const CESIUM_ION_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJiMTQ0MjNmNi01Mjc5LTRmYmEtOTc2OS04MDA0NjRlMDU2MzEiLCJpZCI6MzY4MjA2LCJpYXQiOjE3NjUzMzMwOTZ9.GqzHkgM4rXSaMYDZ6_PzIfE7UtTFhznF3joollqZCZE";
const TILES_3D_ASSET_ID = 4208745;      // 3D Tiles Terban
const BUILDINGS_2D_ASSET_ID = 4219374;  // Bangunan 2D

Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;

// =====================
// VIEWER (FLAT TERRAIN UNTUK SEMUA MODE = anti hitam)
// =====================
const FLAT_TERRAIN = new Cesium.EllipsoidTerrainProvider();

const viewer = new Cesium.Viewer("cesiumContainer", {
  terrainProvider: FLAT_TERRAIN,
  timeline: false,
  animation: false,
});

// default terang (tanpa simulasi)
viewer.scene.globe.enableLighting = false;
viewer.scene.globe.depthTestAgainstTerrain = false;

// zoom feel lebih halus
const controller = viewer.scene.screenSpaceCameraController;
controller.zoomFactor = 2.0;
controller.inertiaZoom = 0.3;
controller.minimumZoomDistance = 20.0;
controller.maximumZoomDistance = 50_000_000.0;

// =====================
// STATE LAYERS
// =====================
let tileset3D;

let buildings2DDataSource;
let buildings2DTileset;

const buildings2DIndex = new Map();
const buildings2DList = [];

const measurementEntity3D = viewer.entities.add(new Cesium.Entity({
  name: "Bangunan 3D",
  show: false,
}));

let lastPicked3D = { feature: null, color: null };
let lastPicked2D = { entity: null, polygonMaterial: null, polygonOutlineColor: null };

// =====================
// LOAD 3D TILESET
// =====================
async function loadTerban3DTiles() {
  tileset3D = await Cesium.Cesium3DTileset.fromIonAssetId(TILES_3D_ASSET_ID);
  viewer.scene.primitives.add(tileset3D);
  await tileset3D.readyPromise;

  tileset3D.style = new Cesium.Cesium3DTileStyle({
    color: "color('#cccccc', 1.0)",
    show: true,
  });
}

// =====================
// LOAD 2D (GeoJSON -> KML -> CZML -> fallback tileset)
// =====================
async function loadBuildings2D() {
  const resource = await Cesium.IonResource.fromAssetId(BUILDINGS_2D_ASSET_ID);

  try {
    const ds = await Cesium.GeoJsonDataSource.load(resource, { clampToGround: true });
    viewer.dataSources.add(ds);
    buildings2DDataSource = ds;

    style2DEntities(ds);
    precompute2DMeasurements(ds);

    ds.show = false;
    return;
  } catch (_) {}

  try {
    const ds = await Cesium.KmlDataSource.load(resource, {
      camera: viewer.scene.camera,
      canvas: viewer.scene.canvas,
      clampToGround: true,
    });
    viewer.dataSources.add(ds);
    buildings2DDataSource = ds;

    style2DEntities(ds);
    precompute2DMeasurements(ds);

    ds.show = false;
    return;
  } catch (_) {}

  try {
    const ds = await Cesium.CzmlDataSource.load(resource);
    viewer.dataSources.add(ds);
    buildings2DDataSource = ds;

    style2DEntities(ds);
    precompute2DMeasurements(ds);

    ds.show = false;
    return;
  } catch (_) {}

  // fallback kalau asset ternyata 3D tiles
  buildings2DTileset = await Cesium.Cesium3DTileset.fromIonAssetId(BUILDINGS_2D_ASSET_ID);
  viewer.scene.primitives.add(buildings2DTileset);

  buildings2DTileset.style = new Cesium.Cesium3DTileStyle({
    color: "color('#ffcc00', 0.9)",
    show: true,
  });

  buildings2DTileset.show = false;
}

function style2DEntities(dataSource) {
  if (!dataSource?.entities) return;

  for (const e of dataSource.entities.values) {
    if (Cesium.defined(e.polygon)) {
      e.polygon.material = new Cesium.ColorMaterialProperty(
        Cesium.Color.YELLOW.withAlpha(0.35)
      );
      e.polygon.outline = true;
      e.polygon.outlineColor = new Cesium.ConstantProperty(
        Cesium.Color.BLACK.withAlpha(0.7)
      );
    }
    if (Cesium.defined(e.polyline)) {
      e.polyline.clampToGround = true;
      e.polyline.width = 2;
      e.polyline.material = new Cesium.ColorMaterialProperty(Cesium.Color.YELLOW);
    }
  }
}

// =====================
// 2D MEASUREMENTS + INFOBOX
// =====================
function precompute2DMeasurements(dataSource) {
  const time = Cesium.JulianDate.now();

  for (const e of dataSource.entities.values) {
    if (!Cesium.defined(e.polygon) || !Cesium.defined(e.polygon.hierarchy)) continue;

    const hierarchy = e.polygon.hierarchy.getValue(time);
    const positions = hierarchy?.positions;
    if (!positions || positions.length < 3) continue;

    const stats = computeFootprintStatsENU(positions);
    if (!stats) continue;

    e._wg_is2DBuilding = true;

    const pv = e.properties?.getValue(time) || {};
    const keys = [
      pv["gml:id"], pv.gml_id, pv.gmlId, pv.gmlid,
      pv.id, pv.ID, pv.objectid, pv.OBJECTID,
      pv.name, pv.Name,
      e.id,
    ].filter(v => v !== undefined && v !== null).map(v => String(v));

    const keyMain = String(getAnyEntityId(e, time));
    if (!keys.includes(keyMain)) keys.push(keyMain);

    for (const k of keys) buildings2DIndex.set(k, stats);
    buildings2DList.push({ centroid: stats.centroid, stats });

    e.name = e.name || `Bangunan 2D`;
    e.description = build2DInfoHtml(stats, keyMain);
  }
}

function getAnyEntityId(entity, time) {
  const props = entity.properties?.getValue(time) || {};
  return (
    props["gml:id"] ?? props.gml_id ?? props.gmlId ?? props.gmlid ??
    props.id ?? props.ID ?? props.objectid ?? props.OBJECTID ??
    props.name ?? props.Name ?? entity.id
  );
}

function computeFootprintStatsENU(cartesianPositions) {
  const pts = cartesianPositions.slice();

  if (pts.length > 2) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Cesium.Cartesian3.equalsEpsilon(first, last, Cesium.Math.EPSILON7)) {
      pts.pop();
    }
  }
  if (pts.length < 3) return null;

  const centroid = Cesium.BoundingSphere.fromPoints(pts).center;

  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(centroid);
  const invEnu = Cesium.Matrix4.inverseTransformation(enu, new Cesium.Matrix4());

  const xy = pts.map((p) => {
    const local = Cesium.Matrix4.multiplyByPoint(invEnu, p, new Cesium.Cartesian3());
    return { x: local.x, y: local.y };
  });

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of xy) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  const dx = maxX - minX;
  const dy = maxY - minY;
  const length_m = Math.max(dx, dy);
  const width_m = Math.min(dx, dy);

  // shoelace area
  let sum = 0;
  for (let i = 0; i < xy.length; i++) {
    const j = (i + 1) % xy.length;
    sum += (xy[i].x * xy[j].y) - (xy[j].x * xy[i].y);
  }
  const area_m2 = Math.abs(sum) * 0.5;

  // perimeter
  let perimeter_m = 0;
  for (let i = 0; i < xy.length; i++) {
    const j = (i + 1) % xy.length;
    perimeter_m += Math.hypot(xy[j].x - xy[i].x, xy[j].y - xy[i].y);
  }

  return { length_m, width_m, area_m2, perimeter_m, centroid };
}

function build2DInfoHtml(stats, key) {
  return `
    <table class="cesium-infoBox-defaultTable">
      <tbody>
        <tr><th>ID</th><td>${escapeHtml(String(key))}</td></tr>
        <tr><th>Panjang</th><td>${fmt(stats.length_m)} m</td></tr>
        <tr><th>Lebar</th><td>${fmt(stats.width_m)} m</td></tr>
        <tr><th>Luas</th><td>${fmt(stats.area_m2)} m²</td></tr>
        <tr><th>Keliling</th><td>${fmt(stats.perimeter_m)} m</td></tr>
      </tbody>
    </table>
  `;
}

// =====================
// HIGHLIGHT 2D
// =====================
function clear2DHighlight() {
  const e = lastPicked2D.entity;
  if (e && e.polygon) {
    if (lastPicked2D.polygonMaterial) e.polygon.material = lastPicked2D.polygonMaterial;
    if (lastPicked2D.polygonOutlineColor) e.polygon.outlineColor = lastPicked2D.polygonOutlineColor;
  }
  lastPicked2D = { entity: null, polygonMaterial: null, polygonOutlineColor: null };
}

viewer.selectedEntityChanged.addEventListener((selected) => {
  if (viewer.scene.mode !== Cesium.SceneMode.SCENE2D) return;

  clear2DHighlight();

  if (selected && selected._wg_is2DBuilding && selected.polygon) {
    lastPicked2D.entity = selected;
    lastPicked2D.polygonMaterial = selected.polygon.material;
    lastPicked2D.polygonOutlineColor = selected.polygon.outlineColor;

    selected.polygon.material = new Cesium.ColorMaterialProperty(
      Cesium.Color.ORANGE.withAlpha(0.55)
    );
    selected.polygon.outlineColor = new Cesium.ConstantProperty(
      Cesium.Color.RED.withAlpha(0.9)
    );
  }
});

// =====================
// 3D VOLUME
// =====================
function getFeaturePropertyIds(feature) {
  if (typeof feature.getPropertyIds === "function") return feature.getPropertyIds();
  if (typeof feature.getPropertyNames === "function") return feature.getPropertyNames();
  return [];
}

function findPropertyIdCaseInsensitive(propertyIds, wantedKeys) {
  const mapLower = new Map(propertyIds.map((id) => [String(id).toLowerCase(), String(id)]));
  for (const k of wantedKeys) {
    const hit = mapLower.get(String(k).toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function getNumberProperty(feature, propertyIds, keys) {
  const id = findPropertyIdCaseInsensitive(propertyIds, keys);
  if (!id) return undefined;
  const v = feature.getProperty(id);
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function getStringProperty(feature, propertyIds, keys) {
  const id = findPropertyIdCaseInsensitive(propertyIds, keys);
  if (!id) return undefined;
  const v = feature.getProperty(id);
  if (v === undefined || v === null) return undefined;
  return String(v);
}

function computeVolumeForFeature(feature) {
  const propertyIds = getFeaturePropertyIds(feature);

  const directVol = getNumberProperty(feature, propertyIds, ["volume", "VOL", "vol", "Volume"]);
  if (directVol !== undefined) {
    return { method: "property:volume", volume_m3: directVol, propertyIds };
  }

  const height = getNumberProperty(feature, propertyIds, [
    "Height", "height", "buildingHeight", "BuildingHeight",
    "measuredHeight", "maxHeight", "MaxHeight", "h"
  ]);

  let area = getNumberProperty(feature, propertyIds, [
    "Area", "area", "footprintArea", "footprint_area", "groundArea", "ground_area"
  ]);

  // kalau area tidak ada di 3D, cari dari 2D (by id atau nearest lat/lon)
  if (area === undefined) {
    const keyCandidates = [
      getStringProperty(feature, propertyIds, ["gml:id", "gml_id", "gmlId", "gmlid"]),
      getStringProperty(feature, propertyIds, ["id", "ID", "objectid", "OBJECTID", "name", "Name"]),
    ].filter(Boolean);

    for (const k of keyCandidates) {
      if (buildings2DIndex.has(k)) {
        area = buildings2DIndex.get(k).area_m2;
        break;
      }
    }

    if (area === undefined) {
      const lat = getNumberProperty(feature, propertyIds, ["Latitude", "latitude", "lat"]);
      const lon = getNumberProperty(feature, propertyIds, ["Longitude", "longitude", "lon", "lng"]);

      if (lat !== undefined && lon !== undefined && buildings2DList.length > 0) {
        const p = Cesium.Cartesian3.fromDegrees(lon, lat);

        let best = null;
        let bestDist = Infinity;
        for (const item of buildings2DList) {
          const d = Cesium.Cartesian3.distance(p, item.centroid);
          if (d < bestDist) {
            bestDist = d;
            best = item;
          }
        }

        const MAX_MATCH_DIST_M = 35.0;
        if (best && bestDist < MAX_MATCH_DIST_M) {
          area = best.stats.area_m2;
        }
      }
    }
  }

  if (height !== undefined && area !== undefined) {
    return { method: "area*height", height_m: height, area_m2: area, volume_m3: area * height, propertyIds };
  }

  return { method: "insufficient", height_m: height, area_m2: area, propertyIds };
}

// =====================
// 3D CLICK PICKING (tanpa "Property (contoh)")
// =====================
const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

handler.setInputAction((movement) => {
  if (viewer.scene.mode !== Cesium.SceneMode.SCENE3D) return;

  const picked = viewer.scene.pick(movement.position);
  if (!Cesium.defined(picked)) return;

  if (picked instanceof Cesium.Cesium3DTileFeature) {
    if (lastPicked3D.feature && lastPicked3D.color) {
      try { lastPicked3D.feature.color = lastPicked3D.color; } catch (_) {}
    }
    lastPicked3D.feature = picked;
    lastPicked3D.color = picked.color?.clone?.() ?? null;

    try { picked.color = Cesium.Color.CYAN.withAlpha(0.85); } catch (_) {}

    const r = computeVolumeForFeature(picked);

    let pos;
    if (viewer.scene.pickPositionSupported) pos = viewer.scene.pickPosition(movement.position);
    if (!Cesium.defined(pos)) pos = viewer.scene.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);

    measurementEntity3D.show = true;
    measurementEntity3D.position = pos;
    measurementEntity3D.name = "Bangunan 3D";
    measurementEntity3D.description = build3DInfoHtml(r);

    viewer.selectedEntity = measurementEntity3D;
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

function build3DInfoHtml(result) {
  if (result.method === "property:volume") {
    return `
      <table class="cesium-infoBox-defaultTable">
        <tbody>
          <tr><th>Volume</th><td>${fmt(result.volume_m3)} m³</td></tr>
          <tr><th>Metode</th><td>Property volume</td></tr>
        </tbody>
      </table>
    `;
  }

  if (result.method === "area*height") {
    return `
      <table class="cesium-infoBox-defaultTable">
        <tbody>
          <tr><th>Area</th><td>${fmt(result.area_m2)} m²</td></tr>
          <tr><th>Tinggi</th><td>${fmt(result.height_m)} m</td></tr>
          <tr><th>Volume</th><td>${fmt(result.volume_m3)} m³</td></tr>
          <tr><th>Metode</th><td>area × height</td></tr>
        </tbody>
      </table>
    `;
  }

  return `
    <table class="cesium-infoBox-defaultTable">
      <tbody>
        <tr><th>Volume</th><td>Tidak bisa dihitung (area/height/volume tidak cukup)</td></tr>
        <tr><th>Height terbaca</th><td>${result.height_m === undefined ? "-" : fmt(result.height_m) + " m"}</td></tr>
        <tr><th>Area terbaca</th><td>${result.area_m2 === undefined ? "-" : fmt(result.area_m2) + " m²"}</td></tr>
      </tbody>
    </table>
  `;
}

// =====================
// VISIBILITY + TOGGLE 2D/3D
// =====================
function setLayerVisibilityByMode() {
  const is2D = viewer.scene.mode === Cesium.SceneMode.SCENE2D;

  if (tileset3D) tileset3D.show = !is2D;
  if (buildings2DDataSource) buildings2DDataSource.show = is2D;
  if (buildings2DTileset) buildings2DTileset.show = is2D;

  if (is2D) measurementEntity3D.show = false;
  else clear2DHighlight();
}

function updateToggleButtonLabel() {
  const btn = document.getElementById("btnToggleMode");
  const is2D = viewer.scene.mode === Cesium.SceneMode.SCENE2D;
  btn.textContent = is2D ? "Ubah ke 3D" : "Ubah ke 2D";
}

function toggle2D3D() {
  const duration = 1.0;
  const is2D = viewer.scene.mode === Cesium.SceneMode.SCENE2D;
  if (is2D) viewer.scene.morphTo3D(duration);
  else viewer.scene.morphTo2D(duration);
}

viewer.scene.morphComplete.addEventListener(() => {
  viewer.terrainProvider = FLAT_TERRAIN;
  viewer.scene.globe.depthTestAgainstTerrain = false;

  setLayerVisibilityByMode();
  updateToggleButtonLabel();
  zoomToBuildings();
});

// =====================
// ZOOM
// =====================
function zoomToWorld() {
  viewer.camera.flyHome(1.5);
}

function zoomToTileset3D() {
  if (!tileset3D) return;
  const bs = tileset3D.boundingSphere;

  viewer.zoomTo(
    tileset3D,
    new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(0.0),
      Cesium.Math.toRadians(-35.0),
      bs.radius * 2.0
    )
  );
}

function zoomToBuildings() {
  const is2D = viewer.scene.mode === Cesium.SceneMode.SCENE2D;
  if (is2D) {
    if (buildings2DDataSource) return viewer.zoomTo(buildings2DDataSource);
    if (buildings2DTileset) return viewer.zoomTo(buildings2DTileset);
  }
  zoomToTileset3D();
}

// =====================
// SIMULASI WAKTU (INDONESIA)
// =====================
const seasonToMonthDay = {
  hujan:      { month: 1,  day: 15 },
  peralihan1: { month: 4,  day: 15 },
  kemarau:    { month: 8,  day: 15 },
  peralihan2: { month: 10, day: 15 },
};

const seasonSelect = document.getElementById("seasonSelect");
const tzSelect = document.getElementById("tzSelect");
const dateInput = document.getElementById("dateInput");
const startTimeInput = document.getElementById("startTime");
const endTimeInput = document.getElementById("endTime");
const speedSelect = document.getElementById("speedSelect");
const shadowToggle = document.getElementById("shadowToggle");
const simNowEl = document.getElementById("simNow");

const btnPlaySim = document.getElementById("btnPlaySim");
const btnPauseSim = document.getElementById("btnPauseSim");
const btnStopSim = document.getElementById("btnStopSim");

let simEnabled = false;

function pad2(n) { return String(n).padStart(2, "0"); }

function setDateInputFromSeason() {
  const year = new Date().getFullYear();
  const md = seasonToMonthDay[seasonSelect.value] || seasonToMonthDay.kemarau;
  dateInput.value = `${year}-${pad2(md.month)}-${pad2(md.day)}`;
}

function parseTimeHHMM(value) {
  const [hh, mm] = String(value || "06:00").split(":").map(Number);
  return { h: Number.isFinite(hh) ? hh : 6, m: Number.isFinite(mm) ? mm : 0 };
}

function localDateTimeToJulian(dateStr, hh, mm, tzOffsetHours) {
  const [Y, M, D] = dateStr.split("-").map(Number);
  const utcDate = new Date(Date.UTC(Y, M - 1, D, hh - tzOffsetHours, mm, 0));
  return Cesium.JulianDate.fromDate(utcDate);
}

function applyShadowSetting(enabled) {
  viewer.shadows = !!enabled;
  viewer.scene.shadowMap.enabled = !!enabled;

  if (tileset3D) tileset3D.shadows = enabled ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED;
  if (buildings2DTileset) buildings2DTileset.shadows = enabled ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED;
}

function applyTimeSimulationFromUI() {
  const tz = Number(tzSelect.value || 7);

  if (!dateInput.value) setDateInputFromSeason();
  const dateStr = dateInput.value;

  const st = parseTimeHHMM(startTimeInput.value);
  const et = parseTimeHHMM(endTimeInput.value);

  let startJul = localDateTimeToJulian(dateStr, st.h, st.m, tz);
  let stopJul  = localDateTimeToJulian(dateStr, et.h, et.m, tz);

  if (Cesium.JulianDate.lessThan(stopJul, startJul)) {
    stopJul = Cesium.JulianDate.addDays(stopJul, 1, new Cesium.JulianDate());
  }

  const multiplier = Number(speedSelect.value || 300);

  viewer.clock.startTime = startJul.clone();
  viewer.clock.stopTime = stopJul.clone();
  viewer.clock.currentTime = startJul.clone();
  viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
  viewer.clock.multiplier = multiplier;
}

function enableTimeSimulation(on) {
  simEnabled = !!on;

  viewer.scene.globe.enableLighting = simEnabled;
  if (simEnabled) viewer.scene.light = new Cesium.SunLight();

  applyShadowSetting(simEnabled && shadowToggle.checked);

  viewer.clock.shouldAnimate = simEnabled;
}

function formatSimNowLocal() {
  if (!simEnabled) return "-";
  const tz = Number(tzSelect.value || 7);

  const utcDate = Cesium.JulianDate.toDate(viewer.clock.currentTime);
  const localMs = utcDate.getTime() + tz * 3600 * 1000;
  const d = new Date(localMs);

  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());

  const tzLabel = tz === 7 ? "WIB" : (tz === 8 ? "WITA" : "WIT");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} ${tzLabel}`;
}

viewer.clock.onTick.addEventListener(() => {
  simNowEl.textContent = formatSimNowLocal();
});

// UI events
seasonSelect.addEventListener("change", () => {
  setDateInputFromSeason();
  if (simEnabled) applyTimeSimulationFromUI();
});
tzSelect.addEventListener("change", () => {
  if (simEnabled) applyTimeSimulationFromUI();
});
dateInput.addEventListener("change", () => {
  if (simEnabled) applyTimeSimulationFromUI();
});
startTimeInput.addEventListener("change", () => {
  if (simEnabled) applyTimeSimulationFromUI();
});
endTimeInput.addEventListener("change", () => {
  if (simEnabled) applyTimeSimulationFromUI();
});
speedSelect.addEventListener("change", () => {
  if (simEnabled) viewer.clock.multiplier = Number(speedSelect.value || 300);
});
shadowToggle.addEventListener("change", () => {
  applyShadowSetting(simEnabled && shadowToggle.checked);
});

btnPlaySim.addEventListener("click", () => {
  applyTimeSimulationFromUI();
  enableTimeSimulation(true);
});
btnPauseSim.addEventListener("click", () => {
  viewer.clock.shouldAnimate = false;
});
btnStopSim.addEventListener("click", () => {
  enableTimeSimulation(false);
  simNowEl.textContent = "-";
});

// =====================
// UTIL
// =====================
function fmt(n, digits = 2) {
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(digits);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// =====================
// BUTTONS TOP
// =====================
document.getElementById("btnToggleMode").addEventListener("click", toggle2D3D);
document.getElementById("btnZoomWorld").addEventListener("click", zoomToWorld);
document.getElementById("btnZoomBuildings").addEventListener("click", zoomToBuildings);

// =====================
// START
// =====================
(async () => {
  try {
    setDateInputFromSeason();

    await loadTerban3DTiles();
    await loadBuildings2D();

    viewer.terrainProvider = FLAT_TERRAIN;
    viewer.scene.globe.enableLighting = false;

    setLayerVisibilityByMode();
    updateToggleButtonLabel();
    zoomToBuildings();
  } catch (err) {
    console.error(err);
    alert("Terjadi error saat inisialisasi.\n\n" + (err?.message || err));
  }
})();
