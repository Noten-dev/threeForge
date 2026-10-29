const m = await import('../src/threeforge-v2_6_0.js');
const keys = Object.keys(m);
console.log('import OK; exports:', keys.length);
// базовые smoke-проверки без DOM/WebGL
const eng = new m.Engine({});
console.log('Engine:', typeof eng.addSystem, 'fixedTimeStep =', eng.fixedTimeStep);
eng.addSystem({ update() {} }, 5);
console.log('systems:', eng.systems.length);
const t = new m.Terrain({ seed: 42 });
console.log('Terrain.height(10,20) =', t.height(10, 20).toFixed(3));
const pw = new m.PhysicsWorld();
const b = pw.addBody({ shape: 'sphere', radius: 0.5, mass: 1, position: { x: 0, y: 10, z: 0, clone(){ return this; }, copy(o){ this.x=o.x; this.y=o.y; this.z=o.z; return this; }, set(){ return this; } } });
console.log('bodies:', pw.bodies.length);
const prng = m.createPRNG(7);
console.log('prng():', prng().toFixed(4));
console.log('FOG_PRESETS:', Object.keys(m.FOG_PRESETS).join(','));
console.log('WEATHER_MODES:', Object.keys(m.WEATHER_MODES).join(','));
console.log('smoke OK ✓');
