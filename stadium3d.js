/*
 * Procedural placeholder stadium renderer for StadiumSync 3D.
 * Classic (non-module) script — depends on the globals THREE and
 * THREE.OrbitControls from vendor/three.min.js + vendor/OrbitControls.js,
 * loaded before this file. Exposes window.Stadium3D.createStadium3D().
 *
 * Zone-level LED brightness/color math (computeDotBrightness/getDotColor)
 * is injected from app.js rather than reimplemented here, so the 3D view
 * and the rest of the app always agree on what a given pattern looks like.
 */
(function(){

  // Proportions measured from the real Jordan-Hare model's own LED section
  // placements (arenalighting-fall2026's Assets/Prefabs/LEDs.prefab — 84 real
  // Section-prefab instances grouped under Lower Deck / Upper Deck / Top Deck
  // parents), plus a sourced real-world rake figure: Jordan-Hare's upper deck
  // is built at ~28° (engineering estimate, close to the 30° sports-ergonomics
  // "sweet spot"). Radii/radial depth per tier come from the LEDs.prefab data
  // (lower/upper decks average radius ~18.5/~18.3 — cantilevered close rather
  // than stepped far back; press/suite level pulled inward and narrow); each
  // tier's height is then set from ITS OWN radial depth (rOuter-rInner) so the
  // rake works out to a real ~25-28° for every tier, not just the upper deck.
  var TIERS = [
    { rInner: 30, rOuter: 46, yBase: 0,  height: 7.5  }, // lower bowl — rake ~25°
    { rInner: 47, rOuter: 62, yBase: 8,  height: 8    }, // upper deck — rake ~28° (sourced, real)
    { rInner: 44, rOuter: 52, yBase: 11, height: 4.25 }  // press / suites / club level — rake ~28°, nested within the upper deck's own height range
  ];
  var ZONE_GAP = 0.05; // radians between adjacent zone segments in the same tier

  function classifyTier(name){
    var n = name.toLowerCase();
    if(/press|suite|club/.test(n)) return 2;
    if(/upper/.test(n)) return 1;
    return 0;
  }

  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t){ return a + (b - a) * t; }

  function parseCapacity(str){
    var n = parseInt(String(str).replace(/[^0-9]/g,''), 10);
    return isFinite(n) && n > 0 ? n : 40000;
  }

  function zoneSlug(name){
    return name.toLowerCase().replace(/[()]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
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

    var camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
    camera.position.set(70, 55, 110);

    // Bloom makes the LED bands read as actual light sources instead of flat-colored
    // boxes — without it, correctly-lit LEDs are nearly imperceptible from a normal
    // viewing distance against the dark "night game" background.
    var composer = null, bloomPass = null;
    if(window.THREE && THREE.EffectComposer && THREE.UnrealBloomPass){
      composer = new THREE.EffectComposer(renderer);
      composer.addPass(new THREE.RenderPass(scene, camera));
      bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(1, 1), 1.6, 0.5, 1.0);
      composer.addPass(bloomPass);
    }

    canvas.addEventListener('wheel', function(e){ e.preventDefault(); }, { passive: false });
    var controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 20;
    controls.maxDistance = 320;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.target.set(0, 8, 0);

    var hemiLight = new THREE.HemisphereLight(0x3d6a6d, 0x0a1414, 1.0);
    scene.add(hemiLight);
    var dirLight = new THREE.DirectionalLight(0xd9ecee, 0.6);
    dirLight.position.set(60, 120, 40);
    scene.add(dirLight);
    var ambient = new THREE.AmbientLight(0x2a3f40, 0.45);
    scene.add(ambient);

    var bowlGroup = new THREE.Group();
    scene.add(bowlGroup);
    var fieldGroup = new THREE.Group();
    scene.add(fieldGroup);

    var zones = []; // index-aligned with venue.zoneData
    var overallScale = 1;
    var bowlRadius = 60;

    var camPresetTarget = null; // {pos:Vector3, look:Vector3}
    var autoOrbit = false;
    var onFrameHook = null;
    var clock = new THREE.Clock();
    var scratchColor = new THREE.Color();

    function disposeGroup(g){
      g.traverse(function(obj){
        if(obj.geometry) obj.geometry.dispose();
        if(obj.material){
          if(Array.isArray(obj.material)) obj.material.forEach(function(m){ m.dispose(); });
          else obj.material.dispose();
        }
      });
      while(g.children.length) g.remove(g.children[0]);
    }

    function buildLedInstances(count){
      var geo = new THREE.BoxGeometry(2.2, 2, 2.2); // cube, not a thin slab, so it reads bright from directly overhead too
      // MeshBasicMaterial's fragment shader in this three.js build only multiplies
      // diffuseColor by vColor when USE_COLOR is defined, and USE_COLOR only turns on
      // when the geometry itself has a per-vertex color attribute — USE_INSTANCING_COLOR
      // alone (from InstancedMesh.setColorAt) sets vColor in the vertex shader but the
      // fragment shader never reads it without USE_COLOR too. A flat white vertex-color
      // attribute costs nothing and makes per-instance tinting actually reach the pixel.
      var whiteColors = new Float32Array(geo.attributes.position.count * 3).fill(1);
      geo.setAttribute('color', new THREE.BufferAttribute(whiteColors, 3));
      var mat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
      var mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.frustumCulled = false; // instances are spread far from the mesh's local origin
      var initColor = new THREE.Color(0x1c2429);
      for(var ci = 0; ci < count; ci++) mesh.setColorAt(ci, initColor); // lets three.js allocate instanceColor itself
      return mesh;
    }

    // A small tileable canvas texture of horizontal row lines, so the raked
    // deck reads as tiered seating rows (like real stadium-bowl photos)
    // instead of a single smooth ramp. Rendered once and reused everywhere;
    // callers clone() it so each zone can set its own independent .repeat.
    var rowTextureBase = null;
    function getBaseRowTexture(){
      if(rowTextureBase) return rowTextureBase;
      var canvas = document.createElement('canvas');
      canvas.width = 4; canvas.height = 64;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 4, 64);
      var rows = 12;
      for(var i = 0; i < rows; i++){
        var y = Math.round((i / rows) * 64);
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(0, y, 4, 2);
      }
      rowTextureBase = new THREE.CanvasTexture(canvas);
      rowTextureBase.wrapS = THREE.RepeatWrapping;
      rowTextureBase.wrapT = THREE.RepeatWrapping;
      return rowTextureBase;
    }
    function getRowTexture(arcLength, height){
      var tex = getBaseRowTexture().clone();
      tex.needsUpdate = true;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(Math.max(1, Math.round(arcLength / 6)), Math.max(1, Math.round(height / 2.5)));
      return tex;
    }

    function buildZoneSegment(tier, thetaStart, thetaLength){
      var group = new THREE.Group();

      // Real stadium sections are raked, not vertical: the seating deck tilts
      // back from the low front row (near the field, at rInner) up to the high
      // back row (at rOuter) — that slope is what makes a section read as a
      // solid angled slab instead of a flat curtain when viewed from the
      // elevated angles this app mostly uses. CylinderGeometry's two radius
      // params model exactly that rake when they differ: radiusTop (rOuter,
      // the far/high edge) vs radiusBottom (rInner, the near/low edge) — a
      // plain cone-frustum lateral surface is a raked grandstand slice.
      var deckGeo = new THREE.CylinderGeometry(
        tier.rOuter, tier.rInner, tier.height, 40, 8, true, thetaStart, thetaLength
      );
      var deckMat = new THREE.MeshStandardMaterial({
        color: 0x3a4048, side: THREE.DoubleSide, roughness: 0.92, metalness: 0.04,
        map: getRowTexture(thetaLength * ((tier.rInner + tier.rOuter) / 2), tier.height)
      });
      var deckMesh = new THREE.Mesh(deckGeo, deckMat);
      deckMesh.position.y = tier.yBase + tier.height / 2;
      group.add(deckMesh);

      // Every seat in a real section carries its own wristband LED, so the
      // whole raked face lights up, not just a strip along the top rail.
      // Cover the surface with a full (cols x rows) grid of instances instead
      // of a single row: cols runs along the arc (as before), rows steps
      // front-to-back following the same rake the deck geometry uses, so a
      // "wave" sweeping by column lights up a full radial band at once —
      // which is also how a real stadium-wide wave actually reads.
      var arcLength = thetaLength * ((tier.rInner + tier.rOuter) / 2);
      var cols = clamp(Math.round(arcLength / 1.4), 12, 90);
      var rows = clamp(Math.round(tier.height / 1.8), 3, 6);
      var ledCount = cols * rows;
      var ledMesh = buildLedInstances(ledCount);
      var dummy = new THREE.Object3D();
      var pad = Math.min(ZONE_GAP, thetaLength * 0.1);
      var usableTheta = Math.max(0.001, thetaLength - pad * 2);
      var edgeInset = (tier.rOuter - tier.rInner) * 0.1; // keep the grid off the very front/back edges
      for(var row = 0; row < rows; row++){
        var rt = rows === 1 ? 0.5 : row / (rows - 1);
        var rowR = lerp(tier.rInner + edgeInset, tier.rOuter - edgeInset, rt);
        var rowY = tier.yBase + rt * tier.height;
        // Nudge outward along the rake's own normal so LEDs sit just proud of
        // the deck surface instead of clipping into it.
        var outR = rowR + 1.3;
        var outY = rowY + 0.7;
        for(var col = 0; col < cols; col++){
          var ct = cols === 1 ? 0.5 : col / (cols - 1);
          var a = thetaStart + pad + ct * usableTheta;
          var x = Math.sin(a) * outR;
          var z = Math.cos(a) * outR;
          var idx = row * cols + col;
          dummy.position.set(x, outY, z);
          dummy.lookAt(0, outY, 0);
          dummy.updateMatrix();
          ledMesh.setMatrixAt(idx, dummy.matrix);
          ledMesh.setColorAt(idx, scratchColor.set(0x222222));
        }
      }
      ledMesh.instanceMatrix.needsUpdate = true;
      ledMesh.instanceColor.needsUpdate = true;
      group.add(ledMesh);

      return { group: group, deckMesh: deckMesh, ledMesh: ledMesh, ledCount: ledCount, ledCols: cols, ledRows: rows };
    }

    function buildField(isArena, palette, innerRadius){
      var w = innerRadius * (isArena ? 0.85 : 1.3);
      var d = innerRadius * (isArena ? 0.55 : 0.58);
      var baseColor = isArena ? 0x3d2a14 : 0x1b3a1f;
      var lineColor = isArena ? 0x6b4a24 : 0x3f6b45;

      var plane = new THREE.Mesh(
        new THREE.PlaneGeometry(w, d),
        new THREE.MeshStandardMaterial({ color: baseColor, roughness: 1 })
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.y = 0.02;
      fieldGroup.add(plane);

      var border = new THREE.Mesh(
        new THREE.RingGeometry(0, 1, 4), // placeholder, replaced below by edges
        new THREE.MeshBasicMaterial({ visible: false })
      );
      fieldGroup.add(border);

      var edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, d)),
        new THREE.LineBasicMaterial({ color: lineColor })
      );
      edges.rotation.x = -Math.PI / 2;
      edges.position.y = 0.03;
      fieldGroup.add(edges);

      if(!isArena && palette){
        var stripeW = w * 0.09;
        [ -1, 1 ].forEach(function(side){
          var stripe = new THREE.Mesh(
            new THREE.PlaneGeometry(stripeW, d),
            new THREE.MeshStandardMaterial({
              color: side < 0 ? palette.primary : palette.secondary, roughness: 1
            })
          );
          stripe.rotation.x = -Math.PI / 2;
          stripe.position.set(side * (w / 2 - stripeW / 2), 0.025, 0);
          fieldGroup.add(stripe);
        });
      } else if(isArena){
        var circle = new THREE.Mesh(
          new THREE.RingGeometry(innerRadius * 0.14, innerRadius * 0.155, 48),
          new THREE.MeshBasicMaterial({ color: lineColor, side: THREE.DoubleSide })
        );
        circle.rotation.x = -Math.PI / 2;
        circle.position.y = 0.03;
        fieldGroup.add(circle);
      }
    }

    function loadVenue(venue, palette){
      disposeGroup(bowlGroup);
      disposeGroup(fieldGroup);
      zones = [];

      var isArena = /arena/i.test(venue.name);
      var capacity = parseCapacity(venue.capacity);
      overallScale = clamp(Math.sqrt(capacity / 90000), 0.55, 1.15);
      // Football bowls are only mildly elongated — corrected down from an earlier
      // 1.85:1 guess that came from FixedCameraControlData.json's camera vantage
      // points (dramatic broadcast framing, not literal bowl edges). The real
      // section geometry in LEDs.prefab tells a different story: Lower Deck's
      // straight sideline sections average radius ~18.5 with the bowl's own x/z
      // footprint spans landing around 1.1-1.3:1, not 1.85:1 — real college
      // football bowls wrap fairly close to round, with the field itself (not
      // the stands) carrying most of the elongation. Arena bowls (Neville) stay
      // rounder still.
      var ellipseX = isArena ? 1.08 : 1.25;

      var byTier = [[], [], []];
      venue.zoneData.forEach(function(z, i){ byTier[classifyTier(z.name)].push(i); });

      // Places `indexList`'s zones as equal-width segments filling the arc
      // [arcStart, arcStart+arcSpan) on the given tier. Shared by the default
      // full-ring layout and the two-arc upper-deck layout below.
      function placeZonesInArc(indexList, tier, arcStart, arcSpan){
        var count = indexList.length;
        if(count === 0) return;
        var thetaLength = (arcSpan - ZONE_GAP * count) / count;
        var thetaStart = arcStart;
        indexList.forEach(function(zoneIdx){
          var z = venue.zoneData[zoneIdx];
          var seg = buildZoneSegment(tier, thetaStart, thetaLength);
          bowlGroup.add(seg.group);
          zones[zoneIdx] = {
            slug: zoneSlug(z.name),
            group: seg.group,
            deckMesh: seg.deckMesh,
            ledMesh: seg.ledMesh,
            ledCount: seg.ledCount,
            ledCols: seg.ledCols,
            ledRows: seg.ledRows
          };
          thetaStart += thetaLength + ZONE_GAP;
        });
      }

      byTier.forEach(function(indexList, tierIdx){
        if(indexList.length === 0) return;
        var tier = TIERS[tierIdx];

        // Real college football upper decks run along the two sidelines only —
        // they do not wrap the end zones or corners (Wikipedia: the west and
        // east upper decks were built as separate structures in 1980/1987;
        // collegegridirons.com: "the lower bowl completely surrounds the
        // playing field, while upper decks are located along both sidelines";
        // RateYourSeats' real section numbering confirms two 16-section runs,
        // one per sideline; the real Jordan-Hare LED section placements mined
        // from arenalighting-fall2026's LEDs.prefab show the same two-band
        // shape). Arenas (Neville) keep a real full-circle upper ring.
        if(tierIdx === 1 && !isArena){
          var eastGroup = [], westGroup = [];
          indexList.forEach(function(zoneIdx){
            var nm = venue.zoneData[zoneIdx].name.toLowerCase();
            if(/west|south/.test(nm)) westGroup.push(zoneIdx);
            else eastGroup.push(zoneIdx); // east/north (and anything unmatched) share the east sideline arc
          });
          var ARC_SPAN = Math.PI * 0.38; // ~38% of the circle per sideline — leaves the end-zone quadrants empty
          placeZonesInArc(eastGroup, tier, 0 - ARC_SPAN / 2, ARC_SPAN);
          placeZonesInArc(westGroup, tier, Math.PI - ARC_SPAN / 2, ARC_SPAN);
          return;
        }

        placeZonesInArc(indexList, tier, -Math.PI / 2, Math.PI * 2);
      });

      bowlGroup.scale.set(ellipseX * overallScale, overallScale, 1 * overallScale);
      fieldGroup.scale.set(overallScale, overallScale, overallScale);

      buildField(isArena, palette, TIERS[0].rInner * ellipseX);

      bowlRadius = TIERS[2].rOuter * overallScale;
      controls.target.set(0, 9 * overallScale, 0);
      camera.position.set(bowlRadius * 1.1, bowlRadius * 0.85, bowlRadius * 1.5);
    }

    function setZoneFrame(index, pattern, t, on){
      var z = zones[index];
      if(!z) return;
      var mesh = z.ledMesh;
      var cols = z.ledCols, rows = z.ledRows;
      for(var row = 0; row < rows; row++){
        for(var col = 0; col < cols; col++){
          var i = row * cols + col;
          var bright, hex;
          if(!on || !pattern){
            bright = 1;
            hex = '#1c2429';
          } else {
            bright = computeDotBrightness(pattern, col, t, cols, row, rows);
            hex = getDotColor(pattern, col, row, cols, rows);
          }
          var boosted = (!on || !pattern) ? bright : (0.55 + bright * 0.45) * 3.4;
          scratchColor.set(hex).multiplyScalar(boosted);
          mesh.setColorAt(i, scratchColor);
        }
      }
      mesh.instanceColor.needsUpdate = true;
    }

    function highlightZone(index){
      zones.forEach(function(z, i){
        if(!z) return;
        z.deckMesh.material.color.setHex(i === index ? 0x565f6a : 0x3a4048);
      });
    }

    var CAM_PRESETS = {
      press:   function(r){ return { pos: [r * 0.55, r * 0.42, r * 0.55], look: [0, r * 0.18, 0] }; },
      field:   function(r){ return { pos: [0, r * 0.10, r * 1.05],  look: [0, r * 0.10, 0] }; },
      student: function(r){ return { pos: [r * 0.75, r * 0.22, r * 0.75], look: [0, r * 0.14, 0] }; }
    };
    function setCameraPreset(name){
      var f = CAM_PRESETS[name];
      if(!f) return;
      var p = f(bowlRadius);
      camPresetTarget = { pos: new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]), look: new THREE.Vector3(p.look[0], p.look[1], p.look[2]) };
    }

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
      if(onFrameHook) onFrameHook(t);
      if(camPresetTarget){
        camera.position.lerp(camPresetTarget.pos, 0.06);
        controls.target.lerp(camPresetTarget.look, 0.06);
        if(camera.position.distanceTo(camPresetTarget.pos) < 0.05) camPresetTarget = null;
      }
      controls.update();
      if(composer) composer.render();
      else renderer.render(scene, camera);
    }
    tick();

    return {
      loadVenue: loadVenue,
      setZoneFrame: setZoneFrame,
      highlightZone: highlightZone,
      setCameraPreset: setCameraPreset,
      setAutoOrbit: setAutoOrbit,
      setTimeOfDay: setTimeOfDay,
      setFogDensity: setFogDensity,
      onResize: onResize,
      set onFrame(fn){ onFrameHook = fn; },
      get onFrame(){ return onFrameHook; },
      dispose: function(){
        if(rafId) window.cancelAnimationFrame(rafId);
        disposeGroup(bowlGroup);
        disposeGroup(fieldGroup);
        renderer.dispose();
      }
    };
  }

  window.Stadium3D = { createStadium3D: createStadium3D };
})();
