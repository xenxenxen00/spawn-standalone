// Characters against characters (motion §5.13, §5.4): a capsule blocks another like a wall (AGENTS.md:156: a body standing
// in a charge lane stops the charge), nobody is pushed or dragged through the controller, and two bodies spawned inside each
// other can walk apart. The port's push-out of character pairs (kcc.ts header 7) has its own file, kcc-pushout.node.test.ts.
import { describe, expect, it } from 'vitest';
import { FLOOR, GRAVITY, MOVE, PlayerLoop, TICK, enemy, gridSoup, player, settle, stepWith, worldOf, type Part } from './rapier-fixtures.ts';

const R = 0.35;

/** a plane y = ax·x + az·z of 1 m squares */
function slopeSoup(half: number, ax: number, az: number): Float32Array {
  const flat = gridSoup(half);
  for (let i = 0; i < flat.length; i += 3) flat[i + 1] = ax * flat[i]! + az * flat[i + 2]!;
  return flat;
}

describe('kcc-chars', () => {
  it('a 0.5 m move at a capsule 0.3 m away stops ~0.29 m on: one offset short of touching', () => {
    const world = worldOf([FLOOR]);
    const a = player(world, { x: 0, y: 0.05, z: 0 }, 'a');
    const b = player(world, { x: 2 * R + 0.3, y: 0.05, z: 0 }, 'b');
    settle(world, a);
    const bx = b.feet.x;
    const x0 = a.feet.x;
    stepWith(world, a, { x: 0.5 / TICK, y: GRAVITY * TICK, z: 0 });
    expect(a.feet.x - x0).toBeGreaterThan(0.28);
    expect(a.feet.x - x0).toBeLessThan(0.3);
    expect(a.feet.x - x0).toBeCloseTo(0.29, 2);
    expect(a.velocity.x).toBeCloseTo(0.29 / TICK, 0);
    // the other body is an obstacle, not a load: it did not move
    expect(b.feet.x).toBe(bx);
    world.free();
  });

  it('a body in a charge lane stops the charge as a wall, and neither is pushed', () => {
    const world = worldOf([FLOOR]);
    const charger = enemy(world, { x: 0, y: 0.05, z: 0 }, 'brute');
    const victim = player(world, { x: 4, y: 0.05, z: 0 }, 'player-1');
    settle(world, charger);
    const vx = victim.feet.x;
    let stopped = 0, impactAt = -1, still = 0, closest = Infinity;
    for (let i = 0; i < 30; i++) {
      // scripts/enemies/runtime.js:1470: the charge writes its lane speed every tick, gravity added to the read
      const v = stepWith(world, charger, { x: 12, y: charger.velocity.y + GRAVITY * TICK, z: 0 });
      const speed = Math.hypot(v.x, v.z);
      const gap = Math.hypot(victim.feet.x - charger.feet.x, victim.feet.z - charger.feet.z) - (R + 0.34);
      closest = Math.min(closest, gap);
      if (i > 8 && speed < 0.1) stopped++;
      // arch/logic.js chargeStep: a wall impact is 3 ticks in a row moving under 35 % of the charge's pace, after 0.3 s
      still = i * TICK > 0.3 && speed < 12 * 0.35 ? still + 1 : 0;
      if (still >= 3 && impactAt < 0) impactAt = i;
    }
    // it met the body on tick 8 and reads a dead stop for the ticks the live charge needs (3) and more
    expect(stopped).toBeGreaterThan(8);
    expect(impactAt).toBeGreaterThan(8);
    expect(impactAt).toBeLessThan(13);
    // capsule surfaces never closer than one offset: stopped, not entered. (Pressing on for a second, a round body turns
    // off the dead-on line and around the other one, as around any round obstacle; the charge has ended long before.)
    expect(closest).toBeGreaterThan(0.009);
    expect(victim.feet.x).toBe(vx);
    expect(victim.feet.z).toBe(0);
    expect(charger.grounded).toBe(true);
    world.free();
  });

  it('a walker brushing past a standing body slides around it and does not drag it along', () => {
    const world = worldOf([FLOOR]);
    const walker = player(world, { x: -3, y: 0.05, z: 0.45 }, 'walker');
    const stander = player(world, { x: 0, y: 0.05, z: 0 }, 'stander');
    const loop = new PlayerLoop(world, walker);
    const rest = new PlayerLoop(world, stander);
    // both loops step the same world: drive the stander's writes by hand and let the walker's loop step
    settle(world, stander);
    const sx = stander.feet.x, sz = stander.feet.z;
    loop.run(5);
    loop.wish(1, 0);
    let slowest = Infinity;
    for (let i = 0; i < 45; i++) {
      stander.desiredVelocity.x = 0; stander.desiredVelocity.y = stander.velocity.y + GRAVITY * TICK; stander.desiredVelocity.z = 0;
      loop.tick();
      if (i > 5) slowest = Math.min(slowest, loop.speed);
    }
    void rest;
    // it got past (no sticking to the other capsule) and was deflected sideways around it
    expect(walker.feet.x).toBeGreaterThan(2.5);
    expect(walker.feet.z).toBeGreaterThan(0.45);
    expect(slowest).toBeGreaterThan(MOVE.walk * 0.5);
    // the stander was neither pushed nor dragged (Rapier's own kinematic friction is neutralised)
    expect(Math.hypot(stander.feet.x - sx, stander.feet.z - sz)).toBeLessThan(0.002);
    expect(Math.hypot(stander.velocity.x, stander.velocity.z)).toBeLessThan(0.05);
    world.free();
  });

  it('a body walking past does not drag a neighbour it touches', () => {
    const world = worldOf([FLOOR]);
    const mover = player(world, { x: 0, y: 0.05, z: 0 }, 'mover');
    const neighbour = player(world, { x: 0, y: 0.05, z: 2 * R + 0.011 }, 'neighbour');
    settle(world, mover);
    settle(world, neighbour, 5);
    const nx = neighbour.feet.x, nz = neighbour.feet.z;
    for (let i = 0; i < 20; i++) {
      neighbour.desiredVelocity.x = 0; neighbour.desiredVelocity.y = neighbour.velocity.y + GRAVITY * TICK; neighbour.desiredVelocity.z = 0;
      stepWith(world, mover, { x: 5, y: mover.velocity.y + GRAVITY * TICK, z: 0 });
    }
    expect(mover.feet.x).toBeGreaterThan(3);
    expect(Math.hypot(neighbour.feet.x - nx, neighbour.feet.z - nz)).toBeLessThan(0.002);
    world.free();
  });

  it('two characters spawned overlapping walk apart: no lock, no launch', () => {
    const world = worldOf([FLOOR]);
    const a = player(world, { x: 0, y: 0.05, z: 0 }, 'a');
    const b = player(world, { x: 0.1, y: 0.05, z: 0 }, 'b');
    // standing inside each other: nobody is thrown upwards or locked (they may be let out sideways)
    let top = 0;
    for (let i = 0; i < 30; i++) {
      for (const c of [a, b]) { c.desiredVelocity.x = 0; c.desiredVelocity.y = c.velocity.y + GRAVITY * TICK; c.desiredVelocity.z = 0; }
      world.step(TICK);
      top = Math.max(top, Math.abs(a.velocity.y), Math.abs(b.velocity.y));
    }
    expect(top).toBeLessThan(3);
    expect(Math.abs(b.feet.x - a.feet.x)).toBeLessThan(1);
    expect(a.grounded && b.grounded).toBe(true);
    expect(a.feet.y).toBeLessThan(0.02);
    expect(b.feet.y).toBeLessThan(0.02);
    const ax = a.feet.x, bx = b.feet.x;
    top = 0;
    for (let i = 0; i < 20; i++) {
      a.desiredVelocity.x = -3; a.desiredVelocity.y = a.velocity.y + GRAVITY * TICK; a.desiredVelocity.z = 0;
      b.desiredVelocity.x = 3; b.desiredVelocity.y = b.velocity.y + GRAVITY * TICK; b.desiredVelocity.z = 0;
      world.step(TICK);
      top = Math.max(top, Math.hypot(a.velocity.x, a.velocity.y, a.velocity.z), Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z));
    }
    // each walked its 2 m (3 m/s × 20 ticks, a tick lost at most): free from the first tick
    expect(a.feet.x - ax).toBeLessThan(-1.8);
    expect(a.feet.x - ax).toBeGreaterThan(-2.01);
    expect(b.feet.x - bx).toBeGreaterThan(1.8);
    expect(b.feet.x - bx).toBeLessThan(2.01);
    expect(top).toBeLessThan(3.2);
    expect(a.feet.y).toBeLessThan(0.03);
    expect(b.feet.y).toBeLessThan(0.03);
    // and from then on they block each other again. Closing at 3 + 3 m/s each moved against the other's place of the
    // tick before, so they meet up to one tick's move (0.1 m, less the offset) inside each other. The push-out takes
    // them out of it again (kcc.ts header 7), the overlap never grows, and pressing on a hair off the centre line they turn around each other as around any
    // round obstacle
    let closest = Infinity;
    for (let i = 0; i < 40; i++) {
      a.desiredVelocity.x = 3; a.desiredVelocity.y = a.velocity.y + GRAVITY * TICK; a.desiredVelocity.z = 0;
      b.desiredVelocity.x = -3; b.desiredVelocity.y = b.velocity.y + GRAVITY * TICK; b.desiredVelocity.z = 0;
      world.step(TICK);
      closest = Math.min(closest, Math.hypot(b.feet.x - a.feet.x, b.feet.z - a.feet.z));
    }
    expect(closest).toBeGreaterThan(2 * R - 3 * TICK);
    expect(closest).toBeLessThan(2 * R + 0.02);
    expect(Math.hypot(b.feet.x - a.feet.x, b.feet.z - a.feet.z)).toBeLessThan(2 * R + 0.05);
    world.free();
  });

  it.each([
    ['two walkers', 5, 5],
    ['two sprinters', 6.6, 6.6],
    ['a charge into a sprinter', 12, 6.6],
  ])('%s meeting head-on keep blocking each other: the overlap of the meeting tick never grows and nobody gets through', (_name, va, vb) => {
    // Each moved against the other's place of the tick before, so they meet up to the slower one's move (less the offset)
    // inside each other. From inside an overlap Rapier's own cast is not reliable (measured: at 5 + 5 m/s one start phase in
    // 200 let a body through after 11 pressed ticks, and every pressed tick used up the controller's 20 iterations); the
    // port blocks the advance itself.
    const bound = Math.min(va, vb) * TICK - 0.01;
    const PHASES = 40;
    for (let phase = 0; phase < PHASES; phase++) {
      const world = worldOf([FLOOR]);
      // phase 73 of 200 at 5 + 5 m/s is the one that got through
      const gap = 4 + ((va === 5 && phase === 0 ? 73 / 200 : phase / PHASES)) * (va + vb) * TICK;
      const a = player(world, { x: -gap / 2 - R, y: 0.02, z: 0 }, 'a');
      const b = player(world, { x: gap / 2 + R, y: 0.02, z: 0 }, 'b');
      settle(world, a, 5);
      let worst = 0, before = 0;
      const ticks = Math.ceil(4 / ((va + vb) * TICK)) + 45;
      for (let i = 0; i < ticks; i++) {
        a.desiredVelocity.x = va; a.desiredVelocity.y = a.velocity.y + GRAVITY * TICK; a.desiredVelocity.z = 0;
        b.desiredVelocity.x = -vb; b.desiredVelocity.y = b.velocity.y + GRAVITY * TICK; b.desiredVelocity.z = 0;
        world.step(TICK);
        const overlap = 2 * R - Math.hypot(b.feet.x - a.feet.x, b.feet.z - a.feet.z);
        worst = Math.max(worst, overlap);
        // a tick that began inside the other (beyond the 2 cm of mere touching) costs a plain move, not a controller loop
        // spun out on the other capsule
        if (before > 0.021) {
          expect(a.hits, `phase ${phase} tick ${i}`).toBeLessThan(10);
          expect(b.hits, `phase ${phase} tick ${i}`).toBeLessThan(10);
        }
        before = overlap;
      }
      // never deeper than the meeting tick made it, so nobody went through the other (they may turn around each other)
      expect(worst, `phase ${phase}`).toBeLessThan(bound + 0.005);
      world.free();
    }
  });

  it('pressed into each other, a body is still free to leave and to walk around the other', () => {
    const world = worldOf([FLOOR]);
    const a = player(world, { x: -1, y: 0.02, z: 0 }, 'a');
    const b = player(world, { x: 1, y: 0.02, z: 0 }, 'b');
    settle(world, a, 5);
    const drive = (ax: number, az: number, bx: number, ticks: number): void => {
      for (let i = 0; i < ticks; i++) {
        a.desiredVelocity.x = ax; a.desiredVelocity.y = a.velocity.y + GRAVITY * TICK; a.desiredVelocity.z = az;
        b.desiredVelocity.x = bx; b.desiredVelocity.y = b.velocity.y + GRAVITY * TICK; b.desiredVelocity.z = 0;
        world.step(TICK);
      }
    };
    drive(5, 0, -5, 20);
    // they met up to a tick's move inside each other, and the push-out (kcc.ts header 7) has taken them out of it again
    // while they press: they rest at contact
    const overlap = 2 * R - (b.feet.x - a.feet.x);
    expect(overlap).toBeLessThan(0.002);
    expect(overlap).toBeGreaterThan(-0.002);
    // a keeps pressing at an angle: it slides around b (the part of its move along the contact is kept) and gets past
    const bx = b.feet.x, bz = b.feet.z;
    drive(4, 3, 0, 30);
    expect(a.feet.x).toBeGreaterThan(b.feet.x + 0.5);
    expect(Math.hypot(b.feet.x - bx, b.feet.z - bz)).toBeLessThan(0.002);
    world.free();
  });

  // Stock Rapier 0.21 glues a character to every KINEMATIC collider within about 5 cm of it (another character, a door):
  // after the ground hit that every gravity-laden ask begins with, its kinematic-friction code sets the part of the
  // remaining move along that contact's normal to the other body's own movement, in BOTH directions. Measured with no port
  // code on a 1 m grid floor: walking straight away from a character 1-5 cm beside it covered 0.01 m in 0.5 s (free: 2.5 m),
  // 30° off 0.37 m. kcc.ts re-asks what the controller dropped after a ground hit (its header, 2).
  const floors: Array<[string, Part, (x: number, z: number) => number]> = [
    ['the box floor', FLOOR, () => 0],
    ['a 1 m grid floor', { row: 'ground', tris: gridSoup(12) }, () => 0],
    ['a 6° slope', { row: 'ground', tris: slopeSoup(12, 0.1, 0.03) }, (x, z) => 0.1 * x + 0.03 * z],
  ];
  it.each(floors)('a body walks away from a character it touches at the pace asked, on %s', (_name, floor, h) => {
    for (const gap of [0.01, 0.02, 0.03, 0.05]) {
      for (const deg of [0, 30, 60, 90, -45]) {
        const world = worldOf([floor]);
        const a = player(world, { x: 0, y: h(0, 0) + 0.05, z: 0 }, 'a');
        const b = enemy(world, { x: R + 0.34 + gap, y: h(R + 0.34 + gap, 0) + 0.05, z: 0 }, 'b');
        for (let i = 0; i < 12; i++) {
          for (const c of [a, b]) { c.desiredVelocity.x = 0; c.desiredVelocity.y = c.velocity.y + GRAVITY * TICK; c.desiredVelocity.z = 0; }
          world.step(TICK);
        }
        const x0 = a.feet.x, z0 = a.feet.z, bx = b.feet.x, bz = b.feet.z;
        const ang = (deg * Math.PI) / 180;
        let slowest = Infinity, fastest = 0;
        for (let i = 0; i < 15; i++) {
          a.desiredVelocity.x = -5 * Math.cos(ang); a.desiredVelocity.y = a.velocity.y + GRAVITY * TICK; a.desiredVelocity.z = 5 * Math.sin(ang);
          b.desiredVelocity.x = 0; b.desiredVelocity.y = b.velocity.y + GRAVITY * TICK; b.desiredVelocity.z = 0;
          world.step(TICK);
          const s = Math.hypot(a.velocity.x, a.velocity.z);
          slowest = Math.min(slowest, s); fastest = Math.max(fastest, s);
          expect(a.grounded, `gap ${gap}, ${deg}°, tick ${i}`).toBe(true);
        }
        const label = `gap ${gap} m, ${deg}° off straight away`;
        // 15 ticks at 5 m/s: 2.5 m, from the first tick on, and never faster than asked
        expect(Math.hypot(a.feet.x - x0, a.feet.z - z0), label).toBeGreaterThan(2.5 * 0.97);
        expect(slowest, label).toBeGreaterThan(5 * 0.9);
        expect(fastest, label).toBeLessThan(5 * 1.02);
        // the one left behind did not come along
        expect(Math.hypot(b.feet.x - bx, b.feet.z - bz), label).toBeLessThan(0.002);
        world.free();
      }
    }
  });

  it('a body backs away from a kinematic door it touches, and the player.js loop gets off a crowd at its own acceleration', () => {
    const world = worldOf([{ row: 'ground', tris: gridSoup(12) }, { row: 'door', box: [0.05, 1, 0.6], at: [R + 0.012 + 0.05, 1, 0], kinematic: true, mutable: true }]);
    const a = player(world, { x: 0, y: 0.05, z: 0 }, 'a');
    settle(world, a, 12);
    const x0 = a.feet.x;
    for (let i = 0; i < 15; i++) stepWith(world, a, { x: -5, y: a.velocity.y + GRAVITY * TICK, z: 0 });
    expect(x0 - a.feet.x).toBeGreaterThan(2.5 * 0.97);
    world.free();

    // three enemies press on a standing player from one side; the player then walks away from them (player.js numbers)
    const crowd = worldOf([{ row: 'ground', tris: gridSoup(12) }]);
    const p = player(crowd, { x: 0, y: 0.05, z: 0 }, 'player-1');
    const es = [enemy(crowd, { x: 2, y: 0.05, z: 0 }, 'e1'), enemy(crowd, { x: 2, y: 0.05, z: 0.9 }, 'e2'), enemy(crowd, { x: 2, y: 0.05, z: -0.9 }, 'e3')];
    const loop = new PlayerLoop(crowd, p);
    const press = (): void => {
      for (const e of es) {
        const dx = p.feet.x - e.feet.x, dz = p.feet.z - e.feet.z, d = Math.hypot(dx, dz) || 1;
        e.desiredVelocity.x = (dx / d) * 3.4; e.desiredVelocity.y = e.velocity.y + GRAVITY * TICK; e.desiredVelocity.z = (dz / d) * 3.4;
      }
    };
    for (let i = 0; i < 45; i++) { press(); loop.tick(); }
    // they are on it
    expect(Math.min(...es.map((e) => Math.hypot(e.feet.x - p.feet.x, e.feet.z - p.feet.z)))).toBeLessThan(R + 0.34 + 0.03);
    loop.wish(-1, 0);
    const speeds: number[] = [];
    for (let i = 0; i < 6; i++) { press(); loop.tick(); speeds.push(loop.speed); }
    // 42 m/s² from rest: 1.4, 2.8, 4.2, 5 m/s, exactly as on an empty floor (kcc-flat), with three bodies touching
    const want = [1.4, 2.8, 4.2, 5, 5, 5];
    speeds.forEach((s, i) => expect(s, `tick ${i + 1}`).toBeCloseTo(want[i]!, 1));
    crowd.free();
  });

  it('a body pressing into the notch between two it touches holds still, at the cost of a plain move', () => {
    const world = worldOf([{ row: 'ground', tris: gridSoup(12) }]);
    const a = player(world, { x: 0, y: 0.05, z: 0 }, 'a');
    // two standing bodies 1 cm from a, 60° apart seen from it, and 1 cm from each other
    const d = 2 * R + 0.01;
    const b = player(world, { x: d * Math.cos(Math.PI / 6), y: 0.05, z: d * Math.sin(Math.PI / 6) }, 'b');
    const c = player(world, { x: d * Math.cos(Math.PI / 6), y: 0.05, z: -d * Math.sin(Math.PI / 6) }, 'c');
    const rest = (o: typeof a): void => { o.desiredVelocity.x = 0; o.desiredVelocity.y = o.velocity.y + GRAVITY * TICK; o.desiredVelocity.z = 0; };
    for (let i = 0; i < 12; i++) { rest(a); rest(b); rest(c); world.step(TICK); }
    const x0 = a.feet.x, z0 = a.feet.z;
    for (let i = 0; i < 60; i++) {
      // straight at the notch, and a little off it
      a.desiredVelocity.x = 5; a.desiredVelocity.y = a.velocity.y + GRAVITY * TICK; a.desiredVelocity.z = i < 30 ? 0 : 0.6;
      rest(b); rest(c);
      world.step(TICK);
      expect(Math.hypot(a.velocity.x, a.velocity.z), `tick ${i}`).toBeLessThan(0.05);
      // no spun-out controller loop behind it
      expect(a.hits, `tick ${i}`).toBeLessThan(6);
    }
    expect(Math.hypot(a.feet.x - x0, a.feet.z - z0)).toBeLessThan(0.01);
    for (const o of [b, c]) expect(Math.hypot(o.feet.x - a.feet.x, o.feet.z - a.feet.z)).toBeGreaterThan(d - 0.005);
    // back out of it: free at once
    for (let i = 0; i < 6; i++) { a.desiredVelocity.x = -5; a.desiredVelocity.y = a.velocity.y + GRAVITY * TICK; a.desiredVelocity.z = 0; rest(b); rest(c); world.step(TICK); }
    expect(x0 - a.feet.x).toBeGreaterThan(6 * 5 * TICK * 0.97);
    world.free();
  });

  it('a slide off a wall does not carry a body deeper into the one it stands inside', () => {
    // a stands 8 cm inside b (b to its +x) and walks toward -z into a wall that deflects it toward +x: the controller's
    // slide would run into b, which its cast does not see
    const n = Math.SQRT1_2;
    const world = worldOf([FLOOR, { row: 'wall', box: [0.25, 2, 5], at: [-0.35 - 0.25 * n, 2, -0.35 - 0.25 * n], axis: [0, 1, 0], deg: -45 }]);
    const a = player(world, { x: 0, y: 0.02, z: 0 }, 'a');
    const b = player(world, { x: 0.62, y: 0.02, z: 0 }, 'b');
    for (let i = 0; i < 10; i++) {
      for (const c of [a, b]) { c.desiredVelocity.x = 0; c.desiredVelocity.y = c.velocity.y + GRAVITY * TICK; c.desiredVelocity.z = 0; }
      world.step(TICK);
    }
    // the push-out (kcc.ts header 7) took them out of each other while they stood, half each; a, toward the wall, stays
    // out of it (its face is 0.495 m from the origin along (-n, -n))
    const start = Math.hypot(b.feet.x - a.feet.x, b.feet.z - a.feet.z);
    expect(start).toBeCloseTo(2 * R, 2);
    expect(0.35 + 0.25 * Math.SQRT2 - 0.25 + (a.feet.x + a.feet.z) * n).toBeGreaterThan(R - 0.002);
    const b0 = b.feet.x;
    let closest = start;
    for (let i = 0; i < 30; i++) {
      a.desiredVelocity.x = 0; a.desiredVelocity.y = a.velocity.y + GRAVITY * TICK; a.desiredVelocity.z = -3;
      b.desiredVelocity.x = 0; b.desiredVelocity.y = b.velocity.y + GRAVITY * TICK; b.desiredVelocity.z = 0;
      world.step(TICK);
      closest = Math.min(closest, Math.hypot(b.feet.x - a.feet.x, b.feet.z - a.feet.z));
    }
    // it reached the wall (the free part of the walk happened) ...
    expect(a.feet.z).toBeLessThan(-0.1);
    // ... and from there it holds its ground instead of sliding into b
    expect(closest).toBeGreaterThan(start - 0.01);
    expect(Math.hypot(a.velocity.x, a.velocity.z)).toBeLessThan(0.1);
    expect(b.feet.x).toBeCloseTo(b0, 3);
    // away from both it is free at once
    for (let i = 0; i < 10; i++) {
      a.desiredVelocity.x = -3; a.desiredVelocity.y = a.velocity.y + GRAVITY * TICK; a.desiredVelocity.z = 3;
      b.desiredVelocity.x = 0; b.desiredVelocity.y = b.velocity.y + GRAVITY * TICK; b.desiredVelocity.z = 0;
      world.step(TICK);
    }
    expect(Math.hypot(b.feet.x - a.feet.x, b.feet.z - a.feet.z)).toBeGreaterThan(1.5);
    world.free();
  });

  it.each([0.1, 0.2, 0.3, 0.45])('a body that comes down on another one\'s head %s m off-centre rests on it or slides off: it never falls through', (off) => {
    const world = worldOf([FLOOR]);
    const below = player(world, { x: 0, y: 0.02, z: 0 }, 'below');
    const above = player(world, { x: off, y: 3.2, z: 0 }, 'above');
    let inside = 0;
    for (let i = 0; i < 90; i++) {
      for (const c of [below, above]) { c.desiredVelocity.x = 0; c.desiredVelocity.y = c.velocity.y + GRAVITY * TICK; c.desiredVelocity.z = 0; }
      world.step(TICK);
      // true capsule distance: both segments are vertical
      const d = Math.hypot(above.feet.x - below.feet.x, above.feet.z - below.feet.z);
      const gapY = Math.max(0, above.feet.y + R - (below.feet.y + 1.9 - R));
      if (2 * R - Math.hypot(d, gapY) > 0.02) inside++;
    }
    expect(inside).toBe(0);
    expect(above.grounded).toBe(true);
    // on the head or shoulder (a walkable cap for the 52° template), or on the floor beside the body: never inside it
    expect(above.feet.y > 1.5 || Math.hypot(above.feet.x, above.feet.z) > 2 * R).toBe(true);
    expect(Math.hypot(below.feet.x, below.feet.z)).toBeLessThan(0.002);
    expect(below.feet.y).toBeLessThan(0.02);
    world.free();
  });

  it('characters move in spawn order against the snapshot of the last step: the result does not depend on who is first', () => {
    const run = (swap: boolean): number[] => {
      const world = worldOf([FLOOR]);
      const first = player(world, swap ? { x: 2, y: 0.05, z: 0 } : { x: -2, y: 0.05, z: 0 }, swap ? 'right' : 'left');
      const second = player(world, swap ? { x: -2, y: 0.05, z: 0 } : { x: 2, y: 0.05, z: 0 }, swap ? 'left' : 'right');
      const left = swap ? second : first, right = swap ? first : second;
      expect(first.serial).toBeLessThan(second.serial);
      for (let i = 0; i < 60; i++) {
        left.desiredVelocity.x = 2; left.desiredVelocity.y = left.velocity.y + GRAVITY * TICK; left.desiredVelocity.z = 0;
        right.desiredVelocity.x = -2; right.desiredVelocity.y = right.velocity.y + GRAVITY * TICK; right.desiredVelocity.z = 0;
        world.step(TICK);
      }
      const out = [left.feet.x, right.feet.x];
      world.free();
      return out;
    };
    const ab = run(false), ba = run(true);
    // they meet in the middle, symmetric, whoever was spawned first. Both moved against the other's place of the tick
    // before, so they end a few centimetres inside each other (the push-out of kcc.ts header 7 then takes them out of it, half each, which keeps it symmetric).
    expect(ab[0]! + ab[1]!).toBeCloseTo(0, 2);
    expect(ba[0]! + ba[1]!).toBeCloseTo(0, 2);
    expect(ab[0]).toBeCloseTo(ba[0]!, 2);
    expect(ab[1]! - ab[0]!).toBeGreaterThan(2 * R - 0.05);
    expect(ab[1]! - ab[0]!).toBeLessThan(2 * R + 0.02);
  });
});
