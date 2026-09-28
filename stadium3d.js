/*
 * Stadium renderer for StadiumSync 3D — the real Jordan-Hare stadium and its
 * 24,778 per-seat LEDs, exported from the arenalighting Unity project
 * (see tools/README.md for the export pipeline).
 *
 * Classic (non-module) script — depends on the globals THREE, THREE.OrbitControls,
 * THREE.GLTFLoader and MeshoptDecoder from vendor/, loaded before this file.
 * Exposes window.Stadium3D.createStadium3D().
 *
 * Zone-level LED brightness/color math (computeDotBrightness/getDotColor)
 * is injected from index.html rather than reimplemented here, so the 3D view
 * and the rest of the app always agree on what a given pattern looks like.
 *
 * Venue assets (venue.model):
 *   glb      stadium mesh (meshopt-compressed, texture embedded)
 *   leds     leds.json — per-LED position + zone/row/col/section, zone grid sizes
 *   cameras  cameras.json — Unity fixed-camera presets, aerial + free-fly settings
 */
(function(){

  var OFF_RGB = [0.07, 0.08, 0.09];        // unlit LED
  var HIGHLIGHT_RGB = [0.32, 0.36, 0.40];  // unlit LED in the selected zone
  var LED_SIZE = 1.1;                      // × Unity's 0.125 radius, so seats still read from the aerial view

  // Shared across both instances (Designer + Preview): each asset URL is fetched/parsed once.
  var assetCache = {};
  function fetchJson(url){
    return fetch(url).then(function(r){
      if(!r.ok) throw new Error(url + ': HTTP ' + r.status);
      return r.json();
    });
  }
  function loadGltf(url){
    return new Promise(function(resolve, reject){
      var loader = new THREE.GLTFLoader();
      if(window.MeshoptDecoder) loader.setMeshoptDecoder(window.MeshoptDecoder);
      loader.load(url, resolve, undefined, reject);
    });
  }
  function loadVenueAssets(model){
    var key = model.glb + '|' + model.leds + '|' + model.cameras;
    if(!assetCache[key]){
      assetCache[key] = Promise.all([loadGltf(model.glb), fetchJson(model.leds), fetchJson(model.cameras)])
        .then(function(r){
          // Unity renders this project in Gamma color space; show the texture as authored.
          r[0].scene.traverse(function(o){
            if(o.isMesh && o.material && o.material.map){
              o.material.map.encoding = THREE.LinearEncoding;
              o.material.needsUpdate = true;
            }
          });
          return { gltf: r[0], leds: r[1], cameras: r[2] };
        });
    }
    return assetCache[key];
  }

  var hexCache = {};
  function hexToRgb(hex){
    var c = hexCache[hex];
    if(!c){
      var col = new THREE.Color(hex);
      c = hexCache[hex] = [col.r, col.g, col.b];
    }
    return c;
  }

  function isTypingTarget(el){
    if(!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function createStadium3D(canvas, opts){
    opts = opts || {};
    var computeDotBrightness = opts.computeDotBrightness || function(){ return 0.6; };
    var getDotColor = opts.getDotColor || function(){ return '#00f0ff'; };

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050a0a);
    scene.fog = new THREE.FogExp2(0x050a0a, 0.0035);

    // Unity camera: FOV 60, near 0.3, far 1000
    var camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(-40, 35, 25);

    // Bloom makes the LEDs read as light sources rather than colored beads; it plays the
    // role of the Unity project's URP Bloom volume. LED colors stay <= 1 so hues don't clip
    // (a boosted #2e6fff turns cyan), so the threshold sits above the night-lit stadium
    // texture but below a lit LED.
    var composer = null, bloomPass = null;
    if(window.THREE && THREE.EffectComposer && THREE.UnrealBloomPass){
      composer = new THREE.EffectComposer(renderer);
      composer.addPass(new THREE.RenderPass(scene, camera));
      bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(1, 1), 0.9, 0.35, 0.5);
      composer.addPass(bloomPass);
    }

    canvas.addEventListener('wheel', function(e){ e.preventDefault(); }, { passive: false });
    var controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 2;
    controls.maxDistance = 160;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.target.set(0, 4, -6.8);

    var hemiLight = new THREE.HemisphereLight(0x3d6a6d, 0x0a1414, 1.0);
    scene.add(hemiLight);
    var dirLight = new THREE.DirectionalLight(0xd9ecee, 0.6);
    dirLight.position.set(60, 120, 40);
    scene.add(dirLight);
    var ambient = new THREE.AmbientLight(0x2a3f40, 0.45);
    scene.add(ambient);

    var stadiumGroup = new THREE.Group();
    scene.add(stadiumGroup);

    // ---- LED state (filled by loadVenue) ----
    var led = null;          // leds.json
    var ledMesh = null;      // one InstancedMesh for every seat
    var ledCount = 0;
    var ledPos = null;       // Float32Array xyz
    var venueZoneOf = null;  // Int16Array: LED → venue.zoneData index (-1 = unmapped)
    var zones = [];          // index-aligned with venue.zoneData: {indices, cols, rows, col, row}
    var baseColors = null;   // Float32Array rgb written by setZoneFrame
    var overrideColors = null, overrideMask = null, ledGain = null;
    var highlighted = -1;
    var cameraData = null;
    var stadiumCenter = new THREE.Vector3(0, 0, -6.8);
    var loadToken = 0;

    var camPresetTarget = null; // {pos:Vector3, look:Vector3}
    var cameraMode = 'orbit';   // 'orbit' | 'aerial' | 'free'
    var autoOrbit = false;
    var onFrameHook = null;
    var clock = new THREE.Clock();
    var lastT = 0;

    var loadingEl = document.createElement('div');
    loadingEl.className = 'stadium3d-loading';
    loadingEl.textContent = 'Loading stadium…';
    if(canvas.parentElement) canvas.parentElement.appendChild(loadingEl);

    function clearVenue(){
      stadiumGroup.clear();
      if(ledMesh){
        scene.remove(ledMesh);
        ledMesh.geometry.dispose();
        ledMesh.material.dispose();
        ledMesh = null;
      }
      led = null; ledCount = 0; zones = [];
      overrideColors = overrideMask = ledGain = null;
    }

    function buildLedMesh(){
      var geo = new THREE.IcosahedronGeometry((led.ledRadius || 0.125) * LED_SIZE, 1);
      // MeshBasicMaterial's fragment shader in this three.js build only multiplies
      // diffuseColor by vColor when USE_COLOR is defined, and USE_COLOR only turns on
      // when the geometry itself has a per-vertex color attribute — USE_INSTANCING_COLOR
      // alone (from InstancedMesh.setColorAt) sets vColor in the vertex shader but the
      // fragment shader never reads it without USE_COLOR too. A flat white vertex-color
      // attribute costs nothing and makes per-instance tinting actually reach the pixel.
      var whiteColors = new Float32Array(geo.attributes.position.count * 3).fill(1);
      geo.setAttribute('color', new THREE.BufferAttribute(whiteColors, 3));
      var mat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
      var mesh = new THREE.InstancedMesh(geo, mat, ledCount);
      mesh.frustumCulled = false; // instances are spread far from the mesh's local origin
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(ledCount * 3), 3);
      var m = new THREE.Matrix4();
      for(var i = 0; i < ledCount; i++){
        m.makeTranslation(ledPos[i * 3], ledPos[i * 3 + 1], ledPos[i * 3 + 2]);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      return mesh;
    }

    // Returns a promise that resolves once the stadium + LEDs are in the scene.
    function loadVenue(venue){
      var token = ++loadToken;
      clearVenue();
      if(!venue || !venue.model){
        loadingEl.textContent = 'No 3D model for this venue';
        loadingEl.style.display = '';
        return Promise.resolve();
      }
      loadingEl.textContent = 'Loading stadium…';
      loadingEl.style.display = '';
      return loadVenueAssets(venue.model).then(function(a){
        if(token !== loadToken) return;
        stadiumGroup.add(a.gltf.scene.clone());
        led = a.leds;
        cameraData = a.cameras;
        ledCount = led.count;
        ledPos = new Float32Array(led.pos);
        baseColors = new Float32Array(ledCount * 3);
        for(var i = 0; i < ledCount; i++){
          baseColors[i * 3] = OFF_RGB[0]; baseColors[i * 3 + 1] = OFF_RGB[1]; baseColors[i * 3 + 2] = OFF_RGB[2];
        }

        // Match the venue's zones (the Designer layers) to the LED file's zones by name.
        var ledZoneToVenue = led.zones.map(function(lz){
          return venue.zoneData.findIndex(function(z){ return z.name === lz.name; });
        });
        venueZoneOf = new Int16Array(ledCount);
        var members = venue.zoneData.map(function(){ return []; });
        for(var j = 0; j < ledCount; j++){
          var vz = ledZoneToVenue[led.zone[j]];
          venueZoneOf[j] = vz;
          if(vz >= 0) members[vz].push(j);
        }
        zones = venue.zoneData.map(function(z, vi){
          var lz = led.zones[ledZoneToVenue.indexOf(vi)];
          var idx = Int32Array.from(members[vi]);
          var col = new Int16Array(idx.length), row = new Int16Array(idx.length);
          for(var k = 0; k < idx.length; k++){ col[k] = led.col[idx[k]]; row[k] = led.row[idx[k]]; }
          return { indices: idx, col: col, row: row, cols: lz ? lz.cols : 1, rows: lz ? lz.rows : 1 };
        });

        ledMesh = buildLedMesh();
        scene.add(ledMesh);
        stadiumCenter.set(led.center[0], led.center[1], led.center[2]);
        controls.target.set(led.center[0], led.center[1] + 4, led.center[2]);
        camera.position.set(led.center[0] - led.radius * 1.3, led.radius * 1.1, led.center[2] + led.radius * 1.2);
        loadingEl.style.display = 'none';
      }).catch(function(err){
        if(token !== loadToken) return;
        loadingEl.textContent = 'Could not load the stadium model (' + err.message + ')';
        console.error('[Stadium3D]', err);
      });
    }

    function setZoneFrame(index, pattern, t, on){
      var z = zones[index];
      if(!z) return;
      var lit = on && pattern;
      for(var k = 0; k < z.indices.length; k++){
        var o = z.indices[k] * 3;
        if(!lit){
          baseColors[o] = OFF_RGB[0]; baseColors[o + 1] = OFF_RGB[1]; baseColors[o + 2] = OFF_RGB[2];
          continue;
        }
        var col = z.col[k], row = z.row[k];
        var bright = computeDotBrightness(pattern, col, t, z.cols, row, z.rows);
        var rgb = hexToRgb(getDotColor(pattern, col, row, z.cols, z.rows));
        var boosted = 0.3 + bright * 0.7;
        baseColors[o] = rgb[0] * boosted; baseColors[o + 1] = rgb[1] * boosted; baseColors[o + 2] = rgb[2] * boosted;
      }
    }

    // Final LED color = (paint override if masked, else zone pattern) × music gain,
    // with unlit LEDs of the highlighted zone brightened so the selection is visible.
    function composeLedColors(){
      if(!ledMesh) return;
      var out = ledMesh.instanceColor.array;
      var hl = highlighted;
      for(var i = 0; i < ledCount; i++){
        var o = i * 3;
        var src = (overrideMask && overrideMask[i]) ? overrideColors : baseColors;
        var g = ledGain ? ledGain[i] : 1;
        var r = src[o] * g, gg = src[o + 1] * g, b = src[o + 2] * g;
        if(hl >= 0 && venueZoneOf[i] === hl){
          if(r < HIGHLIGHT_RGB[0]) r = HIGHLIGHT_RGB[0];
          if(gg < HIGHLIGHT_RGB[1]) gg = HIGHLIGHT_RGB[1];
          if(b < HIGHLIGHT_RGB[2]) b = HIGHLIGHT_RGB[2];
        }
        out[o] = r; out[o + 1] = gg; out[o + 2] = b;
      }
      ledMesh.instanceColor.needsUpdate = true;
    }

    function highlightZone(index){
      highlighted = (typeof index === 'number') ? index : -1;
    }

    // Per-seat paint layer: colors is Float32Array(count*3), mask is Uint8Array(count).
    function setLedOverride(colors, mask){
      overrideColors = colors || null;
      overrideMask = colors ? mask : null;
    }

    // Per-LED brightness multiplier (music-to-light). null = 1 everywhere.
    function setLedGain(gain){ ledGain = gain || null; }

    function getLedData(){
      if(!led) return null;
      return {
        count: ledCount, zone: venueZoneOf, row: led.row, col: led.col,
        section: led.section, rowId: led.rowId, sections: led.sections
      };
    }

    // ---- picking: manual ray/sphere test, far cheaper than InstancedMesh.raycast at 25k ----
    var raycaster = new THREE.Raycaster();
    var ndc = new THREE.Vector2();
    function pickLed(clientX, clientY){
      if(!ledMesh) return null;
      var rect = canvas.getBoundingClientRect();
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      var ro = raycaster.ray.origin, rd = raycaster.ray.direction;
      var best = -1, bestT = Infinity;
      // generous hit radius: seats are tiny at normal viewing distances
      var r = (led.ledRadius || 0.125) * LED_SIZE * 2.2, r2 = r * r;
      for(var i = 0; i < ledCount; i++){
        var ox = ledPos[i * 3] - ro.x, oy = ledPos[i * 3 + 1] - ro.y, oz = ledPos[i * 3 + 2] - ro.z;
        var tc = ox * rd.x + oy * rd.y + oz * rd.z;
        if(tc < 0 || tc >= bestT) continue;
        var d2 = ox * ox + oy * oy + oz * oz - tc * tc;
        if(d2 < r2){ bestT = tc; best = i; }
      }
      if(best < 0) return null;
      return { index: best, rowId: led.rowId[best], section: led.section[best], zone: venueZoneOf[best] };
    }

    // ---- cameras ----
    // Legacy preset names used by the Preview view before the Unity presets existed.
    var PRESET_ALIASES = { press: 'Default', field: 'Section 7 Low', student: 'Section 16 Low' };
    function getCameraPresets(){
      return cameraData ? cameraData.presets.map(function(p){ return p.name; }) : [];
    }
    function setCameraPreset(name){
      if(!cameraData) return;
      var want = PRESET_ALIASES[name] || name;
      var p = cameraData.presets.find(function(c){ return c.name === want; });
      if(!p) return;
      if(cameraMode !== 'orbit') setCameraMode('orbit');
      camPresetTarget = {
        pos: new THREE.Vector3(p.position[0], p.position[1], p.position[2]),
        look: new THREE.Vector3(p.target[0], p.target[1], p.target[2])
      };
    }

    var aerialYaw = 0;
    var flyYaw = 0, flyPitch = 0;
    var keys = {};
    function setCameraMode(mode){
      if(mode === 'fixed') mode = 'orbit';
      if(['orbit', 'aerial', 'free'].indexOf(mode) < 0) return;
      var prev = cameraMode;
      cameraMode = mode;
      camPresetTarget = null;
      controls.enabled = mode === 'orbit';
      if(mode === 'aerial'){
        // continue from the current azimuth so the switch doesn't jump
        var a = cameraData ? cameraData.aerial.target : [0, 0, -6.82];
        aerialYaw = Math.atan2(camera.position.x - a[0], camera.position.z - a[2]);
      } else if(mode === 'free'){
        var dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        flyYaw = Math.atan2(-dir.x, -dir.z);
        flyPitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
      } else if(prev !== 'orbit'){
        var fwd = new THREE.Vector3();
        camera.getWorldDirection(fwd);
        controls.target.copy(camera.position).addScaledVector(fwd, 20);
      }
    }

    function updateAerial(dt){
      var a = cameraData ? cameraData.aerial : { target: [0, 0, -6.82], distance: 56, pitchDeg: 45, yawDegPerSec: 3 };
      aerialYaw += THREE.MathUtils.degToRad(a.yawDegPerSec) * dt;
      var pitch = THREE.MathUtils.degToRad(a.pitchDeg);
      var desired = new THREE.Vector3(
        a.target[0] + Math.sin(aerialYaw) * Math.cos(pitch) * a.distance,
        a.target[1] + Math.sin(pitch) * a.distance,
        a.target[2] + Math.cos(aerialYaw) * Math.cos(pitch) * a.distance
      );
      camera.position.lerp(desired, Math.min(1, dt * 1.5));
      camera.lookAt(a.target[0], a.target[1], a.target[2]);
    }

    var flyVel = new THREE.Vector3();
    function updateFree(dt){
      var f = cameraData ? cameraData.free : { speed: 20, fastSpeed: 100 };
      var speed = keys.shift ? f.fastSpeed : f.speed;
      var fwd = new THREE.Vector3(-Math.sin(flyYaw) * Math.cos(flyPitch), Math.sin(flyPitch), -Math.cos(flyYaw) * Math.cos(flyPitch));
      var right = new THREE.Vector3(Math.cos(flyYaw), 0, -Math.sin(flyYaw));
      var want = new THREE.Vector3();
      if(keys.w) want.add(fwd);
      if(keys.s) want.sub(fwd);
      if(keys.d) want.add(right);
      if(keys.a) want.sub(right);
      if(keys.e) want.y += 1;
      if(keys.q) want.y -= 1;
      if(want.lengthSq() > 0) want.normalize().multiplyScalar(speed);
      flyVel.lerp(want, Math.min(1, dt * 6));
      camera.position.addScaledVector(flyVel, dt);
      camera.lookAt(camera.position.x + fwd.x, camera.position.y + fwd.y, camera.position.z + fwd.z);
    }

    function isVisible(){ return canvas.offsetParent !== null && canvas.clientWidth > 0; }

    function onKey(e, down){
      if(cameraMode !== 'free' || !isVisible() || isTypingTarget(e.target)) return;
      var k = e.key.toLowerCase();
      if(k === 'shift'){ keys.shift = down; return; }
      if('wasdqe'.indexOf(k) >= 0 && k.length === 1){ keys[k] = down; e.preventDefault(); }
    }
    function onKeyDown(e){ onKey(e, true); }
    function onKeyUp(e){ onKey(e, false); }
    function onBlur(){ keys = {}; }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    var dragging = null;
    canvas.addEventListener('pointerdown', function(e){
      if(cameraMode !== 'free' || e.button !== 0) return;
      dragging = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', function(e){
      if(!dragging) return;
      flyYaw -= (e.clientX - dragging.x) * 0.004;
      flyPitch = Math.max(-1.5, Math.min(1.5, flyPitch - (e.clientY - dragging.y) * 0.004));
      dragging.x = e.clientX; dragging.y = e.clientY;
    });
    canvas.addEventListener('pointerup', function(){ dragging = null; });
    canvas.addEventListener('pointercancel', function(){ dragging = null; });

    function setAutoOrbit(on){
      autoOrbit = !!on;
      controls.autoRotate = autoOrbit;
      controls.autoRotateSpeed = 1.1;
    }

    var TOD_STOPS = [
      { max: 34, sky: 0x3a6a70, ground: 0x0d2020, dir: 1.1 },
      { max: 67, sky: 0x2a4a4d, ground: 0x080f0f, dir: 0.6 },
      { max: 101, sky: 0x1a3a3d, ground: 0x050a0a, dir: 0.35 }
    ];
    function setTimeOfDay(v){
      var stop = TOD_STOPS.find(function(s){ return v < s.max; }) || TOD_STOPS[TOD_STOPS.length - 1];
      hemiLight.color.setHex(stop.sky);
      hemiLight.groundColor.setHex(stop.ground);
      dirLight.intensity = stop.dir;
      scene.background.setHex(stop.ground);
      scene.fog.color.setHex(stop.ground);
    }

    function setFogDensity(v){
      scene.fog.density = (v / 100) * 0.018;
    }

    function onResize(){
      var w = canvas.clientWidth || canvas.parentElement.clientWidth || 1;
      var h = canvas.clientHeight || canvas.parentElement.clientHeight || 1;
      if(w < 2 || h < 2) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if(composer) composer.setSize(w, h);
    }

    var rafId = null;
    function tick(){
      rafId = window.requestAnimationFrame(tick);
      var t = clock.getElapsedTime();
      var dt = Math.min(0.1, t - lastT);
      lastT = t;
      if(!isVisible()) return; // the other view's canvas is hidden — don't spend GPU on it
      if(onFrameHook) onFrameHook(t);
      composeLedColors();
      if(cameraMode === 'aerial') updateAerial(dt);
      else if(cameraMode === 'free') updateFree(dt);
      else {
        if(camPresetTarget){
          camera.position.lerp(camPresetTarget.pos, 0.06);
          controls.target.lerp(camPresetTarget.look, 0.06);
          if(camera.position.distanceTo(camPresetTarget.pos) < 0.05) camPresetTarget = null;
        }
        controls.update();
      }
      if(composer) composer.render();
      else renderer.render(scene, camera);
    }
    tick();

    return {
      loadVenue: loadVenue,
      setZoneFrame: setZoneFrame,
      highlightZone: highlightZone,
      setLedOverride: setLedOverride,
      setLedGain: setLedGain,
      getLedData: getLedData,
      pickLed: pickLed,
      getCameraPresets: getCameraPresets,
      setCameraPreset: setCameraPreset,
      setCameraMode: setCameraMode,
      get cameraMode(){ return cameraMode; },
      setAutoOrbit: setAutoOrbit,
      setTimeOfDay: setTimeOfDay,
      setFogDensity: setFogDensity,
      onResize: onResize,
      set onFrame(fn){ onFrameHook = fn; },
      get onFrame(){ return onFrameHook; },
      dispose: function(){
        if(rafId) window.cancelAnimationFrame(rafId);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('blur', onBlur);
        clearVenue();
        if(loadingEl.parentElement) loadingEl.parentElement.removeChild(loadingEl);
        renderer.dispose();
      }
    };
  }

  window.Stadium3D = { createStadium3D: createStadium3D };
})();
