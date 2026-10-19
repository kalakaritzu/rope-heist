// Rendering. Draws the world from a snapshot array (see layout() in sim.js); has no physics of its own.
import * as THREE from 'three';
import { LEVEL, PLAYER_COLORS, ROPE_SEGMENTS, VIEW_DIST, VIEW_HALF_ANGLE, layout } from './sim.js';

const flat = (color) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9 });

export function createView(n, localIndex = -1) {
  const L = layout(n);

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
  for (const s of LEVEL.statics) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(s.h[0] * 2, s.h[1] * 2, s.h[2] * 2), flat(s.color));
    m.position.set(...s.p);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  // the getaway zone: the safe has to end up in here
  const ex = LEVEL.exit;
  const exitMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(ex.hx * 2, ex.hz * 2),
    new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.22, depthWrite: false }),
  );
  exitMesh.rotation.x = -Math.PI / 2;
  exitMesh.position.set(ex.x, 0.03, ex.z);
  scene.add(exitMesh);

  const crateMeshes = LEVEL.crates.map((c) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(c.s, c.s, c.s), flat(c.color));
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    return m;
  });

  // players
  const playerMeshes = [];
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.7, 4, 12), flat(PLAYER_COLORS[i]));
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
    for (let r = 0; r < L.ropes; r++) {
      const k = d[L.kOff + r];
      knots[r].visible = k >= 0;
      if (k >= 0) {
        const o = L.rOff + (r * ROPE_SEGMENTS + k) * 3;
        knots[r].position.set(d[o], d[o + 1], d[o + 2]);
      }
      // flash when either end of this rope has just yanked
      const flash = Math.max(d[L.fOff + r], d[L.fOff + r + 1]);
      ropeMeshes[r].material.emissiveIntensity = Math.max(0, (flash - 0.7) / 0.3) * 0.9;
    }
  }

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
    camGoal.set(camTarget.x, 6 + spread * 1.2, camTarget.z + 9 + spread * 1.8);
    camPos.lerp(camGoal, 1 - Math.exp(-dt * 4)); // frame-rate independent smoothing
    camera.position.copy(camPos);
    camera.lookAt(camTarget);

    if (localIndex >= 0) {
      const p = playerPos[localIndex];
      marker.position.set(p.x, p.y + 1.45 + Math.sin(now / 200) * 0.08, p.z);
    }
    renderer.render(scene, camera);
  }

  return { apply, render, renderer, scene, camera, playerPos };
}
