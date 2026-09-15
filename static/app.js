(() => {
  'use strict';
  // --- Static-first Option B (client-side LOS) — reversible ---
  // Toggle USE_CLIENT_ENGINE to force server fallback. Dynamic import keeps file usable as plain script;
  // to use static import instead, add `import * as Engine from './engine.js'` at top and load app.js as type="module".
  const USE_CLIENT_ENGINE = true;
  const MAX_VIEWSHED_SIDE = 100;
  let Engine = null;
  let GlobalData = null;
  let EngineLoadError = null;
  let clientScene = null; // { meta, scene: Engine.Scene|null, source }
  let staticMode = window.SIGHTLINE_STATIC === true;
  let staticManifest = null;
  let browserSceneData = null;
  let overlayRenderPromise = null;
  let clientEngineReady = false;
  let _updateBadge = () => {};
  function engineModeLabel() {
    if (staticMode && USE_CLIENT_ENGINE && Engine && clientScene && clientScene.scene) return 'client-side engine';
    if (USE_CLIENT_ENGINE && Engine && clientEngineReady) return 'client-ready (meta-only)';
    if (EngineLoadError) return 'server (client failed)';
    return 'server';
  }
  async function populateClientScene() {
    if (!USE_CLIENT_ENGINE || !Engine) return;
    try {
      let manifest = staticManifest;
      for (const url of ['/api/scene', './static/scene.json']) {
        if (manifest) break;
        try {
          const r = await fetch(url);
          if (r.ok && (r.headers.get('content-type')||'').includes('application/json')) manifest = await r.json();
        } catch {}
      }
      if (manifest && manifest.ground && manifest.meta) {
        const obj = manifest.scene || manifest;
        const scene = Engine.Scene.fromObjects(obj);
        clientScene = { meta: scene.meta, scene, source: staticMode ? './static/scene.json' : '/api/scene' };
        console.log('[Sightline] clientScene populated from /api/scene — client-side LOS enabled', { w: scene.w, h: scene.h });
      } else {
        clientScene = { meta: state.meta, scene: null, source: 'meta-only' };
        console.info('[Sightline] clientScene: meta-only (no /api/scene rasters). LOS falls back to server until raster manifest is exposed. See static/engine.js header.');
      }
      _updateBadge();
    } catch (e) { console.warn('[Sightline] populateClientScene failed', e); _updateBadge(); }
  }
  async function fetchLosResult(params, signal) {
    const canUseClient = staticMode && USE_CLIENT_ENGINE && Engine && clientScene && clientScene.scene;
    if (canUseClient) {
      try {
        console.log('[Sightline] LOS: ' + engineModeLabel());
        const r = Engine.analyze(clientScene.scene, params);
        r._engine = 'client';
        _updateBadge();
        return r;
      } catch (e) {
        if (staticMode) throw e;
        console.warn('[Sightline] client trace failed, falling back to server', e);
      }
    }
    console.log('[Sightline] LOS: server');
    const res = await fetch('/api/los', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(params), signal });
    if (!res.ok) { let m=`Request failed (${res.status})`; try{m=(await res.json()).error||m}catch{} throw new Error(m); }
    const r = await res.json(); r._engine='server'; _updateBadge(); return r;
  }
  async function fetchViewshedResult(params) {
    // Validate radius/step before any engine work — actionable, don't silently fallback
    const _vr = Number(params.radius_m); const _vs = Number(params.step_m);
    if (!Number.isFinite(_vr) || !Number.isFinite(_vs) || _vr<=0 || _vs<=0) {
      throw new Error('Viewshed radius and step must be finite numbers greater than 0. Check Radius and Sample step fields.');
    }
    const _vn = Math.ceil(2*_vr/_vs);
    if (!Number.isFinite(_vn) || _vn<=0) throw new Error('Invalid viewshed grid. Check radius and step.');
    if (_vn*_vn>MAX_VIEWSHED_SIDE**2) {
      const _minStep = Math.ceil(2*_vr/MAX_VIEWSHED_SIDE);
      throw new Error(`This viewshed would evaluate ${(_vn*_vn).toLocaleString()} locations. Increase step_m to at least ${_minStep} m or reduce radius. There is no fixed distance cap within 500 km.`);
    }
    const canUseClient = staticMode && USE_CLIENT_ENGINE && Engine && clientScene && clientScene.scene;
    if (canUseClient) {
      try {
        console.log('[Sightline] Viewshed: client-side engine');
        const scene = clientScene.scene;
        // Delegate to Engine.viewshed if available
        if (typeof Engine.viewshed === 'function') {
          const vs = Engine.viewshed(scene, params);
          const canvas = document.createElement('canvas');
          canvas.width = vs.n;
          canvas.height = vs.n;
          const ctx = canvas.getContext('2d');
          const imgData = new ImageData(vs.rgba, vs.n, vs.n);
          ctx.putImageData(imgData, 0, 0);
          const dataUrl = canvas.toDataURL('image/png');
          _updateBadge();
          return { bounds: vs.bounds, image: dataUrl, counts: vs.counts, notes: vs.notes, _engine: 'client' };
        }

        const a = scene.xy(params.a);
        const g_a = scene.groundAt(a[0], a[1]);
        const [r_a, c_a] = scene.cell(a[0], a[1]);
        const b_a = (r_a >= 0 && r_a < scene.h && c_a >= 0 && c_a < scene.w) ? scene.buildings[r_a][c_a] : NaN;
        const auto_rooftop = ('auto_rooftop_a' in params) ? (params.auto_rooftop_a !== false) : (params.mount_type_a === undefined || params.mount_type_a === null);
        if (auto_rooftop && Number.isFinite(b_a) && b_a > g_a) {
          params.mount_type_a = 'rooftop';
        }
        const opts = Engine.settings(params);
        const radius = Number(params.radius_m); const step = Number(params.step_m);
        const n = Math.ceil(2*radius/step);
        if (n*n>MAX_VIEWSHED_SIDE**2) {
          const minStep = Math.ceil(2*radius/MAX_VIEWSHED_SIDE);
          throw new Error(`This viewshed would evaluate ${(n*n).toLocaleString()} locations. Increase step_m to at least ${minStep} m or reduce radius. There is no fixed distance cap within 500 km.`);
        }
        const corners = [];
        for (const dx of [-1,1]) for (const dy of [-1,1]) corners.push(scene.toLL(a[0]+dx*radius, a[1]+dy*radius));
        let west=Infinity,east=-Infinity,south=Infinity,north=-Infinity;
        for (const c of corners) { const lon=c[0], lat=c[1]; if(lon<west)west=lon; if(lon>east)east=lon; if(lat<south)south=lat; if(lat>north)north=lat; }
        const lonArr=new Array(n); for(let i=0;i<n;i++) lonArr[i]=west+(i+0.5)/n*(east-west);
        const latArr=new Array(n); for(let i=0;i<n;i++) latArr[i]=north-(i+0.5)/n*(north-south);
        const isSimple = params.simple !== false;
        const include_foliage = params.include_foliage !== false;
        const visible_color = [235, 55, 65, 215]; // Red for visible coverage
        const foliage_color = include_foliage ? visible_color : [0, 0, 0, 0];
        const colors = isSimple ? {
          clear: visible_color,
          foliage: foliage_color,
          fresnel: visible_color,
          blocked: [0, 0, 0, 0],
          unknown: [130, 135, 145, 90],
        } : {
          clear: visible_color,
          foliage: include_foliage ? [241, 183, 74, 215] : [0, 0, 0, 0],
          fresnel: [172, 129, 245, 215],
          blocked: [0, 0, 0, 0],
          unknown: [130, 135, 145, 90],
        };
        if (params && typeof params.colors === 'object' && params.colors !== null) {
          Object.assign(colors, params.colors);
        }
        const counts={clear:0,foliage:0,blocked:0,unknown:0,fresnel:0};
        const canvas=document.createElement('canvas'); canvas.width=n; canvas.height=n;
        const ctx=canvas.getContext('2d'); const imgData=ctx.createImageData(n,n);
        const [lon_a, lat_a] = scene.toLL(a[0], a[1]);
        for(let row=0;row<n;row++){ for(let col=0;col<n;col++){
          const lon=lonArr[col], lat=latArr[row];
          let xy=null; try{ xy=scene.xy([lat,lon]); }catch{ xy=null; }
          if(!xy){
            const dLat = (lat - lat_a) * 111132.954;
            const dLon = (lon - lon_a) * 111412.84 * Math.cos(lat_a * Math.PI / 180);
            if (Math.hypot(dLat, dLon) > radius) continue;
            const idx=(row*n+col)*4; imgData.data[idx]=colors.unknown[0]; imgData.data[idx+1]=colors.unknown[1]; imgData.data[idx+2]=colors.unknown[2]; imgData.data[idx+3]=colors.unknown[3]; counts.unknown++; continue;
          }
          const b=xy; const dist=Math.hypot(a[0]-b[0],a[1]-b[1]);
          if(dist>radius) continue;
          let onCoverage = false;
          let onBuilding = false;
          try {
            const cell = scene.cell(b[0], b[1]);
            const r = cell[0], c = cell[1];
            onCoverage = r >= 0 && r < scene.h && c >= 0 && c < scene.w && Number.isFinite(scene.ground[r][c]);
            onBuilding = onCoverage && Number.isFinite(scene.buildings[r][c]);
          } catch { onCoverage = false; }

          let st = 'clear';
          if (dist < 0.01) {
            st = (opts.target_surface === 'ground' && onBuilding) ? 'blocked' : 'clear';
          } else if (!onCoverage) {
            st = 'unknown';
          } else if (opts.target_surface === 'ground' && onBuilding) {
            st = 'blocked';
          } else {
            try {
              st = Engine.trace(scene, a, b, opts, false).status;
            } catch (e) {
              const msg = String(e && e.message || '');
              if (msg.toLowerCase().includes('outside')) st = 'unknown';
              else throw e;
            }
          }
          if(!(st in counts)) st='unknown';
          counts[st]++;
          const colr=colors[st]||colors.unknown;
          const idx=(row*n+col)*4; imgData.data[idx]=colr[0]; imgData.data[idx+1]=colr[1]; imgData.data[idx+2]=colr[2]; imgData.data[idx+3]=colr[3];
        }}
        ctx.putImageData(imgData,0,0);
        const dataUrl=canvas.toDataURL('image/png');
        _updateBadge();
        const vsNotes = [];
        const targetDesc = (params.target_surface === 'surface') ? 'rooftop/ground surface' : 'terrain/ground level';
        vsNotes.push('Client-side viewshed (grid ~'+(2*radius/n).toFixed(1)+' m spacing; red=visible line of sight, uncolored=obstructed). Target height is above ' + targetDesc + '.');
        const isCorr= !!(scene.meta && scene.meta.is_corridor);
        if (isCorr) vsNotes.push('Dataset is a narrow corridor: targets outside the corridor appear gray (unknown). For omnidirectional viewshed, fetch a full 360° area or a wider corridor.');
        else {
          const tot=Object.values(counts).reduce((a,b)=>a+b,0);
          if (tot>0 && counts.unknown/tot>0.5) vsNotes.push('Many sampled targets are outside available data coverage. The requested radius may extend beyond the loaded terrain bounds – reduce radius or fetch a larger area.');
        }
        if (radius>50000) vsNotes.push('Long-range viewshed (>50 km): local projection and effective-Earth approximations need independent validation.');
        else if (radius>10000) vsNotes.push('Viewshed uses local transverse-Mercator projection; accuracy decreases with distance – validate beyond ~10 km.');
        return { bounds:[[south,west],[north,east]], image:dataUrl, counts, notes:vsNotes, _engine:'client' };
      } catch (e) {
        // Don't silently fallback for validation / actionable errors — surface them
        if (e && e.message && (e.message.includes('would evaluate') || e.message.includes('must be finite') || e.message.includes('must be between') || e.message.includes('Invalid viewshed'))) throw e;
        console.warn('[Sightline] client viewshed failed, falling back to server', e);
      }
    }
    console.log('[Sightline] Viewshed: server');
    const res=await fetch('/api/viewshed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params)});
    if(!res.ok){ let m=`Request failed (${res.status})`; try{m=(await res.json()).error||m}catch{} throw new Error(m); }
    const r=await res.json(); r._engine='server'; _updateBadge(); return r;
  }

  const $ = id => document.getElementById(id);
  const state = { meta:null, mode:'radio', analysisMode:'path', points:{a:null,b:null}, markers:{}, result:null, layers:{}, viewshed:null, viewshedResult:null };
  // Wire badge + dynamic engine import (keeps 127.0.0.1 dev flow reversible)
  _updateBadge = function updateEngineBadge() {
    try {
      let badge = document.getElementById('engineModeBadge');
      if (!badge) {
        const anchor = document.getElementById('datasetMeta') || document.getElementById('datasetName');
        if (anchor && anchor.parentElement) {
          badge = document.createElement('span');
          badge.id = 'engineModeBadge';
          badge.style.cssText = 'margin-left:8px;padding:2px 6px;border-radius:8px;font-size:10px;border:1px solid var(--line, #2a3330);background:#0a0d0c;color:var(--muted,#8a9590);cursor:default;';
          badge.title = 'Click to toggle client/server (reversible)';
          badge.addEventListener('click', () => {
            // reversible toggle for debugging — does not persist
            // Note: toggling off keeps server fallback; toggling on requires Engine already loaded
            if (clientScene && clientScene.scene) toast('Engine: ' + engineModeLabel());
            else toast('Engine: ' + engineModeLabel() + ' — tip: populate /api/scene for full client LOS');
          });
          anchor.insertAdjacentElement('afterend', badge);
        }
      }
      if (badge) {
        const label = engineModeLabel();
        const isClient = label.includes('client-side');
        badge.textContent = isClient ? '● client-side engine' : '○ server';
        badge.style.color = isClient ? '#53d696' : '#8a9590';
        badge.style.borderColor = isClient ? '#53d69655' : '#2a3330';
        badge.title = 'Engine mode: ' + label + ' (click for info) — USE_CLIENT_ENGINE=' + USE_CLIENT_ENGINE;
      }
      // expose for console
      window.SightlineEngine = { USE_CLIENT_ENGINE, Engine, clientScene, engineModeLabel, EngineLoadError };
    } catch {}
  };
  if (USE_CLIENT_ENGINE) {
    // dynamic import — if this fails we keep server fallback
    import('./engine.js').then(m => {
      Engine = m; clientEngineReady = true;
      console.log('[Sightline] client-side engine loaded (Engine.trace/analyze available)');
      _updateBadge();
      if (staticMode && state.meta) populateClientScene();
    }).catch(e => {
      EngineLoadError = e; console.warn('[Sightline] client engine unavailable — falling back to server', e); _updateBadge();
    });
  } else {
    console.log('[Sightline] USE_CLIENT_ENGINE=false — server LOS only');
  }
  let GlobalDataPromise = null;
  function loadGlobalData() {
    if (!GlobalDataPromise) {
      GlobalDataPromise = import('./global-data.js').then(module => {
        GlobalData = module;
        return module;
      }).catch(error => {
        GlobalDataPromise = null;
        console.warn('[Sightline] browser global-data module unavailable', error);
        throw error;
      });
    }
    return GlobalDataPromise;
  }

  function updateAnalysisModeUI() {
    const isViewshed = state.analysisMode === 'viewshed';
    document.querySelectorAll('[data-analysis]').forEach(b => {
      const on = b.dataset.analysis === state.analysisMode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const bCard = $('pointBCard');
    if (bCard) bCard.hidden = isViewshed;
    // hide B marker + path line on map in viewshed mode, restore when switching back
    if (isViewshed) {
      clearTimeout(autoRunTimer);
      if (autoRunController) { try { autoRunController.abort(); } catch {} }
      if (state.markers.b && map.hasLayer(state.markers.b)) map.removeLayer(state.markers.b);
      if (state.layers.path) { try { map.removeLayer(state.layers.path); } catch {} state.layers.path = null; }
      // also hide any lingering path hover marker
      if (pathHoverMarker && map.hasLayer(pathHoverMarker)) map.removeLayer(pathHoverMarker);
      // restore viewshed layer if previously computed
      if (state.viewshed && !map.hasLayer(state.viewshed)) {
        state.viewshed.addTo(map);
        try { state.viewshed.bringToFront(); } catch {}
      }
      // hide classes overlay while in viewshed mode so hit map is clean
      if (state.layers.classes && map.hasLayer(state.layers.classes)) map.removeLayer(state.layers.classes);
      // hide terrain overlay (both corridor and area) so bounding box is completely removed from map
      if (state.layers.terrain && map.hasLayer(state.layers.terrain)) {
        map.removeLayer(state.layers.terrain);
      }
      if (activeBase === state.layers.terrain) {
        setBase('satellite');
      }
    } else {
      if (staticMode) ensureBrowserOverlays();
      if (state.markers.b && state.points.b && !map.hasLayer(state.markers.b)) state.markers.b.addTo(map);
      if (state.points.a && state.points.b) drawPath();
      // remove viewshed overlay from map while in path mode (preserved in state.viewshed)
      if (state.viewshed && map.hasLayer(state.viewshed)) map.removeLayer(state.viewshed);
      // restore terrain layer if activeBase was terrain
      if (state.layers.terrain && !map.hasLayer(state.layers.terrain) && activeBase === state.layers.terrain) {
        state.layers.terrain.addTo(map);
      }
      // restore classes if toggled
      if (state.layers.classes && !map.hasLayer(state.layers.classes) && $('classToggle')?.checked) map.addLayer(state.layers.classes);
    }
    const vHint = $('viewshedOriginHint');
    if (vHint) vHint.hidden = !isViewshed;
    const vSec = $('viewshedSection');
    if (vSec) vSec.hidden = !isViewshed;
    const radioSec = $('radioSection');
    if (radioSec) radioSec.hidden = isViewshed;
    const vsStep = document.querySelector('#viewshedSection .step');
    if (vsStep) vsStep.textContent = '02';
    const epH = $('endpointsHeading');
    if (epH) epH.textContent = isViewshed ? 'Origin' : 'Endpoints';
    const epHint = $('endpointsHint');
    if (epHint) epHint.textContent = isViewshed ? 'Viewshed center is Site A' : 'Drag markers or place below';
    const runLbl = $('runPrimaryLabel');
    if (runLbl) runLbl.textContent = isViewshed ? 'Calculate 360° Viewshed' : 'Run path';
    const runPrimary = $('runPrimary');
    if (runPrimary) runPrimary.title = isViewshed ? 'Compute 360° viewshed around Site A' : 'Run line-of-sight A→B';
    // toggle Place B button in viewshed mode
    const placeBBtn = $('placeB');
    const placeABar = document.querySelector('.segmented[aria-label="Map placement"]');
    if (placeBBtn) placeBBtn.hidden = isViewshed;
    if (placeABar) placeABar.style.display = isViewshed ? 'none' : 'grid';
    // terrain scope default per mode
    const scopeCorridor = $('scopeCorridor');
    const scopeArea = $('scopeArea');
    if (scopeCorridor && scopeArea) {
      if (isViewshed && scopeCorridor.checked) { scopeArea.checked = true; scopeCorridor.checked = false; }
      // trigger display logic
      document.querySelectorAll('input[name="fetchScope"]').forEach(i => i.dispatchEvent(new Event('change')));
    }

    // Results panel swap between Profile chart (Path) and Viewshed summary card
    const chartWrap = document.querySelector('.chart-wrap');
    const vsSummary = $('viewshedSummary');
    if (isViewshed) {
      if (chartWrap) chartWrap.hidden = true;
      if ($('obstructionHero')) $('obstructionHero').hidden = true;
      if ($('deploymentSection')) $('deploymentSection').hidden = true;
      if ($('profileHud')) $('profileHud').hidden = true;
      $('resultsEyebrow').textContent = 'Viewshed analysis';
      if (state.viewshedResult) {
        renderViewshed(state.viewshedResult);
      } else {
        $('resultTitle').textContent = 'Ready for viewshed';
        $('metrics').innerHTML = '';
        if (vsSummary) {
          vsSummary.innerHTML = `
            <div class="viewshed-empty">
              <span class="empty-icon" aria-hidden="true">◉</span>
              <span>Place Site A and click "Calculate 360° Viewshed" to compute coverage.</span>
            </div>
          `;
          vsSummary.hidden = false;
        }
      }
    } else {
      if (chartWrap) chartWrap.hidden = false;
      if (vsSummary) vsSummary.hidden = true;
      $('resultsEyebrow').textContent = 'Elevation profile';
      if (state.result) {
        renderResult(state.result);
        drawPath(state.result.status);
        drawProfile(state.result.profile || [], state.mode === 'radio', state.result.critical_obstacle);
      } else {
        $('resultTitle').textContent = 'Ready for analysis';
        $('metrics').innerHTML = '';
        const ec = $('emptyChart');
        if (ec) ec.hidden = false;
      }
    }

    // legend footer swap per mode
    const footerEl = document.querySelector('.results-panel footer');
    if (footerEl) {
      if (isViewshed) {
        footerEl.innerHTML = `
          <span><i class="hit-key" style="background:#eb3741;box-shadow:0 0 4px rgba(235,55,65,0.7);"></i>Visible (Hit)</span>
          <span><i class="blocked-key" style="background:transparent;border:1px dashed #7a8a84;"></i>Obstructed (Transparent)</span>
          <span><i class="unknown-key" style="background:rgba(130,135,145,0.4);"></i>Outside terrain</span>
        `;
      } else {
        footerEl.innerHTML = `
          <span><i class="terrain-key"></i>Terrain</span>
          <span><i class="building-key"></i>Structure</span>
          <span><i class="tree-key"></i>Canopy</span>
          <span><i class="ray-key"></i>Ray</span>
          <span><i class="fresnel-key"></i>Fresnel zone</span>
        `;
      }
    }
    const mapLegend = document.querySelector('.map-stage > .legend');
    if (mapLegend) {
      mapLegend.innerHTML = isViewshed
        ? '<span><i style="background:#eb3741"></i>Visible</span><span><i style="background:transparent;border:1px dashed #7a8a84"></i>Obstructed</span><span><i style="background:rgba(130,135,145,.7)"></i>Outside terrain</span>'
        : '<span><i class="clear"></i>Clear</span><span><i class="foliage"></i>Foliage</span><span><i class="fresnel"></i>Fresnel constrained</span><span><i class="blocked"></i>Blocked</span><span><i class="unknown"></i>Unknown</span>';
    }

    // placement default: viewshed uses A
    if (isViewshed) {
      placing = 'a';
      document.querySelectorAll('#placeA, #placeB').forEach(b => { const on=b.id==='placeA'; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    }
    updateRunButtonState();
  }

  function distToSegmentMeters(p, a, b) {
    const latMid = ((a[0] + b[0]) / 2) * Math.PI / 180;
    const mPerLat = 111132.954;
    const mPerLon = 111412.84 * Math.cos(latMid);
    const ax = 0, ay = 0;
    const bx = (b[1] - a[1]) * mPerLon, by = (b[0] - a[0]) * mPerLat;
    const px = (p[1] - a[1]) * mPerLon, py = (p[0] - a[0]) * mPerLat;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px, py);
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
    const projX = ax + t * dx;
    const projY = ay + t * dy;
    return Math.hypot(px - projX, py - projY);
  }

  function isPointsCovered() {
    const isViewshed = state.analysisMode === 'viewshed';
    if (isViewshed) {
      if (!state.points.a) return false;
      const bounds = state.meta?.bounds ? L.latLngBounds(state.meta.bounds) : null;
      if (!bounds) return false;
      if (!bounds.contains(state.points.a)) return false;
      if (clientScene && clientScene.scene) {
        try {
          const xy = clientScene.scene.xy(state.points.a);
          clientScene.scene.groundAt(xy[0], xy[1]);
        } catch (_) {
          return false;
        }
      }
      return true;
    }
    if (!state.points.a || !state.points.b) return false;
    const bounds = state.meta?.bounds ? L.latLngBounds(state.meta.bounds) : null;
    if (!bounds || !bounds.contains(state.points.a) || !bounds.contains(state.points.b)) return false;
    if (state.meta?.is_corridor && state.meta?.default_a && state.meta?.default_b) {
      const da = distToSegmentMeters(state.points.a, state.meta.default_a, state.meta.default_b);
      const db = distToSegmentMeters(state.points.b, state.meta.default_a, state.meta.default_b);
      const buf = state.meta?.corridor_buffer_m || 60;
      if (da > buf * 0.8 || db > buf * 0.8) return false;
    }
    return true;
  }

  function isViewshedAreaCovered() {
    if (!state.points.a || !state.meta?.bounds || state.meta.is_corridor) return false;
    const radius = num('radius') || 1000;
    const latPad = radius / 111320;
    const lonPad = radius / (111320 * Math.max(0.01, Math.cos(state.points.a[0] * Math.PI / 180)));
    const bounds = L.latLngBounds(state.meta.bounds);
    return [
      [state.points.a[0] - latPad, state.points.a[1]],
      [state.points.a[0] + latPad, state.points.a[1]],
      [state.points.a[0], state.points.a[1] - lonPad],
      [state.points.a[0], state.points.a[1] + lonPad],
    ].every(point => bounds.contains(point));
  }

  function updateRunButtonState() {
    const btn = $('runPrimary');
    const hint = $('runHint');
    if (!btn) return;
    const isViewshed = state.analysisMode === 'viewshed';
    if (isViewshed) {
      const hasA = !!state.points.a;
      const outside = hasA && !isPointsCovered();
      const invalid = !hasA;
      btn.disabled = invalid || isFetchingViewshed;
      const r = num('radius') || 1000;
      const rLabel = r >= 1000 ? `${(r / 1000).toFixed(r % 1000 ? 1 : 0)} km` : `${r} m`;
      btn.title = invalid ? 'Place Site A on the map to calculate viewshed' : outside ? `Run will download 360° terrain (${rLabel} radius)` : `Calculate 360° viewshed (${rLabel} radius)`;
      if (hint) hint.textContent = !hasA ? 'Place Site A on the map to enable viewshed.' : outside ? `Ready — click to download 360° terrain (${rLabel} radius) and calculate viewshed.` : `Ready to calculate 360° viewshed (${rLabel} radius).`;
      const vBtn = $('runViewshed');
      if (vBtn) vBtn.disabled = invalid;
      return;
    }
    const hasAB = !!(state.points.a && state.points.b);
    const outside = hasAB && !isPointsCovered();
    const invalid = !hasAB;
    btn.disabled = invalid;
    if (invalid) {
      btn.title = 'Place both Site A and Site B to enable';
      if (hint) hint.textContent = 'Place both Site A and B to enable Run.';
    } else if (outside) {
      btn.title = 'Sites outside terrain — Run will download their corridor';
      if (hint) hint.textContent = 'Sites outside current terrain — Run will download a new corridor in the browser.';
    } else {
      btn.title = 'Run line-of-sight A→B';
      if (hint) hint.textContent = '';
    }
  }
  function updateRadioFieldsState() {
    const isRadio = state.mode === 'radio';
    const box = document.querySelector('.radio-fields');
    if (box) {
      box.style.opacity = isRadio ? '1' : '.45';
      box.querySelectorAll('input, select, button, textarea').forEach(el => { el.disabled = !isRadio; });
    }
  }
  document.querySelectorAll('[data-analysis]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.analysisMode = btn.dataset.analysis;
      updateAnalysisModeUI();
      toast(state.analysisMode==='viewshed' ? 'Viewshed mode — place Site A as origin' : 'Path mode — place A and B');
    });
  });
  // inline hint switch
  const hintLink = $('switchToPathHint');
  if (hintLink) hintLink.addEventListener('click', (e) => { e.preventDefault(); state.analysisMode='path'; updateAnalysisModeUI(); });

  function updateViewshedGridInfo() {
    const r = num('radius');
    const s = num('stepM');
    const info = $('viewshedGridInfo');
    if (info && Number.isFinite(r) && Number.isFinite(s) && s > 0) {
      const n = Math.ceil(2 * r / s);
      info.textContent = `${n}×${n} (${(n * n).toLocaleString()} pts)`;
      info.style.color = n * n > MAX_VIEWSHED_SIDE ** 2 ? '#ff675f' : n * n > 7000 ? '#e8a317' : '';
    }
  }

  function applyViewshedRadius(radiusMeters) {
    const rInput = $('radius');
    const sInput = $('stepM');
    if (!rInput || !sInput) return;
    rInput.value = radiusMeters;
    // Keep the synchronous browser engine within its responsive 100×100 budget.
    let adaptiveStep = Math.max(5, Math.ceil((2 * radiusMeters) / MAX_VIEWSHED_SIDE));
    if (adaptiveStep > 20) adaptiveStep = Math.round(adaptiveStep / 10) * 10;
    else if (adaptiveStep > 10) adaptiveStep = Math.round(adaptiveStep / 5) * 5;
    sInput.value = Math.max(1, adaptiveStep);
    document.querySelectorAll('.radius-presets button').forEach(b => {
      const on = Number(b.dataset.radius) === radiusMeters;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    if (state.viewshed) {
      map.removeLayer(state.viewshed);
      state.viewshed = null;
      state.viewshedResult = null;
    }
    updateViewshedGridInfo();
    updateRunButtonState();
  }

  document.querySelectorAll('.radius-presets button').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = Number(btn.dataset.radius);
      if (Number.isFinite(r)) {
        applyViewshedRadius(r);
      }
    });
  });

  ['radius', 'stepM'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('input', () => {
      const r = num('radius');
      document.querySelectorAll('.radius-presets button').forEach(b => {
        const on = Number(b.dataset.radius) === r;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      if (state.viewshed) {
        map.removeLayer(state.viewshed);
        state.viewshed = null;
        state.viewshedResult = null;
      }
      updateViewshedGridInfo();
      updateRunButtonState();
    });
  });

  ['viewshedTargetHeight', 'viewshedTargetSurface'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', () => {
      if (state.viewshed) {
        map.removeLayer(state.viewshed);
        state.viewshed = null;
        state.viewshedResult = null;
      }
      updateRunButtonState();
    });
  });

  const map = L.map('map', {zoomControl:false, attributionControl:true});
  L.control.zoom({position:'topleft'}).addTo(map);
  map.createPane('viewshedPane');
  map.getPane('viewshedPane').style.zIndex = '430';
  map.createPane('pathPane');
  map.getPane('pathPane').style.zIndex = '450';
  map.setView([44.0521,-123.0868], 13);
  let mapResizeFrame = 0;
  const resizeMap = () => {
    cancelAnimationFrame(mapResizeFrame);
    mapResizeFrame = requestAnimationFrame(() => map.invalidateSize());
  };
  window.addEventListener('resize', resizeMap);
  window.addEventListener('orientationchange', resizeMap);

  const mobileLayout = window.matchMedia('(max-width: 680px), (max-height: 500px) and (max-width: 950px)');
  let mobilePanel = 'map';
  let openMobileResultsAfterRun = false;
  function setMobilePanel(panel, moveFocus = false) {
    mobilePanel = ['map', 'controls', 'results'].includes(panel) ? panel : 'map';
    const focusTarget = mobilePanel === 'controls'
      ? $('closeMobileControls')
      : mobilePanel === 'results'
        ? $('resultsPanel')
        : document.querySelector('[data-mobile-panel="map"]');
    if (mobileLayout.matches && document.activeElement?.closest('#controlsPanel, #resultsPanel')) {
      focusTarget?.focus({preventScroll:true});
    }
    document.body.classList.toggle('mobile-controls-open', mobileLayout.matches && mobilePanel === 'controls');
    document.body.classList.toggle('mobile-results-open', mobileLayout.matches && mobilePanel === 'results');
    document.querySelectorAll('[data-mobile-panel]').forEach(button => {
      const active = button.dataset.mobilePanel === mobilePanel;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    [
      [$('controlsPanel'), 'controls'],
      [$('resultsPanel'), 'results'],
    ].forEach(([panelElement, panelName]) => {
      if (!panelElement) return;
      if (mobileLayout.matches) {
        const hidden = mobilePanel !== panelName;
        panelElement.inert = hidden;
        panelElement.setAttribute('aria-hidden', String(hidden));
      } else {
        panelElement.inert = false;
        panelElement.removeAttribute('aria-hidden');
      }
    });
    if (mobileLayout.matches && moveFocus) focusTarget?.focus({preventScroll:true});
    if (mobilePanel === 'map') requestAnimationFrame(() => map.invalidateSize());
  }
  document.querySelectorAll('[data-mobile-panel]').forEach(button => {
    button.addEventListener('click', () => setMobilePanel(button.dataset.mobilePanel, true));
  });
  $('closeMobileControls')?.addEventListener('click', () => setMobilePanel('map', true));
  const mobileLayersToggle = $('mobileLayersToggle');
  mobileLayersToggle?.addEventListener('click', () => {
    const expanded = document.querySelector('.map-tools')?.classList.toggle('expanded') || false;
    mobileLayersToggle.setAttribute('aria-expanded', String(expanded));
  });
  mobileLayout.addEventListener('change', () => {
    setMobilePanel(mobileLayout.matches ? mobilePanel : 'map');
    resizeMap();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && mobileLayout.matches) {
      document.querySelector('.map-tools')?.classList.remove('expanded');
      mobileLayersToggle?.setAttribute('aria-expanded', 'false');
      setMobilePanel('map', true);
    }
  });
  setMobilePanel('map');

  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:20, attribution:'&copy; OpenStreetMap contributors'});
  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom:20,
    attribution:'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community'
  });
  const pinIcon = key => {
    const symbol = key === 'search' ? '&#9906;' : key.toUpperCase();
    return L.divIcon({className:'',html:`<div class="marker-pin ${key}"><span>${symbol}</span></div>`,iconSize:[28,28],iconAnchor:[14,28]});
  };

  function setBusy(on, title='Analyzing terrain') {
    $('loadingTitle').textContent=title;
    $('loading').hidden=!on;
    if (on && openMobileResultsAfterRun && mobileLayout.matches) setMobilePanel('map');
  }
  let toastTimer;
  function toast(message, error=false) {
    const el=$('toast');
    delete el.dataset.action;
    el.textContent=message;
    el.className=`toast show${error?' error':''}`;
    clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>el.className='toast', error ? 6000 : 3500);
  }
  function showUpdateReady() {
    const el = $('toast');
    el.dataset.action = 'reload';
    el.textContent = 'Update ready — tap to reload';
    el.className = 'toast show';
    clearTimeout(toastTimer);
  }
  if ($('toast')) $('toast').addEventListener('click', () => {
    if ($('toast').dataset.action === 'reload') window.location.reload();
    else $('toast').className = 'toast';
  });
  async function api(url, options={}) { const res=await fetch(url,options); if(!res.ok){let message=`Request failed (${res.status})`;try{message=(await res.json()).error||message}catch{}throw new Error(message)} return res; }
  const num = id => $(id).value.trim()===''?NaN:Number($(id).value);
  const fmt = (n,d=1) => n!==null && n!=='' && Number.isFinite(Number(n)) ? Number(n).toLocaleString(undefined,{maximumFractionDigits:d}) : '—';

  let autoRunTimer = null;
  let autoRunController = null;

  async function autoRunLos(delayMs = 60) {
    clearTimeout(autoRunTimer);
    autoRunTimer = setTimeout(async () => {
      if (state.analysisMode === 'viewshed') return;
      if (!state.points.a || !state.points.b) return;

      const isInside = isPointsCovered();

      if (!isInside) {
        // Endpoints outside current coverage; show dashed line and clear stale profile/metrics
        state.result = null;
        activeProfile = null;
        profileScale = null;
        drawPath();
        if (pathHoverMarker && map.hasLayer(pathHoverMarker)) map.removeLayer(pathHoverMarker);
        if ($('profileHud')) $('profileHud').hidden = true;
        if ($('metrics')) $('metrics').hidden = false;
        if ($('obstructionHero')) $('obstructionHero').hidden = true;
        const pc0 = $('profileChart');
        if (pc0) { const sg0 = pc0.querySelector('.scrubber-group'); if (sg0) sg0.remove(); pc0.innerHTML = ''; }
        $('metrics').innerHTML = '';
        if ($('deploymentSection')) { $('deploymentSection').innerHTML = ''; $('deploymentSection').hidden = true; }
        $('resultTitle').textContent = "Points outside dataset — click 'Run path' to download terrain";
        $('emptyChart').innerHTML = '<span class="empty-icon" aria-hidden="true">◐</span><span>Selected path is outside current terrain coverage. Click \'Run path\' to download it.</span>';
        $('emptyChart').hidden = false;
        return;
      }

      if (autoRunController) {
        try { autoRunController.abort(); } catch {}
      }
      autoRunController = new AbortController();
      try {
        const params = payload();
        // Static-first: try client engine synchronously; signal is only for server fallback
        const result = await fetchLosResult(params, autoRunController.signal);
        // fetchLosResult throws on server error; for client we get result directly
        if (!result || result.error) throw new Error(result?.error || 'LOS failed');
        state.result = result;
        drawPath(result.status);
        renderResult(result);
      } catch (err) {
        openMobileResultsAfterRun = false;
        if (err.name !== 'AbortError') {
          // Keep previous stale-path cleanup semantics for server 4xx
          if (String(err.message).includes('outside') || String(err.message).includes('gap') || String(err.message).includes('Request failed')) {
            state.result = null;
            activeProfile = null;
            drawPath();
          }
          console.warn('Auto LOS evaluation error:', err);
        }
      }
    }, delayMs);
  }

  function clearAnalysis(stale = false) {
    if (state.viewshed) {
      map.removeLayer(state.viewshed);
      // restore building/tree layers that were hidden for clean viewshed (only in path mode)
      if (state.analysisMode !== 'viewshed' && state.viewshedHadClasses && state.layers.classes && !map.hasLayer(state.layers.classes) && $('classToggle')?.checked) map.addLayer(state.layers.classes);
      if (state.analysisMode !== 'viewshed' && state.viewshedHadPath && state.layers.path && !map.hasLayer(state.layers.path)) map.addLayer(state.layers.path);
      state.viewshed = null;
      state.viewshedResult = null;
      state.viewshedHadClasses = false;
      state.viewshedHadPath = false;
      const vsSummary = $('viewshedSummary');
      if (vsSummary) {
        vsSummary.innerHTML = `
          <div class="viewshed-empty">
            <span class="empty-icon" aria-hidden="true">◉</span>
            <span>Place Site A and click "Generate viewshed" to compute 360° visibility.</span>
          </div>
        `;
      }
    }
    state.viewshedResult = null;
    state.result = null;
    activeProfile = null;
    profileScale = null;
    if (pathHoverMarker && map.hasLayer(pathHoverMarker)) map.removeLayer(pathHoverMarker);
    if ($('profileHud')) $('profileHud').hidden = true;
    if ($('metrics')) $('metrics').hidden = false;
    if ($('obstructionHero')) $('obstructionHero').hidden = true;
    if (state.analysisMode !== 'viewshed') {
      drawPath();
    } else {
      if (state.layers.path) { try { map.removeLayer(state.layers.path); } catch {} state.layers.path = null; }
      if (state.markers.b && map.hasLayer(state.markers.b)) map.removeLayer(state.markers.b);
    }
    $('metrics').innerHTML = '';
    const pc = $('profileChart');
    if (pc) {
      const sg = pc.querySelector('.scrubber-group');
      if (sg) sg.remove();
      pc.innerHTML = '';
    }
    $('resultNotes').innerHTML = '';
    if ($('deploymentSection')) { $('deploymentSection').innerHTML = ''; $('deploymentSection').hidden = true; }
    const isVs = state.analysisMode === 'viewshed';
    if (isVs) {
      if (!state.points.a) {
        $('resultTitle').textContent = 'Ready for viewshed';
        $('emptyChart').innerHTML = '<span class="empty-icon" aria-hidden="true">◉</span><span>Place Site A on the map to generate 360° viewshed</span>';
        $('emptyChart').hidden = false;
      } else {
        $('resultTitle').textContent = stale ? 'Sampling viewshed…' : 'Ready for viewshed';
        $('emptyChart').hidden = true;
      }
    } else {
      if (!state.points.a || !state.points.b) {
        $('resultTitle').textContent = 'Ready for analysis';
        $('emptyChart').innerHTML = '<span class="empty-icon" aria-hidden="true">◐</span><span>Place points A &amp; B on the map to analyze line of sight</span>';
        $('emptyChart').hidden = false;
      } else {
        $('resultTitle').textContent = stale ? 'Evaluating path…' : 'Ready for analysis';
        $('emptyChart').hidden = true;
      }
    }
    updateRunButtonState();
  }

  function payload(includeViewshed = (state.analysisMode === 'viewshed')) {
    if (state.analysisMode === 'viewshed' || includeViewshed) {
      if (!state.points.a) throw new Error('Place Site A before running viewshed.');
    } else {
      if(!state.points.a||!state.points.b) throw new Error('Place both A and B before running analysis.');
    }
    const data={
      a:state.points.a,
      b:state.points.b,
      height_a:num('heightA'),
      height_b:num('heightB'),
      mount_type_a:$('mountTypeA')?$('mountTypeA').value:'agl',
      mount_type_b:$('mountTypeB')?$('mountTypeB').value:'agl',
      frequency_mhz:num('frequency'),
      k_factor:num('kFactor'),
      foliage_db_m:num('foliage'),
      include_foliage:$('toggleFoliage')?.checked !== false,
      mode:includeViewshed ? 'optical' : state.mode
    };
    if(state.mode==='radio'){
      Object.assign(data,{
        tx_power_dbm:num('txPower'),
        channel_width_mhz:num('channelWidth'),
        antenna_gain_a_dbi:num('antennaGainA'),
        antenna_gain_b_dbi:num('antennaGainB'),
        cable_loss_a_db:num('cableLossA'),
        cable_loss_b_db:num('cableLossB'),
        rx_sensitivity_dbm:num('rxSensitivity'),
        required_snr_db:num('requiredSnr')
      });
    }
    if (includeViewshed) {
      const vTargetH = num('viewshedTargetHeight');
      const vTargetSurface = $('viewshedTargetSurface') ? $('viewshedTargetSurface').value : 'ground';
      const showObstructions = $('toggleObstructions') ? $('toggleObstructions').checked : true;
      Object.assign(data, {
        radius_m: num('radius') || 1000,
        step_m: num('stepM') || 10,
        target_agl: Number.isFinite(vTargetH) ? vTargetH : 2.0,
        height_b: Number.isFinite(vTargetH) ? vTargetH : 2.0,
        target_surface: vTargetSurface,
        include_blocked: false,
        simple: true,
        auto_rooftop_a: true
      });
    }
    return data;
  }
  let userPlacedEndpoints = false;
  function syncInputs(key, latlng) { state.points[key]=[latlng.lat,latlng.lng]; $(`${key}Lat`).value=latlng.lat.toFixed(7); $(`${key}Lon`).value=latlng.lng.toFixed(7); }
  function syncFetchTargetFromPoints() {
    if (!fetchCenterEdited && state.points.a && state.points.b) {
      const midLat = (state.points.a[0] + state.points.b[0]) / 2;
      const midLon = (state.points.a[1] + state.points.b[1]) / 2;
      $('fetchLat').value = midLat.toFixed(7);
      $('fetchLon').value = midLon.toFixed(7);
      const dist = map.distance(state.points.a, state.points.b);
      const rad = Math.max(150, Math.min(150000, Math.round((dist / 2) * 1.35)));
      $('fetchRadius').value = rad;
    }
  }
  function place(key, latlng, fromUser = false) {
    if (state.analysisMode === 'viewshed') {
      if (key === 'b') return;
      if (state.markers.b && map.hasLayer(state.markers.b)) map.removeLayer(state.markers.b);
      if (state.layers.path) { try { map.removeLayer(state.layers.path); } catch {} state.layers.path = null; }
    }
    if (fromUser) userPlacedEndpoints = true;
    syncInputs(key, latlng);
    if (state.markers[key]) {
      state.markers[key].setLatLng(latlng);
    } else {
      state.markers[key] = L.marker(latlng, {
        icon: pinIcon(key),
        draggable: true,
        zIndexOffset: key === 'a' ? 1000 : 900
      }).addTo(map)
      .on('drag', e => {
        userPlacedEndpoints = true;
        syncInputs(key, e.target.getLatLng());
        if (state.analysisMode === 'viewshed') {
          if (state.markers.b && map.hasLayer(state.markers.b)) map.removeLayer(state.markers.b);
          if (state.layers.path) { try { map.removeLayer(state.layers.path); } catch {} state.layers.path = null; }
          if (state.viewshed) {
            map.removeLayer(state.viewshed);
            state.viewshed = null;
            state.viewshedResult = null;
            const vsSummary = $('viewshedSummary');
            if (vsSummary) {
              vsSummary.innerHTML = `
                <div class="viewshed-empty">
                  <span class="empty-icon" aria-hidden="true">◉</span>
                  <span>Place Site A and click "Calculate 360° Viewshed" to compute coverage.</span>
                </div>
              `;
            }
            $('resultTitle').textContent = 'Ready for viewshed';
            $('metrics').innerHTML = '';
          }
          updateRunButtonState();
          return;
        }
        if (!isPointsCovered()) {
          state.result = null;
          activeProfile = null;
          drawPath();
          $('profileChart').innerHTML = '';
          $('metrics').innerHTML = '';
          if ($('profileHud')) $('profileHud').hidden = true;
          if ($('metrics')) $('metrics').hidden = false;
          if ($('obstructionHero')) $('obstructionHero').hidden = true;
          $('resultTitle').textContent = "Points outside dataset — click 'Run path' to download terrain";
          $('emptyChart').textContent = "Selected path is outside current terrain coverage. Click 'Run path' to download it.";
          $('emptyChart').hidden = false;
        } else {
          drawPath();
        }
        updateRunButtonState();
        autoRunLos(30);
      })
      .on('dragend', e => {
        userPlacedEndpoints = true;
        syncInputs(key, e.target.getLatLng());
        if (state.analysisMode === 'viewshed') {
          if (state.markers.b && map.hasLayer(state.markers.b)) map.removeLayer(state.markers.b);
          if (state.layers.path) { try { map.removeLayer(state.layers.path); } catch {} state.layers.path = null; }
          if (state.viewshed) {
            map.removeLayer(state.viewshed);
            state.viewshed = null;
            state.viewshedResult = null;
            const vsSummary = $('viewshedSummary');
            if (vsSummary) {
              vsSummary.innerHTML = `
                <div class="viewshed-empty">
                  <span class="empty-icon" aria-hidden="true">◉</span>
                  <span>Place Site A and click "Calculate 360° Viewshed" to compute coverage.</span>
                </div>
              `;
            }
            $('resultTitle').textContent = 'Ready for viewshed';
            $('metrics').innerHTML = '';
          }
          updateRunButtonState();
          return;
        }
        syncFetchTargetFromPoints();
        if (!isPointsCovered()) {
          state.result = null;
          activeProfile = null;
          drawPath();
          $('profileChart').innerHTML = '';
          $('metrics').innerHTML = '';
          if ($('profileHud')) $('profileHud').hidden = true;
          if ($('metrics')) $('metrics').hidden = false;
          if ($('obstructionHero')) $('obstructionHero').hidden = true;
          $('resultTitle').textContent = "Points outside dataset — click 'Run path' to download terrain";
          $('emptyChart').textContent = "Selected path is outside current terrain coverage. Click 'Run path' to download it.";
          $('emptyChart').hidden = false;
        } else {
          drawPath();
        }
        updateRunButtonState();
        autoRunLos(0);
      });
    }
    if (fromUser && state.analysisMode !== 'viewshed') syncFetchTargetFromPoints();
    if (state.analysisMode === 'viewshed') {
      if (state.markers.b && map.hasLayer(state.markers.b)) map.removeLayer(state.markers.b);
      if (state.layers.path) { try { map.removeLayer(state.layers.path); } catch {} state.layers.path = null; }
      if (key === 'a' && fromUser && state.viewshed) {
        map.removeLayer(state.viewshed);
        state.viewshed = null;
        state.viewshedResult = null;
        const vsSummary = $('viewshedSummary');
        if (vsSummary) {
          vsSummary.innerHTML = `
            <div class="viewshed-empty">
              <span class="empty-icon" aria-hidden="true">◉</span>
              <span>Place Site A and click "Calculate 360° Viewshed" to compute coverage.</span>
            </div>
          `;
        }
        $('resultTitle').textContent = 'Ready for viewshed';
        $('metrics').innerHTML = '';
      }
    } else {
      drawPath();
    }
    updateRunButtonState();
    if (state.points.a && state.points.b && state.analysisMode !== 'viewshed') {
      autoRunLos(0);
    }
  }
  function drawPath(status) {
    if (state.layers.path) {
      map.removeLayer(state.layers.path);
      state.layers.path = null;
    }
    if (state.analysisMode === 'viewshed') return;
    if (!state.points.a || !state.points.b) return;

    const isInside = isPointsCovered();

    const group = L.layerGroup();

    if (!isInside) {
      const line = L.polyline([state.points.a, state.points.b], {
        color: '#f59e0b',
        weight: 2,
        dashArray: '6 6',
        opacity: 0.85,
        pane: 'pathPane'
      }).addTo(group);
      line.bindTooltip('Points outside coverage — click "Run path" to download terrain corridor', {
        sticky: true,
        direction: 'top'
      });
      state.layers.path = group.addTo(map);
      return;
    }

    const showObstructions = $('toggleObstructions') ? $('toggleObstructions').checked : true;
    const showFoliage = $('toggleFoliage') ? $('toggleFoliage').checked : true;

    const isCurrent = state.result &&
      state.result.segments &&
      state.result.segments.length > 0 &&
      (!state.result.a || (
        Math.abs(state.result.a[0] - state.points.a[0]) < 1e-4 &&
        Math.abs(state.result.a[1] - state.points.a[1]) < 1e-4 &&
        Math.abs(state.result.b[0] - state.points.b[0]) < 1e-4 &&
        Math.abs(state.result.b[1] - state.points.b[1]) < 1e-4
      ));

    if (isCurrent) {
      for (const seg of state.result.segments) {
        let segColor;
        if (seg.status === 'blocked') {
          segColor = showObstructions ? '#ef4444' : '#7c8b84';
        } else if (seg.status === 'foliage') {
          segColor = showFoliage ? '#f59e0b' : '#7c8b84';
        } else if (seg.status === 'fresnel') {
          segColor = '#ac81f5';
        } else {
          segColor = '#53d696';
        }

        const line = L.polyline([seg.start_ll, seg.end_ll], {
          color: segColor,
          weight: 4,
          opacity: 0.95,
          pane: 'pathPane'
        }).addTo(group);

        const obsInfo = seg.obstacle_type !== 'none' ? ` (${seg.obstacle_type})` : '';
        line.bindTooltip(`<strong>${seg.status.toUpperCase()}</strong>: ${fmt(seg.start_m, 0)}–${fmt(seg.end_m, 0)} m${obsInfo}`, {
          sticky: true,
          direction: 'top'
        });
      }
    } else {
      L.polyline([state.points.a, state.points.b], {
        color: '#7c8b84',
        weight: 2.5,
        dashArray: '5 5',
        pane: 'pathPane'
      }).addTo(group);
    }

    state.layers.path = group.addTo(map);
  }
  let placing='a';
  ['a','b'].forEach(key=>$('place'+key.toUpperCase()).addEventListener('click',()=>{placing=key;['a','b'].forEach(k=>{ const b=$('place'+k.toUpperCase()); const on=key===k; b.classList.toggle('active',on); b.setAttribute('aria-pressed', String(on)); });toast('Click map to place '+key.toUpperCase())}));
  map.on('click', e => {
    if (searchMarker && typeof searchMarker.isPopupOpen === 'function' && searchMarker.isPopupOpen()) {
      dismissSearchPopup();
      return;
    }
    const targetKey = state.analysisMode === 'viewshed' ? 'a' : placing;
    place(targetKey, e.latlng, true);
  });
  ['a','b'].forEach(key=>['Lat','Lon'].forEach(part=>$(key+part).addEventListener('change',()=>{const lat=num(key+'Lat'),lng=num(key+'Lon');if(Number.isFinite(lat)&&Number.isFinite(lng))place(key,L.latLng(lat,lng),true);})));

  let activeBase = null;
  function setBase(name) {
    if(activeBase) map.removeLayer(activeBase);
    if (state.analysisMode === 'viewshed' && name === 'terrain') {
      name = 'satellite';
    }
    activeBase=name==='osm'?osm:name==='satellite'?satellite:state.layers.terrain;
    if(activeBase) activeBase.addTo(map);
    document.querySelectorAll('[data-base]').forEach(b=>{ const on=b.dataset.base===name; b.classList.toggle('active',on); b.setAttribute('aria-pressed', String(on)); });
    if(state.layers.classes && map.hasLayer(state.layers.classes)) state.layers.classes.bringToFront();
  }
  document.querySelectorAll('[data-base]').forEach(b=>b.addEventListener('click',()=>setBase(b.dataset.base)));
  $('classToggle').addEventListener('change', e => {
    if (!state.layers.classes) return;
    if (e.target.checked) {
      if (state.analysisMode !== 'viewshed') state.layers.classes.addTo(map);
    } else {
      map.removeLayer(state.layers.classes);
    }
  });

  // Native locator control — Leaflet-style button + blue-dot user location
  let userLocationLayer = null;
  let userAccuracyLayer = null;
  const LocateControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control leaflet-bar leaflet-control-locate');
      const btn = L.DomUtil.create('a', 'locate-button', container);
      btn.href = '#';
      btn.title = 'Center on my location';
      btn.setAttribute('aria-label', 'Center on my location');
      btn.innerHTML = '<span class="locate-icon" aria-hidden="true"></span>';
      L.DomEvent.on(btn, 'click', L.DomEvent.stop)
        .on(btn, 'click', () => locateMe(btn));
      return container;
    }
  });
  map.addControl(new LocateControl());
  // place locate below zoom (zoom is tleft at 0, locate will be second)
  function locateMe(btn) {
    if (!navigator.geolocation) { toast('Geolocation not supported by this browser.', true); return; }
    const orig = btn.innerHTML;
    btn.classList.add('locating');
    btn.innerHTML = '<span class="locate-spinner" aria-hidden="true"></span>';
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = pos.coords.latitude, lon = pos.coords.longitude;
      const acc = pos.coords.accuracy;
      map.flyTo([lat, lon], Math.max(map.getZoom(), 15), { duration: 0.9 });
      // native blue dot
      if (userLocationLayer) { map.removeLayer(userLocationLayer); userLocationLayer = null; }
      if (userAccuracyLayer) { map.removeLayer(userAccuracyLayer); userAccuracyLayer = null; }
      userAccuracyLayer = L.circle([lat, lon], {
        radius: Math.min(acc, 600),
        color: '#4285f4',
        fillColor: '#4285f4',
        fillOpacity: 0.14,
        weight: 1,
        opacity: 0.35
      }).addTo(map);
      userLocationLayer = L.circleMarker([lat, lon], {
        radius: 7,
        fillColor: '#4285f4',
        color: '#ffffff',
        weight: 2.2,
        fillOpacity: 1,
        opacity: 1
      }).addTo(map);
      // pulse fade
      setTimeout(() => {
        if (userAccuracyLayer) {
          let op = 0.14;
          const fade = setInterval(() => {
            op -= 0.02;
            if (op <= 0 || !userAccuracyLayer) { clearInterval(fade); return; }
            userAccuracyLayer.setStyle({ fillOpacity: op, opacity: op * 2.5 });
          }, 700);
        }
      }, 4000);
      toast(`Centered on your location`);
      btn.classList.remove('locating');
      btn.innerHTML = orig;
    }, err => {
      toast('Could not get location: ' + (err.message || 'permission denied'), true);
      btn.classList.remove('locating');
      btn.innerHTML = orig;
    }, { enableHighAccuracy: true, timeout: 9000, maximumAge: 30000 });
  }

  let fetchCenterEdited=false;
  ['fetchLat','fetchLon'].forEach(id=>$(id).addEventListener('input',()=>{fetchCenterEdited=true}));
  $('useMapCenter').addEventListener('click',()=>{const c=map.getCenter();fetchCenterEdited=true;$('fetchLat').value=c.lat.toFixed(7);$('fetchLon').value=c.lng.toFixed(7);toast('Area centered on map view.');});
  if ($('coverPointsAB')) {
    $('coverPointsAB').addEventListener('click', () => {
      if (state.points.a && state.points.b) {
        const midLat = (state.points.a[0] + state.points.b[0]) / 2;
        const midLon = (state.points.a[1] + state.points.b[1]) / 2;
        const dist = map.distance(state.points.a, state.points.b);
        const rad = Math.max(150, Math.min(150000, Math.round((dist / 2) * 1.35)));
        $('fetchLat').value = midLat.toFixed(7);
        $('fetchLon').value = midLon.toFixed(7);
        $('fetchRadius').value = rad;
        fetchCenterEdited = true;
        map.fitBounds([state.points.a, state.points.b], { padding: [50, 50] });
        toast(`Area configured to cover Sites A & B (${fmt(dist, 0)} m span).`);
      } else if (state.points.a || state.points.b) {
        const pt = state.points.a || state.points.b;
        $('fetchLat').value = pt[0].toFixed(7);
        $('fetchLon').value = pt[1].toFixed(7);
        fetchCenterEdited = true;
        map.panTo(pt);
        toast('Area centered on placed site.');
      } else {
        const c = map.getCenter();
        $('fetchLat').value = c.lat.toFixed(7);
        $('fetchLon').value = c.lng.toFixed(7);
        fetchCenterEdited = true;
        toast('Area set to map center.');
      }
    });
  }

  let isFetching = false;
  let isFetchingViewshed = false;
  let browserOverlayUrls = [];

  function installBrowserScene(acquired) {
    const meta = acquired.meta;
    const scene = Engine.Scene.fromObjects(acquired.scene);
    for (const url of browserOverlayUrls) if (String(url).startsWith('blob:')) URL.revokeObjectURL(url);
    browserOverlayUrls = [acquired.terrainUrl, acquired.classesUrl].filter(Boolean);
    browserSceneData = acquired.scene;
    overlayRenderPromise = null;
    staticManifest = acquired.scene;
    clientScene = { meta, scene, source: 'browser-global' };
    state.meta = meta;
    state.result = null;
    if (state.viewshed) { try { map.removeLayer(state.viewshed); } catch {} state.viewshed = null; state.viewshedResult = null; }
    const bounds = L.latLngBounds(meta.bounds);
    ['terrain', 'classes'].forEach(key => {
      if (state.layers[key] && map.hasLayer(state.layers[key])) map.removeLayer(state.layers[key]);
    });
    state.layers.terrain = acquired.terrainUrl ? L.imageOverlay(acquired.terrainUrl, bounds, { opacity: 1 }) : null;
    state.layers.classes = acquired.classesUrl ? L.imageOverlay(acquired.classesUrl, bounds, { opacity: .62, interactive: false }) : null;
    setBase('satellite');
    if (state.analysisMode !== 'viewshed' && $('classToggle').checked && state.layers.classes) state.layers.classes.addTo(map);
    $('datasetName').textContent = meta.name;
    $('datasetMeta').textContent = `${fmt(meta.resolution_m, 1)} m · ${meta.source}`;
    $('datasetDot').classList.add('ready');
    $('fetchResolution').value = meta.resolution_m;
    $('stepM').min = meta.resolution_m;
    $('stepM').value = Math.max(Number($('stepM').value) || 20, meta.resolution_m);
    if ($('viewshedScopeNote')) $('viewshedScopeNote').textContent = 'Downloads coverage around Site A';
    map.fitBounds(bounds, { padding: [20, 20] });
    _updateBadge();
    updateRunButtonState();
  }

  async function ensureBrowserOverlays() {
    if (!staticMode || !browserSceneData || (state.layers.terrain && state.layers.classes)) return;
    const scene = browserSceneData;
    if (overlayRenderPromise?.scene === scene) return overlayRenderPromise.promise;
    const promise = (async () => {
      const globalData = GlobalData || await loadGlobalData();
      const images = await globalData.renderSceneImages(scene);
      if (scene !== browserSceneData) {
        for (const url of [images.terrainUrl, images.classesUrl]) if (String(url).startsWith('blob:')) URL.revokeObjectURL(url);
        return;
      }
      browserOverlayUrls.push(images.terrainUrl, images.classesUrl);
      const bounds = L.latLngBounds(scene.meta.bounds);
      state.layers.terrain = L.imageOverlay(images.terrainUrl, bounds, { opacity: 1 });
      state.layers.classes = L.imageOverlay(images.classesUrl, bounds, { opacity: .62, interactive: false });
      if (state.analysisMode !== 'viewshed' && $('classToggle')?.checked) state.layers.classes.addTo(map);
    })();
    overlayRenderPromise = { scene, promise };
    try {
      await promise;
    } catch (error) {
      console.warn('[Sightline] deferred terrain overlays unavailable', error);
    } finally {
      if (overlayRenderPromise?.promise === promise) overlayRenderPromise = null;
    }
  }

  async function ensureCoverageAndRun(force = false, resumeViewshed = true) {
    const isViewshed = state.analysisMode === 'viewshed';
    if (isViewshed) {
      if (!state.points.a) {
        toast('Place Site A first.', true);
        return;
      }
    } else {
      if (!state.points.a || !state.points.b) {
        toast('Place both Site A and Site B first.', true);
        return;
      }
    }

    const needFetch = force || !isPointsCovered();

    if (needFetch) {
      if (isFetching) {
        toast('A terrain download is already in progress.', true);
        return;
      }
      isFetching = true;
      let scope = document.querySelector('input[name="fetchScope"]:checked')?.value || 'corridor';
      if (isViewshed && scope === 'corridor') {
        scope = 'area';
        if ($('scopeArea')) $('scopeArea').checked = true;
        if ($('scopeCorridor')) $('scopeCorridor').checked = false;
        document.querySelectorAll('input[name="fetchScope"]').forEach(i => i.dispatchEvent(new Event('change')));
      }
      const status = $('fetchStatus');
      if (status) status.className = 'fetch-status';
      setBusy(true, scope === 'corridor' ? 'Auto-fetching terrain corridor' : 'Auto-fetching terrain area');

      try {
        let request;
        const dist = (!isViewshed && state.points.a && state.points.b) ? map.distance(state.points.a, state.points.b) : (num('radius') || 500) * 2;
        let autoRes = dist > 10000 ? Math.max(3, Math.min(25, Math.ceil(dist / 3000))) : (num('fetchResolution') || 3);
        if ($('fetchResolution') && dist > 10000) $('fetchResolution').value = autoRes;

        if (scope === 'corridor' && state.points.a && state.points.b) {
          // Fresnel-aware corridor width: low frequencies + long paths need wider corridors for buildings/trees
          const freq = num('frequency') || 5800;
          const wave = 299.792458 / freq;
          const fresR = Math.sqrt(Math.max(0, wave * dist / 4)); // midpoint 1st Fresnel radius
          const adaptiveBuffer = Math.max(60, Math.ceil(fresR * 1.5 + 25));
          request = {
            mode: 'corridor',
            a: state.points.a,
            b: state.points.b,
            corridor_buffer_m: adaptiveBuffer,
            resolution_m: autoRes
          };
          if (status) status.textContent = `Downloading corridor terrain for Sites A & B (${autoRes}m resolution)…`;
        } else {
          let lat, lon, rad;
          if (isViewshed && state.points.a) {
            lat = state.points.a[0];
            lon = state.points.a[1];
            rad = Math.max(Math.ceil((num('radius') || 1000) * 1.15), 1000);
            if ($('fetchLat')) $('fetchLat').value = lat.toFixed(7);
            if ($('fetchLon')) $('fetchLon').value = lon.toFixed(7);
            if ($('fetchRadius')) $('fetchRadius').value = rad;
            if (rad > 10000) autoRes = 10;
            else if (rad > 4000) autoRes = 5;
            else autoRes = 3;
            if ($('fetchResolution')) $('fetchResolution').value = autoRes;
          } else {
            lat = num('fetchLat');
            lon = num('fetchLon');
            rad = num('fetchRadius');
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
              if (state.points.a && state.points.b && !isViewshed) {
                lat = (state.points.a[0] + state.points.b[0]) / 2;
                lon = (state.points.a[1] + state.points.b[1]) / 2;
              } else if (state.points.a) {
                lat = state.points.a[0];
                lon = state.points.a[1];
              }
              if ($('fetchLat') && Number.isFinite(lat)) $('fetchLat').value = lat.toFixed(7);
              if ($('fetchLon') && Number.isFinite(lon)) $('fetchLon').value = lon.toFixed(7);
            }
            if (!Number.isFinite(rad) || rad <= 0) {
              rad = isViewshed ? Math.max(300, num('radius') || 500) : Math.max(200, Math.min(150000, Math.round((dist / 2) * 1.35)));
              if ($('fetchRadius')) $('fetchRadius').value = rad;
            }
          }
          request = {
            center: [lat, lon],
            radius_m: rad,
            resolution_m: autoRes
          };
          if (status) status.textContent = `Downloading ${fmt(rad, 0)} m radius area (${autoRes}m resolution)…`;
        }

        if (staticMode) {
          if (!Engine) throw new Error('The browser analysis engine is still loading. Try again in a moment.');
          const globalData = GlobalData || await loadGlobalData();
          const acquired = await globalData.acquireScene(request, {
            includeFoliage: $('toggleFoliage')?.checked !== false,
            renderOverlays: state.analysisMode !== 'viewshed',
            onProgress(message) {
              if (status) status.textContent = message;
              $('loadingTitle').textContent = message;
            },
          });
          installBrowserScene(acquired);
          if (status) status.textContent = 'Global terrain ready.';
          toast('Global terrain, buildings, and canopy loaded in this browser.');
        } else {
          const res = await api('/api/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request)
          });
          const { job_id } = await res.json();
          if (!job_id) throw new Error('Server did not return a fetch job.');

          while (true) {
            await new Promise(r => setTimeout(r, 1000));
            const job = await (await api(`/api/jobs/${encodeURIComponent(job_id)}`)).json();
            if (status) status.textContent = job.message || `Fetch ${job.status}…`;
            $('loadingTitle').textContent = job.message || `Fetch ${job.status}…`;
            if (job.status === 'complete') {
              if (status) status.textContent = 'Terrain ready. Loading dataset…';
              await loadMeta();
              if (status) status.textContent = 'Terrain ready.';
              toast('Terrain data loaded.');
              break;
            }
            if (job.status === 'error') throw new Error(job.error || 'Terrain fetch failed.');
          }
        }
      } catch (err) {
        if (status) {
          status.textContent = err.message;
          status.classList.add('error');
        }
        toast(err.message, true);
        return false;
      } finally {
        isFetching = false;
        setBusy(false);
      }
    }

    if (isViewshed) {
      if (resumeViewshed) $('runViewshed').click();
      return true;
    }

    // Now run LOS path analysis — static-first: try client engine, fallback to server
    try {
      setBusy(true, 'Tracing path');
      const params = payload();
      const result = await fetchLosResult(params);
      state.result = result;
      drawPath(result.status);
      renderResult(result);
      const src = result._engine === 'client' ? ' (client-side engine)' : ' (server)';
      toast(`Path is ${result.status}${src}.`);
    } catch (e) {
      const msg = String(e.message || '');
      if (!staticMode && !force && (msg.includes('outside') || msg.includes('gap') || msg.includes('coverage') || msg.includes('footprint') || msg.includes('Request failed') || msg.includes('400'))) {
        console.log('[Sightline] LOS hit gap/outside — auto-fetching terrain corridor…');
        return await ensureCoverageAndRun(true);
      }
      openMobileResultsAfterRun = false;
      toast(e.message, true);
      return false;
    } finally {
      setBusy(false);
    }
    return true;
  }

  $('fetchArea').addEventListener('click', async () => {
    await ensureCoverageAndRun(true);
  });

  document.querySelectorAll('input[name="fetchScope"]').forEach(input => {
    input.addEventListener('change', () => {
      const isCorridor = input.value === 'corridor';
      if ($('areaFields')) $('areaFields').style.display = isCorridor ? 'none' : 'grid';
      if ($('areaHelpers')) $('areaHelpers').style.display = isCorridor ? 'none' : 'flex';
      if ($('drawerScopeLabel')) $('drawerScopeLabel').textContent = isCorridor ? 'Corridor mode' : 'Full 360° area';
    });
  });

  async function loadMeta() {
    try {
      let meta;
      try {
        if (staticMode) throw new Error('static release');
        const res = await api('/api/meta');
        meta = await res.json();
      } catch (_) {
        const res = await fetch('./static/scene.json');
        if (!res.ok) throw new Error('No terrain dataset is available.');
        staticManifest = await res.json();
        meta = (staticManifest.scene || staticManifest).meta;
        staticMode = true;
      }
      state.meta = meta;
      if (!meta || !meta.bounds) {
        $('datasetName').textContent = 'No dataset loaded';
        return;
      }

      const currentVsR = num('radius');
      if (state.analysisMode === 'viewshed' && currentVsR && currentVsR > 0) {
        applyViewshedRadius(currentVsR);
        if ($('fetchRadius') && meta.requested_radius_m) $('fetchRadius').value = meta.requested_radius_m;
      } else if (meta.requested_radius_m) {
        $('fetchRadius').value = meta.requested_radius_m;
      }
      $('fetchResolution').value=meta.resolution_m;
      $('stepM').value=Math.max(Number($('stepM').value)||20,meta.resolution_m);
      $('stepM').min=meta.resolution_m;
      $('datasetName').textContent=meta.name||'Local dataset'; $('datasetMeta').textContent=[meta.resolution_m&&`${meta.resolution_m} m`,meta.source].filter(Boolean).join(' · '); $('datasetDot').classList.add('ready');
      const bounds=L.latLngBounds(meta.bounds); map.fitBounds(bounds,{padding:[20,20]});
      const fetchCenter=meta.requested_center||meta.center;
      if(!fetchCenterEdited&&Array.isArray(fetchCenter)){$('fetchLat').value=fetchCenter[0];$('fetchLon').value=fetchCenter[1]}
      ['terrain','classes'].forEach(k=>{if(state.layers[k]&&map.hasLayer(state.layers[k]))map.removeLayer(state.layers[k])});
      const terrainUrl = staticMode ? './static/scene-terrain.png' : `/api/image?t=${Date.now()}`;
      const classesUrl = staticMode ? './static/scene-classes.png' : `/api/classes?t=${Date.now()}`;
      state.layers.terrain=L.imageOverlay(terrainUrl,bounds,{opacity:1});
      state.layers.classes=L.imageOverlay(classesUrl,bounds,{opacity:.62,interactive:false});

      if (state.analysisMode === 'viewshed') {
        setBase('satellite');
        if (state.markers.b && map.hasLayer(state.markers.b)) map.removeLayer(state.markers.b);
        if (state.layers.path) { try { map.removeLayer(state.layers.path); } catch {} state.layers.path = null; }
        if (pathHoverMarker && map.hasLayer(pathHoverMarker)) map.removeLayer(pathHoverMarker);
        if (state.layers.classes && map.hasLayer(state.layers.classes)) map.removeLayer(state.layers.classes);
        if (state.layers.terrain && map.hasLayer(state.layers.terrain)) map.removeLayer(state.layers.terrain);
      } else {
        setBase('satellite');
        if($('classToggle').checked) state.layers.classes.addTo(map);
      }

      // Preserve user-placed endpoints if they lie within the newly loaded dataset bounds / corridor
      const isCorridor = !!meta.is_corridor;
      const buf = meta.corridor_buffer_m || 60;
      const keepA = state.points.a && (userPlacedEndpoints || state.analysisMode === 'viewshed') && (isCorridor && meta.default_a && meta.default_b ? (distToSegmentMeters(state.points.a, meta.default_a, meta.default_b) <= buf * 0.8) : bounds.contains(state.points.a));
      const keepB = state.analysisMode !== 'viewshed' && userPlacedEndpoints && state.points.b && (isCorridor && meta.default_a && meta.default_b ? (distToSegmentMeters(state.points.b, meta.default_a, meta.default_b) <= buf * 0.8) : bounds.contains(state.points.b));
      if (!keepA && meta.default_a) place('a', L.latLng(...meta.default_a));
      if (state.analysisMode !== 'viewshed' && !keepB && meta.default_b) place('b', L.latLng(...meta.default_b));
      updateRunButtonState();
      if (state.analysisMode !== 'viewshed' && state.points.a && state.points.b) {
        autoRunLos(0);
      }

      // Static-first: after loadMeta() also populate clientScene for next client-side LOS
      if (USE_CLIENT_ENGINE && staticMode) { if (Engine) await populateClientScene(); else { clientScene = { meta, scene:null, source:'meta-only (engine pending)' }; _updateBadge(); } }
      else _updateBadge();

      if (staticMode) {
        const drawer = $('areaDataDrawer');
        if (drawer) drawer.hidden = false;
        const advancedImport = document.querySelector('.advanced-import');
        if (advancedImport) advancedImport.hidden = true;
        const hint = $('autoFetchHint');
        if (hint) hint.textContent = 'Static global mode: Run downloads terrain and available building/canopy data directly to this browser.';
        if ($('searchInput')) $('searchInput').placeholder = 'Go to any coordinates or place…';
        $('datasetMeta').textContent += ' · global browser downloads ready';
        if ($('viewshedScopeNote')) $('viewshedScopeNote').textContent = 'Downloads coverage around Site A';
        if ($('resetDemo')) $('resetDemo').textContent = 'Restore bundled starter area';
      } else if (meta.capabilities?.data_mutations === false) {
        const drawer = $('areaDataDrawer');
        if (drawer) drawer.hidden = true;
      }
      if (staticMode && meta.requested_radius_m) {
        applyViewshedRadius(Math.min(num('radius') || meta.requested_radius_m, meta.requested_radius_m));
      }

      if(meta.notes?.length) toast(meta.notes[0]);
    } catch(e) { $('datasetName').textContent='No dataset loaded'; toast(e.message,true); setBase('satellite'); updateRunButtonState(); }
  }

  const DEFAULT_PRESETS = {
    wifi5_dish: { name:'5.8 GHz High-Gain Dish (PTP Backhaul)', frequency_mhz:5800, tx_power_dbm:24, antenna_gain_a_dbi:23, antenna_gain_b_dbi:23, cable_loss_a_db:1, cable_loss_b_db:1, channel_width_mhz:40, rx_sensitivity_dbm:-79, k_factor:1.333, foliage_db_m:0.35 },
    wifi5_panel: { name:'5.2 GHz Medium-Range Panel', frequency_mhz:5200, tx_power_dbm:20, antenna_gain_a_dbi:16, antenna_gain_b_dbi:16, cable_loss_a_db:1, cable_loss_b_db:1, channel_width_mhz:20, rx_sensitivity_dbm:-82, k_factor:1.333, foliage_db_m:0.30 },
    wifi24_ptp: { name:'2.4 GHz Long-Range / Tree Foliage', frequency_mhz:2437, tx_power_dbm:20, antenna_gain_a_dbi:14, antenna_gain_b_dbi:14, cable_loss_a_db:1.5, cable_loss_b_db:1.5, channel_width_mhz:20, rx_sensitivity_dbm:-85, k_factor:1.333, foliage_db_m:0.15 },
    wifi6_ptp: { name:'6 GHz Wi-Fi 6E/7 High-Capacity PTP', frequency_mhz:6100, tx_power_dbm:22, antenna_gain_a_dbi:25, antenna_gain_b_dbi:25, cable_loss_a_db:1, cable_loss_b_db:1, channel_width_mhz:80, rx_sensitivity_dbm:-74, k_factor:1.333, foliage_db_m:0.40 },
    lora_915: { name:'915 MHz ISM / LoRa / Mesh', frequency_mhz:915, tx_power_dbm:27, antenna_gain_a_dbi:6, antenna_gain_b_dbi:6, cable_loss_a_db:1, cable_loss_b_db:1, channel_width_mhz:0.25, rx_sensitivity_dbm:-110, k_factor:1.333, foliage_db_m:0.10 }
  };
  let presets = DEFAULT_PRESETS;

  async function loadPresets() {
    if (staticMode) return;
    try {
      const res = await (await api('/api/presets')).json();
      if(res && typeof res === 'object') presets = res;
    } catch {}
  }

  function applyPreset(id) {
    const p = presets[id];
    if(!p) return;
    $('frequency').value = p.frequency_mhz;
    $('txPower').value = p.tx_power_dbm;
    $('channelWidth').value = p.channel_width_mhz;
    $('antennaGainA').value = p.antenna_gain_a_dbi;
    $('antennaGainB').value = p.antenna_gain_b_dbi;
    $('cableLossA').value = p.cable_loss_a_db;
    $('cableLossB').value = p.cable_loss_b_db;
    $('rxSensitivity').value = p.rx_sensitivity_dbm;
    $('kFactor').value = p.k_factor;
    $('foliage').value = p.foliage_db_m;
    autoRunLos(0);
  }

  if($('radioPreset')) $('radioPreset').addEventListener('change', e => {
    if(e.target.value !== 'custom') applyPreset(e.target.value);
  });
  ['frequency','kFactor','foliage','txPower','channelWidth','antennaGainA','antennaGainB','cableLossA','cableLossB','rxSensitivity','requiredSnr'].forEach(id => {
    if($(id)) $(id).addEventListener('input', () => {
      if($('radioPreset')) $('radioPreset').value = 'custom';
      autoRunLos(150);
    });
  });
  ['mountTypeA','mountTypeB'].forEach(id => {
    if($(id)) $(id).addEventListener('change', () => {
      if (state.analysisMode === 'viewshed') {
        if (id === 'mountTypeA') {
          if (state.viewshed) { map.removeLayer(state.viewshed); state.viewshed = null; state.viewshedResult = null; }
          updateRunButtonState();
        }
        return;
      }
      autoRunLos(0);
    });
  });

  document.querySelectorAll('[data-mode]').forEach(btn=>btn.addEventListener('click',()=>{
    if(state.mode!==btn.dataset.mode){
      state.mode=btn.dataset.mode;
      document.querySelectorAll('[data-mode]').forEach(b=>{ const on=b===btn; b.classList.toggle('active',on); b.setAttribute('aria-pressed', String(on)); });
      updateRadioFieldsState();
      if(state.points.a&&state.points.b) autoRunLos(0);
    }
  }));
  ['heightA','heightB'].forEach(id=>$(id).addEventListener('input',()=>{
    if(state.points.a&&state.points.b) autoRunLos(80);
  }));
  ['heightA','heightB'].forEach(id=>$(id).addEventListener('change',()=>{
    if (state.analysisMode === 'viewshed') {
      if (id === 'heightA') {
        if (state.viewshed) { map.removeLayer(state.viewshed); state.viewshed = null; state.viewshedResult = null; }
        updateRunButtonState();
      }
      return;
    }
    if(state.points.a&&state.points.b) autoRunLos(0);
  }));
  ['radius','stepM'].forEach(id=>$(id).addEventListener('change',()=>{
    if(state.viewshed){
      map.removeLayer(state.viewshed);
      state.viewshed=null;
      state.viewshedResult=null;
      const vsSummary = $('viewshedSummary');
      if (vsSummary) {
        vsSummary.innerHTML = `
          <div class="viewshed-empty">
            <span class="empty-icon" aria-hidden="true">◉</span>
            <span>Place Site A and click "Generate viewshed" to compute 360° visibility.</span>
          </div>
        `;
      }
      $('resultTitle').textContent = 'Ready for viewshed';
      $('metrics').innerHTML = '';
    }
  }));
  const runPrimary = $('runPrimary');
  if (runPrimary) runPrimary.addEventListener('click', () => {
    openMobileResultsAfterRun = true;
    if (mobileLayout.matches) setMobilePanel('map');
    if (state.analysisMode === 'viewshed') {
      $('runViewshed').click();
    } else {
      ensureCoverageAndRun();
    }
  });
  // keep legacy hidden button for backwards compat
  const legacyRunLos = $('runLos');
  if (legacyRunLos) legacyRunLos.addEventListener('click', () => ensureCoverageAndRun());
  ['toggleObstructions', 'toggleFoliage'].forEach(id => {
    const el = $(id);
    if (el) {
      el.addEventListener('change', () => {
        if (id === 'toggleFoliage' && staticMode && el.checked && state.meta?.canopy_loaded === false) {
          ensureCoverageAndRun(true);
          return;
        }
        if (state.analysisMode === 'viewshed') {
          if (state.viewshedResult) {
            $('runViewshed').click();
          }
          return;
        }
        if (id === 'toggleFoliage' && state.points.a && state.points.b) {
          autoRunLos(0);
        } else if (state.result) {
          drawPath(state.result.status);
          drawProfile(state.result.profile || [], state.mode === 'radio', state.result.critical_obstacle);
        }
      });
    }
  });
  let isRetryingViewshed = false;
  let isAutoFetchingViewshed = false;
  $('runViewshed').addEventListener('click', async () => {
    if (state.analysisMode !== 'viewshed') {
      state.analysisMode = 'viewshed';
      updateAnalysisModeUI();
    }
    // Concurrency guard like ensureCoverageAndRun
    if (isFetchingViewshed) return;
    if (!state.points.a) { toast('Place Site A first on the map to calculate viewshed.', true); return; }
    // Static mode downloads full radial coverage; server corridor scenes may
    // still show explicit outside-data samples without replacing their scene.
    if (staticMode ? !isViewshedAreaCovered() : !isPointsCovered()) {
      if (isAutoFetchingViewshed) {
        isAutoFetchingViewshed = false;
        toast('The fetched terrain does not fully cover the viewshed radius. Try reducing the radius.', true);
        return;
      }
      isAutoFetchingViewshed = true;
      const scopeArea = $('scopeArea');
      const scopeCorridor = $('scopeCorridor');
      if (scopeArea && scopeCorridor) {
        scopeArea.checked = true;
        scopeCorridor.checked = false;
        document.querySelectorAll('input[name="fetchScope"]').forEach(i => i.dispatchEvent(new Event('change')));
      }
      const neededRad = Math.max(Math.ceil((num('radius') || 1000) * 1.15), 1000);
      if ($('fetchLat')) $('fetchLat').value = state.points.a[0].toFixed(7);
      if ($('fetchLon')) $('fetchLon').value = state.points.a[1].toFixed(7);
      if ($('fetchRadius')) $('fetchRadius').value = neededRad;
      const rLabel = neededRad >= 1000 ? `${(neededRad / 1000).toFixed(neededRad % 1000 ? 1 : 0)} km` : `${neededRad} m`;
      toast(`Streaming 360° terrain around Site A (${rLabel} radius)…`);
      isFetchingViewshed = true;
      updateRunButtonState();
      let coverageReady = false;
      try {
        coverageReady = await ensureCoverageAndRun(true, false);
      } finally {
        isAutoFetchingViewshed = false;
        isFetchingViewshed = false;
        updateRunButtonState();
      }
      if (!coverageReady) return;
      if (!isViewshedAreaCovered()) {
        toast('The downloaded terrain does not fully cover this viewshed. Reduce the radius or increase the sample step.', true);
        return;
      }
    }
    isAutoFetchingViewshed = false;
    // Corridor warning — viewshed is 360°, corridor may be clipped (ensureCoverageAndRun not needed)
    const _vsScope = document.querySelector('input[name="fetchScope"]:checked')?.value || 'corridor';
    if (_vsScope === 'corridor' || state.meta?.is_corridor) {
      toast('Viewshed samples 360° around Site A — corridor data may clip the result. For full 360° coverage switch to “Full 360° area”.', false);
    }
    // Validate radius/step before calling — actionable, don't silently fallback
    const _vr = num('radius'); let _vs = num('stepM');
    if (!Number.isFinite(_vr) || !Number.isFinite(_vs)) {
      toast('Viewshed radius and sample step must be numbers. Check Radius and Sample step fields.', true);
      return;
    }
    if (_vr <= 0 || _vs <= 0) {
      toast('Viewshed radius and sample step must be greater than 0.', true);
      return;
    }
    let _vn = Math.ceil(2 * _vr / _vs);
    if (!Number.isFinite(_vn) || _vn <= 0) {
      toast('Invalid viewshed grid. Check radius and step values.', true);
      return;
    }
    if (_vn * _vn > MAX_VIEWSHED_SIDE ** 2) {
      _vs = Math.ceil(2 * _vr / MAX_VIEWSHED_SIDE);
      if ($('stepM')) $('stepM').value = _vs;
      _vn = Math.ceil(2 * _vr / _vs);
      updateViewshedGridInfo();
    }
    // Clear stale LOS hero/profile before new viewshed
    const _hero = $('obstructionHero');
    if (_hero) _hero.hidden = true;
    const _pc = $('profileChart');
    if (_pc) { const _sg = _pc.querySelector('.scrubber-group'); if (_sg) _sg.remove(); _pc.innerHTML = ''; }
    if ($('profileHud')) $('profileHud').hidden = true;
    if (pathHoverMarker && map.hasLayer(pathHoverMarker)) map.removeLayer(pathHoverMarker);
    // Concurrency guard + disable button while busy
    isFetchingViewshed = true;
    const _btn = $('runViewshed');
    if (_btn) _btn.disabled = true;
    updateRunButtonState();
    try {
      while (true) {
        try {
      setBusy(true, 'Sampling viewshed');
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      if (state.layers.classes && map.hasLayer(state.layers.classes)) map.removeLayer(state.layers.classes);
      if (state.layers.terrain && map.hasLayer(state.layers.terrain)) map.removeLayer(state.layers.terrain);
      if (state.markers.b && map.hasLayer(state.markers.b)) map.removeLayer(state.markers.b);
      if (state.layers.path) { try { map.removeLayer(state.layers.path); } catch {} state.layers.path = null; }
      if (activeBase === state.layers.terrain) setBase('satellite');
      const result = await fetchViewshedResult(payload(true));
      isRetryingViewshed = false;
      // Validate overlay payload before adding to map
      if (!result || !result.image || !result.bounds || !Array.isArray(result.bounds) || result.bounds.length !== 2) {
        throw new Error('Viewshed returned invalid image or bounds.');
      }
      const _bnds = result.bounds;
      const _validBounds = Array.isArray(_bnds) && _bnds.length===2 && _bnds.every(p=>Array.isArray(p)&&p.length===2&&Number.isFinite(p[0])&&Number.isFinite(p[1]));
      if (!_validBounds) throw new Error('Viewshed bounds are invalid.');
      if (typeof result.image !== 'string' || !result.image.length) throw new Error('Viewshed image is empty.');
      // Validate image is data URL or http URL
      if (!result.image.startsWith('data:image') && !result.image.startsWith('http') && !result.image.startsWith('blob:')) {
        // still allow but ensure non-empty
      }
      if (state.viewshed) { map.removeLayer(state.viewshed); state.viewshed = null; }
      // hide building/tree clutter and terrain overlays during viewshed — just show hit map
      const hadClasses = state.layers.classes && map.hasLayer(state.layers.classes);
      if (hadClasses) map.removeLayer(state.layers.classes);
      const hadPath = state.layers.path && map.hasLayer(state.layers.path);
      if (hadPath) try { map.removeLayer(state.layers.path); } catch {}
      // strictly ensure B marker and line stay hidden in viewshed mode
      if (state.layers.path) { try { map.removeLayer(state.layers.path); } catch {} state.layers.path = null; }
      if (state.markers.b && map.hasLayer(state.markers.b)) map.removeLayer(state.markers.b);
      // hide terrain overlay (corridor and area) so dataset bounding box is completely removed
      if (state.layers.terrain && map.hasLayer(state.layers.terrain)) {
        map.removeLayer(state.layers.terrain);
      }
      if (activeBase === state.layers.terrain) setBase('satellite');
      const overlay = L.imageOverlay(result.image, _bnds, {opacity:.85, interactive: false, pane: 'viewshedPane'});
      overlay.on('error', () => toast('Failed to load viewshed overlay image.', true));
      state.viewshed = overlay.addTo(map);
      try { state.viewshed.bringToFront(); } catch {}
      // zoom to show the red hits clearly
      try { map.fitBounds(_bnds, { padding: [30,30], maxZoom: 16, animate: true, duration: 0.7 }); } catch {}
      // store flag to restore layers on clear
      state.viewshedHadClasses = hadClasses;
      state.viewshedHadPath = hadPath;
      state.viewshedResult = result;
      renderViewshed(result);
      const src = result._engine==='client'?' (client-side engine)':''; toast('Viewshed complete'+src+'.');
          break;
        } catch(e){
      const msg = String(e && e.message || '');
      if (!staticMode && !isRetryingViewshed && (msg.includes('outside') || msg.includes('gap') || msg.includes('coverage') || msg.includes('footprint'))) {
        isRetryingViewshed = true;
        console.log('[Sightline] Viewshed hit gap/outside — auto-fetching 360° area…', msg);
        const neededRad = Math.max(Math.ceil((num('radius') || 1000) * 1.15), 1000);
        const rLabel = neededRad >= 1000 ? `${(neededRad / 1000).toFixed(neededRad % 1000 ? 1 : 0)} km` : `${neededRad} m`;
        toast(`Streaming fresh 360° terrain around Site A (${rLabel} radius)…`);
        const scopeArea = $('scopeArea');
        const scopeCorridor = $('scopeCorridor');
        if (scopeArea && scopeCorridor) {
          scopeArea.checked = true;
          scopeCorridor.checked = false;
          document.querySelectorAll('input[name="fetchScope"]').forEach(i => i.dispatchEvent(new Event('change')));
        }
        if ($('fetchLat')) $('fetchLat').value = state.points.a[0].toFixed(7);
        if ($('fetchLon')) $('fetchLon').value = state.points.a[1].toFixed(7);
        if ($('fetchRadius')) $('fetchRadius').value = neededRad;
        const refreshed = await ensureCoverageAndRun(true, false);
        if (refreshed) {
          continue;
        }
        isRetryingViewshed = false;
        break;
      }
      isRetryingViewshed = false;
      toast(e.message, true);
          break;
        }
      }
    } finally { isFetchingViewshed=false; if(_btn) _btn.disabled=false; updateRunButtonState(); setBusy(false); }
  });

  function metricsHtml(items){return items.map(([label,value,cls=''])=>`<div class="metric"><small>${label}</small><strong class="${cls}">${value}</strong></div>`).join('')}
  function showNotes(notes=[]){$('resultNotes').innerHTML=notes.length?`<details><summary>Data and model details (${notes.length})</summary>${notes.map(n=>`<p>${escapeHtml(n)}</p>`).join('')}</details>`:''}
  function escapeHtml(value){const el=document.createElement('span');el.textContent=String(value);return el.innerHTML}
  function statusLabel(status){return status==='fresnel'?'Fresnel constrained':status?status[0].toUpperCase()+status.slice(1):'Unknown'}
  function viabilityBadge(v) {
    if(!v) return '';
    const labels = { viable: 'Viable Link', marginal: 'Marginal', deficit: 'Link Deficit', blocked: 'Obstructed', unknown: 'Unknown' };
    return `<span class="badge badge-${v}">${labels[v] || v}</span>`;
  }

  function renderDeployment(r) {
    const el = $('deploymentSection');
    if (!el) return;
    if (state.mode !== 'radio' || !r.link_budget) {
      el.innerHTML = '';
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const lb = r.link_budget;
    const al = r.alignment || {};
    const ma = r.mounts?.a || {};
    const mb = r.mounts?.b || {};

    el.innerHTML = `
      <details class="rf-details-drawer">
        <summary>Detailed RF Link Budget &amp; Antenna Alignment (${viabilityBadge(lb.viability)})</summary>
        <div class="rf-drawer-content">
          <div class="deployment-card">
            <h3>Field Alignment <span>Bearing &amp; Tilt</span></h3>
            <div class="deploy-grid">
              <div class="deploy-item"><small>Site A &rarr; B Heading</small><strong>${fmt(al.azimuth_a_to_b, 1)}&deg; True</strong></div>
              <div class="deploy-item"><small>Site A Tilt</small><strong>${al.tilt_a_to_b >= 0 ? '+' : ''}${fmt(al.tilt_a_to_b, 1)}&deg;</strong></div>
              <div class="deploy-item"><small>Site B &rarr; A Heading</small><strong>${fmt(al.azimuth_b_to_a, 1)}&deg; True</strong></div>
              <div class="deploy-item"><small>Site B Tilt</small><strong>${al.tilt_b_to_a >= 0 ? '+' : ''}${fmt(al.tilt_b_to_a, 1)}&deg;</strong></div>
              <div class="deploy-item"><small>Site A Base (${ma.mount_type || 'agl'})</small><strong>${fmt(ma.base_elevation_m, 1)} m (${fmt(ma.mast_height_m, 1)} m mast)</strong></div>
              <div class="deploy-item"><small>Site B Base (${mb.mount_type || 'agl'})</small><strong>${fmt(mb.base_elevation_m, 1)} m (${fmt(mb.mast_height_m, 1)} m mast)</strong></div>
            </div>
          </div>

          <div class="deployment-card">
            <h3>RF Link Budget <span>${fmt(lb.channel_width_mhz, 0)} MHz BW</span></h3>
            <div class="deploy-grid">
              <div class="deploy-item"><small>Tx EIRP</small><strong>${fmt(lb.eirp_dbm, 1)} dBm</strong></div>
              <div class="deploy-item"><small>Rx Signal Level (RSL)</small><strong class="${lb.link_margin_db >= 10 ? 'status-viable' : lb.link_margin_db >= 0 ? 'status-marginal' : 'status-deficit'}">${fmt(lb.rx_power_dbm, 1)} dBm</strong></div>
              <div class="deploy-item"><small>Free-Space Loss (FSPL)</small><strong>${fmt(lb.free_space_loss_db, 1)} dB</strong></div>
              <div class="deploy-item"><small>Rx Sensitivity</small><strong>${fmt(lb.rx_sensitivity_dbm, 1)} dBm</strong></div>
              <div class="deploy-item"><small>Foliage Loss</small><strong>${fmt(lb.foliage_loss_db, 1)} dB</strong></div>
              <div class="deploy-item"><small>Link Fade Margin</small><strong class="${lb.link_margin_db >= 10 ? 'status-viable' : lb.link_margin_db >= 0 ? 'status-marginal' : 'status-deficit'}">${lb.link_margin_db >= 0 ? '+' : ''}${fmt(lb.link_margin_db, 1)} dB</strong></div>
              <div class="deploy-item"><small>Total Path Loss</small><strong>${fmt(lb.total_path_loss_db, 1)} dB</strong></div>
              <div class="deploy-item"><small>Estimated SNR</small><strong>${fmt(lb.snr_db, 1)} dB</strong></div>
            </div>
          </div>
        </div>
      </details>
    `;
  }

  function renderResult(r) {
    if (state.analysisMode === 'viewshed') return;
    $('resultTitle').textContent = `${statusLabel(r.status)} path`;

    // Streamlined Obstruction Hero Banner
    const hero = $('obstructionHero');
    const crit = r.critical_obstacle;
    if (hero) {
      if (r.status === 'blocked' && crit) {
        hero.className = 'obstruction-hero hero-blocked';
        hero.hidden = false;
        const obsType = crit.obstacle_type[0].toUpperCase() + crit.obstacle_type.slice(1);
        hero.innerHTML = `
          <div class="hero-main">
            <span class="hero-badge badge-blocked">Blocked</span>
            <div class="hero-text">
              <strong>Interrupted by ${obsType} at ${fmt(crit.distance_m, 0)} m (${fmt(crit.fraction * 100, 0)}% of path)</strong>
              <small>Ray penetrates by ${fmt(-crit.clearance_m, 1)} m (obstacle: ${fmt(crit.obstacle_elevation_m, 1)} m, ray: ${fmt(crit.ray_elevation_m, 1)} m)</small>
            </div>
          </div>
        `;
      } else if (r.status === 'fresnel' && crit) {
        hero.className = 'obstruction-hero hero-fresnel';
        hero.hidden = false;
        const obsType = crit.obstacle_type[0].toUpperCase() + crit.obstacle_type.slice(1);
        hero.innerHTML = `
          <div class="hero-main">
            <span class="hero-badge badge-fresnel">Fresnel Constrained</span>
            <div class="hero-text">
              <strong>Direct LOS is clear, but 60% Fresnel zone touches ${obsType} at ${fmt(crit.distance_m, 0)} m</strong>
              <small>Fresnel clearance margin: ${fmt(crit.fresnel_clearance_m, 1)} m</small>
            </div>
          </div>
        `;
      } else if (r.status === 'clear') {
        hero.className = 'obstruction-hero hero-clear';
        hero.hidden = false;
        const marginStr = r.link_budget ? ` · Link fade margin: +${fmt(r.link_budget.link_margin_db, 1)} dB` : '';
        hero.innerHTML = `
          <div class="hero-main">
            <span class="hero-badge badge-clear">Clear Line of Sight</span>
            <div class="hero-text">
              <strong>Full optical and 60% Fresnel clearance over all terrain &amp; buildings</strong>
              <small>Minimum clearance: +${fmt(r.min_clearance_m, 1)} m${marginStr}</small>
            </div>
          </div>
        `;
      } else {
        hero.hidden = true;
      }
    }

    // High-level clean metrics
    const metrics = [
      ['Distance', `${fmt(r.distance_m, 0)} m`],
      ['Direct LOS', statusLabel(r.direct_status), `status-${r.direct_status || 'unknown'}`],
      ['Clearance', `${r.min_clearance_m >= 0 ? '+' : ''}${fmt(r.min_clearance_m)} m`, r.min_clearance_m >= 0 ? 'status-clear' : 'status-blocked'],
    ];
    if (state.mode === 'radio' && r.link_budget) {
      metrics.push(['Viability', r.link_budget.viability.toUpperCase(), `status-${r.link_budget.viability}`]);
    } else {
      metrics.push(['Status', statusLabel(r.status), `status-${r.status}`]);
    }
    $('metrics').innerHTML = metricsHtml(metrics);
    $('metrics').hidden = false;
    if ($('profileHud')) $('profileHud').hidden = true;
    showNotes(r.notes);
    $('emptyChart').hidden = true;
    const chartWrap = document.querySelector('.chart-wrap');
    if (chartWrap) chartWrap.hidden = false;
    const vsSummary = $('viewshedSummary');
    if (vsSummary) vsSummary.hidden = true;
    if ($('resultsEyebrow')) $('resultsEyebrow').textContent = 'Elevation profile';
    drawProfile(r.profile || [], state.mode === 'radio', r.critical_obstacle);
    renderDeployment(r);
    const panel = $('resultsPanel');
    panel.classList.remove('collapsed');
    const btn = $('collapseResults');
    if (btn) { btn.setAttribute('aria-expanded','true'); btn.textContent='⌄'; btn.setAttribute('aria-label','Collapse results'); }
    if (openMobileResultsAfterRun && mobileLayout.matches) {
      openMobileResultsAfterRun = false;
      setMobilePanel('results', true);
    }
  }

  function renderViewshed(r){
    state.viewshedResult = r;
    const c = r.counts || {};
    $('resultTitle').textContent = 'Viewshed complete';
    $('resultsEyebrow').textContent = 'Viewshed analysis';
    const total = (c.clear || 0) + (c.foliage || 0) + (c.fresnel || 0) + (c.blocked || 0) + (c.unknown || 0);
    const visible = (c.clear || 0) + (c.foliage || 0) + (c.fresnel || 0);
    const blocked = c.blocked || 0;
    const unknown = c.unknown || 0;
    const measuredTotal = visible + blocked;
    const visiblePct = measuredTotal > 0 ? ((visible / measuredTotal) * 100).toFixed(1) + '%' : '0%';

    $('metrics').innerHTML = metricsHtml([
      ['Visible (Red)', fmt(visible, 0), 'status-hit'],
      ['Obstructed', fmt(blocked, 0), 'status-blocked'],
      ['Outside Data', fmt(unknown, 0), 'status-unknown'],
      ['Hit Rate', visiblePct, 'status-hit']
    ]);
    $('metrics').hidden = false;
    if ($('profileHud')) $('profileHud').hidden = true;
    showNotes(r.notes);
    if ($('deploymentSection')) { $('deploymentSection').innerHTML = ''; $('deploymentSection').hidden = true; }
    if ($('obstructionHero')) $('obstructionHero').hidden = true;
    $('emptyChart').hidden = true;

    // Hide profile chart, show dedicated viewshed summary card
    const chartWrap = document.querySelector('.chart-wrap');
    if (chartWrap) chartWrap.hidden = true;

    const vsSummary = $('viewshedSummary');
    if (vsSummary) {
      vsSummary.hidden = false;
      const vr = num('radius') || 1000;
      const vs = num('stepM') || 10;
      const isCorridor = !!state.meta?.is_corridor;
      const unknownRatio = total > 0 ? (unknown / total) : 0;
      const showCorridorBanner = isCorridor && (unknownRatio > 0.15 || unknown > 20);

      const visPctVal = total > 0 ? ((visible / total) * 100).toFixed(1) : 0;
      const blkPctVal = total > 0 ? ((blocked / total) * 100).toFixed(1) : 0;
      const unkPctVal = total > 0 ? ((unknown / total) * 100).toFixed(1) : 0;

      let bannerHtml = '';
      if (showCorridorBanner) {
        bannerHtml = `
          <div class="viewshed-corridor-banner">
            <div class="banner-text">
              <strong>Dataset is a narrow corridor</strong>
              <span>${fmt(unknown, 0)} sampled points (${Math.round(unknownRatio * 100)}%) fall outside this corridor. Fetch a full 360° area around Site A for accurate omnidirectional coverage.</span>
            </div>
            <button type="button" class="button button-accent button-sm" id="btnFetchViewshedArea">Fetch Full 360° Area</button>
          </div>
        `;
      }

      vsSummary.innerHTML = `
        ${bannerHtml}
        <div class="viewshed-dist-bar" title="Visible (Red): ${visPctVal}%, Obstructed: ${blkPctVal}%, Outside: ${unkPctVal}%">
          <div class="viewshed-dist-seg visible" style="width:${visPctVal}%" title="Visible (Red): ${visPctVal}%"></div>
          <div class="viewshed-dist-seg blocked" style="width:${blkPctVal}%" title="Obstructed: ${blkPctVal}%"></div>
          <div class="viewshed-dist-seg unknown" style="width:${unkPctVal}%" title="Outside: ${unkPctVal}%"></div>
        </div>
        <div class="viewshed-stat-grid">
          <div class="viewshed-stat-card">
            <small>Coverage Radius</small>
            <strong>${fmt(vr, 0)} m</strong>
          </div>
          <div class="viewshed-stat-card">
            <small>Sampling Step</small>
            <strong>${fmt(vs, 0)} m</strong>
          </div>
          <div class="viewshed-stat-card">
            <small>Points Sampled</small>
            <strong>${fmt(total, 0)}</strong>
          </div>
          <div class="viewshed-stat-card">
            <small>Hit Rate</small>
            <strong style="color:var(--status-hit, #eb3741)">${visiblePct}</strong>
          </div>
        </div>
      `;

      if (showCorridorBanner) {
        const btnArea = $('btnFetchViewshedArea');
        if (btnArea) {
          btnArea.addEventListener('click', async () => {
            const scopeArea = $('scopeArea');
            const scopeCorridor = $('scopeCorridor');
            if (scopeArea && scopeCorridor) {
              scopeArea.checked = true;
              scopeCorridor.checked = false;
              document.querySelectorAll('input[name="fetchScope"]').forEach(i => i.dispatchEvent(new Event('change')));
            }
            if (state.points.a) {
              if ($('fetchLat')) $('fetchLat').value = state.points.a[0].toFixed(7);
              if ($('fetchLon')) $('fetchLon').value = state.points.a[1].toFixed(7);
              if ($('fetchRadius')) $('fetchRadius').value = Math.max(num('radius') || 500, 500);
            }
            toast('Downloading full 360° area around Site A…');
            await ensureCoverageAndRun(true);
          });
        }
      }
    }

    const pv = $('profileChart');
    if (pv) { const sg2 = pv.querySelector('.scrubber-group'); if (sg2) sg2.remove(); }
    if (pathHoverMarker && map.hasLayer(pathHoverMarker)) map.removeLayer(pathHoverMarker);
    const panel2 = $('resultsPanel');
    if (panel2) panel2.classList.remove('collapsed');
    const btn2 = $('collapseResults');
    if (btn2) { btn2.setAttribute('aria-expanded','true'); btn2.textContent='⌄'; }
    if (openMobileResultsAfterRun && mobileLayout.matches) {
      openMobileResultsAfterRun = false;
      setMobilePanel('results', true);
    }
  }

  let activeProfile = null;
  let profileScale = null;
  let pathHoverMarker = null;

  function drawProfile(profile, radio, criticalObstacle) {
    activeProfile = profile;
    const svg = $('profileChart'), w = 1000, h = 128, p = { l: 40, r: 14, t: 14, b: 20 };
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    // Remove stale scrubber on re-draw / empty profile — prevents placeholder ghost
    const existingScrub = svg.querySelector('.scrubber-group');
    if (existingScrub) existingScrub.remove();
    if (profile.length < 2) {
      svg.innerHTML = '';
      profileScale = null;
      const ec2 = $('emptyChart');
      if (ec2) ec2.hidden = false;
      // Ensure inspector is fully hidden (no 0m ghost) and metrics visible
      const hud2 = $('profileHud');
      const metricsEl2 = $('metrics');
      if (hud2) hud2.hidden = true;
      if (metricsEl2) metricsEl2.hidden = false;
      if (pathHoverMarker && map.hasLayer(pathHoverMarker)) map.removeLayer(pathHoverMarker);
      return;
    }
    let min = Infinity, max = -Infinity;
    for (const d of profile) {
      for (const key of ['ground_m', 'building_m', 'tree_m', 'ray_m']) {
        if (Number.isFinite(d[key])) {
          min = Math.min(min, d[key]);
          max = Math.max(max, d[key]);
        }
      }
    }
    if (!Number.isFinite(min)) {
      svg.innerHTML = '';
      profileScale = null;
      return;
    }
    const pad = Math.max((max - min) * 0.14, 3);
    min -= pad;
    max += pad;
    const maxD = profile.at(-1).distance_m || 1;
    const x = d => p.l + (d / maxD) * (w - p.l - p.r);
    const y = v => p.t + (max - v) / (max - min) * (h - p.t - p.b);
    profileScale = { min, max, maxD, w, h, p, x, y };

    const line = key => {
      let open = false;
      return profile.map(d => {
        if (!Number.isFinite(d[key])) {
          open = false;
          return '';
        }
        const cmd = open ? 'L' : 'M';
        open = true;
        return `${cmd}${x(d.distance_m).toFixed(1)},${y(d[key]).toFixed(1)}`;
      }).join(' ');
    };
    const ticks = [0, 0.5, 1].map(t => {
      const v = min + (max - min) * t, yy = y(v);
      return `<line x1="${p.l}" y1="${yy}" x2="${w - p.r}" y2="${yy}" stroke="#ffffff0f" stroke-width="0.6" vector-effect="non-scaling-stroke"/><text x="${p.l - 6}" y="${yy + 3}" text-anchor="end" fill="#7a8a84" font-size="8.5" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${fmt(v, 0)}</text>`;
    }).join('');
    // Muted status ribbon — desaturated, thin, two colors only
    let statusRibbon = '';
    const showObstructions = $('toggleObstructions') ? $('toggleObstructions').checked : true;
    const showFoliage = $('toggleFoliage') ? $('toggleFoliage').checked : true;
    if (state.result && state.result.segments) {
      for (const seg of state.result.segments) {
        if (seg.status === 'blocked' && !showObstructions) continue;
        if (seg.status === 'foliage' && !showFoliage) continue;
        if (seg.status !== 'blocked' && seg.status !== 'foliage') continue;
        const x1 = Math.max(p.l, x(seg.start_m));
        const x2 = Math.min(w - p.r, x(seg.end_m));
        const segW = Math.max(1.5, x2 - x1);
        if (segW < 0.8) continue;
        const color = seg.status === 'blocked' ? '#b56a5a' : '#9a8a5a';
        statusRibbon += `<rect x="${x1.toFixed(1)}" y="${(p.t - 5).toFixed(1)}" width="${segW.toFixed(1)}" height="2.5" rx="1" fill="${color}" opacity="0.92"/>`;
      }
    }
    // Fresnel — very subtle, muted blue-gray, thin
    let fresnel = '';
    if (radio) {
      const top = profile.map((d, i) => `${i ? 'L' : 'M'}${x(d.distance_m)},${y(d.ray_m + (d.fresnel_m || 0))}`).join(' ');
      const bottom = [...profile].reverse().map(d => `L${x(d.distance_m)},${y(d.ray_m - (d.fresnel_m || 0))}`).join(' ');
      fresnel = `<path d="${top}${bottom}Z" fill="#8aa0b813" stroke="#8aa0b826" stroke-width="0.5" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"/>`;
    }
    // Critical marker — muted thin dashed, no stretched elements
    let critMarker = '';
    if (criticalObstacle && criticalObstacle.distance_m > 0 && criticalObstacle.distance_m < maxD && state.result && state.result.status === 'blocked') {
      const cx = x(criticalObstacle.distance_m);
      critMarker = `<line x1="${cx}" y1="${p.t}" x2="${cx}" y2="${h - p.b}" stroke="#b56a5a" stroke-dasharray="4 3" stroke-width="0.8" opacity="0.42" vector-effect="non-scaling-stroke"/>`;
    }
    // Muted fills — desaturated brick & sage, thin strokes, GIS feel
    const buildFill = (() => {
      let d = '';
      let open = false;
      for (let i = 0; i < profile.length; i++) {
        const g = profile[i].ground_m, b = profile[i].building_m;
        if (!Number.isFinite(b) || !Number.isFinite(g) || b < g + 0.3) { open = false; continue; }
        const xx = x(profile[i].distance_m).toFixed(1), yyB = y(b).toFixed(1), yyG = y(g).toFixed(1);
        if (!open) { d += `M${xx},${yyG} L${xx},${yyB}`; open = true; }
        else d += ` L${xx},${yyB}`;
        const nextB = profile[i+1]?.building_m;
        if (i === profile.length-1 || !Number.isFinite(nextB)) {
          d += ` L${xx},${yyG} Z `;
          open = false;
        }
      }
      return d ? `<path d="${d}" fill="#b56a5a18" stroke="#b56a5a30" stroke-width="0.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : '';
    })();
    const treeFill = (() => {
      let d = '';
      let open = false;
      for (let i = 0; i < profile.length; i++) {
        const g = profile[i].ground_m, t = profile[i].tree_m, b = profile[i].building_m;
        if (!Number.isFinite(t) || !Number.isFinite(g) || t < g + 0.4 || (Number.isFinite(b) && b >= g + 0.3)) { open = false; continue; }
        const xx = x(profile[i].distance_m).toFixed(1), yyT = y(t).toFixed(1), yyG = y(g).toFixed(1);
        if (!open) { d += `M${xx},${yyG} L${xx},${yyT}`; open = true; }
        else d += ` L${xx},${yyT}`;
        const nextT = profile[i+1]?.tree_m;
        if (i === profile.length-1 || !Number.isFinite(nextT)) {
          d += ` L${xx},${yyG} Z `;
          open = false;
        }
      }
      return d ? `<path d="${d}" fill="#6b8a7216" stroke="#6b8a7230" stroke-width="0.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : '';
    })();
    const ec = $('emptyChart');
    if (ec) ec.hidden = true;
    svg.innerHTML = `${ticks}${treeFill}${buildFill}${fresnel}<path d="${line('ground_m')}" fill="none" stroke="#8a9a93" stroke-width="1" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/><path d="${line('ray_m')}" fill="none" stroke="#c2d08a" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>${statusRibbon}${critMarker}<text x="${p.l}" y="${h - 3}" fill="#6e7c76" font-size="7.5" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">0 m</text><text x="${w - p.r}" y="${h - 3}" text-anchor="end" fill="#6e7c76" font-size="7.5" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${fmt(maxD, 0)} m</text>`;
  }

  function initScrubber() {
    const svg = $('profileChart');
    const hud = $('profileHud');
    const metricsEl = $('metrics');
    if (!svg) return;
    // Prevent inspector 0m (0%) ghost on load — hide hud until hover
    if (hud) hud.hidden = true;
    if (metricsEl) metricsEl.hidden = false;

    let isPointerDown = false;

    function updateScrubber(clientX, clientY) {
      if (!activeProfile || activeProfile.length < 2 || !state.points.a || !state.points.b || !profileScale) {
        handleLeave();
        return;
      }

      const w = profileScale.w, h = profileScale.h, p = profileScale.p;
      let svgX = null;
      if (svg.getScreenCTM && svg.createSVGPoint) {
        try {
          const ctm = svg.getScreenCTM();
          if (ctm) {
            const pt = svg.createSVGPoint();
            pt.x = clientX;
            pt.y = clientY || 0;
            const svgP = pt.matrixTransform(ctm.inverse());
            svgX = svgP.x;
          }
        } catch {}
      }
      if (svgX === null) {
        const rect = svg.getBoundingClientRect();
        if (!rect.width) return;
        svgX = (clientX - rect.left) * (w / rect.width);
      }

      const clampedSvgX = Math.max(p.l, Math.min(w - p.r, svgX));
      const maxD = profileScale.maxD;
      const frac = Math.max(0, Math.min(1, (clampedSvgX - p.l) / (w - p.l - p.r)));
      const targetDist = frac * maxD;

      let loIdx = 0, hiIdx = activeProfile.length - 1;
      while (hiIdx - loIdx > 1) {
        const mid = (loIdx + hiIdx) >> 1;
        if (activeProfile[mid].distance_m <= targetDist) loIdx = mid;
        else hiIdx = mid;
      }
      const aP = activeProfile[loIdx];
      const bP = activeProfile[hiIdx];
      const span = (bP.distance_m - aP.distance_m) || 1;
      const t = Math.max(0, Math.min(1, (targetDist - aP.distance_m) / span));
      const lerp = (av, bv) => {
        if (!Number.isFinite(av) && !Number.isFinite(bv)) return av;
        if (!Number.isFinite(av)) return bv;
        if (!Number.isFinite(bv)) return av;
        return av + (bv - av) * t;
      };
      const sample = {
        distance_m: targetDist,
        ground_m: lerp(aP.ground_m, bP.ground_m),
        building_m: lerp(aP.building_m, bP.building_m),
        tree_m: lerp(aP.tree_m, bP.tree_m),
        ray_m: lerp(aP.ray_m, bP.ray_m),
        fresnel_m: lerp(aP.fresnel_m, bP.fresnel_m),
        unknown: aP.unknown || bP.unknown
      };

      let group = svg.querySelector('.scrubber-group');
      if (!group) {
        group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', 'scrubber-group');
        svg.appendChild(group);
      }

      const rayY = profileScale.y(sample.ray_m);
      let obsElev = sample.ground_m;
      let obsType = 'ground';
      let obsLabel = 'Ground';
      let obsClass = 'status-clear';
      let clearance = sample.ray_m - sample.ground_m;

      if (Number.isFinite(sample.building_m) && sample.building_m > sample.ground_m) {
        obsElev = sample.building_m;
        obsType = 'building';
        obsLabel = `Structure ${fmt(sample.building_m, 1)} m`;
        obsClass = 'status-blocked';
        clearance = sample.ray_m - sample.building_m;
      } else if (Number.isFinite(sample.tree_m) && sample.tree_m > sample.ground_m) {
        obsElev = sample.tree_m;
        obsType = 'tree';
        obsLabel = `Canopy ${fmt(sample.tree_m, 1)} m`;
        obsClass = 'status-foliage';
        clearance = sample.ray_m - sample.tree_m;
      }

      const obsY = profileScale.y(obsElev);
      const isPenetration = clearance < 0;
      const clearanceClass = isPenetration ? 'penetration' : 'clear';
      const clearanceColor = isPenetration ? 'status-blocked' : 'status-clear';

      const rect = svg.getBoundingClientRect();
      const sxScale = rect.width ? (w / rect.width) : 1;
      const syScale = rect.height ? (h / rect.height) : 1;
      const rxObs = (3.0 * sxScale).toFixed(2);
      const ryObs = (3.0 * syScale).toFixed(2);
      const rxRay = (3.8 * sxScale).toFixed(2);
      const ryRay = (3.8 * syScale).toFixed(2);
      const thumbW = (13.0 * sxScale).toFixed(2);
      const thumbH = (8.0 * syScale).toFixed(2);
      const thumbX = (clampedSvgX - (13.0 * sxScale) / 2).toFixed(2);
      const grip1X = (clampedSvgX - (2.5 * sxScale)).toFixed(2);
      const grip2X = (clampedSvgX + (2.5 * sxScale)).toFixed(2);
      const sx = clampedSvgX.toFixed(1);

      group.innerHTML = `
        <line class="scrubber-line" x1="${sx}" y1="${p.t}" x2="${sx}" y2="${h - p.b}"/>
        <line class="scrubber-clearance-bar ${clearanceClass}" x1="${sx}" y1="${rayY.toFixed(1)}" x2="${sx}" y2="${obsY.toFixed(1)}"/>
        <ellipse class="scrubber-dot scrubber-dot-obs dot-${obsType}" cx="${sx}" cy="${obsY.toFixed(1)}" rx="${rxObs}" ry="${ryObs}"/>
        <ellipse class="scrubber-dot scrubber-dot-ray" cx="${sx}" cy="${rayY.toFixed(1)}" rx="${rxRay}" ry="${ryRay}"/>
        <rect class="scrubber-thumb" x="${thumbX}" y="1.5" width="${thumbW}" height="${thumbH}" rx="2"/>
        <line class="scrubber-thumb-grip" x1="${grip1X}" y1="3.5" x2="${grip1X}" y2="7.5"/>
        <line class="scrubber-thumb-grip" x1="${grip2X}" y1="3.5" x2="${grip2X}" y2="7.5"/>
      `;

      const a = state.points.a, b = state.points.b;
      const curLat = a[0] + frac * (b[0] - a[0]);
      const curLon = a[1] + frac * (b[1] - a[1]);

      if (!pathHoverMarker) {
        pathHoverMarker = L.circleMarker([curLat, curLon], {
          radius: 5,
          color: '#ffffff',
          fillColor: '#c2d08a',
          fillOpacity: 1,
          weight: 1.6,
          pane: 'markerPane',
          interactive: false
        });
      }
      pathHoverMarker.setLatLng([curLat, curLon]);
      if (!map.hasLayer(pathHoverMarker)) pathHoverMarker.addTo(map);

      if (hud && metricsEl) {
        metricsEl.hidden = true;
        hud.hidden = false;

        const fresnelHtml = Number.isFinite(sample.fresnel_m)
          ? `<div class="metric"><small>Fresnel R1</small><strong class="status-fresnel">&plusmn;${fmt(sample.fresnel_m, 1)} m</strong></div>`
          : '';

        hud.innerHTML = `
          <div class="inspector-badge"><span class="inspector-dot"></span>Inspect</div>
          <div class="metric"><small>Distance</small><strong>${fmt(sample.distance_m, 0)} m<span class="metric-pct"> (${fmt(frac * 100, 0)}%)</span></strong></div>
          <div class="metric"><small>Terrain</small><strong>${fmt(sample.ground_m, 1)} m</strong></div>
          <div class="metric"><small>Object</small><strong class="${obsClass}">${obsLabel}</strong></div>
          <div class="metric"><small>Ray</small><strong>${fmt(sample.ray_m, 1)} m</strong></div>
          <div class="metric"><small>Clearance</small><strong class="${clearanceColor}">${isPenetration ? '' : '+'}${fmt(clearance, 1)} m</strong></div>
          ${fresnelHtml}
        `;
      }
    }

    function handleLeave() {
      if (isPointerDown) return;
      const group = svg.querySelector('.scrubber-group');
      if (group) group.remove();
      if (pathHoverMarker && map.hasLayer(pathHoverMarker)) {
        map.removeLayer(pathHoverMarker);
      }
      if (hud && metricsEl) {
        hud.hidden = true;
        metricsEl.hidden = false;
      }
    }

    svg.addEventListener('pointerdown', e => {
      if (!activeProfile || activeProfile.length < 2) return;
      isPointerDown = true;
      try { svg.setPointerCapture(e.pointerId); } catch {}
      updateScrubber(e.clientX, e.clientY);
    });

    svg.addEventListener('pointermove', e => {
      if (isPointerDown || e.buttons > 0) {
        updateScrubber(e.clientX, e.clientY);
      } else {
        const rect = svg.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          updateScrubber(e.clientX, e.clientY);
        } else {
          handleLeave();
        }
      }
    });

    const finishPointer = e => {
      if (isPointerDown) {
        isPointerDown = false;
        try { svg.releasePointerCapture(e.pointerId); } catch {}
      }
      handleLeave();
    };

    svg.addEventListener('pointerup', finishPointer);
    svg.addEventListener('pointercancel', finishPointer);
    svg.addEventListener('mouseleave', handleLeave);

    svg.addEventListener('touchstart', e => {
      if (e.touches && e.touches[0]) {
        isPointerDown = true;
        updateScrubber(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: true });
    svg.addEventListener('touchmove', e => {
      if (e.touches && e.touches[0]) {
        updateScrubber(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: true });
    svg.addEventListener('touchend', finishPointer);
    svg.addEventListener('touchcancel', finishPointer);
  }
  $('collapseResults').addEventListener('click',()=>{
    const panel=$('resultsPanel');
    const btn=$('collapseResults');
    const collapsed=panel.classList.toggle('collapsed');
    if(btn){
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.textContent = collapsed ? '⌃' : '⌄';
      btn.setAttribute('aria-label', collapsed ? 'Expand results' : 'Collapse results');
    }
    // Ensure inspector doesn't linger when collapsing
    if(collapsed){
      const hud=$('profileHud');
      const metricsEl=$('metrics');
      const group=$('profileChart')?.querySelector('.scrubber-group');
      if(group) group.remove();
      if(hud) hud.hidden = true;
      if(metricsEl) metricsEl.hidden = false;
      if(pathHoverMarker && map.hasLayer(pathHoverMarker)) map.removeLayer(pathHoverMarker);
    }
  });
  $('reset').addEventListener('click',()=>{clearAnalysis();toast('Analysis overlays cleared.')});
  $('exportJson').addEventListener('click',()=>{
    const isViewshed = state.analysisMode === 'viewshed';
    const data = isViewshed ? state.viewshedResult : (state.result || state.viewshedResult);
    if (!data) return toast(isViewshed ? 'Run a viewshed analysis before exporting.' : 'Run a path analysis before exporting.', true);
    const filename = (isViewshed || (!state.result && state.viewshedResult)) ? 'sightline-viewshed.json' : 'sightline-result.json';
    download(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}), filename);
  });
  function clientKml(result) {
    if (!result || !state.points.a || !state.points.b) throw new Error('Run a path analysis before exporting KML.');
    const esc = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
    const a = state.points.a, b = state.points.b;
    const za = result.mounts?.a?.total_elevation_m ?? 0;
    const zb = result.mounts?.b?.total_elevation_m ?? 0;
    const color = {clear:'ff96d653',foliage:'ff55baf5',fresnel:'fff581ac',blocked:'ff5f67ff',unknown:'ffa4a6a3'}[result.status] || 'ffa4a6a3';
    const detail = esc(`Sightline status: ${String(result.status || 'unknown').toUpperCase()}\nDistance: ${fmt(result.distance_m,1)} m\nSource: ${state.meta?.source || 'bundled static scene'}`);
    return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Sightline analysis</name><Style id="path"><LineStyle><color>${color}</color><width>4</width></LineStyle></Style><Placemark><name>Site A</name><description>${detail}</description><Point><altitudeMode>absolute</altitudeMode><coordinates>${a[1]},${a[0]},${za}</coordinates></Point></Placemark><Placemark><name>Site B</name><description>${detail}</description><Point><altitudeMode>absolute</altitudeMode><coordinates>${b[1]},${b[0]},${zb}</coordinates></Point></Placemark><Placemark><name>${esc(String(result.status || 'unknown').toUpperCase())}</name><description>${detail}</description><styleUrl>#path</styleUrl><LineString><altitudeMode>absolute</altitudeMode><coordinates>${a[1]},${a[0]},${za} ${b[1]},${b[0]},${zb}</coordinates></LineString></Placemark></Document></kml>`;
  }
  $('exportKml').addEventListener('click',async()=>{try{
    if (state.analysisMode === 'viewshed') throw new Error('KML export is available for A-to-B path results.');
    if (staticMode) return download(new Blob([clientKml(state.result)],{type:'application/vnd.google-earth.kml+xml'}),'sightline-path.kml');
    const res=await api('/api/kml',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload())});download(await res.blob(),'sightline-path.kml');
  }catch(e){toast(e.message,true)}});
  function download(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
  $('importButton').addEventListener('click',()=>$('fileInput').click());
  $('fileInput').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;try{setBusy(true,`Importing ${file.name}`);const query=new URLSearchParams({resolution:'3'});if($('importUnits').value)query.set('vertical_unit',$('importUnits').value);if($('importCrs').value.trim())query.set('crs',$('importCrs').value.trim());await api(`/api/import?${query}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Filename':encodeURIComponent(file.name)},body:file});await loadMeta();toast('Local dataset loaded.')}catch(err){toast(err.message,true)}finally{setBusy(false);e.target.value=''}});
  $('resetDemo').addEventListener('click',async()=>{try{setBusy(true,'Restoring starter dataset');if(staticMode){for(const url of browserOverlayUrls)if(String(url).startsWith('blob:'))URL.revokeObjectURL(url);browserOverlayUrls=[];staticManifest=null;}else{await api('/api/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});}fetchCenterEdited=false;userPlacedEndpoints=false;await loadMeta();toast('Starter dataset restored.')}catch(e){toast(e.message,true)}finally{setBusy(false)}});
  // Location Search & Navigation ("Go there")
  let searchMarker = null;
  let searchDebounce = null;
  let activeSearchItems = [];
  let selectedSearchIndex = -1;

  function parseCoordinates(text) {
    text = (text || '').trim();
    if (!text) return null;

    // 1. Google Maps / OSM / Geo URLs
    let m = text.match(/[@\?&](?:q=)?([+-]?\d+\.?\d*),([+-]?\d+\.?\d*)/);
    if (m) {
      const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return { lat, lon };
    }
    m = text.match(/#map=\d+\/([+-]?\d+\.?\d*)\/([+-]?\d+\.?\d*)/);
    if (m) {
      const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return { lat, lon };
    }

    // 2. DMS / DDM: e.g. 37°46'29.6"N 122°25'09.8"W or 37 46 29.6 N, 122 25 09.8 W
    const dmsRe = /(\d+)[°d\s]+(\d+(?:\.\d+)?)['m\s]*(?:([\d.]+)["s\s]*)?([NSEWnsew])/g;
    const dmsMatches = [...text.matchAll(dmsRe)];
    if (dmsMatches.length === 2) {
      const parts = {};
      for (const match of dmsMatches) {
        const deg = parseFloat(match[1]);
        const min = parseFloat(match[2]);
        const sec = parseFloat(match[3] || 0);
        const hemi = match[4].toUpperCase();
        let val = deg + min / 60.0 + sec / 3600.0;
        if (hemi === 'S' || hemi === 'W') val = -val;
        if (hemi === 'N' || hemi === 'S') parts.lat = val;
        else parts.lon = val;
      }
      if (parts.lat !== undefined && parts.lon !== undefined) {
        if (parts.lat >= -90 && parts.lat <= 90 && parts.lon >= -180 && parts.lon <= 180) {
          return { lat: parts.lat, lon: parts.lon };
        }
      }
    }

    // 3. Decimal with hemisphere letter: e.g. 37.7749N 122.4194W or 122.4194W 37.7749N
    const hemiRe = /([+-]?\d+\.?\d*)\s*°?\s*([NSEWnsew])/g;
    const hemiMatches = [...text.matchAll(hemiRe)];
    if (hemiMatches.length === 2) {
      const parts = {};
      for (const match of hemiMatches) {
        let val = Math.abs(parseFloat(match[1]));
        const hemi = match[2].toUpperCase();
        if (hemi === 'S' || hemi === 'W') val = -val;
        if (hemi === 'N' || hemi === 'S') parts.lat = val;
        else parts.lon = val;
      }
      if (parts.lat !== undefined && parts.lon !== undefined) {
        if (parts.lat >= -90 && parts.lat <= 90 && parts.lon >= -180 && parts.lon <= 180) {
          return { lat: parts.lat, lon: parts.lon };
        }
      }
    }

    // 4. JSON / Tuple / plain numbers: [37.77, -122.42], (37.77, -122.42), 37.77, -122.42
    const clean = text.replace(/[\[\]\(\)\{\}"'a-zA-Z_:]+/g, ' ').replace(/;/g, ',');
    const nums = clean.match(/[+-]?\d+\.?\d*/g);
    if (nums && nums.length === 2) {
      const n1 = parseFloat(nums[0]), n2 = parseFloat(nums[1]);
      if (!isNaN(n1) && !isNaN(n2)) {
        if (n1 >= -90 && n1 <= 90 && n2 >= -180 && n2 <= 180) return { lat: n1, lon: n2 };
        if (n1 >= -180 && n1 <= 180 && n2 >= -90 && n2 <= 90) return { lat: n2, lon: n1 };
      }
    }

    return null;
  }

  function hideSearchDropdown() {
    const dd = $('searchDropdown');
    if (dd) {
      dd.hidden = true;
      dd.innerHTML = '';
    }
    const si = $('searchInput');
    if (si) si.setAttribute('aria-expanded', 'false');
    activeSearchItems = [];
    selectedSearchIndex = -1;
  }

  function showSearchDropdown(results) {
    activeSearchItems = results || [];
    selectedSearchIndex = -1;
    const dropdown = $('searchDropdown');
    if (!dropdown) return;
    const si2 = $('searchInput');
    if (si2) si2.setAttribute('aria-expanded', 'true');
    if (!activeSearchItems.length) {
      dropdown.innerHTML = '<div class="search-empty">No matching locations found</div>';
      dropdown.hidden = false;
      return;
    }
    dropdown.innerHTML = activeSearchItems.map((item, idx) => `
      <div class="search-item" data-index="${idx}" role="option" aria-selected="false" id="search-option-${idx}">
        <span class="item-type">${escapeHtml(item.type || 'place')}</span>
        <strong>${escapeHtml(item.name || item.display_name)}</strong>
        <small>${escapeHtml(item.display_name)}</small>
      </div>
    `).join('');
    dropdown.querySelectorAll('.search-item').forEach(el => {
      el.addEventListener('click', () => {
        const item = activeSearchItems[Number(el.dataset.index)];
        if (item) {
          $('searchInput').value = item.name || item.display_name;
          goToLocation(item.lat, item.lon, item.name || item.display_name, item.boundingbox);
        }
      });
    });
    dropdown.hidden = false;
  }

  let searchPopupTimer = null;
  function dismissSearchPopup() {
    if (searchMarker) {
      try { searchMarker.closePopup(); } catch {}
      // remove marker after popup animates away
      setTimeout(() => {
        if (searchMarker && !searchMarker.isPopupOpen()) {
          map.removeLayer(searchMarker);
          searchMarker = null;
        }
      }, 400);
    }
    if (searchPopupTimer) { clearTimeout(searchPopupTimer); searchPopupTimer = null; }
  }

  async function geocodeLocations(query) {
    if (!staticMode) return (await api(`/api/geocode?q=${encodeURIComponent(query)}`)).json();
    const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5' });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
    if (!response.ok) throw new Error(`Location service returned HTTP ${response.status}.`);
    return (await response.json()).map(item => ({
      lat: Number(item.lat),
      lon: Number(item.lon),
      name: String(item.display_name || '').split(',')[0],
      display_name: item.display_name,
      boundingbox: item.boundingbox,
    }));
  }

  function goToLocation(lat, lon, label, bounds) {
    if (searchMarker) {
      map.removeLayer(searchMarker);
      searchMarker = null;
    }
    if (searchPopupTimer) { clearTimeout(searchPopupTimer); searchPopupTimer = null; }

    if (bounds && bounds.length === 4) {
      const south = Math.min(Number(bounds[0]), Number(bounds[1]));
      const north = Math.max(Number(bounds[0]), Number(bounds[1]));
      const west = Math.min(Number(bounds[2]), Number(bounds[3]));
      const east = Math.max(Number(bounds[2]), Number(bounds[3]));
      if (Number.isFinite(south) && Number.isFinite(north) && Number.isFinite(west) && Number.isFinite(east)) {
        map.fitBounds([[south, west], [north, east]], { maxZoom: 16, padding: [40, 40] });
      } else {
        map.flyTo([lat, lon], 16, { duration: 1.2 });
      }
    } else {
      map.flyTo([lat, lon], 16, { duration: 1.2 });
    }

    const isVs = state.analysisMode === 'viewshed';
    const popupContent = document.createElement('div');
    popupContent.className = 'search-popup';
    popupContent.innerHTML = `
      <strong>${escapeHtml(label || 'Target Location')}</strong>
      <div class="coords">${lat.toFixed(6)}, ${lon.toFixed(6)}</div>
      <div class="search-popup-actions">
        <button class="primary" id="popupFetchArea">Fetch area</button>
        <button id="popupSetA">${isVs ? 'Set Origin (Site A)' : 'Set Site A'}</button>
        <button id="popupSetB" ${isVs ? 'hidden' : ''}>Set Site B</button>
      </div>
    `;

    popupContent.querySelector('#popupFetchArea').addEventListener('click', () => {
      $('fetchLat').value = lat.toFixed(6);
      $('fetchLon').value = lon.toFixed(6);
      fetchCenterEdited = true;
      toast(`Area coordinates set to ${lat.toFixed(4)}, ${lon.toFixed(4)}.`);
      $('fetchArea').focus();
      dismissSearchPopup();
    });

    popupContent.querySelector('#popupSetA').addEventListener('click', () => {
      place('a', L.latLng(lat, lon), true);
      toast(`Site A placed at ${lat.toFixed(4)}, ${lon.toFixed(4)}.`);
      dismissSearchPopup();
    });

    popupContent.querySelector('#popupSetB').addEventListener('click', () => {
      place('b', L.latLng(lat, lon), true);
      toast(`Site B placed at ${lat.toFixed(4)}, ${lon.toFixed(4)}.`);
      dismissSearchPopup();
    });

    searchMarker = L.marker([lat, lon], {
      icon: pinIcon('search'),
      zIndexOffset: 850
    }).addTo(map);

    searchMarker.bindPopup(popupContent, { offset: [0, -20] }).openPopup();
    // auto-dismiss popup after 12s if user does nothing, and on next map interaction
    // guard map click so it doesn't also place A/B (fixes dismiss triggers place)
    searchPopupTimer = setTimeout(() => dismissSearchPopup(), 12000);
    searchMarker.once('popupclose', () => { if (searchPopupTimer) { clearTimeout(searchPopupTimer); searchPopupTimer = null; } });
    map.once('click', (e) => {
      if (e.originalEvent && e.originalEvent.target && e.originalEvent.target.closest && e.originalEvent.target.closest('.leaflet-popup')) return;
      L.DomEvent.stop(e);
      dismissSearchPopup();
    });
    map.once('movestart', () => { if (searchPopupTimer) { clearTimeout(searchPopupTimer); searchPopupTimer = setTimeout(() => dismissSearchPopup(), 4000); } });

    $('fetchLat').value = lat.toFixed(6);
    $('fetchLon').value = lon.toFixed(6);
    fetchCenterEdited = true;

    hideSearchDropdown();
    toast(`Navigated to ${label || `${lat.toFixed(4)}, ${lon.toFixed(4)}`}`);
  }

  async function executeSearch(query) {
    query = (query || '').trim();
    if (!query) return;

    const coords = parseCoordinates(query);
    if (coords) {
      goToLocation(coords.lat, coords.lon, `Coordinates (${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)})`);
      return;
    }

    try {
      setBusy(true, `Searching "${query}"`);
      const res = await geocodeLocations(query);
      if (res && res.length > 0) {
        if (res.length === 1) {
          goToLocation(res[0].lat, res[0].lon, res[0].name || res[0].display_name, res[0].boundingbox);
        } else {
          showSearchDropdown(res);
        }
      } else {
        toast(`Location "${query}" not found.`, true);
        hideSearchDropdown();
      }
    } catch (err) {
      toast(`Search failed: ${err.message}`, true);
    } finally {
      setBusy(false);
    }
  }

  const searchInput = $('searchInput');
  const searchClear = $('searchClear');
  const searchSubmit = $('searchSubmit');

  if (searchInput) {
    searchInput.addEventListener('input', e => {
      const val = e.target.value;
      if (searchClear) searchClear.hidden = !val.trim();
      clearTimeout(searchDebounce);
      if (!val.trim()) {
        hideSearchDropdown();
        return;
      }
      if (parseCoordinates(val)) {
        hideSearchDropdown();
        return;
      }
      if (!staticMode && val.trim().length >= 3) {
        searchDebounce = setTimeout(async () => {
          try {
            const res = await geocodeLocations(val.trim());
            showSearchDropdown(res);
          } catch {}
        }, 320);
      } else {
        hideSearchDropdown();
      }
    });

    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(searchDebounce);
        if (selectedSearchIndex >= 0 && activeSearchItems[selectedSearchIndex]) {
          const item = activeSearchItems[selectedSearchIndex];
          searchInput.value = item.name || item.display_name;
          goToLocation(item.lat, item.lon, item.name || item.display_name, item.boundingbox);
        } else {
          executeSearch(searchInput.value);
        }
      } else if (e.key === 'Escape') {
        hideSearchDropdown();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const items = $('searchDropdown').querySelectorAll('.search-item');
        if (items.length) {
          selectedSearchIndex = (selectedSearchIndex + 1) % items.length;
          items.forEach((it, i) => { const on=i===selectedSearchIndex; it.classList.toggle('active', on); it.setAttribute('aria-selected', String(on)); });
          if (items[selectedSearchIndex]) items[selectedSearchIndex].scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const items = $('searchDropdown').querySelectorAll('.search-item');
        if (items.length) {
          selectedSearchIndex = (selectedSearchIndex - 1 + items.length) % items.length;
          items.forEach((it, i) => { const on=i===selectedSearchIndex; it.classList.toggle('active', on); it.setAttribute('aria-selected', String(on)); });
          if (items[selectedSearchIndex]) items[selectedSearchIndex].scrollIntoView({ block: 'nearest' });
        }
      }
    });
  }

  if (searchClear) {
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.hidden = true;
      hideSearchDropdown();
      dismissSearchPopup();
      searchInput.focus();
    });
  }

  if (searchSubmit) {
    searchSubmit.addEventListener('click', () => {
      clearTimeout(searchDebounce);
      executeSearch(searchInput.value);
    });
  }

  document.addEventListener('click', e => {
    const locSearch = $('locationSearch');
    if (locSearch && !locSearch.contains(e.target)) {
      hideSearchDropdown();
    }
  });

  const help=$('helpDialog');$('helpButton').addEventListener('click',()=>help.showModal());help.querySelector('.dialog-close').addEventListener('click',()=>help.close());help.addEventListener('click',e=>{if(e.target===help)help.close()});
  if (staticMode && 'serviceWorker' in navigator) {
    const hadServiceWorker = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadServiceWorker) showUpdateReady();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js', {updateViaCache: 'none'}).catch(error => {
        console.warn('[Sightline] offline app setup failed', error);
      });
    });
  }
  initScrubber();
  updateAnalysisModeUI();
  updateRadioFieldsState();
  updateRunButtonState();
  loadPresets().then(() => loadMeta().then(() => { updateAnalysisModeUI(); updateRadioFieldsState(); updateRunButtonState(); }));
})();
