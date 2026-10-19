// Rendering. Draws the world from a snapshot array (see layout() in sim.js); has no physics of its own.
import * as THREE from 'three';
import { levelById, ROPE_SEGMENTS, VIEW_DIST, VIEW_HALF_ANGLE, LASER_HEIGHT, layout } from './sim.js';
import { EMOTES, colorCss, colorHex } from './profile.js';

const flat = (color) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9 });

const EMOTE_SECONDS = 2.5;

/** Draws a crate: a plain box, or for the treasures a box with a few extra bits so you can tell them apart. */
function makeCrateMesh(c) {
  const [dx, dy, dz] = c.s != null ? [c.s, c.s, c.s] : [c.sx, c.sy, c.sz];
  const m = new THREE.Mesh(new THREE.BoxGeometry(dx, dy, dz), flat(c.color));
  m.castShadow = m.receiveShadow = true;
  const add = (geo, color, x, y, z) => {
    const part = new THREE.Mesh(geo, flat(color));
    part.position.set(x, y, z);
    part.castShadow = true;
    m.add(part);
    return part;
  };
  if (c.kind === 'safe') {
    add(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 16), 0x6b5300, 0, 0.1, dz / 2 + 0.03).rotation.x = Math.PI / 2; // the dial
  } else if (c.kind === 'painting') {
    add(new THREE.BoxGeometry(dx * 0.82, 0.04, dz * 0.78), 0xf4d35e, 0, dy / 2 + 0.01, 0); // the canvas
    add(new THREE.BoxGeometry(dx * 0.4, 0.05, dz * 0.4), 0xee6c4d, -dx * 0.12, dy / 2 + 0.03, 0.05);
  } else if (c.kind === 'clock') {
    add(new THREE.CylinderGeometry(0.26, 0.26, 0.06, 20), 0xfff3d6, 0, dy * 0.28, dz / 2 + 0.02).rotation.x = Math.PI / 2; // the face
    add(new THREE.BoxGeometry(0.07, 0.5, 0.05), 0xd4af37, 0, -dy * 0.2, dz / 2 + 0.02); // the pendulum
  } else if (c.kind === 'pig') {
    add(new THREE.BoxGeometry(0.28, 0.24, 0.16), 0xf08fa6, 0, 0.02, dz / 2 + 0.07); // snout
    add(new THREE.BoxGeometry(0.14, 0.16, 0.08), 0xe27a95, -0.18, dy / 2 + 0.05, dz / 2 - 0.12); // ears
    add(new THREE.BoxGeometry(0.14, 0.16, 0.08), 0xe27a95, 0.18, dy / 2 + 0.05, dz / 2 - 0.12);
    add(new THREE.BoxGeometry(0.06, 0.06, 0.18), 0xe27a95, 0, 0.08, -dz / 2 - 0.08); // tail
  }
  return m;
}

/** A name on a rounded dark plate with a border in the player's colour. Drawn through the canvas, so names are never parsed as HTML. */
function makeNametag(name, color) {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 80;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(15, 17, 26, 0.78)';
  g.strokeStyle = color;
  g.lineWidth = 6;
  g.beginPath();
  g.roundRect(5, 5, 310, 70, 24);
  g.fill();
  g.stroke();
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 40;
  g.font = `bold ${size}px system-ui, sans-serif`;
  while (g.measureText(name).width > 280 && size > 16) { size -= 2; g.font = `bold ${size}px system-ui, sans-serif`; }
  g.fillText(name, 160, 42);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(2.4, 0.6, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/** One speech bubble per emote, made once and reused. */
function makeEmoteTextures() {
  return EMOTES.map((emoji) => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(255, 255, 255, 0.94)';
    g.beginPath();
    g.arc(64, 60, 54, 0, Math.PI * 2);
    g.fill();
    g.font = '70px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(emoji, 64, 66);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

/** profiles: [{ name, color }] per player, color is an index into PALETTE. */
export function createView(n, localIndex = -1, profiles = [], levelId = 0) {
  const lv = levelById(levelId);
  const L = layout(n, levelId);
  const profile = (i) => profiles[i] ?? { name: `Player ${i + 1}`, color: i };

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1d29);
  scene.fog = new THREE.Fog(0x1a1d29, 40, 110);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 200);

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x30263a, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(10, 30, 4);
  sun.target.position.set(0, 0, -6);
  scene.add(sun.target);
  sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, far: 80 });
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // level
  for (const s of lv.statics) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(s.h[0] * 2, s.h[1] * 2, s.h[2] * 2), flat(s.color));
    m.position.set(...s.p);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  // the getaway zone: the safe has to end up in here
  const ex = lv.exit;
  const exitMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(ex.hx * 2, ex.hz * 2),
    new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.22, depthWrite: false }),
  );
  exitMesh.rotation.x = -Math.PI / 2;
  exitMesh.position.set(ex.x, 0.03, ex.z);
  scene.add(exitMesh);

  const crateMeshes = lv.crates.map((c) => {
    const m = makeCrateMesh(c);
    scene.add(m);
    return m;
  });

  // laser beams: a glowing red slab that is only there while the beam is on
  const laserMeshes = lv.lasers.map((La) => {
    const dx = La.b[0] - La.a[0], dz = La.b[1] - La.a[1], len = Math.hypot(dx, dz);
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.8, depthWrite: false });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.12, LASER_HEIGHT, len), mat);
    beam.position.y = LASER_HEIGHT / 2;
    g.add(beam);
    for (const sign of [-1, 1]) { // the two emitters
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 1.1, 10), flat(0x2b2d3a));
      post.position.set(0, 0.55, sign * (len / 2 + 0.1));
      post.castShadow = true;
      g.add(post);
    }
    g.position.set((La.a[0] + La.b[0]) / 2, 0, (La.a[1] + La.b[1]) / 2);
    g.rotation.y = Math.atan2(dx, dz);
    scene.add(g);
    return { beam, mat };
  });

  // players
  const playerMeshes = [];
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.7, 4, 12), flat(colorHex(profile(i).color)));
    m.castShadow = true;
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.3), flat(0xffffff)); // shows facing
    nose.position.set(0, 0.25, 0.42);
    m.add(nose);
    scene.add(m);
    playerMeshes.push(m);
  }

  // guards: a body plus a flat cone on the floor showing what they can see
  const guardMeshes = Array.from({ length: L.guards }, () => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.7, 4, 12), flat(0x8b2e3c));
    body.castShadow = true;
    const hat = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.15, 0.9), flat(0x1c1c28));
    hat.position.y = 0.62;
    body.add(hat);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.3), flat(0xffffff));
    nose.position.set(0, 0.25, 0.42);
    body.add(nose);
    g.add(body);
    const coneMat = new THREE.MeshBasicMaterial({ color: 0xfff3a0, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false });
    const cone = new THREE.Mesh(new THREE.CircleGeometry(VIEW_DIST, 28, Math.PI / 2 - VIEW_HALF_ANGLE, VIEW_HALF_ANGLE * 2), coneMat);
    cone.rotation.x = Math.PI / 2; // lay it flat; the sector points along +z
    cone.position.y = -0.7;
    g.add(cone);
    g.userData = { body, coneMat };
    scene.add(g);
    return g;
  });

  // nametags and emote bubbles float above everyone's head
  const nametags = Array.from({ length: n }, (_, i) => {
    const t = makeNametag(profile(i).name, colorCss(profile(i).color));
    scene.add(t);
    return t;
  });
  const emoteTextures = makeEmoteTextures();
  const emoteSprites = Array.from({ length: n }, () => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: emoteTextures[0], transparent: true, depthTest: false }));
    s.scale.set(1.1, 1.1, 1);
    s.renderOrder = 11;
    s.visible = false;
    scene.add(s);
    return s;
  });
  const emoteUntil = new Array(n).fill(0);

  // arrow above your own head so you can find yourself in the pile
  const marker = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.4, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  marker.rotation.x = Math.PI;
  marker.visible = localIndex >= 0;
  scene.add(marker);

  // ropes: one tube per rope, rebuilt every frame from the segment positions
  const ropeMeshes = Array.from({ length: L.ropes }, () => {
    const mat = new THREE.MeshStandardMaterial({ color: 0xe8d9a8, roughness: 1, emissive: 0xffffff, emissiveIntensity: 0 });
    const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    m.castShadow = true;
    m.frustumCulled = false;
    scene.add(m);
    return m;
  });
  // a knot where the rope is tied to a pillar
  const knotMaterial = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 1 });
  const knots = Array.from({ length: L.ropes }, () => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), knotMaterial);
    m.castShadow = true;
    m.visible = false;
    scene.add(m);
    return m;
  });

  const playerPos = Array.from({ length: n }, () => new THREE.Vector3());

  /** Pop an emote bubble over a player. `now` is performance.now() in ms. */
  function showEmote(i, emoteId, now = performance.now()) {
    if (i < 0 || i >= n || !emoteTextures[emoteId]) return;
    emoteSprites[i].material.map = emoteTextures[emoteId];
    emoteUntil[i] = now + EMOTE_SECONDS * 1000;
  }

  function apply(d) {
    for (let i = 0; i < n; i++) {
      const o = L.pOff + i * 4;
      playerMeshes[i].position.set(d[o], d[o + 1], d[o + 2]);
      playerMeshes[i].rotation.y = d[o + 3];
      playerPos[i].set(d[o], d[o + 1], d[o + 2]);
    }
    for (let r = 0; r < L.ropes; r++) {
      const pts = [playerPos[r]];
      for (let i = 0; i < ROPE_SEGMENTS; i++) {
        const o = L.rOff + (r * ROPE_SEGMENTS + i) * 3;
        pts.push(new THREE.Vector3(d[o], d[o + 1], d[o + 2]));
      }
      pts.push(playerPos[r + 1]);
      const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), ROPE_SEGMENTS * 3, 0.07, 6, false);
      ropeMeshes[r].geometry.dispose();
      ropeMeshes[r].geometry = geo;
    }
    for (let i = 0; i < L.crates; i++) {
      const o = L.cOff + i * 7;
      crateMeshes[i].position.set(d[o], d[o + 1], d[o + 2]);
      crateMeshes[i].quaternion.set(d[o + 3], d[o + 4], d[o + 5], d[o + 6]).normalize();
      crateMeshes[i].material.emissive.setHex(d[L.hOff + i] > 0 ? 0x66561a : 0x000000); // glow while held
    }
    for (let i = 0; i < L.guards; i++) {
      const o = L.gOff + i * 5, g = guardMeshes[i], mode = d[o + 4];
      g.position.set(d[o], d[o + 1], d[o + 2]);
      g.rotation.y = d[o + 3];
      g.userData.coneMat.color.setHex(mode === 2 ? 0xff4d4d : 0xfff3a0); // red while chasing
      g.userData.coneMat.opacity = mode === 2 ? 0.3 : 0.2;
    }
    for (let i = 0; i < L.lasers; i++) {
      const on = d[L.lOff + i * 2] === 1, tripped = d[L.lOff + i * 2 + 1] === 1;
      laserMeshes[i].beam.visible = on;
      laserMeshes[i].mat.color.setHex(tripped ? 0xffffff : 0xff2a2a); // a tripped beam flashes white
    }
    for (let r = 0; r < L.ropes; r++) {
      const k = d[L.kOff + r];
      knots[r].visible = k >= 0;
      if (k >= 0) {
        const o = L.rOff + (r * ROPE_SEGMENTS + k) * 3;
        knots[r].position.set(d[o], d[o + 1], d[o + 2]);
      }
    }
  }

  let zoom = 1;
  const setZoom = (z) => { zoom = z; };
  const camTarget = new THREE.Vector3();
  const camGoal = new THREE.Vector3();
  const camPos = new THREE.Vector3(0, 10, 18);

  function render(dt, now) {
    // camera frames everyone, pulling back as the group spreads out
    camTarget.set(0, 0, 0);
    for (const p of playerPos) camTarget.add(p);
    camTarget.divideScalar(n);
    let spread = 0;
    for (const p of playerPos) spread = Math.max(spread, Math.hypot(p.x - camTarget.x, p.z - camTarget.z));
    camTarget.y = 1;
    // steeper than before so low walls in front of the crew don't hide them; `zoom` < 1 pulls the camera in (used by the replay)
    camGoal.set(camTarget.x, (8.5 + spread * 1.2) * zoom, camTarget.z + (7.5 + spread * 1.8) * zoom);
    camPos.lerp(camGoal, 1 - Math.exp(-Math.min(Math.max(dt, 0), 0.25) * 4)); // frame-rate independent smoothing; a bad time step can't throw the camera away
    camera.position.copy(camPos);
    camera.lookAt(camTarget);

    for (let i = 0; i < n; i++) {
      const p = playerPos[i];
      nametags[i].position.set(p.x, p.y + 1.3, p.z);
      const left = emoteUntil[i] - now;
      const s = emoteSprites[i];
      s.visible = left > 0;
      if (s.visible) {
        const pop = Math.min(1, Math.max(0, (EMOTE_SECONDS * 1000 - left) / 150)); // quick pop-in, never outside 0..1
        s.scale.setScalar(1.1 * (0.5 + 0.5 * pop));
        s.material.opacity = Math.min(1, left / 400); // fade out at the end
        s.position.set(p.x, p.y + 2.45 + Math.sin(now / 250) * 0.06, p.z);
      }
    }
    if (localIndex >= 0) {
      const p = playerPos[localIndex];
      marker.position.set(p.x, p.y + 1.8 + Math.sin(now / 200) * 0.08, p.z);
    }
    renderer.render(scene, camera);
  }

  return { apply, render, showEmote, setZoom, renderer, scene, camera, playerPos };
}
